import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIPv4 } from 'node:net';
import { DomainError } from '../../domain/src/index.js';
import { normalizeBilibiliUrl } from './bilibili.js';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(address, prefix);
export const isPublicIPv4 = (address: string) => isIPv4(address) && !blocked.check(address);
const invalid = () => new DomainError('UNSUPPORTED_BILIBILI_URL', '仅支持 B 站第一分 P 视频链接和 b23.tv 短链接');
function validate(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw invalid();
  if (url.hostname === 'b23.tv' && /^\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) return url;
  normalizeBilibiliUrl(url.href);
  return url;
}

async function readRedirect(url: URL, signal: AbortSignal): Promise<string> {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.throwIfAborted(); signal.addEventListener('abort', cancel, { once: true });
  let addresses: string[];
  try { addresses = await resolver.resolve4(url.hostname); }
  finally { signal.removeEventListener('abort', cancel); }
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(address => !isPublicIPv4(address))) throw invalid();
  return new Promise((resolve, reject) => {
    // Pin the checked address while keeping TLS verification and Host bound to b23.tv.
    const req = request(url, { method: 'GET', signal, agent: false, family: 4, maxHeaderSize: 16384,
      lookup: (_hostname, _options, callback) => callback(null, addresses[0]!, 4),
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    }, response => {
      const location = response.headers.location;
      const status = response.statusCode || 0;
      response.destroy();
      if ([301, 302, 303, 307, 308].includes(status) && location && location.length <= 2048) resolve(location);
      else reject(new DomainError('BILIBILI_SHORT_LINK_FAILED', '短链接未返回有效视频地址，请使用标准 BV 链接', status === 429 || status >= 500));
    });
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.end();
  });
}

export async function resolveBilibiliUrl(input: string, redirect = readRedirect) {
  const signal = AbortSignal.timeout(10000);
  const visited = new Set<string>();
  let url = validate(input);
  try {
    for (let hop = 0; hop < 4; hop++) {
      signal.throwIfAborted();
      if (url.hostname !== 'b23.tv') return normalizeBilibiliUrl(url.href);
      if (visited.has(url.href)) throw invalid();
      visited.add(url.href);
      const location = await redirect(url, signal);
      url = validate(new URL(location, url).href);
    }
    if (url.hostname !== 'b23.tv') return normalizeBilibiliUrl(url.href);
    throw invalid();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('BILIBILI_SHORT_LINK_FAILED', '短链接解析失败或超时，请稍后重试或使用标准 BV 链接', true);
  }
}
