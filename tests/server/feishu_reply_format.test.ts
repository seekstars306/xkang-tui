import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpAgentRunner } from '../../server/src/feishu/runner.ts';

/** format 是 private，借个子类把它暴露出来做单测 */
class Probe extends HttpAgentRunner {
  run(answer: unknown, issueId: string): string {
    return (this as unknown as { format(a: unknown, i: string): string }).format(answer, issueId);
  }
}
const probe = new Probe({ baseUrl: 'http://127.0.0.1:8600', token: 't' });

const ANSWER = {
  conclusion: '两笔火车票订单均未收款，页面提示是提交前被拦下的。',
  businessData: [
    { label: '乘客姓名', value: '范明生' },
    { label: '火车票订单号1', value: '1559576307896025088' },
    { label: '两笔合计票价', value: '328元' },
    { label: '导出文件下载链接', value: 'http://116.205.106.6/files/a.xlsx?e=1&s=2' },
  ],
  pendingItems: ['需确认"点击"的具体时间。', '需确认收款栏是否为空。'],
  reviewStatus: 'needs_human',
};

test('默认只发结论：业务信息只留链接，待确认不发', () => {
  delete process.env.FEISHU_REPLY_DETAIL;
  const text = probe.run(ANSWER, 'abc12345');
  assert.match(text, /【结论】\n两笔火车票订单均未收款/);
  // 链接是交付物，保留
  assert.match(text, /导出文件下载链接：http:\/\/116\.205\.106\.6/);
  // 普通业务信息不发
  assert.doesNotMatch(text, /乘客姓名/);
  assert.doesNotMatch(text, /328元/);
  // 待确认不发（详情页里有）
  assert.doesNotMatch(text, /【还需确认】/);
  assert.doesNotMatch(text, /点击.*具体时间/);
  // 安全提示和编号保留
  assert.match(text, /本结论尚未完成自动复核/);
  assert.match(text, /问题编号 abc12345/);
});

test('FEISHU_REPLY_DETAIL=full 回到旧行为：结论 + 业务信息 + 待确认', () => {
  process.env.FEISHU_REPLY_DETAIL = 'full';
  try {
    const text = probe.run(ANSWER, 'abc12345');
    assert.match(text, /【业务信息】/);
    assert.match(text, /乘客姓名：范明生/);
    assert.match(text, /328元/);
    assert.match(text, /【还需确认】/);
    assert.match(text, /需确认"点击"的具体时间/);
  } finally { delete process.env.FEISHU_REPLY_DETAIL; }
});

test('结论为空时用兜底句，不输出空的【结论】', () => {
  const text = probe.run({ conclusion: '', businessData: [], pendingItems: [] }, 'x');
  assert.match(text, /本次未形成可直接采信的结论/);
});

test('多个链接也只留前 3 个，避免又变成长文', () => {
  const many = { conclusion: 'c', businessData: [1, 2, 3, 4, 5].map(i => ({ label: '链接' + i, value: 'http://x/' + i })), pendingItems: [] };
  const text = probe.run(many, 'x');
  assert.equal((text.match(/http:\/\/x\//g) || []).length, 3);
});

test('复核未完成时安全提示一定在，且简洁模式也保留', () => {
  const text = probe.run({ conclusion: 'c', reviewStatus: 'needs_human' }, 'x');
  assert.match(text, /建议二线核实后再答复客户/);
  const ok = probe.run({ conclusion: 'c', reviewStatus: 'reviewed' }, 'x');
  assert.doesNotMatch(ok, /建议二线核实/);
});
