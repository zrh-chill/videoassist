import type { Prisma, Job } from '@prisma/client';
import type { Database } from './client.js';
import { persistMedia } from './media.js';
import type { Stage, StageResult, VideoStatus } from '../../contracts/src/index.js';
import { DomainError, fingerprint, nextStage, retryDelay, stageStatus } from '../../domain/src/index.js';

type Tx = Prisma.TransactionClient;
export const LEASE_MS = 120_000;
const missing = () => new DomainError('VIDEO_NOT_FOUND', '视频不存在', false, 404);
async function event(tx: Tx, videoId: string, status: string, stage: string | null) {
  await tx.event.create({ data: { videoId, payload: JSON.stringify({ videoId, status, stage }) } });
}
async function snapshot(tx: Tx, videoId: string, status: VideoStatus, stage: string | null, error?: DomainError) {
  await tx.video.update({ where: { id: videoId }, data: {
    overallStatus: status, currentStage: stage,
    latestErrorCode: error?.code ?? null, latestErrorMessage: error?.message ?? null,
  } });
  await event(tx, videoId, status, stage);
}
async function enqueue(tx: Tx, videoId: string, stage: Stage, input: unknown) {
  return tx.job.create({ data: { videoId, stage, inputFingerprint: fingerprint({ stage, input, version: 'simulation-v1' }) } });
}
async function release(tx: Tx, owner: string) {
  await tx.workerLease.updateMany({ where: { id: 'singleton', owner }, data: { owner: null, expiresAt: new Date(0) } });
}
async function cancelJob(tx: Tx, job: Job, now: Date) {
  await tx.job.update({ where: { id: job.id }, data: { status: 'CANCELED', finishedAt: now, leaseOwner: null, leaseExpiresAt: null } });
  await tx.stageRun.updateMany({ where: { jobId: job.id, status: 'RUNNING' }, data: { status: 'CANCELED', finishedAt: now } });
  await snapshot(tx, job.videoId, 'CANCELED', job.stage);
}
export class Tasks {
  constructor(public db: Database) {}

