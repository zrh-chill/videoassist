import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig, type AppConfig } from '../packages/config/src/index.js';
import { createDatabase, initializeDatabase, type Database } from '../packages/database/src/client.js';
import { applyTestMigrations } from './helpers.js';
import { Tasks } from '../packages/database/src/tasks.js';
import { MediaLibrary } from '../packages/database/src/media.js';
import { initializeStorage, resolveStorageKey } from '../packages/storage/src/index.js';
import { createApp } from '../apps/api/src/app.js';
import { Worker } from '../apps/worker/src/runner.js';
import { mediaHandler } from '../apps/worker/src/media-handler.js';
import { normalizeBilibiliUrl } from '../packages/integrations/src/bilibili.js';
import { runTool } from '../packages/integrations/src/process.js';
import { modelRequest, transcribeAudio, splitText, tokenCount, summarizeText, endpoint } from '../packages/integrations/src/models.js';
import { summarySchema } from '../packages/contracts/src/media.js';

let db: Database; let config: AppConfig; let server: Server;
let speechCalls = 0; let llmCalls = 0; let speechFailure = 0; let repairFailure = false;
let httpStatus = 200; let receivedAuth = ''; let receivedFields = '';
const content = { one_sentence: '介绍测试步骤。', key_points: ['先准备音频，再保存文稿。'], detailed_summary: '### 准备音频\n\n保留内容。', keywords: ['测试'] };
beforeEach(async () => {
  speechCalls = 0; llmCalls = 0; speechFailure = 0; repairFailure = false; httpStatus = 200;
  process.env.VIDEOASSIST_TEST_KEY = 'test-only-not-a-real-key';
  const root = await mkdtemp(path.join(os.tmpdir(), 'videoassist-media-'));
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    receivedAuth = request.headers.authorization || ''; receivedFields = body;
    response.setHeader('Content-Type', 'application/json');
    if (httpStatus !== 200) { response.writeHead(httpStatus); response.end(JSON.stringify({ error: 'raw-sensitive-value' })); return; }
    if (request.url?.endsWith('audio/transcriptions')) {
      speechCalls++;
      if (speechCalls === speechFailure) { response.writeHead(503); response.end('{}'); return; }
      response.end(JSON.stringify({ text: '本段讲述音频处理与结果保存。' }));
    } else {
      llmCalls++;
      const payload = JSON.parse(body);
      const map = payload.messages[0].content.includes('当前为分段整理阶段');
      const value = map ? { segment_index: 0, topics: ['测试'], facts_and_events: ['内容'], steps_and_conditions: [], author_views: [], open_threads: [], uncertainties: [] } : content;
      response.end(JSON.stringify({ choices: [{ message: { content: repairFailure ? 'invalid json' : JSON.stringify(value) }, finish_reason: 'stop' }] }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
  config = loadConfig({ DATA_DIR: root, DATABASE_URL: 'file:' + path.join(root, 'db', 'test.sqlite').replaceAll('\\', '/'),
    S2T_BASE_URL: base, S2T_MODEL: 'test-asr', S2T_API_KEY_REF: 'env:VIDEOASSIST_TEST_KEY',
    LLM_BASE_URL: base, LLM_MODEL: 'test-llm', LLM_API_KEY_REF: 'env:VIDEOASSIST_TEST_KEY', AUDIO_CHUNK_MINUTES: '0.1' });
  await initializeStorage(root);
  db = createDatabase(config.databaseUrl); await applyTestMigrations(db); await initializeDatabase(db);
});
afterEach(async () => { await db.$disconnect(); await new Promise<void>(resolve => server.close(() => resolve())); delete process.env.VIDEOASSIST_TEST_KEY; });

async function sampleVideo(seconds = 2) {
  const file = path.join(config.dataDir, 'temp', 'sample.mp4');
  await runTool(config.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', String(seconds), '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', file]);
  return file;
}
async function upload(file: string, override?: AppConfig) {
  const app = createApp(db, override || config);
  const boundary = 'videoassist-test-boundary';
  const payload = Buffer.concat([Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="sample.mp4"\r\nContent-Type: video/mp4\r\n\r\n'),
    await readFile(file), Buffer.from('\r\n--' + boundary + '--\r\n')]);
  try { return await app.inject({ method: 'POST', url: '/api/v1/videos/uploads', headers: { 'content-type': 'multipart/form-data; boundary=' + boundary, 'idempotency-key': randomUUID() }, payload }); }
  finally { await app.close(); }
}
test('B 站规范化去掉追踪参数并拒绝伪造主机与多分 P', () => {
  assert.deepEqual(normalizeBilibiliUrl('https://www.bilibili.com/video/BV17xo9BsEnx/?spm_id_from=test'), { bvid: 'BV17xo9BsEnx', url: 'https://www.bilibili.com/video/BV17xo9BsEnx/' });
  for (const value of ['https://www.bilibili.com.evil.test/video/BV17xo9BsEnx/', 'file:///video/BV17xo9BsEnx/', 'https://user:pass@www.bilibili.com/video/BV17xo9BsEnx/', 'https://www.bilibili.com/video/BV17xo9BsEnx/?p=2']) {
    assert.throws(() => normalizeBilibiliUrl(value));
  }
  assert.equal(endpoint('https://example.test/v1/audio/transcriptions', 'audio/transcriptions'), 'https://example.test/v1/audio/transcriptions');
});
test('同 BVID 并发导入仅保存一条记录和任务', async () => {
  const library = new MediaLibrary(db);
  const normalized = normalizeBilibiliUrl('https://www.bilibili.com/video/BV17xo9BsEnx/');
  const input = { sourceType: 'BILIBILI' as const, title: '测试', bvid: normalized.bvid, originalUrl: normalized.url };
  const results = await Promise.all([library.importVideo(input, randomUUID()), library.importVideo(input, randomUUID())]);
  assert.equal(results[0]!.id, results[1]!.id); assert.equal(await db.video.count(), 1); assert.equal(await db.job.count(), 1);
});
test('真实视频上传和 FFmpeg 配合 HTTP 模型完成闭环并保留总结旧版本', async () => {
  const response = await upload(await sampleVideo());
  assert.equal(response.statusCode, 201, response.body);
  const id = response.json().id;
  const worker = new Worker(new Tasks(db), mediaHandler(db, config));
  for (let i = 0; i < 3; i++) await worker.tick();
  assert.equal((await new Tasks(db).detail(id)).overallStatus, 'COMPLETED');
  assert.equal(await db.artifact.count(), 2); assert.equal(await db.transcript.count(), 1); assert.equal(await db.summary.count(), 1);
  assert.equal(receivedAuth, 'Bearer test-only-not-a-real-key');
  const transcript = (await db.transcript.findFirst({ include: { segments: true } }))!;
  assert.equal(transcript.timestampPrecision, 'CHUNK'); assert.ok(transcript.segments[0]!.endMs > 1000);
  const first = (await db.summary.findFirst())!;
  // Change the prompt file through runtime configuration, then preserve its new immutable version.
  const promptFile = path.join(config.dataDir, 'temp', 'custom-prompt.txt');
  await writeFile(promptFile, '忠实总结输入，只输出 JSON：' + JSON.stringify(content));
  const changed = { ...config, summaryPromptFile: promptFile };
  await new MediaLibrary(db).regenerateSummary(id, randomUUID());
  await new Worker(new Tasks(db), mediaHandler(db, changed)).tick();
  assert.equal(await db.summary.count(), 2); assert.equal(await db.promptVersion.count(), 2);
  assert.equal((await db.summary.findUnique({ where: { id: first.id } }))!.isCurrent, false);
  assert.equal(await db.summary.count({ where: { isCurrent: true } }), 1);
  assert.equal(await db.transcript.count(), 1);
  const app = createApp(db, config);
  try {
    const old = (await app.inject({ url: '/api/v1/videos/' + id + '/summary?revision=1' })).json();
    assert.equal(old.current.id, first.id); assert.equal(old.versions.length, 2);
    const runs = await app.inject({ url: '/api/v1/videos/' + id + '/runs' });
    assert.ok(!runs.body.includes(transcript.fullText));
  } finally { await app.close(); }
});
test('音频分片失败后复用成功检查点并保留全局时间偏移', async () => {
  const response = await upload(await sampleVideo(8));
  const id = response.json().id;
  const tasks = new Tasks(db); const worker = new Worker(tasks, mediaHandler(db, config));
  await worker.tick(); speechFailure = 2;
  await worker.tick();
  assert.equal(speechCalls, 2); assert.equal(await db.transcript.count(), 0);
  assert.equal(await db.checkpoint.count({ where: { kind: 'TRANSCRIBE' } }), 1);
  await db.job.updateMany({ where: { videoId: id, status: 'QUEUED' }, data: { availableAt: new Date(0) } });
  await worker.tick();
  assert.equal(speechCalls, 3); // only the failed second chunk was called again
  const transcript = (await db.transcript.findFirst({ include: { segments: { orderBy: { sequence: 'asc' } } } }))!;
  assert.equal(transcript.segments.length, 2); assert.equal(transcript.segments[1]!.startMs, 6000);
});
test('上传伪视频与超限文件不创建任务且不遗留媒体事实', async () => {
  const fake = path.join(config.dataDir, 'temp', 'fake.mp4'); await writeFile(fake, 'not a video');
  const rejected = await upload(fake); assert.equal(rejected.statusCode, 400);
  const file = await sampleVideo();
  const oversized = await upload(file, { ...config, uploadMaxBytes: 100 });
  assert.equal(oversized.statusCode, 413);
  assert.equal(await db.video.count(), 0); assert.equal(await db.artifact.count(), 0);
});
test('媒体产物缺失时在调用模型前明确失败', async () => {
  const response = await upload(await sampleVideo());
  const record = (await db.artifact.findFirst())!;
  await unlink(resolveStorageKey(config.dataDir, record.storageKey));
  await new Worker(new Tasks(db), mediaHandler(db, config)).tick();
  assert.equal((await new Tasks(db).detail(response.json().id)).latestErrorCode, 'ARTIFACT_MISSING');
  assert.equal(speechCalls, 0);
});
test('模型错误分类不暴露原始响应，结构化结果只允许一次修复', async () => {
  httpStatus = 401;
  await assert.rejects(modelRequest('S2T', config.s2t.url, '{}', config, new AbortController().signal), { code: 'S2T_AUTH_FAILED' });
  httpStatus = 429;
  await assert.rejects(modelRequest('LLM', config.llm.url, '{}', config, new AbortController().signal), { code: 'LLM_RATE_LIMITED', retryable: true });
  httpStatus = 200; repairFailure = true;
  await assert.rejects(summarizeText({ text: '材料', prompt: '输出 JSON', title: '标题', source: 'LOCAL', creator: '未知', durationMs: 1000, language: '中文', cached: (_key, execute) => execute() }, config, new AbortController().signal), { code: 'LLM_RESPONSE_INVALID' });
  assert.equal(llmCalls, 2);
});
test('长文稿按令牌切片保持原文，Map-Reduce 生成有效结构', async () => {
  const text = '这是用于验证长内容的具体事实与步骤。'.repeat(400);
  const chunks = splitText(text, 100);
  assert.equal(chunks.join(''), text); assert.ok(chunks.every(chunk => tokenCount(chunk) <= 100));
  assert.equal(splitText('\n。！？\n' + text, 100).join(''), '\n。！？\n' + text);
  const result = await summarizeText({ text, prompt: '只依据材料总结并输出 JSON', title: '长视频', source: 'LOCAL', creator: '未知', durationMs: 8000, language: '中文', cached: (_key, execute) => execute() },
    { ...config, summaryInputTokens: 4096 }, new AbortController().signal);
  assert.ok(result.chunkCount > 1); assert.ok(summarySchema.safeParse(result.content).success); assert.ok(llmCalls > 2);
});

test('强制转写绕过旧检查点，幂等重放不重复入队，失败取消保留历史', async () => {
  const id = (await upload(await sampleVideo())).json().id;
  const tasks = new Tasks(db); const library = new MediaLibrary(db);
  const worker = new Worker(tasks, mediaHandler(db, config));
  for (let i = 0; i < 3; i++) await worker.tick();
  const input = { stage: 'TRANSCRIBE' as const, force: true as const, reason: '验收强制转写' };
  const key = randomUUID();
  await library.reprocess(id, input, key);
  await library.reprocess(id, input, key);
  assert.equal(await db.job.count({ where: { status: 'QUEUED' } }), 1);
  await assert.rejects(library.reprocess(id, { ...input, reason: '不同请求' }, key), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(library.reprocess(id, input, randomUUID()), { code: 'TASK_ACTIVE' });
  assert.equal(await db.transcript.count({ where: { isCurrent: true } }), 0);
  assert.equal(await db.summary.count({ where: { isCurrent: true } }), 0);
  assert.equal(await db.artifact.count({ where: { isCurrent: true } }), 2);
  httpStatus = 401; await worker.tick();
  assert.equal((await tasks.detail(id)).overallStatus, 'FAILED');
  const app = createApp(db, config);
  try {
    assert.equal((await app.inject({ url: '/api/v1/videos/' + id + '/transcript' })).json().current, null);
    assert.ok((await app.inject({ url: '/api/v1/videos/' + id + '/transcript?revision=1' })).json().current.fullText);
    assert.ok((await app.inject({ url: '/api/v1/videos/' + id + '/summary?revision=1' })).json().current.renderedText);
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/videos/' + id + '/actions/reprocess', headers: { 'idempotency-key': randomUUID() }, payload: { stage: 'TRANSCRIBE', force: false, reason: 'test' } });
    assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); }
  httpStatus = 200; await tasks.retry(id, randomUUID());
  await worker.tick(); await worker.tick();
  assert.equal(speechCalls, 2); assert.equal(llmCalls, 2);
  assert.equal(await db.transcript.count(), 2); assert.equal(await db.summary.count(), 2);
  await library.reprocess(id, input, randomUUID()); await tasks.cancel(id);
  assert.equal(await db.transcript.count(), 2); assert.equal(await db.summary.count(), 2);
  assert.equal(await db.transcript.count({ where: { isCurrent: true } }), 0);
  const audit = await db.event.findMany({ where: { videoId: id } });
  assert.ok(audit.some(event => event.payload.includes(input.reason) && event.payload.includes('"force":true')));
});

test('重新提取保留原音频并生成新版本；重新下载失效所有下游产物', async () => {
  const id = (await upload(await sampleVideo())).json().id;
  const tasks = new Tasks(db); const library = new MediaLibrary(db);
  const worker = new Worker(tasks, mediaHandler(db, config));
  for (let i = 0; i < 3; i++) await worker.tick();
  const oldAudio = (await db.artifact.findFirst({ where: { kind: 'AUDIO' } }))!;
  await assert.rejects(library.reprocess(id, { stage: 'FETCH', force: true, reason: '本地下载不支持' }, randomUUID()), { code: 'INVALID_TRANSITION' });
  await library.reprocess(id, { stage: 'EXTRACT_AUDIO', force: true, reason: '重新提取验收' }, randomUUID());
  assert.equal(await db.artifact.count({ where: { kind: 'AUDIO', isCurrent: true } }), 0);
  for (let i = 0; i < 3; i++) await worker.tick();
  assert.equal(speechCalls, 2);
  assert.equal(await db.artifact.count({ where: { kind: 'AUDIO' } }), 2);
  assert.equal((await db.artifact.findUniqueOrThrow({ where: { id: oldAudio.id } })).isCurrent, false);
  assert.ok((await readFile(resolveStorageKey(config.dataDir, oldAudio.storageKey))).length);
  // Reuse fixture media to verify FETCH's full invalidation and downstream enqueue without external calls.
  await db.video.update({ where: { id }, data: { sourceType: 'BILIBILI', bvid: 'BV17xo9BsEnx', originalUrl: 'https://www.bilibili.com/video/BV17xo9BsEnx/' } });
  await library.reprocess(id, { stage: 'FETCH', force: true, reason: '重新下载验收' }, randomUUID());
  assert.equal(await db.artifact.count({ where: { isCurrent: true } }), 0);
  assert.equal(await db.transcript.count({ where: { isCurrent: true } }), 0);
  assert.equal(await db.summary.count({ where: { isCurrent: true } }), 0);
  const claimed = (await tasks.claim('download-test'))!;
  assert.equal(claimed.stage, 'FETCH'); assert.equal(await tasks.cached(claimed), null);
  const source = (await db.artifact.findFirst({ where: { kind: 'SOURCE_VIDEO' } }))!;
  await tasks.finish(claimed.id, 'download-test', { simulated: false, text: '测试下载完成', artifact: { kind: 'SOURCE_VIDEO', storageKey: source.storageKey, sizeBytes: Number(source.sizeBytes), sha256: source.sha256, mimeType: source.mimeType } });
  for (let i = 0; i < 3; i++) await worker.tick();
  assert.equal((await tasks.detail(id)).overallStatus, 'COMPLETED');
  assert.equal(await db.artifact.count({ where: { isCurrent: true } }), 2);
  assert.equal(await db.transcript.count(), 3); assert.equal(await db.summary.count(), 3);
});
