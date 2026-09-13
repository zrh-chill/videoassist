import { PrismaClient } from '@prisma/client';

export function createDatabase(databaseUrl: string) {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}
export async function initializeDatabase(db: PrismaClient) {
  await db.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await db.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  await db.workerLease.upsert({
    where: { id: 'singleton' }, update: {},
    create: { id: 'singleton', expiresAt: new Date(0) },
  });
}
export type Database = PrismaClient;
