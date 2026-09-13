import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { Settings } from '../../../packages/database/src/settings.js';
import path from 'node:path';
import type { Database } from '../../../packages/database/src/client.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import type { StageHandler } from '../../../packages/domain/src/index.js';
import { DomainError, fingerprint } from '../../../packages/domain/src/index.js';
import type { StageInput } from '../../../packages/contracts/src/index.js';
import { resolveStorageKey } from '../../../packages/storage/src/index.js';
import { describeFile } from '../../../packages/storage/src/media.js';
import { bilibiliMetadata, downloadBilibili } from '../../../packages/integrations/src/bilibili.js';
import { extractAudio, probeMedia } from '../../../packages/integrations/src/ffmpeg.js';
import { transcribeAudio, summarizeText } from '../../../packages/integrations/src/models.js';
import { simulationHandler } from '../../../packages/integrations/src/simulation.js';

export function mediaHandler(db: Database, config: AppConfig): StageHandler {
  async function checkpoint<T>(input: StageInput, kind: string, key: unknown, execute: () => Promise<T>): Promise<T> {
    const id = fingerprint({ videoId: input.videoId, jobId: input.jobId, kind, key });
    const saved = await db.checkpoint.findUnique({ where: { id } });
    if (saved) return JSON.parse(saved.outputJson) as T;
    const output = await execute();
    await db.$transaction(async tx => {
      const owned = await tx.job.updateMany({ where: {
        id: input.jobId, status: 'RUNNING', leaseOwner: input.leaseOwner, leaseExpiresAt: { gt: new Date() }, cancelRequestedAt: null,
      }, data: { lastErrorCode: null } });
      if (!owned.count) throw new DomainError('OPERATION_CANCELED', '执行租约已失效');
      await tx.checkpoint.upsert({ where: { id }, update: {}, create: { id, videoId: input.videoId, kind, outputJson: JSON.stringify(output) } });
      await tx.event.create({ data: { videoId: input.videoId, payload: JSON.stringify({ videoId: input.videoId, stage: input.stage, progress: kind }) } });
    });
    return output;
  }
  async function artifact(videoId: string, kind: 'SOURCE_VIDEO' | 'AUDIO') {
    const saved = await db.artifact.findFirst({ where: { videoId, kind, deletedAt: null, isCurrent: true }, orderBy: { createdAt: 'desc' } });
    if (!saved) throw new DomainError('ARTIFACT_MISSING', '所需媒体文件记录不存在，请重新导入');
    const current = await describeFile(config.dataDir, saved.storageKey, kind, saved.mimeType);
    if (current.sha256 !== saved.sha256) throw new DomainError('ARTIFACT_MISSING', '媒体文件已改变，请重新导入');
    return current;
  }
  return { async execute(input, signal) {
    if (input.sourceType === 'SIMULATION') {
      if (!config.simulation) throw new DomainError('SIMULATION_DISABLED', '模拟模式未启用');
      return simulationHandler(config.mockStageMs).execute(input, signal);
    }
    const video = await db.video.findUniqueOrThrow({ where: { id: input.videoId } });
    const base = 'videos/' + video.id;
    if (input.stage === 'FETCH') {
      if (!video.originalUrl) throw new DomainError('UNSUPPORTED_BILIBILI_URL', '视频缺少来源链接');
      const metadata = await checkpoint(input, 'METADATA', video.originalUrl, () => bilibiliMetadata(video.originalUrl!, config, signal));
      const storageKey = base + '/source/' + input.jobId + '.mp4';
      if (!await stat(resolveStorageKey(config.dataDir, storageKey)).catch(() => null)) await downloadBilibili(video.originalUrl, storageKey, config, signal);
      await probeMedia(resolveStorageKey(config.dataDir, storageKey), config, signal);
      return { simulated: false, text: '视频下载完成', metadata, artifact: await describeFile(config.dataDir, storageKey, 'SOURCE_VIDEO', 'video/mp4') };
    }
    if (input.stage === 'EXTRACT_AUDIO') {
      const source = await artifact(video.id, 'SOURCE_VIDEO');
      const sourceFile = resolveStorageKey(config.dataDir, source.storageKey);
      const metadata = await probeMedia(sourceFile, config, signal);
      const storageKey = base + '/audio/' + input.jobId + '-16k.flac';
      const target = resolveStorageKey(config.dataDir, storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      if (!await stat(target).catch(() => null)) {
        const temp = target + '.' + input.leaseOwner + '.part';
        try { await extractAudio(sourceFile, temp, config, signal); await rename(temp, target); }
        finally { await unlink(temp).catch(() => {}); }
      }
      await probeMedia(target, config, signal, false);
      return { simulated: false, text: '已提取 16kHz 单声道音频', metadata: { title: video.title, ...metadata },
        artifact: await describeFile(config.dataDir, storageKey, 'AUDIO', 'audio/flac') };
    }
    if (input.stage === 'TRANSCRIBE') {
      const audio = await artifact(video.id, 'AUDIO');
      const file = resolveStorageKey(config.dataDir, audio.storageKey);
      const { durationMs } = await probeMedia(file, config, signal, false);
      // FLAC worst case stays below the 16-bit PCM upper bound plus margin.
      const seconds = Math.min(config.audioChunkSeconds, Math.floor(config.s2tMaxBytes / 36000));
      const chunks: Awaited<ReturnType<typeof transcribeAudio>>[] = [];
      const count = Math.ceil(durationMs / (seconds * 1000));
      const cacheDir = resolveStorageKey(config.dataDir, base + '/chunks');
      await mkdir(cacheDir, { recursive: true });
      const started = Date.now();
      for (let index = 0; index < count; index++) {
        signal.throwIfAborted();
        const start = index * seconds;
        const duration = Math.min(seconds, durationMs / 1000 - start);
        const cacheKey = { audio: audio.sha256, start, duration, provider: config.s2t, version: 'flac16k-v1' };
        chunks.push(await checkpoint(input, 'TRANSCRIBE', cacheKey, async () => {
          const part = path.join(cacheDir, fingerprint(cacheKey) + '.' + input.leaseOwner + '.flac');
          try {
            await extractAudio(file, part, config, signal, { start, duration });
            return await transcribeAudio(part, Math.round(start * 1000), Math.round(duration * 1000), config, signal);
          } finally { await unlink(part).catch(() => {}); }
        }));
      }
      return { simulated: false, text: '全文转写完成，共 ' + count + ' 个音频分片', transcript: {
        fullText: chunks.map(c => c.text).join('\n\n'), language: chunks[0]?.language || '未指定',
        provider: new URL(config.s2t.url).hostname, model: config.s2t.model, durationMs: Date.now() - started,
        timestampPrecision: chunks.every(c => c.timestampPrecision === 'SEGMENT') ? 'SEGMENT' : 'CHUNK', segments: chunks.flatMap(c => c.segments),
      } };
    }
    const transcript = await db.transcript.findFirst({ where: { videoId: video.id, isCurrent: true } });
    if (!transcript) throw new DomainError('TRANSCRIPT_MISSING', '尚未生成有效文稿');
    const version = await new Settings(db, config).activePrompt();
    const started = Date.now();
    const summary = await summarizeText({
      text: transcript.fullText, prompt: version.body, title: video.title, source: video.sourceType,
      creator: video.creatorName || '未知', durationMs: video.durationMs || 0, language: transcript.language,
      cached: (key, execute) => checkpoint(input, 'SUMMARY_MAP', { transcriptId: transcript.id, prompt: version.hash, model: config.llm, key }, execute),
    }, config, signal);
    return { simulated: false, text: '结构化总结完成', summary: {
      transcriptId: transcript.id, promptVersionId: version.id, provider: new URL(config.llm.url).hostname, model: config.llm.model,
      content: summary.content, chunkCount: summary.chunkCount, durationMs: Date.now() - started,
    } };
  } };
}
