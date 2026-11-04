import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPublicText, collectPrivateTerms, parsePublicDraft } from '../../server/src/agent/publication.ts';

test('必要业务数据完整保留，不掩码、不转数字', () => {
  const draft = { conclusion: '已核对客户资料与两笔收款记录。', businessData: [
    { label: '姓名', value: '测试客户' }, { label: '联系电话', value: '0013812345678' },
    { label: '证件号码', value: '11010119900101001X' }, { label: '订单号', value: '1530517490084478976' },
    { label: '金额', value: '81.43' }], evidenceSummary: ['业务记录显示两笔收款。'], customerReply: '我们正在核对退款与收款的对应关系。', pendingItems: [] };
  assert.deepEqual(parsePublicDraft(JSON.stringify(draft), new Set()), draft);
  assert.equal(checkPublicText('数据库维护后订单已恢复；客户手机号为13812345678。', new Set()).length, 0);
});
test('PNR/PDF 这类通用缩写可以作为业务字段名，英文字段名仍然被拒', () => {
  // 现网 2026-10-20 客票 9999204322942：label 写成 "PNR" 触发格式关，复核没进入内容审核即被判需修订，
  // 一份已查清的答案被降级成「本次尚未形成可直接采信的业务结论」。
  const withAbbr = { conclusion: '该客票为改签票。', businessData: [
    { label: '客票号', value: '9999204322942' }, { label: 'PNR', value: 'KX2R6P' }, { label: 'PDF', value: '无' }],
    evidenceSummary: [], customerReply: '', pendingItems: [] };
  assert.deepEqual(parsePublicDraft(JSON.stringify(withAbbr), new Set()), withAbbr);
  // 直接把英文字段名搬进公开答案仍然拒绝：只有 2~6 位全大写缩写被放行
  for (const label of ['Order No', 'total amount', 'receivable_state', 'Pnr', 'PNR CODE', 'ABCDEFGHIJKLMNOP']) {
    const bad = { ...withAbbr, businessData: [{ label, value: 'x' }] };
    assert.throws(() => parsePublicDraft(JSON.stringify(bad), new Set()), /业务字段必须使用中文名称/, label);
  }
});
test('开发信息不能放在公开正文或业务字段中，额外字段不放行', () => {
  const terms = collectPrivateTerms([{ role: 'tool', content: '{"columns":["private_customer_key"],"database":"private_billing"}', evidence: { id: 'e1', observedAt: '', arguments: { filePath: 'D:/secret/BalanceService.java', sql: 'SELECT * FROM private_bill_records' }, outcome: 'success', completeness: 'complete' } }]);
  for (const text of ['SELECT id FROM private_bill_records', 'private_customer_key', 'D:/secret/BalanceService.java', 'http://10.197.1.2:8066/private', '```java\nclass Secret {}\n```']) assert.ok(checkPublicText(text, terms).length, text);
  assert.throws(() => parsePublicDraft(JSON.stringify({ conclusion: '正常', businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [], raw_tool_result: 'secret' }), terms));
});
test('源码中的简单字段条件和声明也必须隔离，完整联系方式不受影响', () => {
  const terms = collectPrivateTerms([{ role: 'tool', name: 'read_file_lines', content: '10: WHERE u.deleted = 0\n11: private BigDecimal serviceCharge;' }]);
  assert.ok(checkPublicText('按 deleted=0 读取配置', terms).length);
  assert.ok(checkPublicText('服务费对应 serviceCharge', terms).length);
  assert.equal(checkPublicText('数据库维护后，客户联系电话0013812345678、证件11010119900101001X保持不变。', terms).length, 0);
});
