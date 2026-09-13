import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, lstat, copyFile, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { checkedFile } from '../packages/storage/src/maintenance.js';
import { resolveStorageKey, initializeStorage } from '../packages/storage/src/index.js';
import { describeFile } from '../packages/storage/src/media.js';
import { DomainError } from '../packages/domain/src/index.js';

export async function restoreBackup(sourcePath: string, destinationPath: string) {
  const source = path.resolve(sourcePath); const destination = path.resolve(destinationPath);
  const manifest = z.object({ operationId: z.string().uuid(), files: z.number().int().nonnegative() }).parse(JSON.parse(await readFile(await checkedFile(source, 'manifest.json'), 'utf8')));
  const existing = await lstat(destination).catch(() => null);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(destination)).length)) throw new DomainError('RESTORE_TARGET_NOT_EMPTY', '恢复目标必须是空目录，不能覆盖现有数据');
  await initializeStorage(destination);
  const databasePath = resolveStorageKey(destination, 'db/videoassist.sqlite');
  await copyFile(await checkedFile(source, 'db/videoassist.sqlite'), databasePath);
  const db = new DatabaseSync(databasePath);
  let files = 0;
  try {
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new DomainError('RESTORE_INVALID', '备份数据库校验失败');
    for (const row of db.prepare('SELECT storageKey,sha256,kind,mimeType FROM Artifact WHERE deletedAt IS NULL').iterate()) {
      const key = String(row.storageKey); const file = await checkedFile(source, key);
      const target = resolveStorageKey(destination, key);
      await mkdir(path.dirname(target), { recursive: true }); await copyFile(file, target);
      const restored = await describeFile(destination, key, row.kind as 'SOURCE_VIDEO' | 'AUDIO', String(row.mimeType));
      if (restored.sha256 !== row.sha256) throw new DomainError('RESTORE_INVALID', '恢复媒体校验失败，请保留原备份并检查磁盘');
      files++;
    }
    if (files !== manifest.files) throw new DomainError('RESTORE_INVALID', '备份清单与媒体数量不一致');
    // Normalize transient execution state only in the new restored database.
    db.exec("BEGIN IMMEDIATE; UPDATE WorkerLease SET owner=NULL, expiresAt=0; UPDATE Operation SET status='CANCELED',activeKey=NULL,leaseOwner=NULL,leaseExpiresAt=NULL,finishedAt=CURRENT_TIMESTAMP,errorMessage='从备份恢复，需重新手动发起' WHERE status IN ('QUEUED','RUNNING'); UPDATE StageRun SET status='INTERRUPTED',finishedAt=CURRENT_TIMESTAMP,errorCode='BACKUP_RESTORED',errorMessage='从备份恢复后继续处理' WHERE status='RUNNING'; UPDATE Video SET overallStatus='WAITING' WHERE id IN (SELECT videoId FROM Job WHERE status='RUNNING'); UPDATE Job SET status='QUEUED',leaseOwner=NULL,leaseExpiresAt=NULL,availableAt=0,maxAttempts=MAX(maxAttempts,attempt+1) WHERE status='RUNNING'; DELETE FROM Command WHERE key LIKE 'daily-cleanup:%'; COMMIT;");
  } finally { db.close(); }
  for (const key of ['runtime-config.json', 'summary-prompt.txt']) await copyFile(await checkedFile(source, key), resolveStorageKey(destination, key));
  await writeFile(path.join(destination, 'restore-complete.json'), JSON.stringify({ sourceOperationId: manifest.operationId, files, restoredAt: new Date().toISOString() }, null, 2));
  return { destination, files, message: '恢复校验完成；配置 DATA_DIR、DATABASE_URL、SUMMARY_PROMPT_FILE 和密钥引用后再启动服务' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) { console.error('用法：pnpm exec tsx scripts/restore.ts <完整备份目录> <空目标目录>'); process.exitCode = 1; }
  else try { console.log(JSON.stringify(await restoreBackup(source, destination))); }
  catch (error) { console.error(error instanceof DomainError ? error.message : '恢复失败，目标目录可能不完整；请检查备份和文件权限'); process.exitCode = 1; }
}
