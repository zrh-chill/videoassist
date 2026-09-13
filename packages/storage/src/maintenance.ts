import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, lstat, realpath, readFile, writeFile, copyFile, rename, unlink } from 'node:fs/promises';
import { z } from 'zod';
import type { Database } from '../../database/src/client.js';
import { Settings } from '../../database/src/settings.js';
import { projectRoot, type AppConfig } from '../../config/src/index.js';
import { configValues } from '../../config/src/settings.js';
import { DomainError } from '../../domain/src/index.js';
import { resolveStorageKey } from './index.js';
import { describeFile } from './media.js';
export async function checkedFile(root: string, key: string) {
  const target = resolveStorageKey(root, key);
  const actualRoot = await realpath(root);
  const actual = await realpath(target);
  const relative = path.relative(actualRoot, actual);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new DomainError('INVALID_STORAGE_KEY', '文件越出数据目录');
  let current = root;
  for (const part of key.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new DomainError('INVALID_STORAGE_KEY', '不处理符号链接或目录联接');
  }
  return target;
}
async function* regularFiles(root: string, key: string): AsyncGenerator<{ key: string; modified: number; size: number }> {
  const target = resolveStorageKey(root, key);
  const info = await lstat(target).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  await checkedFile(root, key);
  if (info.isFile()) { yield { key, modified: info.mtimeMs, size: info.size }; return; }
  if (info.isDirectory()) for (const entry of await readdir(target)) yield* regularFiles(root, key + '/' + entry);
}
export async function backupWorkspace(db: Database, config: AppConfig, operationId: string, signal: AbortSignal) {
  z.string().uuid().parse(operationId);
  await mkdir(path.join(config.dataDir, 'backups'), { recursive: true });
  await checkedFile(config.dataDir, 'backups');
  const finalKey = 'backups/' + operationId;
  const existing = await readFile(resolveStorageKey(config.dataDir, finalKey + '/manifest.json'), 'utf8').catch(() => null);
  if (existing) { await checkedFile(config.dataDir, finalKey + '/manifest.json'); return JSON.parse(existing); }
  const stagingKey = 'backups/' + operationId + '-' + randomUUID() + '.partial';
  const staging = resolveStorageKey(config.dataDir, stagingKey);
  await mkdir(path.join(staging, 'db'), { recursive: true });
  const prompt = await new Settings(db, config).activePrompt();
  const source = new DatabaseSync(path.resolve(projectRoot, config.databaseUrl.replace(/^file:/, '').split('?')[0]!), { readOnly: true, timeout: 5000 });
  const target = path.join(staging, 'db/videoassist.sqlite');
  try { signal.throwIfAborted(); await backup(source, target, { rate: 128, progress: () => { signal.throwIfAborted(); } }); }
  finally { source.close(); }
  const snapshot = new DatabaseSync(target, { readOnly: true });
  let files = 0; let bytes = 0; let videos = 0;
  try {
    if (snapshot.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new DomainError('BACKUP_INVALID', '数据库快照校验失败');
    if (snapshot.prepare('PRAGMA foreign_key_check').all().length) throw new DomainError('BACKUP_INVALID', '数据库关联校验失败');
    videos = Number(snapshot.prepare('SELECT COUNT(*) AS count FROM Video').get()!.count);
    for (const row of snapshot.prepare('SELECT storageKey, sha256, kind, mimeType FROM Artifact WHERE deletedAt IS NULL').iterate()) {
      signal.throwIfAborted();
      const key = String(row.storageKey);
      let file: string;
      try { file = await checkedFile(config.dataDir, key); }
      catch { throw new DomainError('BACKUP_MEDIA_MISSING', '存在缺失或不可读取的媒体，备份未完成'); }
      const destination = resolveStorageKey(staging, key);
      await mkdir(path.dirname(destination), { recursive: true }); await copyFile(file, destination);
      const copied = await describeFile(staging, key, row.kind as 'SOURCE_VIDEO' | 'AUDIO', String(row.mimeType));
      if (copied.sha256 !== row.sha256) throw new DomainError('BACKUP_MEDIA_CHANGED', '媒体文件缺失或校验不一致，备份未完成');
      files++; bytes += copied.sizeBytes;
    }
  } finally { snapshot.close(); }
  const values = configValues(config);
  for (const key of ['S2T_BASE_URL', 'LLM_BASE_URL'] as const) {
    try { const url = new URL(values[key]); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; values[key] = url.href; } catch { values[key] = ''; }
  }
  await writeFile(path.join(staging, 'runtime-config.json'), JSON.stringify(values, null, 2));
  await writeFile(path.join(staging, 'summary-prompt.txt'), prompt.body);
  const manifest = { operationId, storageKey: finalKey, createdAt: new Date().toISOString(), videos, files, bytes,
    includes: ['SQLite 在线快照', '全部仍被引用的媒体（含历史版本）', '配置及密钥引用', '当前提示词'],
    secrets: '未备份 .env 原文与引用所指向的密钥/Cookie 文件，恢复时请另行配置',
  };
  await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  signal.throwIfAborted();
  await rename(staging, resolveStorageKey(config.dataDir, finalKey));
  return manifest;
}
export async function cleanupWorkspace(db: Database, config: AppConfig, signal: AbortSignal, now = Date.now()) {
  const protectedKeys = new Set((await db.artifact.findMany({ select: { storageKey: true } })).map(a => a.storageKey));
  const active = new Set((await db.job.findMany({ where: { status: { in: ['RUNNING', 'QUEUED'] } }, select: { videoId: true } })).map(j => j.videoId));
  let removed = 0; let bytes = 0; let orphans = 0; let missing = 0;
  const clean = async (key: string, age: number, logs = false) => {
    for await (const file of regularFiles(config.dataDir, key)) {
      signal.throwIfAborted();
      if (file.modified > now - age || protectedKeys.has(file.key)) continue;
      if (logs && !/^(api|worker)-\d{4}-\d{2}-\d{2}-\d+\.jsonl$/.test(path.basename(file.key))) continue;
      await checkedFile(config.dataDir, file.key);
      await unlink(resolveStorageKey(config.dataDir, file.key)); removed++; bytes += file.size;
    }
  };
  await clean('temp', 86400000);
  const videos = await db.video.findMany({ select: { id: true } });
  for (const video of videos) if (!active.has(video.id)) await clean('videos/' + video.id + '/chunks', 86400000);
  await clean('logs', 14 * 86400000, true);
  // Report unreferenced permanent media; never delete originals/audio or backup directories.
  for await (const file of regularFiles(config.dataDir, 'videos')) if (!file.key.includes('/chunks/') && !protectedKeys.has(file.key) && file.modified < now - 86400000) orphans++;
  for (const key of protectedKeys) {
    signal.throwIfAborted();
    try { await checkedFile(config.dataDir, key); } catch { missing++; }
  }
  return { removed, bytes, orphans, missing, checkedAt: new Date(now).toISOString() };
}
