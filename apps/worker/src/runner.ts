import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Tasks } from '../../../packages/database/src/tasks.js';
import { publicError, type StageHandler } from '../../../packages/domain/src/index.js';
import type { Stage } from '../../../packages/contracts/src/index.js';

export class Worker {
  constructor(private tasks: Tasks, private handler: StageHandler, private heartbeatMs = 1000) {}
  async tick(shutdown?: AbortSignal): Promise<boolean> {
    if (shutdown?.aborted) return false;
    const owner = randomUUID();
    const job = await this.tasks.claim(owner);
    if (!job) return false;
    const operation = new AbortController();
    const monitor = new AbortController();
    const stop = () => operation.abort();
    shutdown?.addEventListener('abort', stop, { once: true });
    if (shutdown?.aborted) operation.abort();
    const heartbeat = (async () => {
      try {
        while (!monitor.signal.aborted) {
          await delay(this.heartbeatMs, undefined, { signal: monitor.signal });
          if (!await this.tasks.renew(job.id, owner)) { operation.abort(); break; }
        }
      } catch { if (!monitor.signal.aborted) operation.abort(); }
    })();
    try {
      const result = await this.tasks.cached(job) ?? await this.handler.execute({
        videoId: job.videoId, title: job.video.title, stage: job.stage as Stage,
        jobId: job.id, leaseOwner: owner, sourceType: job.video.sourceType,
        attempt: job.attempt, options: JSON.parse(job.video.optionsJson),
      }, operation.signal);
      // Shutdown leaves a leased job for crash recovery, rather than reporting a false failure.
      if (!shutdown?.aborted) await this.tasks.finish(job.id, owner, result);
    } catch (error) {
      if (!shutdown?.aborted) await this.tasks.finish(job.id, owner, publicError(error));
    } finally {
      monitor.abort();
      await heartbeat;
      shutdown?.removeEventListener('abort', stop);
    }
    return true;
  }
  async run(signal: AbortSignal, background?: { tick(signal?: AbortSignal): Promise<boolean> }) {
    while (!signal.aborted) {
      try {
        if (!await background?.tick(signal) && !await this.tick(signal)) await delay(1000, undefined, { signal });
      } catch {
        if (!signal.aborted) {
          process.stderr.write(JSON.stringify({ level: 'error', code: 'WORKER_TICK_FAILED', message: '任务调度暂时失败，稍后重试' }) + '\n');
          await delay(1000, undefined, { signal }).catch(() => {});
        }
      }
    }
  }
}
