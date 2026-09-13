import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { resolveStorageKey } from './index.js';
import type { MediaArtifact } from '../../contracts/src/media.js';
import { DomainError } from '../../domain/src/index.js';

export async function describeFile(root: string, storageKey: string, kind: MediaArtifact['kind'], mimeType: string): Promise<MediaArtifact> {
  const file = resolveStorageKey(root, storageKey);
  const info = await stat(file).catch(() => { throw new DomainError('ARTIFACT_MISSING', '阶段文件缺失，请重新上传或下载视频'); });
  if (!info.isFile() || !info.size) throw new DomainError('ARTIFACT_MISSING', '阶段文件为空或不可读取');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return { storageKey, kind, mimeType, sizeBytes: info.size, sha256: hash.digest('hex') };
}
export async function receiveUpload(root: string, source: Readable, maxBytes: number) {
  const key = 'temp/' + randomUUID() + '.upload';
  const file = resolveStorageKey(root, key);
  let size = 0; const hash = createHash('sha256');
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    if (size > maxBytes) return callback(new DomainError('UPLOAD_TOO_LARGE', '上传文件超过容量限制', false, 413));
    hash.update(chunk); callback(null, chunk);
  } });
  try { await pipeline(source, meter, createWriteStream(file, { flags: 'wx' })); }
  catch (error) { await unlink(file).catch(() => {}); throw error; }
  return { key, sizeBytes: size, sha256: hash.digest('hex') };
}
export async function moveIntoStorage(root: string, temporaryKey: string, finalKey: string) {
  const target = resolveStorageKey(root, finalKey);
  await mkdir(path.dirname(target), { recursive: true });
  await rename(resolveStorageKey(root, temporaryKey), target);
}
