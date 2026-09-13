import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { getEncoding } from 'js-tiktoken';
import { resolveSecret, type AppConfig } from '../../config/src/index.js';
import { DomainError } from '../../domain/src/index.js';
import { summarySchema, type Segment, type StructuredSummary } from '../../contracts/src/media.js';

export function endpoint(base: string, suffix: string): string {
  try {
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = url.pathname.replace(/\/$/, '');
    if (!url.pathname.endsWith('/' + suffix)) url.pathname += '/' + suffix;
    return url.toString();
  } catch { throw new DomainError('CONFIG_INVALID', '模型接口地址无效'); }
}
export async function modelRequest(kind: 'S2T' | 'LLM', url: string, body: BodyInit, config: AppConfig, signal: AbortSignal) {
  const settings = kind === 'S2T' ? config.s2t : config.llm;
  if (!settings.model) throw new DomainError('CONFIG_INVALID', '请配置模型名称');
  const headers: Record<string, string> = { Authorization: 'Bearer ' + resolveSecret(settings.keyRef) };
  if (typeof body === 'string') headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch(url, { method: 'POST', headers, body, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.modelTimeoutMs)]) });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new DomainError(kind + '_AUTH_FAILED', '模型鉴权失败，请检查服务端密钥及模型权限');
      if (response.status === 429) throw new DomainError(kind + '_RATE_LIMITED', '模型接口限流，稍后自动重试', true);
      if (response.status >= 500) throw new DomainError(kind + '_UNAVAILABLE', '模型服务暂时不可用，稍后自动重试', true);
      throw new DomainError(kind + '_REQUEST_REJECTED', '模型接口拒绝请求（HTTP ' + response.status + '），请检查模型、地址和参数');
    }
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new DomainError(kind + '_RESPONSE_INVALID', '模型响应超过容量限制'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new DomainError(kind + '_RESPONSE_INVALID', '模型响应不是合法 JSON'); }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (signal.aborted) throw new DomainError('OPERATION_CANCELED', '请求已取消');
    throw new DomainError(kind + '_NETWORK_ERROR', '模型请求超时或网络异常，稍后自动重试', true);
  }
}
export async function transcribeAudio(file: string, startMs: number, durationMs: number, config: AppConfig, signal: AbortSignal) {
  if ((await stat(file)).size > config.s2tMaxBytes) throw new DomainError('S2T_FILE_TOO_LARGE', '音频分片超过模型限制，请减小分片时长');
  const form = new FormData();
  form.set('model', config.s2t.model);
  form.set('file', await openAsBlob(file, { type: 'audio/flac' }), 'audio.flac');
  const raw = await modelRequest('S2T', endpoint(config.s2t.url, 'audio/transcriptions'), form, config, signal);
  const data = z.object({
    text: z.string().min(1), language: z.string().optional(),
    segments: z.array(z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string() })).optional(),
  }).safeParse(raw);
  if (!data.success) throw new DomainError('S2T_RESPONSE_INVALID', '转写接口未返回有效文稿');
  const text = data.data.text.replace(/<\|[^|]*\|>/g, '').trim();
  if (!text) throw new DomainError('S2T_RESPONSE_INVALID', '转写结果为空');
  const segments: Segment[] = data.data.segments?.length ? data.data.segments.map(segment => {
    if (segment.end < segment.start || segment.start * 1000 > durationMs || segment.end * 1000 > durationMs + 2000) throw new DomainError('S2T_RESPONSE_INVALID', '转写时间段超出音频范围');
    return { startMs: startMs + Math.round(segment.start * 1000), endMs: startMs + Math.min(durationMs, Math.round(segment.end * 1000)), text: segment.text.trim() };
  }) : [{ startMs, endMs: startMs + durationMs, text }];
  return { text, language: data.data.language || '未指定', segments, timestampPrecision: data.data.segments?.length ? 'SEGMENT' as const : 'CHUNK' as const };
}

