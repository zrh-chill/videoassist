import { z } from 'zod';
import path from 'node:path';
import { mkdir, stat, readdir, rename, unlink } from 'node:fs/promises';
import type { AppConfig } from '../../config/src/index.js';
import { DomainError } from '../../domain/src/index.js';
import { resolveStorageKey } from '../../storage/src/index.js';
import { runTool, ToolError } from './process.js';

export function normalizeBilibiliUrl(input: string): { bvid: string; url: string } {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new DomainError('UNSUPPORTED_BILIBILI_URL', '请输入有效的 B 站视频链接'); }
  const bvid = /^\/video\/(BV[a-zA-Z0-9]{10})\/?$/.exec(url.pathname)?.[1];
  if (url.protocol !== 'https:' || !['www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(url.hostname)
    || url.username || url.password || url.port || !bvid || (url.searchParams.has('p') && url.searchParams.get('p') !== '1')) {
    throw new DomainError('UNSUPPORTED_BILIBILI_URL', '请使用 https://www.bilibili.com/video/BV…/ 单视频链接（目前仅支持第一分 P）');
  }
  return { bvid, url: 'https://www.bilibili.com/video/' + bvid + '/' };
}
export function classifyBilibili(error: unknown): never {
  if (!(error instanceof ToolError)) throw error;
  if (/429|412|rate.limit|too many/i.test(error.output)) throw new DomainError('BILIBILI_RATE_LIMITED', 'B 站请求受限，请稍后重试', true);
  if (/login|cookie|sign.in|会员|登录/i.test(error.output)) throw new DomainError('BILIBILI_COOKIE_EXPIRED', '视频需要有效登录态，请配置 B 站 Cookie 文件后重试');
  if (/404|not.available|not found|不存在|已删除/i.test(error.output)) throw new DomainError('BILIBILI_VIDEO_UNAVAILABLE', 'B 站视频已失效或不可访问');
  throw new DomainError('DOWNLOAD_FAILED', 'B 站解析或下载失败，请检查网络和 yt-dlp 配置', true);
}
function args(config: AppConfig) {
  return ['--ignore-config', '--no-playlist', '--no-warnings', '--socket-timeout', '20', '--retries', '1', '--fragment-retries', '1',
    ...(config.cookieFile ? ['--cookies', path.resolve(config.cookieFile)] : [])];
}
export async function bilibiliMetadata(url: string, config: AppConfig, signal: AbortSignal) {
  const normalized = normalizeBilibiliUrl(url);
  try {
    const raw = await runTool(config.ytdlp, [...args(config), '--skip-download', '--dump-single-json', '--', normalized.url], { signal, code: 'DOWNLOAD_FAILED' });
    const data = z.object({ title: z.string(), duration: z.number().positive(), uploader: z.string().optional(), timestamp: z.number().optional(), thumbnail: z.string().optional() }).parse(JSON.parse(raw));
    return {
      title: data.title.slice(0, 500), durationMs: Math.round(data.duration * 1000), creatorName: data.uploader,
      publishedAt: data.timestamp ? new Date(data.timestamp * 1000).toISOString() : undefined, coverUrl: data.thumbnail,
    };
  } catch (error) { if (error instanceof z.ZodError || error instanceof SyntaxError) throw new DomainError('BILIBILI_RESPONSE_INVALID', '视频元数据格式不正确'); classifyBilibili(error); }
}
export async function downloadBilibili(url: string, key: string, config: AppConfig, signal: AbortSignal) {
  const file = resolveStorageKey(config.dataDir, key);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.download.mp4';
  const bounded = new AbortController();
  let oversized = false;
  let checking = false;
  // yt-dlp's per-stream limit cannot bound an unknown-length combined download.
  const monitor = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const files = (await readdir(path.dirname(file))).filter(name => name.startsWith(path.basename(file)));
      const sizes = await Promise.all(files.map(name => stat(path.join(path.dirname(file), name)).then(info => info.size).catch(() => 0)));
      // Merging temporarily retains both input streams and the output.
      if (sizes.reduce((total, size) => total + size, 0) > config.downloadMaxBytes * 2) { oversized = true; bounded.abort(); }
    } finally { checking = false; }
  }, 500);
  try {
    await runTool(config.ytdlp, [...args(config), '--no-progress', '--max-filesize', String(config.downloadMaxBytes),
      '--format', 'b[ext=mp4]/bv[height<=1080]+ba/b', '--merge-output-format', 'mp4',
      ...(path.isAbsolute(config.ffmpeg) ? ['--ffmpeg-location', config.ffmpeg] : []),
      '--output', temporary, '--', normalizeBilibiliUrl(url).url], { signal: AbortSignal.any([signal, bounded.signal]), timeoutMs: 3600000, code: 'DOWNLOAD_FAILED' });
    const info = await stat(temporary);
    if (info.size > config.downloadMaxBytes) throw new DomainError('DOWNLOAD_TOO_LARGE', '下载文件超过容量限制');
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (oversized) throw new DomainError('DOWNLOAD_TOO_LARGE', '下载超过容量限制，已停止下载');
    classifyBilibili(error);
  } finally { clearInterval(monitor); }
}
