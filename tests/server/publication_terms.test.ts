import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPublicText, collectPrivateTerms } from '../../server/src/agent/publication.ts';

test('源码里的局部变量（app/vip/pdf）不再误杀公开答案', () => {
  const terms = collectPrivateTerms([{ role: 'tool', name: 'read_file_lines', content: '10: const app = getApp();\n11: const vip = getVip();\n12: const pdf = getPdf();', evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' } }]);
  assert.equal(checkPublicText('请引导客户在 APP 中查看 VIP 订单，或导出 PDF 行程单。', terms).length, 0);
  assert.equal(checkPublicText('支持 OTA、SMS、H5、PC 各渠道的订单核验。', terms).length, 0);
});

test('用户自己写过的单号豁免，驼峰内部名不豁免', () => {
  const withUser = collectPrivateTerms([
    { role: 'user', content: '帮我查一下单号 HVBJEE 的订单' },
    { role: 'tool', name: 'codegraph_explore', content: '{"symbol":"HVBJEE"}', evidence: { id: 'e1', observedAt: '', arguments: { symbol: 'HVBJEE' }, outcome: 'success', completeness: 'complete' } },
  ]);
  assert.equal(checkPublicText('单号 HVBJEE 已确认退款。', withUser).length, 0);
  // 大小写不敏感：用户写小写、答案写大写同样豁免
  const lowerUser = collectPrivateTerms([
    { role: 'user', content: 'hvbjee 这笔退款' },
    { role: 'tool', name: 'codegraph_explore', content: '{}', evidence: { id: 'e1', observedAt: '', arguments: { symbol: 'HVBJEE' }, outcome: 'success', completeness: 'complete' } },
  ]);
  assert.equal(checkPublicText('单号 HVBJEE 已确认退款。', lowerUser).length, 0);
  // 13～24 位字母数字供应商单号同样豁免（真实外部单号常在这个长度）
  const longCode = 'HVBJEE20261010ABC123';
  const longTerms = collectPrivateTerms([
    { role: 'user', content: `单号 ${longCode} 到哪了` },
    { role: 'tool', name: 'codegraph_explore', content: '{}', evidence: { id: 'e1', observedAt: '', arguments: { symbol: longCode }, outcome: 'success', completeness: 'complete' } },
  ]);
  assert.equal(checkPublicText(`单号 ${longCode} 已发货。`, longTerms).length, 0);
  // 用户消息里出现驼峰标识也不豁免：orderNew 仍进词表
  const camelTerms = collectPrivateTerms([
    { role: 'user', content: 'orderNew 这个实现对吗' },
    { role: 'tool', name: 'codegraph_explore', content: '{}', evidence: { id: 'e1', observedAt: '', arguments: { symbol: 'orderNew' }, outcome: 'success', completeness: 'complete' } },
  ]);
  assert.ok(checkPublicText('orderNew 已处理。', camelTerms).length);
});

test('真实内部标识仍然拦截', () => {
  const terms = collectPrivateTerms([{ role: 'tool', name: 'read_file_lines', content: '10: private BigDecimal serviceCharge;\n11: class SktHotelCLOrderServiceImpl\n12: if (orderNew != null)\n13: where deleted = 0', evidence: { id: 'e1', observedAt: '', arguments: { sql: 'SELECT * FROM t_order_hotel' }, outcome: 'success', completeness: 'complete' } }]);
  for (const text of ['服务费对应 serviceCharge', '按 deleted=0 读取配置', '订单表 t_order_hotel 有更新', 'SktHotelCLOrderServiceImpl 处理中', 'orderNew 已处理']) {
    assert.ok(checkPublicText(text, terms).length, text);
  }
});

test('词表长度边界：5 字符不入表、6 字符入表', () => {
  const terms = collectPrivateTerms([{ role: 'tool', name: 'read_file_lines', content: '10: private String notes;\n11: private String refund;', evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' } }]);
  assert.equal(checkPublicText('notes 字段的含义', terms).length, 0);
  assert.ok(checkPublicText('refund 字段的含义', terms).length);
});

test('业务数据（订单号/金额/手机号）不受词表影响', () => {
  const terms = collectPrivateTerms([{ role: 'tool', name: 'company_db_query', content: '{"columns":["order_id","amount"],"database":"billing"}', evidence: { id: 'e1', observedAt: '', arguments: { database: 'billing', tableName: 'bill_records' }, outcome: 'success', completeness: 'complete' } }]);
  assert.equal(checkPublicText('订单 1530517490084478976 金额 81.43，客户手机 0013812345678。', terms).length, 0);
});
