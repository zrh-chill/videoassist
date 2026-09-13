import type { Database } from './client.js';
import type { Prisma } from '@prisma/client';
import { DomainError, fingerprint } from '../../domain/src/index.js';
import { normalizeCreator, type CreatorVideos } from '../../integrations/src/creators.js';
import { importMedia } from './media.js';
import { LEASE_MS } from './tasks.js';
import { z } from 'zod';
export const trackingSettingsSchema = z.object({ latestLimit: z.number().int().min(1).max(50), autoProcess: z.boolean() }).strict();
async function trackingSettings(tx: Prisma.TransactionClient, initial?: { latestLimit: number; autoProcess: boolean }) {
  const row = await tx.systemSettings.findUnique({ where: { id: 'creator-tracking' } });
  if (row) return { ...trackingSettingsSchema.parse(JSON.parse(row.valuesJson)), revision: row.revision };
  const first = await tx.creator.findFirst({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } });
  const values = trackingSettingsSchema.parse(first ? { latestLimit: first.latestLimit, autoProcess: first.autoProcess } : initial || { latestLimit: 5, autoProcess: true });
  await tx.systemSettings.create({ data: { id: 'creator-tracking', valuesJson: JSON.stringify(values) } });
  await tx.creator.updateMany({ where: { deletedAt: null }, data: values });
  return { ...values, revision: 0 };
}
export type OperationKind = 'CREATOR_CHECK' | 'BACKUP' | 'CLEANUP';
export class Operations {
  constructor(public db: Database) {}
  async trackingSettings() {
    return this.db.$transaction(async tx => {
      await tx.command.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      return trackingSettings(tx);
    });
  }
  async saveTrackingSettings(input: { latestLimit: number; autoProcess: boolean; revision: number }) {
    const values = trackingSettingsSchema.parse({ latestLimit: input.latestLimit, autoProcess: input.autoProcess });
    return this.db.$transaction(async tx => {
      await tx.command.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const current = await trackingSettings(tx);
      if (current.revision !== input.revision) throw new DomainError('SETTINGS_CONFLICT', '追踪设置已被修改，请重新打开后保存', false, 409);
      await tx.systemSettings.update({ where: { id: 'creator-tracking' }, data: { valuesJson: JSON.stringify(values), revision: { increment: 1 } } });
      await tx.creator.updateMany({ where: { deletedAt: null }, data: values });
      return { ...values, revision: current.revision + 1 };
    });
  }
  async addCreator(input: { source: string; latestLimit?: number; autoProcess?: boolean }, key: string) {
    const normalized = normalizeCreator(input.source);
    return this.command(key, { action: 'add-creator', ...input, source: normalized.uid }, async tx => {
      const { latestLimit, autoProcess } = await trackingSettings(tx, { latestLimit: input.latestLimit ?? 5, autoProcess: input.autoProcess ?? true });
      const creator = await tx.creator.upsert({ where: { uid: normalized.uid }, create: { ...normalized, name: normalized.uid, latestLimit, autoProcess },
        update: { deletedAt: null, enabled: true, latestLimit, autoProcess } });
      return { id: creator.id };
    });
  }
  private async command<T>(key: string, input: unknown, execute: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.db.$transaction(async tx => {
      await tx.command.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const hash = fingerprint(input); const prior = await tx.command.findUnique({ where: { key } });
      if (prior) {
        if (prior.fingerprint !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', '请求键已用于其他内容', false, 409);
        return JSON.parse(prior.responseJson) as T;
      }
      const result = await execute(tx);
      await tx.command.create({ data: { key, fingerprint: hash, responseJson: JSON.stringify(result), expiresAt: new Date(Date.now() + 86400000) } });
      return result;
    });
  }
  async editCreator(id: string, patch: { latestLimit?: number; autoProcess?: boolean; enabled?: boolean }, remove = false) {
    return this.db.$transaction(async tx => {
      await tx.creator.updateMany({ where: { id, deletedAt: null }, data: { ...patch, ...(remove ? { deletedAt: new Date(), enabled: false } : {}) } });
      const creator = await tx.creator.findUnique({ where: { id } });
      if (!creator || (creator.deletedAt && !remove)) throw new DomainError('CREATOR_NOT_FOUND', '追踪对象不存在', false, 404);
      if (!creator.enabled || remove) {
        await tx.operation.updateMany({ where: { creatorId: id, status: 'RUNNING' }, data: { cancelRequestedAt: new Date() } });
        await tx.operation.updateMany({ where: { creatorId: id, status: 'QUEUED' }, data: { status: 'CANCELED', activeKey: null, finishedAt: new Date() } });
      }
      return { id };
    });
  }
  async enqueue(kind: OperationKind, key: string, creatorId?: string) {
    return this.command(key, { kind, creatorId }, async tx => {
      if (kind === 'CREATOR_CHECK') {
        const creator = await tx.creator.findUnique({ where: { id: creatorId } });
        if (!creator || creator.deletedAt) throw new DomainError('CREATOR_NOT_FOUND', '追踪对象不存在', false, 404);
        if (!creator.enabled) throw new DomainError('CREATOR_DISABLED', '请先启用追踪', false, 409);
      }
      const activeKey = kind + ':' + (creatorId || 'singleton');
      const existing = await tx.operation.findUnique({ where: { activeKey } });
      if (existing) return { id: existing.id };
      return { id: (await tx.operation.create({ data: { kind, creatorId, activeKey } })).id };
    });
  }
  async claim(owner: string, now = new Date()) {
    return this.db.$transaction(async tx => {
      if (!(await tx.workerLease.updateMany({ where: { id: 'singleton', expiresAt: { lte: now } }, data: { owner, expiresAt: new Date(now.getTime() + LEASE_MS) } })).count) return null;
      const job = await tx.operation.findFirst({ where: { OR: [{ status: 'QUEUED' }, { status: 'RUNNING', leaseExpiresAt: { lte: now } }] }, orderBy: { createdAt: 'asc' } });
      if (!job || job.attempt >= 3 || job.cancelRequestedAt) {
        if (job) await tx.operation.update({ where: { id: job.id }, data: { status: job.cancelRequestedAt ? 'CANCELED' : 'FAILED', errorMessage: job.cancelRequestedAt ? null : '多次执行中断，请重新创建任务', activeKey: null, leaseOwner: null, leaseExpiresAt: null, finishedAt: now } });
        await tx.workerLease.update({ where: { id: 'singleton' }, data: { owner: null, expiresAt: new Date(0) } }); return null;
      }
      return tx.operation.update({ where: { id: job.id }, data: { status: 'RUNNING', attempt: { increment: 1 }, leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), startedAt: now } });
    });
  }
  async renew(id: string, owner: string, now = new Date()) {
    return this.db.$transaction(async tx => {
      const expiresAt = new Date(now.getTime() + LEASE_MS);
      if (!(await tx.workerLease.updateMany({ where: { id: 'singleton', owner, expiresAt: { gt: now } }, data: { expiresAt } })).count) return false;
      return Boolean((await tx.operation.updateMany({ where: { id, status: 'RUNNING', leaseOwner: owner, leaseExpiresAt: { gt: now }, cancelRequestedAt: null }, data: { leaseExpiresAt: expiresAt } })).count);
    });
  }
  async finish(id: string, owner: string, result: unknown, error?: DomainError, now = new Date()) {
    return this.db.$transaction(async tx => {
      const guarded = await tx.operation.updateMany({ where: { id, status: 'RUNNING', leaseOwner: owner, leaseExpiresAt: { gt: now } }, data: { finishedAt: now } });
      if (!guarded.count) return false;
      const job = await tx.operation.findUniqueOrThrow({ where: { id } });
      let canceled = Boolean(job.cancelRequestedAt);
      let output = result;
      if (job.kind === 'CREATOR_CHECK') {
        const creator = await tx.creator.findUnique({ where: { id: job.creatorId! } });
        canceled ||= !creator || !creator.enabled || Boolean(creator.deletedAt);
        if (creator && !canceled) {
          const data = result as CreatorVideos;
          let added = 0;
          if (!error) {
            for (const video of data.videos) {
              const imported = await importMedia(tx, { sourceType: 'BILIBILI', bvid: video.bvid, originalUrl: video.url, title: video.title, creatorId: creator.id, creatorName: data.name, autoProcess: creator.autoProcess });
              if (!imported.duplicate) added++;
            }
            output = { found: data.videos.length, added, autoProcess: creator.autoProcess };
          }
          await tx.creator.update({ where: { id: creator.id }, data: { lastCheckedAt: now, latestError: error?.message ?? null, ...(!error ? { name: data.name } : {}) } });
        }
      }
      await tx.operation.update({ where: { id }, data: { status: canceled ? 'CANCELED' : error ? 'FAILED' : 'SUCCEEDED', activeKey: null, leaseOwner: null, leaseExpiresAt: null, errorMessage: canceled ? null : error?.message ?? null, resultJson: !error && !canceled ? JSON.stringify(output) : null } });
      await tx.workerLease.updateMany({ where: { id: 'singleton', owner }, data: { owner: null, expiresAt: new Date(0) } });
      return true;
    });
  }
}
