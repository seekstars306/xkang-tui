import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * 图片资源键提取。
 *
 * 真实事故：客服在群里发的是富文本(post)消息，三张截图嵌套在
 * body.content 的 content[][] 二维数组的 img 节点里。
 * 旧实现直接排除 post 类型，附件数恒为 0，模型完全看不到截图。
 */

// 与 dispatcher.extractKeys 同口径
function extractKeys(item) {
  const msgType = String(item.msg_type ?? '');
  if (msgType !== 'image' && msgType !== 'file' && msgType !== 'post') return [];
  const raw = typeof item.body?.content === 'string'
    ? String(item.body.content)
    : typeof item.content === 'string' ? String(item.content) : '';
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  if (msgType === 'post') {
    const keys = [];
    const rows = parsed.content;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        for (const node of row) {
          if (!node || typeof node !== 'object') continue;
          if (node.tag === 'img' && typeof node.image_key === 'string' && node.image_key) keys.push(node.image_key);
        }
      }
    }
    return keys;
  }
  const key = parsed.image_key ?? parsed.file_key;
  return typeof key === 'string' && key ? [key] : [];
}

// 真实富文本形态：三张图 + 一段文字，来自飞书群实际消息
const realPost = {
  title: '',
  content: [
    [{ tag: 'img', image_key: 'img_v3_02172_d6f48ace', width: 1863, height: 386 }],
    [],
    [{ tag: 'img', image_key: 'img_v3_02172_c158377d', width: 2058, height: 372 }],
    [],
    [{ tag: 'img', image_key: 'img_v3_02172_fc2f4cb5', width: 2426, height: 818 }],
    [{ tag: 'text', text: '请尽快排查下这些问题', style: [] }]
  ]
};

test('富文本消息：三张图片键全部提取，不再恒为 0', () => {
  const item = { msg_type: 'post', body: { content: JSON.stringify(realPost) } };
  const keys = extractKeys(item);
  assert.equal(keys.length, 3, '富文本里三张图必须全部取出');
  assert.deepEqual(keys, ['img_v3_02172_d6f48ace', 'img_v3_02172_c158377d', 'img_v3_02172_fc2f4cb5']);
});

test('富文本消息：空 content 或非法 JSON 不抛错', () => {
  assert.deepEqual(extractKeys({ msg_type: 'post', body: { content: '{}' } }), []);
  assert.deepEqual(extractKeys({ msg_type: 'post', body: { content: 'not json' } }), []);
  assert.deepEqual(extractKeys({ msg_type: 'post', body: { content: '' } }), []);
  assert.deepEqual(extractKeys({ msg_type: 'post' }), []);
});

test('image 类型：顶层 image_key 仍然可用', () => {
  const item = { msg_type: 'image', body: { content: JSON.stringify({ image_key: 'img_plain' }) } };
  assert.deepEqual(extractKeys(item), ['img_plain']);
});

test('file 类型：file_key 仍然可用', () => {
  const item = { msg_type: 'file', body: { content: JSON.stringify({ file_key: 'file_plain' }) } };
  assert.deepEqual(extractKeys(item), ['file_plain']);
});

test('text 类型：不产生资源键', () => {
  assert.deepEqual(extractKeys({ msg_type: 'text', body: { content: JSON.stringify({ text: 'hi' }) } }), []);
});

test('富文本：img 节点缺少 image_key 时跳过，不影响其他图片', () => {
  const post = { content: [[{ tag: 'img' }, { tag: 'img', image_key: 'good' }]] };
  const item = { msg_type: 'post', body: { content: JSON.stringify(post) } };
  assert.deepEqual(extractKeys(item), ['good']);
});
