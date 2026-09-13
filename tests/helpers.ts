import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../packages/config/src/index.js';
import type { Database } from '../packages/database/src/client.js';

export async function applyTestMigrations(db: Database) {
  const root = path.join(projectRoot, 'packages/database/prisma/migrations');
  for (const entry of (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = await readFile(path.join(root, entry.name, 'migration.sql'), 'utf8');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  }
}
