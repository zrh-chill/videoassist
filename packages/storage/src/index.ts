import path from 'node:path';
import { mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { DomainError } from '../../domain/src/index.js';

export function resolveStorageKey(root: string, key: string): string {
  if (!key || path.isAbsolute(key) || key.includes('\\') || key.includes(':')) {
    throw new DomainError('INVALID_STORAGE_KEY', '文件路径无效');
  }
  const target = path.resolve(root, key);
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DomainError('INVALID_STORAGE_KEY', '文件路径无效');
  }
  return target;
}
export async function initializeStorage(root: string) {
  for (const folder of ['db', 'videos', 'temp', 'logs']) await mkdir(path.join(root, folder), { recursive: true });
  await access(root, constants.R_OK | constants.W_OK);
}
