import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';
import { DomainError } from '../../domain/src/index.js';

export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
function environment(overrides: NodeJS.ProcessEnv = {}) {
  let file = '';
  try { file = readFileSync(path.join(projectRoot, '.env'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { ...dotenv.parse(file), ...process.env, ...overrides };
}
export function resolveSecret(reference: string): string {
  try {
    const value = reference.startsWith('env:') ? environment()[reference.slice(4)]
      : reference.startsWith('file:') ? readFileSync(path.resolve(projectRoot, reference.slice(5)), 'utf8').trim() : undefined;
    if (!value) throw new Error();
    return value;
  } catch { throw new DomainError('CONFIG_INVALID', '密钥引用未配置或无法读取，请检查服务端配置'); }
}
export function loadConfig(overrides: NodeJS.ProcessEnv = {}) {
  const env = environment(overrides);
  const parsed = z.object({
    APP_HOST: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
    APP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATA_DIR: z.string().default(path.join(projectRoot, 'data')),
    ENABLE_SIMULATION: z.enum(['true', 'false']).default('false'),
    MOCK_STAGE_MS: z.coerce.number().int().min(0).max(60000).default(1500),
    UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(4 * 1024 ** 3).default(4 * 1024 ** 3),
    DOWNLOAD_MAX_BYTES: z.coerce.number().int().positive().max(4 * 1024 ** 3).default(4 * 1024 ** 3),
    AUDIO_CHUNK_MINUTES: z.coerce.number().min(0.1).max(20).default(15),
    S2T_MAX_BYTES: z.coerce.number().int().min(100000).max(50_000_000).default(45_000_000),
    SUMMARY_MAX_INPUT_TOKENS: z.coerce.number().int().min(4096).max(128000).default(24000),
    MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(1800000).default(600000),
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(512).max(32000).default(8000),
  }).safeParse(env);
  if (!parsed.success) throw new DomainError('CONFIG_INVALID', '配置格式不正确，请检查监听地址、容量和分片参数');
  const c = parsed.data;
  const dataDir = path.resolve(projectRoot, c.DATA_DIR);
  const provider = (kind: 'S2T' | 'LLM') => ({
    url: (kind === 'S2T' ? env.S2T_BASE_URL || env.S2T_API_URL : env.LLM_BASE_URL || env.write_API_URL) || '',
    model: (kind === 'S2T' ? env.S2T_MODEL : env.LLM_MODEL || env.write_MODEL) || '',
    keyRef: (kind === 'S2T' ? env.S2T_API_KEY_REF : env.LLM_API_KEY_REF) || (kind === 'S2T' ? 'env:S2T_API_KEY' : 'env:write_API_KEY'),
  });
  return {
    host: c.APP_HOST, port: c.APP_PORT, dataDir,
    databaseUrl: env.DATABASE_URL || 'file:' + path.join(dataDir, 'db', 'videoassist.sqlite').replaceAll('\\', '/'),
    simulation: c.ENABLE_SIMULATION === 'true', mockStageMs: c.MOCK_STAGE_MS,
    s2t: provider('S2T'), llm: provider('LLM'),
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg', ffprobe: env.FFPROBE_PATH || 'ffprobe', ytdlp: env.YTDLP_PATH || 'yt-dlp',
    cookieFile: env.BILIBILI_COOKIE_FILE_REF?.replace(/^file:/, ''),
    uploadMaxBytes: c.UPLOAD_MAX_BYTES, downloadMaxBytes: c.DOWNLOAD_MAX_BYTES,
    audioChunkSeconds: c.AUDIO_CHUNK_MINUTES * 60, s2tMaxBytes: c.S2T_MAX_BYTES,
    summaryInputTokens: c.SUMMARY_MAX_INPUT_TOKENS, modelTimeoutMs: c.MODEL_TIMEOUT_MS,
    llmMaxOutputTokens: c.LLM_MAX_OUTPUT_TOKENS,
    summaryPromptFile: path.resolve(projectRoot, env.SUMMARY_PROMPT_FILE || 'docs/ai_summary_system_prompt.md'),
  };
}
export type AppConfig = ReturnType<typeof loadConfig>;
