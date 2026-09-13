import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, utimes, lstat, symlink, copyFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, type AppConfig } from '../packages/config/src/index.js';
import { createDatabase, initializeDatabase, type Database } from '../packages/database/src/client.js';
import { applyTestMigrations } from './helpers.js';
import { Operations } from '../packages/database/src/operations.js';
import { Tasks, LEASE_MS } from '../packages/database/src/tasks.js';
import { MediaLibrary, persistMedia } from '../packages/database/src/media.js';
import { OperationWorker } from '../apps/worker/src/operations.js';
import { fetchCreatorVideos, normalizeCreator, type CreatorVideos } from '../packages/integrations/src/creators.js';
import { initializeStorage, resolveStorageKey } from '../packages/storage/src/index.js';
import { describeFile } from '../packages/storage/src/media.js';
import { backupWorkspace, cleanupWorkspace, checkedFile } from '../packages/storage/src/maintenance.js';
import { createLogger, redactLog } from '../packages/storage/src/logging.js';
import { createApp } from '../apps/api/src/app.js';
import { restoreBackup } from '../scripts/restore.js';
let db: Database; let config: AppConfig; let operations: Operations;
const found: CreatorVideos = { name: '测试 UP', videos: [{ bvid: 'BV17xo9BsEnx', title: '测试投稿', url: 'https://www.bilibili.com/video/BV17xo9BsEnx/' }] };
beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'videoassist-ops-'));
  config = loadConfig({ DATA_DIR: root, DATABASE_URL: 'file:' + path.join(root, 'db/test.sqlite').replaceAll('\\', '/') });
  await initializeStorage(root); db = createDatabase(config.databaseUrl); await applyTestMigrations(db); await initializeDatabase(db); operations = new Operations(db);
});
afterEach(async () => { await db.$disconnect(); });
const add = (autoProcess = false) => operations.addCreator({ source: '12345', latestLimit: 5, autoProcess }, randomUUID());
const signal = () => new AbortController().signal;
async function oldFile(key: string, text = 'fixture') {
  const file = resolveStorageKey(config.dataDir, key); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text);
  const old = new Date(Date.now() - 20 * 86400000); await utimes(file, old, old); return file;
}
test('UP 主仅接受 UID 或受支持主页，拒绝凭据和伪造域名', () => {
  assert.equal(normalizeCreator('https://space.bilibili.com/12345?from=test').uid, '12345');
  assert.equal(normalizeCreator('12345').url, 'https://space.bilibili.com/12345/upload/video');
  for (const input of ['0', 'https://space.bilibili.com.evil/12345', 'http://space.bilibili.com/12345', 'https://user@space.bilibili.com/12345', 'https://space.bilibili.com/12345/favlist']) assert.throws(() => normalizeCreator(input));
});
test('精简投稿列表补齐标题昵称，数量受限且伪造视频链接不进入元数据请求', async () => {
  let calls = 0;
  const providers = {
    runTool: async () => JSON.stringify({ entries: [{ id: 'BV17xo9BsEnx' }, { id: 'BV1JttL67Ek6' }] }),
    bilibiliMetadata: async () => { calls++; return { title: '补齐标题', creatorName: '补齐昵称', durationMs: 1000 }; },
  };
  const result = await fetchCreatorVideos('12345', 1, config, signal(), providers);
  assert.equal(result.name, '补齐昵称'); assert.equal(result.videos[0]!.title, '补齐标题'); assert.equal(calls, 1);
  await assert.rejects(fetchCreatorVideos('12345', 1, config, signal(), { ...providers, runTool: async () => JSON.stringify({ entries: [{ url: 'https://private.invalid/video' }] }) }), { code: 'UNSUPPORTED_BILIBILI_URL' });
  assert.equal(calls, 1);
});
test('检查幂等去重、只发现不处理与手动启动，列表和导出复用 UP 主条件', async () => {
  const creator = await add();
  const queued = await Promise.all([operations.enqueue('CREATOR_CHECK', randomUUID(), creator.id), operations.enqueue('CREATOR_CHECK', randomUUID(), creator.id)]);
  assert.equal(queued[0]!.id, queued[1]!.id);
  const worker = new OperationWorker(db, config, async () => found);
  await worker.tick();
  const video = (await db.video.findFirst())!; assert.equal(video.overallStatus, 'DISCOVERED'); assert.equal(video.creatorId, creator.id); assert.equal(await db.job.count(), 0);
  await operations.enqueue('CREATOR_CHECK', randomUUID(), creator.id); await worker.tick();
  assert.equal(await db.video.count(), 1);
  const history = await db.operation.findMany({ orderBy: { createdAt: 'desc' } }); assert.equal(JSON.parse(history[0]!.resultJson!).added, 0);
  const app = createApp(db, config);
  try {
    const listed = (await app.inject({ url: '/api/v1/videos?creatorId=' + creator.id })).json(); assert.equal(listed.total, 1);
    assert.equal((await app.inject({ url: '/api/v1/videos?creatorId=' + randomUUID() })).json().total, 0);
    const key = randomUUID();
    for (let i = 0; i < 2; i++) assert.equal((await app.inject({ method: 'POST', url: '/api/v1/videos/' + video.id + '/actions/start', headers: { 'idempotency-key': key }, payload: {} })).statusCode, 200);
    assert.equal(await db.job.count(), 1); assert.equal((await db.video.findUniqueOrThrow({ where: { id: video.id } })).overallStatus, 'WAITING');
  } finally { await app.close(); }
});
test('自动处理进入流水线，停止追踪保留视频且取消检查；再次添加恢复追踪', async () => {
  const creator = await add(true); const worker = new OperationWorker(db, config, async () => found);
  await operations.enqueue('CREATOR_CHECK', randomUUID(), creator.id); await worker.tick(); assert.equal(await db.job.count(), 1);
  await operations.enqueue('CREATOR_CHECK', randomUUID(), creator.id);
  await operations.editCreator(creator.id, {}, true);
  assert.equal(await db.video.count(), 1); assert.equal(await db.operation.count({ where: { status: 'CANCELED' } }), 1);
  await assert.rejects(operations.enqueue('CREATOR_CHECK', randomUUID(), creator.id), { code: 'CREATOR_NOT_FOUND' });
  assert.equal((await add()).id, creator.id);
});
test('后台租约和视频任务互斥，过期恢复拒绝旧进程提交，停止后禁止导入', async () => {
  const creator = await add(); const job = await operations.enqueue('CREATOR_CHECK', randomUUID(), creator.id);
  const time = new Date(); await operations.claim('old-owner', time);
  await new Tasks(db).createSimulation({ title: '互斥', retryableFailure: false }, 'sim');
  assert.equal(await new Tasks(db).claim('media-owner', time), null);
  const next = new Date(time.getTime() + LEASE_MS + 1);
  assert.equal((await operations.claim('new-owner', next))!.attempt, 2);
  assert.equal(await operations.finish(job.id, 'old-owner', found, undefined, next), false);
  await operations.editCreator(creator.id, { enabled: false });
  assert.equal(await operations.finish(job.id, 'new-owner', found, undefined, next), true);
  assert.equal(await db.video.count({ where: { sourceType: 'BILIBILI' } }), 0);
  assert.equal((await db.operation.findUniqueOrThrow({ where: { id: job.id } })).status, 'CANCELED');
});
test('检查失败明确记录，重新检查可成功，不生成空壳视频', async () => {
  const creator = await add(); const job = await operations.enqueue('CREATOR_CHECK', randomUUID(), creator.id);
  await new OperationWorker(db, config, async () => { throw Error('private-cookie-value'); }).tick();
  const failed = await db.operation.findUniqueOrThrow({ where: { id: job.id } }); assert.equal(failed.status, 'FAILED'); assert.ok(!failed.errorMessage?.includes('private-cookie'));
  assert.equal(await db.video.count(), 0);
  await operations.enqueue('CREATOR_CHECK', randomUUID(), creator.id); await new OperationWorker(db, config, async () => found).tick();
  assert.equal((await db.creator.findUniqueOrThrow({ where: { id: creator.id } })).latestError, null);
});
test('在线备份可读取恢复，媒体哈希与快照一致，重试复用完成备份', async () => {
  const video = await db.video.create({ data: { title: '备份恢复', sourceType: 'LOCAL', overallStatus: 'COMPLETED' } });
  const key = 'videos/' + video.id + '/source/original.mp4'; await oldFile(key);
  await db.$transaction(tx => persistMedia(tx, video.id, { artifact: undefined, transcript: { fullText: '备份文稿', language: 'zh', provider: 'test', model: 'test', durationMs: 1, timestampPrecision: 'CHUNK', segments: [] } }));
  const artifact = await describeFile(config.dataDir, key, 'SOURCE_VIDEO', 'video/mp4'); await db.$transaction(tx => persistMedia(tx, video.id, { artifact }));
  const id = (await operations.enqueue('BACKUP', randomUUID())).id; await operations.claim('backup-owner');
  const result = await backupWorkspace(db, config, id, signal());
  assert.equal(result.files, 1); assert.equal(result.videos, 1);
  const directory = resolveStorageKey(config.dataDir, result.storageKey);
  const restoredRoot = path.join(config.dataDir, 'restored'); await restoreBackup(directory, restoredRoot);
  await assert.rejects(restoreBackup(directory, restoredRoot), { code: 'RESTORE_TARGET_NOT_EMPTY' });
  const restored = path.join(restoredRoot, 'db/videoassist.sqlite');
  const restoreDb = createDatabase('file:' + restored.replaceAll('\\', '/'));
  try { await initializeDatabase(restoreDb); assert.equal((await restoreDb.transcript.findFirst())!.fullText, '备份文稿'); assert.equal(await restoreDb.artifact.count(), 1); assert.equal((await restoreDb.operation.findUniqueOrThrow({ where: { id } })).status, 'CANCELED'); } finally { await restoreDb.$disconnect(); }
  assert.equal((await db.operation.findUniqueOrThrow({ where: { id } })).status, 'RUNNING');
  assert.equal((await describeFile(directory, key, 'SOURCE_VIDEO', 'video/mp4')).sha256, artifact.sha256);
  const duplicate = await backupWorkspace(db, config, id, signal()); assert.equal(duplicate.createdAt, result.createdAt);
  assert.ok(!(await readFile(path.join(directory, 'runtime-config.json'), 'utf8')).includes('S2T_API_KEY":'));
  const snapshot = new DatabaseSync(path.join(directory, 'db/videoassist.sqlite'), { readOnly: true }); assert.equal(snapshot.prepare('PRAGMA quick_check').get()!.quick_check, 'ok'); snapshot.close();
});
test('备份缺失媒体明确失败，不发布不完整的备份目录', async () => {
  const video = await db.video.create({ data: { title: '缺失媒体' } });
  await db.artifact.create({ data: { videoId: video.id, storageKey: 'videos/' + video.id + '/missing.mp4', sha256: 'missing', sizeBytes: 1, kind: 'SOURCE_VIDEO', mimeType: 'video/mp4' } });
  const id = randomUUID(); await assert.rejects(backupWorkspace(db, config, id, signal()), { code: 'BACKUP_MEDIA_MISSING' });
  assert.equal(await lstat(resolveStorageKey(config.dataDir, 'backups/' + id)).catch(() => null), null);
});
test('清理保护活跃分片、媒体引用、符号链接和原始文件，仅清理过期临时文件和日志', async () => {
  await oldFile('temp/stale.upload'); await writeFile(resolveStorageKey(config.dataDir, 'temp/fresh.upload'), 'fresh');
  const protectedFile = await oldFile('temp/protected.flac');
  const active = await db.video.create({ data: { title: '活跃任务' } }); const inactive = await db.video.create({ data: { title: '历史视频' } });
  await db.job.create({ data: { videoId: active.id, stage: 'TRANSCRIBE', inputFingerprint: 'active' } });
  await db.artifact.create({ data: { videoId: active.id, storageKey: 'temp/protected.flac', sha256: 'protected', sizeBytes: 7, kind: 'AUDIO', mimeType: 'audio/flac' } });
  const activeChunk = await oldFile('videos/' + active.id + '/chunks/part.flac');
  await oldFile('videos/' + inactive.id + '/chunks/part.flac');
  const original = await oldFile('videos/' + inactive.id + '/source/orphan.mp4');
  await oldFile('logs/api-2000-01-01-0.jsonl'); const unknown = await oldFile('logs/personal-notes.txt');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'videoassist-outside-')); await writeFile(path.join(outside, 'keep.txt'), 'safe');
  await symlink(outside, resolveStorageKey(config.dataDir, 'temp/external'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await cleanupWorkspace(db, config, signal());
  assert.equal(result.removed, 3); assert.equal(result.orphans, 1);
  for (const file of [protectedFile, activeChunk, original, unknown, path.join(outside, 'keep.txt')]) assert.ok(await lstat(file));
  await assert.rejects(checkedFile(config.dataDir, 'temp/external/keep.txt'), { code: 'INVALID_STORAGE_KEY' });
});
test('结构化日志脱敏并按容量轮转，API 不记录查询和请求正文', async () => {
  const log = createLogger(config.dataDir, 'api', 160);
  for (let i = 0; i < 5; i++) await log({ event: 'test', message: 'Bearer secret-value https://user:password@example.test/path?token=hidden', apiKey: 'never-log', detail: { secret: 'never-log' } });
  const files = await readdir(path.join(config.dataDir, 'logs')); assert.ok(files.length > 1);
  const all = (await Promise.all(files.map(file => readFile(path.join(config.dataDir, 'logs', file), 'utf8')))).join('');
  assert.ok(!all.includes('secret-value')); assert.ok(!all.includes('password')); assert.ok(!all.includes('hidden')); assert.ok(!all.includes('never-log'));
  assert.ok(!redactLog('Cookie: SESSDATA=a; bili_jct=b').includes('bili_jct'));
  const app = createApp(db, config);
  try { await app.inject({ url: '/api/v1/videos?q=private-query' }); } finally { await app.close(); }
  const after = (await Promise.all((await readdir(path.join(config.dataDir, 'logs'))).map(file => readFile(path.join(config.dataDir, 'logs', file), 'utf8')))).join('');
  assert.ok(!after.includes('private-query'));
});
