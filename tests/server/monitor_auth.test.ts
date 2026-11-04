import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword, createSessionCookie, readSession, clearSessionCookie } from '../../server/src/feishu/monitor_auth.ts';

const SECRET = 'test-secret-0123456789';

function fakeReq(cookie?: string) {
  return { headers: cookie ? { cookie } : {} } as unknown as import('express').Request;
}

test('密码哈希可验证，错误密码不通过', () => {
  const stored = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('同一密码两次哈希不同（盐随机），但都能验证通过', () => {
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notEqual(a, b, '必须加盐，否则相同密码哈希相同');
  assert.equal(verifyPassword('same', a), true);
  assert.equal(verifyPassword('same', b), true);
});

test('登录后签发的 Cookie 能被校验并取回用户名', () => {
  const cookie = createSessionCookie('alice', SECRET);
  const value = cookie.split(';')[0];
  const session = readSession(fakeReq(value), SECRET);
  assert.equal(session?.u, 'alice');
});

test('篡改 Cookie 内容后校验失败', () => {
  const cookie = createSessionCookie('alice', SECRET).split(';')[0];
  const [name, token] = cookie.split('=');
  const [body, sig] = token.split('.');
  // 把用户名改成 admin，签名不变
  const forgedBody = Buffer.from(JSON.stringify({ u: 'admin', exp: Date.now() + 999999 })).toString('base64url');
  const forged = `${name}=${forgedBody}.${sig}`;
  assert.equal(readSession(fakeReq(forged), SECRET), null, '改内容必须失效');
  // 保留 body 改签名同理
  assert.equal(readSession(fakeReq(`${name}=${body}.AAAA`), SECRET), null);
});

test('换一个密钥后旧 Cookie 失效', () => {
  const cookie = createSessionCookie('alice', SECRET).split(';')[0];
  assert.equal(readSession(fakeReq(cookie), 'another-secret'), null);
});

test('过期会话被拒绝', () => {
  const past = Date.now() - 9 * 60 * 60 * 1000;
  const cookie = createSessionCookie('alice', SECRET, past).split(';')[0];
  assert.equal(readSession(fakeReq(cookie), SECRET), null);
});

test('没有 Cookie 或格式异常时返回 null，不抛错', () => {
  assert.equal(readSession(fakeReq(), SECRET), null);
  assert.equal(readSession(fakeReq('other=1'), SECRET), null);
  assert.equal(readSession(fakeReq('xkang_monitor_session=bad'), SECRET), null);
});

test('Cookie 属性包含 HttpOnly 与 SameSite，避免脚本读取和跨站提交', () => {
  const cookie = createSessionCookie('alice', SECRET);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
});
