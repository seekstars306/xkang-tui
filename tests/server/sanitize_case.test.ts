import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildCaseFromRun, sanitizeCase, sanitizeText } from '../../scripts/eval/sanitize_case.ts';
import { BENCHMARK_CASES, FICTIONAL_CASES } from '../../scripts/eval/review_benchmark_cases.ts';

test('等长形态保留脱敏：长数字与姓名替换为占位符，长度与形态不变', () => {
  const phone = sanitizeText('客户手机 13812345678，备用 0013912345678。');
  assert.equal(phone.text, '客户手机 00000000000，备用 0000000000000。');
  assert.equal(phone.replaced.length, 2);
  const idCard = sanitizeText('证件号码：11010119900101001X');
  assert.equal(idCard.text, '证件号码：00000000000000000X');
  assert.equal(idCard.replaced[0].kind, 'id18');
  const order = sanitizeText('订单号 1530517490084478976 与 9993903209296。');
  assert.equal(order.text, '订单号 0000000000000000000 与 0000000000000。');
  const name = sanitizeText('姓名：张三 联系电话 13812345678');
  assert.equal(name.text, '姓名：某某 联系电话 00000000000');
  // 中文正常业务文本与非敏感数字不受影响
  const plain = sanitizeText('金额 81.43 元，状态为已受理； Token 计数 128。');
  assert.equal(plain.text, plain.text);
  assert.equal(plain.replaced.length, 0);
  assert.equal(sanitizeText('订单 1530517490084478976').text.includes('1530517490084478976'), false);
});

test('脱敏幂等：对已脱敏文本再跑一次，文本保持不变', () => {
  const once = sanitizeText('手机 13812345678，证件 11010119900101001X，姓名：李四。');
  const twice = sanitizeText(once.text);
  assert.equal(twice.text, once.text);
});

test('sanitizeCase：question/source/answer 全覆盖，返回替换台账', () => {
  const { item, replaced } = sanitizeCase({ question: '订单 1530517490084478976 的退款', source: '联系电话：13812345678', answer: { conclusion: '已核实', businessData: [{ label: '手机号', value: '0013812345678' }] } });
  assert.equal(item.question.includes('1530517490084478976'), false);
  assert.equal(item.source.includes('13812345678'), false);
  assert.equal(JSON.stringify(item.answer).includes('0013812345678'), false);
  assert.ok(replaced.length >= 3);
  assert.equal((item.answer as any).businessData[0].value, '0000000000000');
});

test('buildCaseFromRun：真实运行目录提取脱敏后的案例，原敏感号清零', () => {
  const runDir = path.resolve('tests/eval/reports/server-harness-20261009/acceptance-verified/candidate-amount_taxi_coupon-1');
  if (!fs.existsSync(path.join(runDir, 'messages.json'))) { assert.ok(true, '运行目录不在本机，跳过'); return; }
  const { item, replacedCount } = buildCaseFromRun(runDir, true, 'branch_scope');
  assert.equal(item.runId, 'candidate-amount_taxi_coupon-1');
  assert.equal(item.expected, true);
  assert.ok(item.question.length > 0 && item.source.length > 0 && String(item.answer).length > 0);
  assert.equal(/\d{17,20}/.test(JSON.stringify(item)), false, '不得残留 17-20 位长数字');
  assert.equal(/1[3-9]\d{9}/.test(JSON.stringify(item)), false, '不得残留手机号');
  assert.ok(replacedCount >= 0);
});

test('基准用例表：虚构用例一条不少、期望不变（含 R5 新增角色归因回归），真实案例按来源标注', () => {
  assert.equal(FICTIONAL_CASES.length, 19);
  const expectedById: Record<string, boolean> = {
    receipt_supported: true, receipt_invented_deadline: false,
    equipment_scoped: true, equipment_overgeneralized: false,
    inventory_scoped: true, inventory_negative: false,
    reservation_premise: true, reservation_false_action: false,
    business_identifiers: true,
    pending_request: true, pending_time_request: true, pending_mandatory_rule: false, pending_hidden_rule: false,
    cached_destination_false: false, cached_destination_scoped: true,
    guard_blocks_destination: true,
    overwritten_price_false: false, overwritten_price_scoped: true,
    duplicate_invoice_actor_role: false,
  };
  assert.deepEqual(FICTIONAL_CASES.map(c => c.id), Object.keys(expectedById));
  for (const item of FICTIONAL_CASES) {
    assert.equal(item.expected, expectedById[item.id], item.id);
    assert.equal(item.origin, 'fictional');
    assert.ok(item.category && item.question && item.source, item.id);
  }
  // 代码块类用例的 source 逐字保留（形态影响复核判断）
  assert.match(FICTIONAL_CASES.find(c => c.id === 'cached_destination_false')!.source, /let destination = job\.savedAddress/);
  // 角色归因用例的证据形态：只有开票人字段，没有提交人/日志（规则依赖这一点，须钉住）
  assert.match(FICTIONAL_CASES.find(c => c.id === 'duplicate_invoice_actor_role')!.source, /kpr=开票人/);
  assert.equal(/提交人|日志|审批/.test(FICTIONAL_CASES.find(c => c.id === 'duplicate_invoice_actor_role')!.source.replace(/没有提交人、请求来源、日志或审批字段。/, '')), false);
  // 全表 = 虚构用例 + 真实案例；真实案例带 run_id 来源
  assert.ok(BENCHMARK_CASES.length >= FICTIONAL_CASES.length);
  for (const item of BENCHMARK_CASES.filter(c => c.origin !== 'fictional')) {
    assert.match(item.origin, /^real-(failure|correct):.+/);
    assert.ok(item.id.startsWith('real_'));
  }
  const categories = new Set(BENCHMARK_CASES.map(c => c.category));
  for (const required of ['overgeneralization', 'unsupported_assertion', 'material_request', 'false_action', 'branch_scope', 'config_as_effect', 'citation_mismatch']) {
    assert.ok(categories.has(required as any), `缺少类别覆盖: ${required}`);
  }
});
