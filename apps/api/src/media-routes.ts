import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../packages/database/src/client.js';
import type { AppConfig } from '../../../packages/config/src/index.js';
import { MediaLibrary } from '../../../packages/database/src/media.js';
import { Settings } from '../../../packages/database/src/settings.js';
import { Tasks } from '../../../packages/database/src/tasks.js';
import { receiveUpload, moveIntoStorage } from '../../../packages/storage/src/media.js';
import { resolveStorageKey } from '../../../packages/storage/src/index.js';
import { probeMedia } from '../../../packages/integrations/src/ffmpeg.js';
import { resolveVideoCreator } from '../../../packages/integrations/src/bilibili.js';
import { resolveBilibiliUrl } from '../../../packages/integrations/src/bilibili-links.js';
import { DomainError } from '../../../packages/domain/src/index.js';
import { z } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

export function mediaRoutes(app: FastifyInstance, db: Database, base: AppConfig) {
  const settings = new Settings(db, base);
  app.register(multipart, { limits: { fileSize: 4 * 1024 ** 3, files: 1, fields: 0, parts: 1 } });
  const media = new MediaLibrary(db);
  const tasks = new Tasks(db);
  const prefix = '/api/v1/videos';
  const requestKey = (value: unknown) => z.string().min(1).max(128).parse(value);
  const idOf = (params: unknown) => z.object({ id: z.string().uuid() }).parse(params).id;
  app.post(prefix + '/bilibili', async (request, reply) => {
    const body = z.object({ url: z.string().max(2048) }).strict().parse(request.body);
    const key = requestKey(request.headers['idempotency-key']);
    const normalized = await resolveBilibiliUrl(body.url);
    const result = await media.importVideo({ sourceType: 'BILIBILI', title: normalized.bvid, bvid: normalized.bvid, originalUrl: normalized.url }, key);
    if (!result.duplicate && await db.creator.count({ where: { deletedAt: null } })) {
      // Associate before downloading; metadata processing retries this if the public lookup is unavailable.
      const metadata = await resolveVideoCreator(normalized.bvid).catch(() => null);
      if (metadata) await db.$transaction(async tx => {
        const creator = await tx.creator.findFirst({ where: { uid: metadata.creatorUid, deletedAt: null } });
        await tx.video.updateMany({ where: { id: result.id, isDeleted: false }, data: { ...metadata, creatorId: creator?.id } });
        await tx.event.create({ data: { videoId: result.id, payload: JSON.stringify({ videoId: result.id }) } });
      });
    }
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });
  app.post(prefix + '/uploads', async (request, reply) => {
    const config = await settings.effective();
    const key = requestKey(request.headers['idempotency-key']);
    const part = await request.file();
    if (!part) throw new DomainError('INVALID_VIDEO_FILE', '请选择一个视频文件');
    const name = path.basename(part.filename).slice(0, 255);
    const ext = path.extname(name).toLowerCase();
    if (!['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'].includes(ext)) {
      part.file.resume(); throw new DomainError('INVALID_VIDEO_FILE', '支持 MP4、MOV、MKV、WebM、AVI 和 M4V 视频');
    }
    let cleanup: string | undefined;
    try {
      const upload = await receiveUpload(config.dataDir, part.file, config.uploadMaxBytes);
      cleanup = upload.key;
      if (part.file.truncated) throw new DomainError('UPLOAD_TOO_LARGE', '上传文件超过容量限制', false, 413);
      const metadata = await probeMedia(resolveStorageKey(config.dataDir, upload.key), config);
      const id = randomUUID();
      const storageKey = 'videos/' + id + '/source/original' + ext;
      await moveIntoStorage(config.dataDir, upload.key, storageKey); cleanup = storageKey;
      const result = await media.importVideo({
        id, sourceType: 'LOCAL', title: name, localOriginalName: name, sourceHash: upload.sha256, durationMs: metadata.durationMs,
        artifact: { kind: 'SOURCE_VIDEO', storageKey, sizeBytes: upload.sizeBytes, sha256: upload.sha256, mimeType: 'application/octet-stream' },
      }, key);
      if (result.id === id) cleanup = undefined;
      return reply.code(201).send(result);
    } finally { if (cleanup) await unlink(resolveStorageKey(config.dataDir, cleanup)).catch(() => {}); }
  });
  app.get(prefix + '/:id/transcript', async request => {
    const id = idOf(request.params); await tasks.detail(id);
    const { revision } = z.object({ revision: z.coerce.number().int().positive().optional() }).parse(request.query);
    const [current, versions] = await db.$transaction([
      db.transcript.findFirst({ where: { videoId: id, ...(revision ? { revision } : { isCurrent: true }) }, include: { segments: { orderBy: { sequence: 'asc' } } } }),
      db.transcript.findMany({ where: { videoId: id }, select: { id: true, revision: true, isCurrent: true }, orderBy: { revision: 'desc' } }),
    ]);
    return { current, versions };
  });
  app.get(prefix + '/:id/summary', async request => {
    const id = idOf(request.params); await tasks.detail(id);
    const { revision } = z.object({ revision: z.coerce.number().int().positive().optional() }).parse(request.query);
    const [current, versions] = await db.$transaction([
      db.summary.findFirst({ where: { videoId: id, ...(revision ? { revision } : { isCurrent: true }) } }),
      db.summary.findMany({ where: { videoId: id }, select: { id: true, revision: true, isCurrent: true }, orderBy: { revision: 'desc' } }),
    ]);
    return { current, versions };
  });
  app.post(prefix + '/:id/actions/regenerate-summary', async request => media.regenerateSummary(idOf(request.params), requestKey(request.headers['idempotency-key'])));
  app.post(prefix + '/:id/actions/reprocess', async request => {
    const input = z.object({ stage: z.enum(['FETCH', 'EXTRACT_AUDIO', 'TRANSCRIBE', 'SUMMARIZE']), force: z.literal(true), reason: z.string().trim().min(1).max(500) }).strict().parse(request.body);
    return media.reprocess(idOf(request.params), input, requestKey(request.headers['idempotency-key']));
  });
}
