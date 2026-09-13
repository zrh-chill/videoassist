import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../../../packages/database/src/client.js';
import { Tasks } from '../../../packages/database/src/tasks.js';
import { DomainError, publicError } from '../../../packages/domain/src/index.js';
import { createSimulationSchema, listQuerySchema } from '../../../packages/contracts/src/index.js';
import { projectRoot, type loadConfig } from '../../../packages/config/src/index.js';
import { mediaRoutes } from './media-routes.js';

export function createApp(db: Database, config: ReturnType<typeof loadConfig>) {
  const app = Fastify({ bodyLimit: 16 * 1024, logger: false });
  const tasks = new Tasks(db);
  const prefix = '/api/v1';
  const streams = new Set<() => void>();
  mediaRoutes(app, db, config);
  app.addHook('onRequest', async request => {
    const host = new URL('http://' + request.headers.host).hostname;
    const local = ['127.0.0.1', 'localhost', '[::1]'];
    if (!local.includes(host)) throw new DomainError('INVALID_HOST', '仅允许本机访问', false, 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new DomainError('INVALID_ORIGIN', '拒绝跨站请求', false, 403);
    if (request.headers.origin) {
      let allowed = false;
      try {
        const origin = new URL(request.headers.origin);
        allowed = origin.protocol === 'http:' && local.includes(origin.hostname)
          && [String(config.port), '5173'].includes(origin.port);
      } catch { /* reject malformed origin */ }
      if (!allowed) throw new DomainError('INVALID_ORIGIN', '拒绝跨站请求', false, 403);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const safe = error instanceof z.ZodError
      ? new DomainError('INVALID_INPUT', '请求参数格式不正确')
      : (error as { statusCode?: number }).statusCode === 413
        ? new DomainError('UPLOAD_TOO_LARGE', '上传文件超过容量限制', false, 413)
      : (error as { statusCode?: number }).statusCode === 400
        ? new DomainError('INVALID_INPUT', '请求内容格式不正确') : publicError(error);
    reply.code(safe.httpStatus).send({ error: { code: safe.code, message: safe.message, requestId: request.id } });
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const probe = path.join(config.dataDir, 'temp', randomUUID() + '.probe');
    try {
      await db.$transaction(async tx => {
        await tx.command.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        await tx.video.count();
      });
      await writeFile(probe, '');
      await unlink(probe);
      return { status: 'ready' };
    } catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  app.get(prefix + '/capabilities', async () => ({ simulation: config.simulation, phase: 2, media: true, uploadMaxBytes: config.uploadMaxBytes }));
  app.get(prefix + '/videos', async request => tasks.list(listQuerySchema.parse(request.query)));
  app.post(prefix + '/videos/simulations', async (request, reply) => {
    if (!config.simulation) throw new DomainError('SIMULATION_DISABLED', '未启用模拟模式', false, 403);
    const key = z.string().min(1).max(128).parse(request.headers['idempotency-key']);
    const result = await tasks.createSimulation(createSimulationSchema.parse(request.body), key);
    return reply.code(201).send(result);
  });
  const idOf = (params: unknown) => z.object({ id: z.string().uuid() }).parse(params).id;
  app.get(prefix + '/videos/:id', async request => tasks.detail(idOf(request.params)));
  app.get(prefix + '/videos/:id/runs', async request => {
    const id = idOf(request.params);
    await tasks.detail(id);
    return db.stageRun.findMany({ where: { videoId: id }, orderBy: [{ startedAt: 'asc' }, { attempt: 'asc' }], select: {
      id: true, stage: true, attempt: true, status: true, startedAt: true, finishedAt: true,
      errorCode: true, errorMessage: true, outputJson: true,
    } });
  });
  app.post(prefix + '/videos/:id/actions/cancel', async request => tasks.cancel(idOf(request.params)));
  app.post(prefix + '/videos/:id/actions/retry', async request => tasks.retry(
    idOf(request.params), z.string().min(1).max(128).parse(request.headers['idempotency-key']),
  ));
  app.get(prefix + '/events', async (request, reply) => {
    const query = z.object({ after: z.coerce.number().int().nonnegative().optional() }).parse(request.query);
    let cursor = z.coerce.number().int().nonnegative().parse(request.headers['last-event-id'] ?? query.after ?? 0);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    let busy = false;
    let closed = false;
    const cleanup = () => { closed = true; clearInterval(timer); streams.delete(close); };
    const close = () => { cleanup(); res.end(); };
    const flush = async () => {
      if (busy || closed) return;
      if (res.writableLength > 1024 * 1024) { close(); return; }
      busy = true;
      try {
        const events = await db.event.findMany({ where: { id: { gt: cursor } }, orderBy: { id: 'asc' }, take: 100 });
        if (closed) return;
        for (const event of events) {
          res.write('id: ' + event.id + '\nevent: task\ndata: ' + event.payload + '\n\n');
          cursor = event.id;
        }
        if (!events.length) res.write(': heartbeat\n\n');
      } catch { close(); }
      finally { busy = false; }
    };
    const timer = setInterval(() => { void flush(); }, 1000);
    streams.add(close);
    res.once('close', cleanup);
    await flush();
  });
  app.addHook('preClose', async () => { for (const close of streams) close(); });
  const webRoot = path.join(projectRoot, 'apps/web/dist');
  if (existsSync(webRoot)) {
    app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/health/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在', requestId: request.id } });
    });
  }
  return app;
}
