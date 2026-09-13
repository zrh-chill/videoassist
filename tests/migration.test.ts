import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { projectRoot } from '../packages/config/src/index.js';
import { createDatabase } from '../packages/database/src/client.js';

test('真实迁移命令可初始化空目录且重复运行无副作用', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'videoassist-migrate-'));
  const databaseUrl = 'file:' + path.join(root, 'db', 'videoassist.sqlite').replaceAll('\\', '/');
  for (let run = 0; run < 3; run++) {
    if (run === 2) {
      const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { PrismaClient } from '@prisma/client';
        const db = new PrismaClient();
        await db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
        await db.video.create({data:{title:'重启恢复验收'}});
        process.exit(0);
      `], { cwd: projectRoot, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 30000 });
      assert.equal(writer.status, 0, writer.stderr);
    }
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
      cwd: projectRoot, env: { ...process.env, DATA_DIR: root, DATABASE_URL: databaseUrl, RUST_LOG: '' },
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  }
  const db = createDatabase(databaseUrl);
  try {
    assert.equal(await db.video.count(), 1);
    const migrations = await db.$queryRawUnsafe<Array<{ finished_at: unknown }>>('SELECT finished_at FROM _prisma_migrations');
    assert.equal(migrations.length, 6);
    assert.ok(migrations.every(migration => migration.finished_at));
  } finally { await db.$disconnect(); }
});
