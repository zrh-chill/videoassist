import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDatabase, initializeDatabase, type Database } from '../packages/database/src/client.js';
import { Tasks, LEASE_MS } from '../packages/database/src/tasks.js';
import { DomainError, fingerprint, nextStage, publicError, retryDelay } from '../packages/domain/src/index.js';
import { loadConfig, projectRoot } from '../packages/config/src/index.js';
import { initializeStorage, resolveStorageKey } from '../packages/storage/src/index.js';
import { createApp } from '../apps/api/src/app.js';
import { Worker } from '../apps/worker/src/runner.js';
import { simulationHandler } from '../packages/integrations/src/simulation.js';

let db: Database;
let tasks: Tasks;
let root: string;
let url: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'videoassist-test-'));
  url = 'file:' + path.join(root, 'db', 'test.sqlite').replaceAll('\\', '/');
  await initializeStorage(root);
  db = createDatabase(url);
  const migration = await readFile(path.join(projectRoot, 'packages/database/prisma/migrations/202609130001_initial/migration.sql'), 'utf8');
  for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  await initializeDatabase(db);
  tasks = new Tasks(db);
});
afterEach(async () => { await db.$disconnect(); });
const create = (extra = {}) => tasks.createSimulation({ title: '测试视频', retryableFailure: false, ...extra }, randomUUID());
const success = { simulated: true, text: '模拟处理成功' };

test('状态链路、稳定指纹、退避和内部异常脱敏', () => {
  assert.equal(nextStage('FETCH'), 'EXTRACT_AUDIO');
  assert.equal(nextStage('SUMMARIZE'), null);
  assert.equal(fingerprint({ b: 1, a: { d: 2, c: 3 } }), fingerprint({ a: { c: 3, d: 2 }, b: 1 }));
  assert.deepEqual([1, 2, 3].map(retryDelay), [60_000, 300_000, 1_200_000]);
  assert.equal(publicError(new Error('Authorization: secret')).message.includes('secret'), false);
  assert.throws(() => resolveStorageKey(root, '../secret'), DomainError);
  assert.throws(() => resolveStorageKey(root, 'C:/secret'), DomainError);
  assert.equal(resolveStorageKey(root, 'videos/test.flac'), path.join(root, 'videos', 'test.flac'));
});

