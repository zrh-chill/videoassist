import path from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../../config/src/index.js';
import { DomainError } from '../../domain/src/index.js';
import { classifyBilibili, normalizeBilibiliUrl } from './bilibili.js';
import { runTool } from './process.js';
export function normalizeCreator(input: string) {
  let uid = input.trim();
  if (!/^[1-9]\d{0,19}$/.test(uid)) {
    let url: URL;
    try { url = new URL(uid); } catch { throw new DomainError('INVALID_CREATOR', '请输入有效 UID 或 B 站 UP 主主页链接'); }
    if (url.protocol !== 'https:' || url.hostname !== 'space.bilibili.com' || url.username || url.password || url.port) throw new DomainError('INVALID_CREATOR', '仅支持 https://space.bilibili.com/UID 主页');
    uid = /^\/([1-9]\d{0,19})(?:\/(?:upload\/)?video)?\/?$/.exec(url.pathname)?.[1] || '';
    if (!uid) throw new DomainError('INVALID_CREATOR', 'UP 主主页链接无效');
  }
  return { uid, url: 'https://space.bilibili.com/' + uid + '/upload/video' };
}
export interface CreatorVideos { name: string; videos: Array<{ bvid: string; title: string; url: string }> }
export async function fetchCreatorVideos(uid: string, limit: number, config: AppConfig, signal: AbortSignal): Promise<CreatorVideos> {
  const source = normalizeCreator(uid);
  try {
    const output = await runTool(config.ytdlp, ['--ignore-config', '--flat-playlist', '--dump-single-json', '--playlist-end', String(limit),
      '--socket-timeout', '20', '--retries', '1', '--no-warnings',
      ...(config.cookieFile ? ['--cookies', path.resolve(config.cookieFile)] : []), '--', source.url],
    { signal, timeoutMs: 90000, maxOutputBytes: 2 * 1024 ** 2 });
    const data = z.object({ title: z.string().optional(), uploader: z.string().optional(), entries: z.array(z.object({
      id: z.string().optional(), url: z.string().optional(), title: z.string().optional(), uploader: z.string().optional(),
    })) }).parse(JSON.parse(output));
    const videos = data.entries.slice(0, limit).map(entry => {
      const normalized = normalizeBilibiliUrl(/^BV[a-zA-Z0-9]{10}$/.test(entry.id || '') ? 'https://www.bilibili.com/video/' + entry.id + '/' : entry.url || '');
      return { ...normalized, title: (entry.title || normalized.bvid).slice(0, 500) };
    });
    return { name: (data.uploader || data.entries[0]?.uploader || data.title || uid).slice(0, 200), videos: [...new Map(videos.map(v => [v.bvid, v])).values()] };
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw new DomainError('CREATOR_RESPONSE_INVALID', 'UP 主视频列表格式异常');
    classifyBilibili(error);
  }
}
