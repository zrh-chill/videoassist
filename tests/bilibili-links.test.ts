import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIPv4, resolveBilibiliUrl } from '../packages/integrations/src/bilibili-links.js';

const canonical = 'https://www.bilibili.com/video/BV17xo9BsEnx/';
test('标准链接无需请求；短链接逐跳校验后规范化为相同 BVID', async () => {
  assert.equal((await resolveBilibiliUrl(canonical, async () => { throw Error('不应联网'); })).url, canonical);
  let calls = 0;
  const result = await resolveBilibiliUrl('https://b23.tv/abc', async () => ++calls === 1 ? '/def' : canonical + '?p=1&tracking=test');
  assert.equal(result.url, canonical); assert.equal(calls, 2);
});
test('恶意主机、内网、凭据与第二分 P 在发出下一跳请求前拒绝', async () => {
  for (const target of ['http://b23.tv/abc', 'https://127.0.0.1/', 'https://b23.tv.evil.test/abc', 'https://user@b23.tv/abc', canonical + '?p=2', 'https://www.bilibili.com/api']) {
    let calls = 0;
    await assert.rejects(resolveBilibiliUrl('https://b23.tv/abc', async () => { calls++; return target; }), { code: 'UNSUPPORTED_BILIBILI_URL' });
    assert.equal(calls, 1);
  }
});
test('循环与无限重定向有上限，网络错误不会暴露底层内容', async () => {
  await assert.rejects(resolveBilibiliUrl('https://b23.tv/abc', async () => '/abc'), { code: 'UNSUPPORTED_BILIBILI_URL' });
  let calls = 0;
  await assert.rejects(resolveBilibiliUrl('https://b23.tv/abc', async () => '/x' + ++calls));
  assert.equal(calls, 4);
  await assert.rejects(resolveBilibiliUrl('https://b23.tv/abc', async () => { throw Error('secret-network-detail'); }), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('secret')); return true;
  });
});
test('DNS 结果拒绝内网、保留网段与 IPv6 地址', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.1.1', '192.168.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicIPv4(address), false, address);
  assert.equal(isPublicIPv4('1.1.1.1'), true);
});
