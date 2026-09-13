import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Database } from '../../../packages/database/src/client.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import { Operations } from '../../../packages/database/src/operations.js';
import { Settings } from '../../../packages/database/src/settings.js';
import { fetchCreatorVideos } from '../../../packages/integrations/src/creators.js';
import { backupWorkspace, cleanupWorkspace } from '../../../packages/storage/src/maintenance.js';
import { createLogger } from '../../../packages/storage/src/logging.js';
import { DomainError, publicError } from '../../../packages/domain/src/index.js';
export class OperationWorker {
  private operations: Operations;
  constructor(private db: Database, private config: AppConfig, private fetchVideos = fetchCreatorVideos) { this.operations = new Operations(db); }
  async tick(shutdown?: AbortSignal) {
    if (shutdown?.aborted) return false;
    const owner = randomUUID(); const job = await this.operations.claim(owner);
    if (!job) return false;
    const operation = new AbortController(); const monitor = new AbortController();
    const stop = () => operation.abort(); shutdown?.addEventListener('abort', stop, { once: true });
    if (shutdown?.aborted) operation.abort();
    const heartbeat = (async () => {
      try { while (!monitor.signal.aborted) {
        await delay(1000, undefined, { signal: monitor.signal });
        if (!await this.operations.renew(job.id, owner)) { operation.abort(); break; }
      } } catch { if (!monitor.signal.aborted) operation.abort(); }
    })();
    const log = createLogger(this.config.dataDir, 'worker');
    try {
      const config = await new Settings(this.db, this.config).effective();
      let result: unknown;
      if (job.kind === 'CREATOR_CHECK') {
        const creator = await this.db.creator.findUniqueOrThrow({ where: { id: job.creatorId! } });
        if (!creator.enabled || creator.deletedAt) throw new DomainError('CREATOR_DISABLED', '追踪已停止');
        result = await this.fetchVideos(creator.uid, creator.latestLimit, config, operation.signal);
      } else if (job.kind === 'BACKUP') result = await backupWorkspace(this.db, config, job.id, operation.signal);
      else result = await cleanupWorkspace(this.db, config, operation.signal);
      if (!shutdown?.aborted && await this.operations.finish(job.id, owner, result)) {
        const stored = await this.db.operation.findUniqueOrThrow({ where: { id: job.id } });
        await log({ event: 'operation_finished', jobId: job.id, kind: job.kind, status: stored.status });
      }
    } catch (error) {
      const safe = publicError(error);
      if (!shutdown?.aborted && await this.operations.finish(job.id, owner, null, safe)) {
        const stored = await this.db.operation.findUniqueOrThrow({ where: { id: job.id } });
        await log({ event: 'operation_finished', jobId: job.id, kind: job.kind, status: stored.status, errorCode: safe.code, message: safe.message });
      }
    } finally { monitor.abort(); await heartbeat; shutdown?.removeEventListener('abort', stop); }
    return true;
  }
}