const mapSchema = z.object({
  segment_index: z.number().int(), topics: z.array(z.string()), facts_and_events: z.array(z.string()),
  steps_and_conditions: z.array(z.string()), author_views: z.array(z.string()),
  open_threads: z.array(z.string()), uncertainties: z.array(z.string()),
}).strict();
const encoder = getEncoding('cl100k_base');
export const tokenCount = (text: string) => encoder.encode(text).length;
export function splitText(text: string, budget: number): string[] {
  if (budget < 32) throw new DomainError('LLM_CONTEXT_EXCEEDED', '总结输入预算过小');
  const pieces = text.match(/[^。！？\n]*[。！？\n]+|[^。！？\n]+$/gu) || [text];
  const result: string[] = []; let current = ''; let count = 0;
  for (const piece of pieces) {
    let remaining = piece;
    while (tokenCount(remaining) > budget) {
      if (current) { result.push(current); current = ''; count = 0; }
      const chars = Array.from(remaining); let low = 1; let high = chars.length;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (tokenCount(chars.slice(0, mid).join('')) <= budget) low = mid; else high = mid - 1; }
      result.push(chars.slice(0, low).join('')); remaining = chars.slice(low).join('');
    }
    const size = tokenCount(remaining);
    if (count + size > budget && current) { result.push(current); current = ''; count = 0; }
    current += remaining; count += size;
  }
  if (current) result.push(current);
  return result;
}
async function jsonCompletion<T>(system: string, user: string, schema: z.ZodType<T>, config: AppConfig, signal: AbortSignal): Promise<T> {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await modelRequest('LLM', endpoint(config.llm.url, 'chat/completions'), JSON.stringify({
      model: config.llm.model, messages, temperature: 0.2, max_tokens: config.llmMaxOutputTokens,
      response_format: { type: 'json_object' },
      ...(new URL(config.llm.url).hostname.endsWith('aliyuncs.com') ? { enable_thinking: false } : {}),
    }), config, signal);
    const response = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string().nullable().optional() })).min(1) }).safeParse(raw);
    if (!response.success) throw new DomainError('LLM_RESPONSE_INVALID', '总结接口未返回有效内容');
    const choice = response.data.choices[0]!;
    if (choice.finish_reason === 'length') throw new DomainError('LLM_OUTPUT_TRUNCATED', '总结输出达到长度限制，请增加输出预算或减小输入分片');
    try { return schema.parse(JSON.parse(choice.message.content)); }
    catch {
      if (attempt === 1) throw new DomainError('LLM_RESPONSE_INVALID', '总结结构校验失败，模型修复后仍不符合格式');
      messages.push({ role: 'assistant', content: choice.message.content });
      messages.push({ role: 'user', content: '上次响应未通过字段与类型校验。仅修复 JSON 格式，严格遵守系统规定的字段，不补充事实。' });
    }
  }
  throw new DomainError('LLM_RESPONSE_INVALID', '总结失败');
}
export async function summarizeText(input: {
  text: string; prompt: string; title: string; source: string; creator: string; durationMs: number; language: string;
  cached: (key: string, execute: () => Promise<unknown>) => Promise<unknown>;
}, config: AppConfig, signal: AbortSignal): Promise<{ content: StructuredSummary; chunkCount: number }> {
  // Qwen tokenization differs; reserve 20% beyond the actual cl100k estimate.
  const budget = Math.floor(config.summaryInputTokens * 0.8) - tokenCount(input.prompt) - 1000;
  if (budget < 256) throw new DomainError('LLM_CONTEXT_EXCEEDED', '提示词过长，剩余上下文不足');
  let content = input.text; let type = 'transcript'; let chunkCount = 0;
  for (let level = 0; tokenCount(content) > budget; level++) {
    if (level >= 4) throw new DomainError('LLM_CONTEXT_EXCEEDED', '分段材料仍过长，请增大输入预算');
    const pieces = splitText(content, budget);
    const maps: unknown[] = [];
    for (const [index, piece] of pieces.entries()) {
      const system = input.prompt + '\n\n当前为分段整理阶段，以下输出格式替代最终四字段格式。只整理本段事实，不生成全片结论。仅输出 JSON：' +
        JSON.stringify({ segment_index: index, topics: [], facts_and_events: [], steps_and_conditions: [], author_views: [], open_threads: [], uncertainties: [] }) +
        '。所有数组元素为字符串，缺失信息使用空数组。不得增加字段。';
      maps.push(await input.cached('map:' + level + ':' + index + ':' + piece, () => jsonCompletion(system, piece, mapSchema, config, signal)));
      chunkCount++;
    }
    const next = JSON.stringify(maps);
    if (tokenCount(next) >= tokenCount(content)) throw new DomainError('LLM_CONTEXT_EXCEEDED', '分段总结未有效缩短材料，请调整模型或输入预算');
    content = next; type = 'segment_summaries';
  }
  const user = '请根据以下资料生成结构化视频总结。\n<video_context>\n' + JSON.stringify({
    title: input.title, source: input.source, creator: input.creator, duration_ms: input.durationMs, language: input.language,
  }) + '\n</video_context>\n<input_type>' + type + '</input_type>\n<content>\n' + content + '\n</content>';
  return { content: await jsonCompletion(input.prompt, user, summarySchema, config, signal), chunkCount };
}