test('相同请求键幂等创建，冲突内容被拒绝', async () => {
  const input = { title: '并发请求', retryableFailure: false };
  const key = randomUUID();
  const ids = await Promise.all([tasks.createSimulation(input, key), tasks.createSimulation(input, key)]);
  assert.equal(ids[0]!.id, ids[1]!.id);
  assert.equal(await db.video.count(), 1);
  assert.equal(await db.job.count(), 1);
  await assert.rejects(tasks.createSimulation({ ...input, title: '不同请求' }, key), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('模拟处理器跑通四个阶段，数据库重连后结果与事件仍存在', async () => {
  const video = await create();
  const worker = new Worker(tasks, simulationHandler(0));
  for (let i = 0; i < 4; i++) assert.equal(await worker.tick(), true);
  assert.equal(await worker.tick(), false);
  assert.equal((await tasks.detail(video.id)).overallStatus, 'COMPLETED');
  assert.equal(await db.stageResult.count(), 4);
  assert.equal(await db.stageRun.count({ where: { status: 'SUCCEEDED' } }), 4);
  await db.$disconnect();
  db = createDatabase(url);
  await initializeDatabase(db);
  tasks = new Tasks(db);
  assert.equal((await tasks.detail(video.id)).overallStatus, 'COMPLETED');
  assert.ok(await db.event.count() >= 9);
});

test('全局租约阻止两个 Worker 同时执行不同任务', async () => {
  await create(); await create();
  const anotherDb = createDatabase(url);
  await initializeDatabase(anotherDb);
  try {
    const claims = await Promise.all([tasks.claim('worker-1'), new Tasks(anotherDb).claim('worker-2')]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await db.job.count({ where: { status: 'RUNNING' } }), 1);
  } finally { await anotherDb.$disconnect(); }
});

test('过期租约恢复，中断历史保留，旧 Worker 提交被拒绝', async () => {
  const video = await create();
  const now = new Date();
  const first = (await tasks.claim('old', now))!;
  const later = new Date(now.getTime() + LEASE_MS + 1);
  const recovered = (await tasks.claim('new', later))!;
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.attempt, 2);
  assert.equal(await tasks.finish(first.id, 'old', success, later), false);
  assert.equal(await tasks.finish(first.id, 'new', success, later), true);
  assert.equal(await db.stageRun.count({ where: { status: 'INTERRUPTED' } }), 1);
  assert.equal((await tasks.detail(video.id)).currentStage, 'EXTRACT_AUDIO');
});

test('续租延长独占，过期进程不能续租', async () => {
  await create();
  const now = new Date();
  const job = (await tasks.claim('worker', now))!;
  const renewal = new Date(now.getTime() + 90_000);
  assert.equal(await tasks.renew(job.id, 'worker', renewal), true);
  assert.equal(await tasks.claim('other', new Date(now.getTime() + LEASE_MS + 1)), null);
  assert.equal(await tasks.renew(job.id, 'worker', new Date(now.getTime() + LEASE_MS * 3)), false);
});

test('排队取消与运行中取消不提交结果、不创建下游', async () => {
  const queued = await create();
  await tasks.cancel(queued.id);
  assert.equal((await tasks.detail(queued.id)).overallStatus, 'CANCELED');
  const running = await create();
  const job = (await tasks.claim('worker'))!;
  await tasks.cancel(running.id);
  assert.equal(await tasks.renew(job.id, 'worker'), false);
  assert.equal(await tasks.finish(job.id, 'worker', success), true);
  assert.equal((await tasks.detail(running.id)).overallStatus, 'CANCELED');
  assert.equal(await db.stageResult.count(), 0);
  assert.equal(await db.job.count(), 2);
});

test('Worker 通过 AbortSignal 终止正在运行的处理器', async () => {
  const video = await create();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const worker = new Worker(tasks, { execute: async (_input, signal) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } }, 10);
  const tick = worker.tick();
  await ready;
  await tasks.cancel(video.id);
  await tick;
  assert.equal((await tasks.detail(video.id)).overallStatus, 'CANCELED');
});

test('转写失败手动重试只执行失败阶段，保留上游事实和历史', async () => {
  const video = await create({ failStage: 'TRANSCRIBE' });
  const worker = new Worker(tasks, simulationHandler(0));
  for (let i = 0; i < 3; i++) await worker.tick();
  assert.equal((await tasks.detail(video.id)).overallStatus, 'FAILED');
  const key = randomUUID();
  await tasks.retry(video.id, key); await tasks.retry(video.id, key);
  await worker.tick(); await worker.tick();
  assert.equal((await tasks.detail(video.id)).overallStatus, 'COMPLETED');
  assert.equal(await db.stageRun.count({ where: { stage: 'FETCH' } }), 1);
  assert.equal(await db.stageRun.count({ where: { stage: 'TRANSCRIBE' } }), 2);
  assert.equal(await db.stageResult.count(), 4);
  await assert.rejects(tasks.retry(video.id, randomUUID()), { code: 'INVALID_TRANSITION' });
});

test('可重试错误按退避执行并在预算耗尽后失败', async () => {
  const video = await create();
  let now = new Date();
  const error = new DomainError('S2T_RATE_LIMITED', '模型限流，请稍后重试', true);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = (await tasks.claim('w' + attempt, now))!;
    assert.equal(job.attempt, attempt);
    await tasks.finish(job.id, 'w' + attempt, error, now);
    if (attempt < 3) {
      assert.equal(await tasks.claim('early', now), null);
      now = new Date(now.getTime() + retryDelay(attempt));
    }
  }
  assert.equal((await tasks.detail(video.id)).overallStatus, 'FAILED');
  assert.equal(await db.stageRun.count(), 3);
});

