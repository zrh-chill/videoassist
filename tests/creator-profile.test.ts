import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfileLookup } from '../packages/integrations/src/creator-profile.js';

test('头像查询固定目标并合并并发请求，缓存真实名称与图片', async () => {
  let calls = 0;
  const lookup = createProfileLookup(async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.bilibili.com/x/web-interface/card?mid=37858284');
    assert.equal(options?.redirect, 'error');
    return new Response(JSON.stringify({ code: 0, data: { card: { name: '作者', face: 'http://i0.hdslb.com/bfs/face/avatar.jpg' } } }));
  });
  const results = await Promise.all([lookup('37858284'), lookup('37858284')]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], { name: '作者', avatarUrl: 'https://i0.hdslb.com/bfs/face/avatar.jpg' });
  assert.deepEqual(await lookup('37858284'), results[0]);
  assert.equal(calls, 1);
  assert.throws(() => lookup('https://localhost/profile'), /主页/);
});

test('头像请求失败或返回不可信地址时降级且避免反复请求', async () => {
  for (const response of [new Response('', { status: 412 }), new Response('invalid'), new Response(JSON.stringify({ code: 0, data: { card: { name: '作者', face: 'https://localhost/avatar' } } }))]) {
    let calls = 0;
    const lookup = createProfileLookup(async () => { calls++; return response; });
    assert.deepEqual(await lookup('123456'), { name: null, avatarUrl: null });
    await lookup('123456');
    assert.equal(calls, 1);
  }
});
