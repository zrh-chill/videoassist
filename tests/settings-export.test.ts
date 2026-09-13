import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { loadConfig, type AppConfig } from '../packages/config/src/index.js';
import { createDatabase, initializeDatabase, type Database } from '../packages/database/src/client.js';
import { initializeStorage } from '../packages/storage/src/index.js';
import { applyTestMigrations } from './helpers.js';
import { Settings } from '../packages/database/src/settings.js';
import { persistMedia, MediaLibrary } from '../packages/database/src/media.js';
import { Tasks } from '../packages/database/src/tasks.js';
import { Worker } from '../apps/worker/src/runner.js';
import { mediaHandler } from '../apps/worker/src/media-handler.js';
import { createApp } from '../apps/api/src/app.js';
import { excelText } from '../apps/api/src/export-routes.js';

let db: Database; let config: AppConfig; let server: Server; let status = 200; let received = '';
const content = { one_sentence: '一句话总结', key_points: ['要点'], detailed_summary: '详细总结', keywords: ['测试'] };
beforeEach(async () => {
  status = 200; received = ''; process.env.SETTINGS_TEST_KEY = 'settings-test-secret';
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const part of request) chunks.push(part);
    received = Buffer.concat(chunks).toString();
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status !== 200 ? { error: 'settings-test-secret' } : request.url?.endsWith('/audio/transcriptions') ? { text: 'Hello connection test' } : { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'videoassist-settings-'));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
  config = { ...loadConfig({ DATA_DIR: root, DATABASE_URL: 'file:' + path.join(root, 'db/test.sqlite').replaceAll('\\', '/'),
    S2T_BASE_URL: url, LLM_BASE_URL: url, S2T_MODEL: 'mock-s2t', LLM_MODEL: 'mock-llm',
    S2T_API_KEY_REF: 'env:SETTINGS_TEST_KEY', LLM_API_KEY_REF: 'env:SETTINGS_TEST_KEY' }), lockedSettings: [] };
  await initializeStorage(root); db = createDatabase(config.databaseUrl);
  await applyTestMigrations(db); await initializeDatabase(db);
});
afterEach(async () => {
  await db.$disconnect(); await new Promise<void>(resolve => server.close(() => resolve())); delete process.env.SETTINGS_TEST_KEY;
});
async function fixture(title = '导出测试', long = true) {
  const video = await db.video.create({ data: { title, sourceType: 'LOCAL', overallStatus: 'COMPLETED', currentStage: 'SUMMARIZE' } });
  await db.$transaction(tx => persistMedia(tx, video.id, { transcript: {
    fullText: long ? '=危险公式\n' + '中'.repeat(32765) + '😀' : '先准备音频，再转写和总结。', language: 'zh', model: 'mock', provider: 'test', durationMs: 1, timestampPrecision: 'CHUNK', segments: [],
  } }));
  const transcript = (await db.transcript.findFirst({ where: { videoId: video.id } }))!;
  const prompt = await new Settings(db, config).activePrompt();
  await db.$transaction(tx => persistMedia(tx, video.id, { summary: { transcriptId: transcript.id, promptVersionId: prompt.id, provider: 'test', model: 'mock', durationMs: 1, chunkCount: 1,
    content: { ...content, detailed_summary: '+危险总结' + '字'.repeat(33000) } } }));
  return video;
}
test('设置持久化、环境优先、乐观锁和敏感引用不回显', async () => {
  config.lockedSettings = ['LLM_MODEL'];
  const settings = new Settings(db, config);
  const app = createApp(db, config);
  try {
    const put = (revision: number, values: unknown) => app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { revision, values } });
    assert.equal((await put(0, { LLM_MODEL: 'override' })).statusCode, 409);
    assert.equal((await put(0, { AUDIO_CHUNK_MINUTES: 4, LLM_API_KEY_REF: 'env:SETTINGS_TEST_KEY' })).statusCode, 200);
    assert.equal((await put(0, { AUDIO_CHUNK_MINUTES: 5 })).statusCode, 409);
    assert.equal((await put(1, { LLM_API_KEY: 'raw-secret' })).statusCode, 400);
    assert.equal((await put(1, { LLM_API_KEY_REF: 'raw-secret' })).statusCode, 400);
    assert.equal((await put(1, { LLM_BASE_URL: 'https://user:secret@example.test/?key=secret' })).statusCode, 400);
    await db.$disconnect();
    assert.equal((await settings.effective()).audioChunkSeconds, 240);
    assert.equal((await settings.effective()).llm.model, config.llm.model);
    const response = await app.inject({ url: '/api/v1/settings' });
    assert.ok(!response.body.includes('settings-test-secret')); assert.ok(!response.body.includes('SETTINGS_TEST_KEY'));
    const fields = response.json().fields;
    assert.equal(fields.find((f: { key: string }) => f.key === 'LLM_API_KEY_REF').configured, true);
    assert.equal(fields.find((f: { key: string }) => f.key === 'LLM_MODEL').source, 'environment');
  } finally { await app.close(); }
});
test('四类连接测试保存结果，失败脱敏且配置修改后标记过期', async () => {
  const app = createApp(db, config);
  try {
    for (const kind of ['ffmpeg', 'ytdlp', 's2t', 'llm']) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/settings/actions/test-' + kind, payload: {} });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().ok, true, response.body);
    }
    status = 401;
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/settings/actions/test-llm', payload: {} });
    assert.equal(rejected.json().ok, false); assert.ok(rejected.json().message.includes('LLM_AUTH_FAILED')); assert.ok(!rejected.body.includes('settings-test-secret'));
    await new Settings(db, config).save({ AUDIO_CHUNK_MINUTES: 3 }, 0);
    const result = (await app.inject({ url: '/api/v1/settings' })).json();
    assert.equal(result.tests.llm.stale, true); assert.equal(result.tests.s2t.ok, true);
  } finally { await app.close(); }
});
test('提示词并发版本唯一、幂等重放不重新启用，Worker 使用选定正文并保留旧总结', async () => {
  const video = await fixture('提示词验收', false); const settings = new Settings(db, config);
  const old = (await db.summary.findFirst())!;
  const versions = await Promise.all([
    settings.createPrompt({ name: '新版本 A', body: '特别要求 A：保留数字，输出 JSON' }, 'prompt-a'),
    settings.createPrompt({ name: '新版本 B', body: '特别要求 B：忠实内容，输出 JSON' }, 'prompt-b'),
  ]);
  assert.notEqual(versions[0]!.revision, versions[1]!.revision);
  const selected = await settings.createPrompt({ name: '当前版本', body: '特别要求 C：准确总结，输出 JSON' }, 'prompt-c');
  await settings.createPrompt({ name: '新版本 A', body: '特别要求 A：保留数字，输出 JSON' }, 'prompt-a');
  assert.equal((await settings.activePrompt()).id, selected.id);
  await assert.rejects(settings.createPrompt({ name: '冲突', body: '不同正文' }, 'prompt-a'), { code: 'IDEMPOTENCY_CONFLICT' });
  await new MediaLibrary(db).regenerateSummary(video.id, randomUUID());
  await new Worker(new Tasks(db), mediaHandler(db, await settings.effective())).tick();
  assert.ok(received.includes('特别要求 C'));
  const current = (await db.summary.findFirst({ where: { isCurrent: true } }))!;
  assert.equal(current.promptVersionId, selected.id); assert.notEqual(current.id, old.id);
  assert.equal((await db.summary.findUniqueOrThrow({ where: { id: old.id } })).promptVersionId, old.promptVersionId);
  const app = createApp(db, config);
  try {
    const result = await app.inject({ method: 'POST', url: '/api/v1/prompt-versions', headers: { 'idempotency-key': 'large-prompt' }, payload: { name: '长提示词', body: '中'.repeat(20000) } });
    assert.equal(result.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/v1/prompt-versions' })).json().filter((p: { active: boolean }) => p.active).length, 1);
  } finally { await app.close(); }
});
test('Excel 导出全部筛选结果、当前版本与记录，截断长文本并阻止公式注入', async () => {
  const first = await fixture('=导出测试');
  for (let i = 0; i < 28; i++) await db.video.create({ data: { title: '导出测试' + i, sourceType: 'LOCAL', overallStatus: 'COMPLETED' } });
  await db.video.create({ data: { title: '导出测试排除', sourceType: 'BILIBILI', overallStatus: 'FAILED' } });
  const job = await db.job.create({ data: { videoId: first.id, stage: 'SUMMARIZE', status: 'SUCCEEDED', inputFingerprint: 'test' } });
  await db.stageRun.create({ data: { videoId: first.id, jobId: job.id, stage: 'SUMMARIZE', attempt: 1, status: 'SUCCEEDED', errorMessage: '@危险错误文本' } });
  const app = createApp(db, config);
  try {
    const query = 'q=' + encodeURIComponent('导出测试') + '&sourceType=LOCAL&status=COMPLETED';
    const list = (await app.inject({ url: '/api/v1/videos?' + query + '&limit=1' })).json();
    const response = await app.inject({ url: '/api/v1/exports/videos.xlsx?' + query + '&limit=1&cursor=' + list.items[0].id + '&history=true' });
    assert.equal(response.statusCode, 200); assert.ok(response.headers['content-type']?.includes('spreadsheetml'));
    const book = new ExcelJS.Workbook(); await book.xlsx.load(response.rawPayload as never);
    const sheet = book.getWorksheet('视频')!; assert.equal(sheet.rowCount, list.total + 1);
    let target: ExcelJS.Row | undefined; sheet.eachRow(row => { if (row.getCell(1).value === first.id) target = row; });
    assert.ok(target); assert.equal(target.getCell(2).value, "'=导出测试");
    assert.equal(target.getCell(14).value, '是'); assert.equal(target.getCell(20).value, '是');
    assert.equal(typeof target.getCell(13).value, 'string'); assert.ok(String(target.getCell(13).value).length <= 32767);
    assert.equal(book.getWorksheet('处理记录')!.getRow(2).getCell(9).value, "'@危险错误文本");
    await db.transcript.updateMany({ data: { isCurrent: false } }); await db.summary.updateMany({ data: { isCurrent: false } });
    const empty = await app.inject({ url: '/api/v1/exports/videos.xlsx?q=' + encodeURIComponent('=导出测试') });
    const historical = new ExcelJS.Workbook(); await historical.xlsx.load(empty.rawPayload as never);
    assert.equal(historical.getWorksheet('视频')!.getRow(2).getCell(13).value, '');
    assert.equal(historical.worksheets.length, 1);
  } finally { await app.close(); }
});
test('Excel 边界不会切断代理对，处理控制字符与空筛选结果', async () => {
  const value = excelText('中'.repeat(32766) + '😀');
  assert.equal(value.truncated, true); assert.equal(value.value.length, 32766);
  assert.equal(excelText('\t=1+1').value, "'\t=1+1");
  assert.equal(excelText('a\x00b').value, 'ab');
  const app = createApp(db, config);
  try {
    const response = await app.inject({ url: '/api/v1/exports/videos.xlsx?q=missing' });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(response.rawPayload as never);
    assert.equal(book.getWorksheet('视频')!.rowCount, 1);
  } finally { await app.close(); }
});