test('恢复多次崩溃最终退出无限重试', async () => {
  const video = await create();
  let now = new Date();
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.ok(await tasks.claim('w' + attempt, now));
    now = new Date(now.getTime() + LEASE_MS + 1);
  }
  assert.equal(await tasks.claim('exhausted', now), null);
  assert.equal((await tasks.detail(video.id)).latestErrorCode, 'ATTEMPTS_EXHAUSTED');
  assert.equal(await db.stageRun.count({ where: { status: 'RUNNING' } }), 0);
});

test('已有相同指纹产物时复用，不重复外部操作', async () => {
  const video = await create();
  const job = (await db.job.findFirst({ where: { videoId: video.id } }))!;
  await db.stageResult.create({ data: { videoId: video.id, stage: job.stage, inputFingerprint: job.inputFingerprint, outputJson: JSON.stringify(success) } });
  let calls = 0;
  await new Worker(tasks, { execute: async () => { calls++; return success; } }).tick();
  assert.equal(calls, 0);
  assert.equal((await tasks.detail(video.id)).currentStage, 'EXTRACT_AUDIO');
});

test('API 校验、错误封装、同源防护、查询分页和未启用模拟保护', async () => {
  const config = loadConfig({ DATA_DIR: root, DATABASE_URL: url, ENABLE_SIMULATION: 'true' });
  const app = createApp(db, config);
  try {
    assert.equal((await app.inject({ url: '/health/ready' })).statusCode, 200);
    const headers = { 'idempotency-key': randomUUID() };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/videos/simulations', headers, payload: { title: '' } })).statusCode, 400);
    const response = await app.inject({ method: 'POST', url: '/api/v1/videos/simulations', headers, payload: { title: '接口样例' } });
    assert.equal(response.statusCode, 201);
    const id = response.json().id;
    assert.equal((await app.inject({ url: '/api/v1/videos/' + id })).json().title, '接口样例');
    assert.equal((await app.inject({ url: '/api/v1/videos?q=不存在' })).json().total, 0);
    await create();
    const first = (await app.inject({ url: '/api/v1/videos?limit=1' })).json();
    const second = (await app.inject({ url: '/api/v1/videos?limit=1&cursor=' + first.nextCursor })).json();
    assert.notEqual(first.items[0].id, second.items[0].id);
    assert.equal(second.nextCursor, null);
    assert.equal((await app.inject({ url: '/api/v1/videos/' + randomUUID() })).statusCode, 404);
    const cross = await app.inject({ method: 'POST', url: '/api/v1/videos/simulations', headers: { ...headers, origin: 'https://attacker.example' }, payload: { title: '恶意请求' } });
    assert.equal(cross.statusCode, 403);
    assert.equal((await app.inject({ url: '/api/v1/videos', headers: { host: 'attacker.example' } })).statusCode, 403);
    assert.equal(JSON.stringify((await app.inject({ url: '/api/v1/capabilities' })).json()).includes('KEY'), false);
  } finally { await app.close(); }
  const disabled = createApp(db, { ...config, simulation: false });
  try {
    assert.equal((await disabled.inject({ method: 'POST', url: '/api/v1/videos/simulations', headers: { 'idempotency-key': randomUUID() }, payload: { title: '禁用' } })).statusCode, 403);
  } finally { await disabled.close(); }
});

test('SSE 重连仅重放游标后的事件并关闭连接', async () => {
  const video = await create();
  const events = await db.event.findMany({ orderBy: { id: 'asc' } });
  await tasks.cancel(video.id);
  const app = createApp(db, loadConfig({ DATA_DIR: root, DATABASE_URL: url, ENABLE_SIMULATION: 'true' }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('http://127.0.0.1:' + address.port + '/api/v1/events', {
      headers: { 'Last-Event-ID': String(events[0]!.id) }, signal: controller.signal,
    });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('event: task')) text += new TextDecoder().decode((await reader.read()).value);
    assert.ok(text.includes('CANCELED'));
    assert.ok(!text.includes('id: ' + events[0]!.id + '\n'));
    await reader.cancel();
  } finally { clearTimeout(timeout); controller.abort(); await app.close(); }
});
