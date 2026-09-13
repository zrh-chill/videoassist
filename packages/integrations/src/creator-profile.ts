import { z } from 'zod';
import { normalizeCreator } from './creators.js';

export interface CreatorProfile { name: string | null; avatarUrl: string | null; followers: number | null; bio: string | null }
// Public profile lookup is independent of checking/importing videos.
export function createProfileLookup(request: typeof fetch = fetch) {
  const cache = new Map<string, { expires: number; value: Promise<CreatorProfile> }>();
  return (input: string): Promise<CreatorProfile> => {
    const { uid } = normalizeCreator(input);
    const existing = cache.get(uid);
    if (existing && existing.expires > Date.now()) return existing.value;
    const entry = { expires: Date.now() + 3600000, value: Promise.resolve<CreatorProfile>({ name: null, avatarUrl: null, followers: null, bio: null }) };
    entry.value = (async () => {
      try {
        const response = await request('https://api.bilibili.com/x/web-interface/card?mid=' + uid, {
          headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://space.bilibili.com/' }, redirect: 'error', signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('Profile unavailable');
        const data = z.object({ code: z.literal(0), data: z.object({ follower: z.number().int().nonnegative().optional(), card: z.object({ name: z.string().max(200), face: z.string().url(), fans: z.number().int().nonnegative().optional(), sign: z.string().optional() }) }) }).parse(await response.json());
        const avatar = new URL(data.data.card.face);
        if (!['http:', 'https:'].includes(avatar.protocol) || !avatar.hostname.endsWith('.hdslb.com') || avatar.username || avatar.password || avatar.port) throw new Error('Invalid avatar');
        avatar.protocol = 'https:';
        return { name: data.data.card.name, avatarUrl: avatar.href, followers: data.data.follower ?? data.data.card.fans ?? null, bio: data.data.card.sign?.trim() || null };
      } catch {
        entry.expires = Date.now() + 300000;
        return { name: null, avatarUrl: null, followers: null, bio: null };
      }
    })();
    if (cache.size >= 500) cache.delete(cache.keys().next().value!);
    cache.set(uid, entry);
    return entry.value;
  };
}
