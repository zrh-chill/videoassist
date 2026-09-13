import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadConfig, projectRoot } from '../packages/config/src/index.js';
import { initializeStorage } from '../packages/storage/src/index.js';
import { createDatabase } from '../packages/database/src/client.js';

const config = loadConfig();
await initializeStorage(config.dataDir);
// Recover/checkpoint a WAL left by an interrupted process before the schema engine takes its lock.
// This never deletes database files; a live writer must be stopped first.
const database = createDatabase(config.databaseUrl + (config.databaseUrl.includes('?') ? '&' : '?') + 'connection_limit=1');
try {
  const result = await database.$queryRawUnsafe<Array<{ busy: bigint }>>('PRAGMA wal_checkpoint(TRUNCATE)');
  if (result.some(row => Number(row.busy) !== 0)) throw new Error('数据库仍在使用，请先停止 API 和 Worker 再迁移');
  // Prisma's schema engine needs the rollback journal for this existing Windows database.
  // A single connection avoids our own pool retaining a read lock during the mode change.
  await database.$queryRawUnsafe('PRAGMA journal_mode=DELETE');
} finally { await database.$disconnect(); }
const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy',
  '--schema', path.join(projectRoot, 'packages/database/prisma/schema.prisma')], {
  cwd: projectRoot, stdio: 'inherit', shell: false,
  // Prisma 6 SQLite bootstrap can return an empty schema-engine error without this.
  // https://github.com/prisma/prisma/issues/29355
  env: { ...process.env, DATABASE_URL: config.databaseUrl, RUST_LOG: process.env.RUST_LOG || 'info' },
});
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
