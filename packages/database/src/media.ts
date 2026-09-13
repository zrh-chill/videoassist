import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { Database } from './client.js';
import { DomainError, fingerprint } from '../../domain/src/index.js';
import type { MediaArtifact, MediaOutput } from '../../contracts/src/media.js';

export async function persistMedia(tx: Prisma.TransactionClient, videoId: string, output: MediaOutput) {
  if (output.artifact) {
    const data = { ...output.artifact, sizeBytes: BigInt(output.artifact.sizeBytes), videoId };
    await tx.artifact.upsert({ where: { storageKey: data.storageKey }, create: data, update: {} });
  }
  if (output.metadata) await tx.video.update({ where: { id: videoId }, data: {
    ...output.metadata, publishedAt: output.metadata.publishedAt ? new Date(output.metadata.publishedAt) : undefined,
  } });
  if (output.transcript) {
    const revision = (await tx.transcript.aggregate({ where: { videoId }, _max: { revision: true } }))._max.revision ?? 0;
    await tx.transcript.updateMany({ where: { videoId, isCurrent: true }, data: { isCurrent: false } });
    await tx.summary.updateMany({ where: { videoId, isCurrent: true }, data: { isCurrent: false } });
    const { segments, ...transcript } = output.transcript;
    await tx.transcript.create({ data: {
      ...transcript, videoId, revision: revision + 1,
      segments: { create: segments.map((segment, sequence) => ({ ...segment, sequence })) },
    } });
  }
  if (output.summary) {
    const revision = (await tx.summary.aggregate({ where: { videoId }, _max: { revision: true } }))._max.revision ?? 0;
    await tx.summary.updateMany({ where: { videoId, isCurrent: true }, data: { isCurrent: false } });
    const { content, ...summary } = output.summary;
    await tx.summary.create({ data: { ...summary, videoId, revision: revision + 1, structuredJson: JSON.stringify(content),
      renderedText: content.one_sentence + '\n\n' + content.key_points.map(p => '- ' + p).join('\n') + '\n\n' + content.detailed_summary + '\n\n关键词：' + content.keywords.join('、'),
    } });
  }
}
export class MediaLibrary {
  constructor(public db: Database) {}
  async importVideo(input: {
    id?: string; sourceType: 'LOCAL' | 'BILIBILI'; title: string; bvid?: string; originalUrl?: string;
    localOriginalName?: string; durationMs?: number; sourceHash?: string; artifact?: MediaArtifact;
  }, key: string) {
    const { artifact, ...videoData } = input;
    const hash = fingerprint({ ...videoData, id: undefined });
    return this.db.$transaction(async tx => {
      await tx.command.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const prior = await tx.command.findUnique({ where: { key } });
      if (prior) {
        if (prior.fingerprint !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', '请求键已用于其他内容', false, 409);
        return JSON.parse(prior.responseJson) as { id: string; duplicate: boolean };
      }
      const existing = input.bvid ? await tx.video.findUnique({ where: { sourceType_bvid: { sourceType: 'BILIBILI', bvid: input.bvid } } }) : null;
      let id = existing?.id;
      if (!id) {
        const stage = input.sourceType === 'LOCAL' ? 'EXTRACT_AUDIO' : 'FETCH';
        const video = await tx.video.create({ data: { ...videoData, currentStage: stage } });
        id = video.id;
        if (artifact) await persistMedia(tx, id, { artifact });
        await tx.job.create({ data: { videoId: id, stage, inputFingerprint: fingerprint({ stage, input: artifact?.sha256 || input.bvid, version: 'media-v1' }) } });
        await tx.event.create({ data: { videoId: id, payload: JSON.stringify({ videoId: id, status: 'WAITING', stage }) } });
      }
      const sameFile = input.sourceHash ? await tx.video.count({ where: { sourceHash: input.sourceHash, id: { not: id } } }) : 0;
      const result = { id, duplicate: Boolean(existing || sameFile) };
      await tx.command.create({ data: { key, fingerprint: hash, responseJson: JSON.stringify(result), expiresAt: new Date(Date.now() + 86400000) } });
      return result;
    });
  }
  async regenerateSummary(videoId: string, key: string) {
    return this.db.$transaction(async tx => {
      await tx.command.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const hash = fingerprint({ videoId, action: 'regenerate-summary' });
      const prior = await tx.command.findUnique({ where: { key } });
      if (prior) {
        if (prior.fingerprint !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', '请求键已用于其他内容', false, 409);
        return JSON.parse(prior.responseJson) as { id: string };
      }
      if (await tx.job.count({ where: { videoId, status: { in: ['RUNNING', 'QUEUED'] } } })) throw new DomainError('TASK_ACTIVE', '请等待当前处理结束后再生成总结', false, 409);
      const transcript = await tx.transcript.findFirst({ where: { videoId, isCurrent: true } });
      if (!transcript) throw new DomainError('TRANSCRIPT_MISSING', '请先完成视频转写', false, 409);
      await tx.job.create({ data: { videoId, stage: 'SUMMARIZE', inputFingerprint: fingerprint({ transcriptId: transcript.id, force: randomUUID() }) } });
      await tx.video.update({ where: { id: videoId }, data: { currentStage: 'SUMMARIZE', overallStatus: 'WAITING', latestErrorCode: null, latestErrorMessage: null } });
      await tx.event.create({ data: { videoId, payload: JSON.stringify({ videoId, status: 'WAITING', stage: 'SUMMARIZE' }) } });
      const result = { id: videoId };
      await tx.command.create({ data: { key, fingerprint: hash, responseJson: JSON.stringify(result), expiresAt: new Date(Date.now() + 86400000) } });
      return result;
    });
  }
}
