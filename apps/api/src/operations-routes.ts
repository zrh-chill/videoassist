import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../packages/database/src/client.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import { Operations } from '../../../packages/database/src/operations.js';
import { MediaLibrary } from '../../../packages/database/src/media.js';
const options = z.object({ latestLimit: z.number().int().min(1).max(50), autoProcess: z.boolean(), enabled: z.boolean() });
export function operationsRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const operations = new Operations(db);
  const keyOf = (value: unknown) => z.string().min(1).max(128).parse(value);
  const idOf = (value: unknown) => z.object({ id: z.string().uuid() }).parse(value).id;
  app.get('/api/v1/creators', () => db.creator.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }));
  app.post('/api/v1/creators', request => {
    const input = z.object({ source: z.string().trim().min(1).max(2048), latestLimit: options.shape.latestLimit.default(5), autoProcess: z.boolean().default(true) }).strict().parse(request.body);
    return operations.addCreator(input, keyOf(request.headers['idempotency-key']));
  });
  app.patch('/api/v1/creators/:id', request => operations.editCreator(idOf(request.params), options.partial().strict().parse(request.body)));
  app.delete('/api/v1/creators/:id', request => operations.editCreator(idOf(request.params), {}, true));
  app.post('/api/v1/creators/:id/actions/check', request => operations.enqueue('CREATOR_CHECK', keyOf(request.headers['idempotency-key']), idOf(request.params)));
  app.get('/api/v1/creators/:id/checks', request => db.operation.findMany({ where: { creatorId: idOf(request.params) }, orderBy: { createdAt: 'desc' }, take: 50 }));
  app.post('/api/v1/videos/:id/actions/start', request => new MediaLibrary(db).start(idOf(request.params), keyOf(request.headers['idempotency-key'])));
  app.get('/api/v1/maintenance', async () => ({ backupDirectory: path.join(config.dataDir, 'backups'), logDirectory: path.join(config.dataDir, 'logs'),
    operations: await db.operation.findMany({ where: { kind: { in: ['BACKUP', 'CLEANUP'] } }, orderBy: { createdAt: 'desc' }, take: 50 }) }));
  app.post('/api/v1/maintenance/actions/:action', request => {
    const { action } = z.object({ action: z.enum(['backup', 'cleanup']) }).parse(request.params);
    return operations.enqueue(action === 'backup' ? 'BACKUP' : 'CLEANUP', keyOf(request.headers['idempotency-key']));
  });
  // Maintenance only: V1 creator checks remain explicitly manual.
  let timer: ReturnType<typeof setInterval> | undefined;
  app.addHook('onListen', async () => {
    const schedule = async () => {
      const date = new Date().toISOString().slice(0, 10);
      try { await operations.enqueue('CLEANUP', 'daily-cleanup:' + date); } catch { /* next hourly attempt retries */ }
    };
    await schedule(); timer = setInterval(() => { void schedule(); }, 3600000); timer.unref();
  });
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); });
}
