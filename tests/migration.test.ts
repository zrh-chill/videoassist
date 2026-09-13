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
  for (let run = 0; run < 2; run++) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
      cwd: projectRoot, env: { ...process.env, DATA_DIR: root, DATABASE_URL: databaseUrl, RUST_LOG: '' },
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  }
  const db = createDatabase(databaseUrl);
  try {
    assert.equal(await db.video.count(), 0);
    const migrations = await db.$queryRawUnsafe<Array<{ finished_at: unknown }>>('SELECT finished_at FROM _prisma_migrations');
    assert.equal(migrations.length, 2);
    assert.ok(migrations.every(migration => migration.finished_at));
  } finally { await db.$disconnect(); }
});
