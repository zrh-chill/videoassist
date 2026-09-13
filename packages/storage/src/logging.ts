import path from 'node:path';
import { mkdir, appendFile, stat } from 'node:fs/promises';
import { checkedFile } from './maintenance.js';
export function redactLog(value: string) {
  return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|cookie|password|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s"']+/g, raw => { try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; } catch { return '[URL]'; } }).slice(0, 4000);
}
export function createLogger(root: string, role: 'api' | 'worker', maxBytes = 5 * 1024 ** 2) {
  let queue = Promise.resolve(); let day = ''; let sequence = 0;
  return (record: Record<string, unknown>) => {
    queue = queue.then(async () => {
      const now = new Date(); const date = now.toISOString().slice(0, 10);
      if (day !== date) { day = date; sequence = 0; }
      await mkdir(path.join(root, 'logs'), { recursive: true }); await checkedFile(root, 'logs');
      const safe = Object.fromEntries(Object.entries(record).filter(([key]) => !/key|authorization|cookie|password|token|body|prompt/i.test(key)).map(([key, value]) => [key, typeof value === 'string' ? redactLog(value) : value]));
      const line = JSON.stringify({ at: now.toISOString(), ...safe }) + '\n';
      let file: string;
      while (true) {
        file = path.join(root, 'logs', role + '-' + day + '-' + sequence + '.jsonl');
        const info = await stat(file).catch(() => null);
        if (!info || info.size + Buffer.byteLength(line) <= maxBytes) break;
        sequence++;
      }
      if (await stat(file).catch(() => null)) await checkedFile(root, 'logs/' + path.basename(file));
      await appendFile(file, line);
    }).catch(() => {}); // Logging failure must not corrupt task state.
    return queue;
  };
}