  async createSimulation(input: { title: string; failStage?: Stage; retryableFailure: boolean }, key: string) {
    return this.db.$transaction(async tx => {
      // First statement takes the SQLite writer lock, serializing idempotent commands.
      await tx.command.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const hash = fingerprint(input);
      const existing = await tx.command.findUnique({ where: { key } });
      if (existing) {
        if (existing.fingerprint !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', '请求键已用于其他内容', false, 409);
        return JSON.parse(existing.responseJson) as { id: string };
      }
      const video = await tx.video.create({ data: {
        title: input.title, currentStage: 'FETCH', optionsJson: JSON.stringify(input),
      } });
      await enqueue(tx, video.id, 'FETCH', video.id);
      await event(tx, video.id, 'WAITING', 'FETCH');
      const result = { id: video.id };
      await tx.command.create({ data: {
        key, fingerprint: hash, responseJson: JSON.stringify(result), expiresAt: new Date(Date.now() + 86_400_000),
      } });
      return result;
    });
  }

  async list(query: { q: string; status?: string; sourceType?: string; cursor?: string; limit: number }) {
    const where: Prisma.VideoWhereInput = {
      ...(query.q ? { title: { contains: query.q } } : {}),
      ...(query.status ? { overallStatus: query.status } : {}),
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
    };
    const [items, total] = await this.db.$transaction([
      this.db.video.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}), take: query.limit + 1,
        select: videoSelect,
      }),
      this.db.video.count({ where }),
    ]);
    const hasMore = items.length > query.limit;
    if (hasMore) items.pop();
    return { items, total, nextCursor: hasMore ? items.at(-1)!.id : null };
  }

  async detail(id: string) {
    const video = await this.db.video.findUnique({ where: { id }, select: {
      ...videoSelect, originalUrl: true, localOriginalName: true, durationMs: true, creatorName: true,
      jobs: { orderBy: { createdAt: 'asc' }, select: {
        id: true, stage: true, status: true, attempt: true, maxAttempts: true, availableAt: true, cancelRequestedAt: true,
      } },
    } });
    if (!video) throw missing();
    return video;
  }

  async cancel(id: string) {
    return this.db.$transaction(async tx => {
      await tx.job.updateMany({ where: { videoId: id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { cancelRequestedAt: new Date() } });
      const video = await tx.video.findUnique({ where: { id } });
      if (!video) throw missing();
      const jobs = await tx.job.findMany({ where: { videoId: id, status: 'QUEUED' } });
      for (const job of jobs) await cancelJob(tx, job, new Date());
      // Running operations acknowledge cancellation before their outputs can commit.
      await event(tx, id, jobs.length ? 'CANCELED' : video.overallStatus, video.currentStage);
      return { accepted: true };
    });
  }

  async retry(id: string, key: string) {
    return this.db.$transaction(async tx => {
      await tx.command.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const hash = fingerprint({ action: 'retry', id });
      const prior = await tx.command.findUnique({ where: { key } });
      if (prior) {
        if (prior.fingerprint !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', '请求键已用于其他内容', false, 409);
        return JSON.parse(prior.responseJson) as { id: string };
      }
      const video = await tx.video.findUnique({ where: { id } });
      if (!video) throw missing();
      if (!['FAILED', 'CANCELED'].includes(video.overallStatus)) throw new DomainError('INVALID_TRANSITION', '仅失败或取消的任务可以重试', false, 409);
      const job = await tx.job.findFirst({ where: { videoId: id, status: { in: ['FAILED', 'CANCELED'] } }, orderBy: { createdAt: 'desc' } });
      if (!job) throw new DomainError('INVALID_TRANSITION', '没有可重试阶段', false, 409);
      // Preserve attempt/run history while granting a fresh retry budget.
      await tx.job.update({ where: { id: job.id }, data: {
        status: 'QUEUED', maxAttempts: job.attempt + 3, availableAt: new Date(),
        cancelRequestedAt: null, finishedAt: null, leaseOwner: null, leaseExpiresAt: null,
        lastErrorCode: null, lastErrorMessage: null,
      } });
      await snapshot(tx, id, 'WAITING', job.stage);
      const result = { id };
      await tx.command.create({ data: { key, fingerprint: hash, responseJson: JSON.stringify(result), expiresAt: new Date(Date.now() + 86_400_000) } });
      return result;
    });
  }

  async claim(owner: string, now = new Date()) {
    return this.db.$transaction(async tx => {
      const lock = await tx.workerLease.updateMany({
        where: { id: 'singleton', expiresAt: { lte: now } },
        data: { owner, expiresAt: new Date(now.getTime() + LEASE_MS) },
      });
      if (!lock.count) return null;
      const job = await tx.job.findFirst({
        where: { OR: [{ status: 'QUEUED', availableAt: { lte: now } }, { status: 'RUNNING', leaseExpiresAt: { lte: now } }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (!job) { await release(tx, owner); return null; }
      if (job.cancelRequestedAt) { await cancelJob(tx, job, now); await release(tx, owner); return null; }
      if (job.status === 'RUNNING') {
        await tx.stageRun.updateMany({ where: { jobId: job.id, status: 'RUNNING' }, data: {
          status: 'INTERRUPTED', finishedAt: now, errorCode: 'LEASE_EXPIRED', errorMessage: '执行进程中断，租约已过期',
        } });
      }
      if (job.attempt >= job.maxAttempts) {
        await tx.job.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: now, leaseOwner: null, leaseExpiresAt: null,
          lastErrorCode: 'ATTEMPTS_EXHAUSTED', lastErrorMessage: '任务多次中断，请手动重试' } });
        await snapshot(tx, job.videoId, 'FAILED', job.stage, new DomainError('ATTEMPTS_EXHAUSTED', '任务多次中断，请手动重试'));
        await release(tx, owner); return null;
      }
      const claimed = await tx.job.update({ where: { id: job.id }, data: {
        status: 'RUNNING', attempt: { increment: 1 }, leaseOwner: owner,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS), startedAt: now, finishedAt: null,
      }, include: { video: true } });
      await tx.stageRun.create({ data: {
        videoId: job.videoId, jobId: job.id, stage: job.stage, attempt: claimed.attempt, status: 'RUNNING', startedAt: now,
      } });
      await snapshot(tx, job.videoId, stageStatus[job.stage as Stage], job.stage);
      return claimed;
    });
  }

  async renew(jobId: string, owner: string, now = new Date()) {
    return this.db.$transaction(async tx => {
      const lease = new Date(now.getTime() + LEASE_MS);
      const lock = await tx.workerLease.updateMany({ where: { id: 'singleton', owner, expiresAt: { gt: now } }, data: { expiresAt: lease } });
      if (!lock.count) return false;
      const job = await tx.job.updateMany({ where: {
        id: jobId, status: 'RUNNING', leaseOwner: owner, leaseExpiresAt: { gt: now }, cancelRequestedAt: null,
      }, data: { leaseExpiresAt: lease } });
      return job.count === 1;
    });
  }

  async finish(jobId: string, owner: string, result: StageResult | DomainError, now = new Date()) {
    return this.db.$transaction(async tx => {
      // Fence stale processes before reading or writing stage results.
      const guard = await tx.job.updateMany({ where: {
        id: jobId, status: 'RUNNING', leaseOwner: owner, leaseExpiresAt: { gt: now },
      }, data: { finishedAt: now } });
      if (!guard.count) return false;
      const job = (await tx.job.findUnique({ where: { id: jobId } }))!;
      if (job.cancelRequestedAt) {
        await cancelJob(tx, job, now); await release(tx, owner); return true;
      }
      const error = result instanceof DomainError ? result : undefined;
      const retry = error?.retryable && job.attempt < job.maxAttempts;
      const jobStatus = error ? (retry ? 'QUEUED' : 'FAILED') : 'SUCCEEDED';
      await tx.stageRun.update({ where: { jobId_attempt: { jobId, attempt: job.attempt } }, data: {
        status: error ? 'FAILED' : 'SUCCEEDED', finishedAt: now,
        errorCode: error?.code, errorMessage: error?.message,
        outputJson: error ? undefined : JSON.stringify({ simulated: (result as StageResult).simulated, text: (result as StageResult).text }),
      } });
      await tx.job.update({ where: { id: jobId }, data: {
        status: jobStatus, leaseOwner: null, leaseExpiresAt: null,
        availableAt: retry ? new Date(now.getTime() + retryDelay(job.attempt)) : job.availableAt,
        finishedAt: retry ? null : now, lastErrorCode: error?.code ?? null, lastErrorMessage: error?.message ?? null,
      } });
      if (error) {
        await snapshot(tx, job.videoId, retry ? 'WAITING' : 'FAILED', job.stage, error);
      } else {
        await persistMedia(tx, job.videoId, result as StageResult);
        const saved = await tx.stageResult.upsert({
          where: { videoId_stage_inputFingerprint: { videoId: job.videoId, stage: job.stage, inputFingerprint: job.inputFingerprint } },
          update: {}, create: { videoId: job.videoId, stage: job.stage, inputFingerprint: job.inputFingerprint, outputJson: JSON.stringify(result) },
        });
        const next = nextStage(job.stage as Stage);
        if (next) await enqueue(tx, job.videoId, next, saved.id);
        await snapshot(tx, job.videoId, next ? 'WAITING' : 'COMPLETED', next ?? job.stage);
      }
      await release(tx, owner);
      return true;
    });
  }

  async cached(job: Job): Promise<StageResult | null> {
    const result = await this.db.stageResult.findUnique({ where: {
      videoId_stage_inputFingerprint: { videoId: job.videoId, stage: job.stage, inputFingerprint: job.inputFingerprint },
    } });
    return result ? JSON.parse(result.outputJson) : null;
  }
}
const videoSelect = {
  id: true, title: true, sourceType: true, overallStatus: true, currentStage: true,
  latestErrorCode: true, latestErrorMessage: true, createdAt: true, updatedAt: true,
} as const;
