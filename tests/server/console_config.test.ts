import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_FIELDS, applyEnvChanges, configField, describeConfig, editableKeys, envFilePath, envValue,
  parseEnv, validateConfigValue, writeEnvFile,
} from '../../server/src/feishu/console_config.ts';

const BASE = [
  '# 注释一',
  'PORT=8600',
  '',
  '# 注释二：中文注释必须原样保留',
  'CODE_REPO_PATH=D:/skt_project',
  'DEEPSEEK_BASE_URL=http://127.0.0.1:3065/v1',
  'DEEPSEEK_BASE_URL=http://127.0.0.1:3425/v1',
  'FEATURE_INPUT_GUARD=1',
  '',
].join('\r\n');

test('解析 .env：跳过注释与空行，保留出现顺序', () => {
  const entries = parseEnv(BASE);
  assert.deepEqual(entries.map(e => e.key), ['PORT', 'CODE_REPO_PATH', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_BASE_URL', 'FEATURE_INPUT_GUARD']);
  assert.equal(envValue(BASE, 'CODE_REPO_PATH'), 'D:/skt_project');
  assert.equal(envValue(BASE, 'NOT_SET'), '');
});

test('修改已存在的键：只动目标行，注释、空行、行序原样保留', () => {
  const r = applyEnvChanges(BASE, [{ key: 'CODE_REPO_PATH', value: 'D:/other' }]);
  assert.ok(r.ok, r.error);
  const lines = r.text!.split('\r\n');
  assert.equal(lines[0], '# 注释一');
  assert.equal(lines[1], 'PORT=8600');
  assert.equal(lines[2], '');
  assert.equal(lines[3], '# 注释二：中文注释必须原样保留');
  assert.equal(lines[4], 'CODE_REPO_PATH=D:/other');
  assert.deepEqual(r.updated, ['CODE_REPO_PATH']);
  assert.deepEqual(r.added, []);
});

test('重复键一次性对齐：不会留下另一个值继续干扰排查', () => {
  const r = applyEnvChanges(BASE, [{ key: 'DEEPSEEK_BASE_URL', value: 'http://127.0.0.1:9999/v1' }]);
  assert.ok(r.ok, r.error);
  assert.deepEqual(parseEnv(r.text!).filter(e => e.key === 'DEEPSEEK_BASE_URL').map(e => e.value), ['http://127.0.0.1:9999/v1', 'http://127.0.0.1:9999/v1']);
});

test('新键追加到末尾，行尾 CRLF 与文件一致', () => {
  const r = applyEnvChanges(BASE, [{ key: 'SHARE_TTL_HOURS', value: '72' }]);
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.added, ['SHARE_TTL_HOURS']);
  assert.ok(r.text!.endsWith('SHARE_TTL_HOURS=72\r\n'));
  assert.equal(envValue(r.text!, 'PORT'), '8600');
});

test('编码损坏时拒绝写入，不做任何改动', () => {
  const broken = BASE.replace('CODE_REPO_PATH=D:/skt_project', 'CODE_REPO_PATH=\uFFFD?');
  const r = applyEnvChanges(broken, [{ key: 'PORT', value: '9000' }]);
  assert.equal(r.ok, false);
  assert.match(r.error!, /编码损坏/);
  assert.equal(r.text, undefined);
});

test('取值校验：数字范围、枚举、布尔、换行', () => {
  assert.equal(validateConfigValue(configField('CONTEXT_TOKENS')!, '1048576'), null);
  assert.match(validateConfigValue(configField('CONTEXT_TOKENS')!, '10')!, /不能小于/);
  assert.match(validateConfigValue(configField('CONTEXT_TOKENS')!, 'abc')!, /非负整数/);
  assert.equal(validateConfigValue(configField('REVIEW_MODE')!, 'off'), null);
  assert.match(validateConfigValue(configField('REVIEW_MODE')!, 'on')!, /只能是/);
  assert.equal(validateConfigValue(configField('FEATURE_INPUT_GUARD')!, 'true'), null);
  assert.match(validateConfigValue(configField('FEATURE_INPUT_GUARD')!, 'yes')!, /true/);
  assert.match(validateConfigValue(configField('CODE_REPO_PATH')!, 'a\nb')!, /换行/);
  assert.equal(validateConfigValue(configField('CODE_REPO_PATH')!, ''), null);
});

test('配置视图：密钥只回长度不回内容，标出只读项', () => {
  const view = describeConfig(BASE);
  const secret = view.find(v => v.key === 'DEEPSEEK_API_KEY')!;
  assert.equal(secret.kind, 'secret');
  assert.equal(secret.value, '');
  assert.equal(secret.secretLength, 0);
  assert.equal(secret.present, false);
  const plain = view.find(v => v.key === 'CODE_REPO_PATH')!;
  assert.equal(plain.value, 'D:/skt_project');
  assert.equal(plain.present, true);
  const ro = view.find(v => v.key === 'XKANG_MONITOR_ACCOUNTS')!;
  assert.equal(ro.readOnly, true);
  assert.ok(!editableKeys().includes('XKANG_MONITOR_ACCOUNTS'));
  assert.ok(editableKeys().includes('CODE_REPO_PATH'));
});

test('写文件：先备份、写后回读校验，键都能读回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, BASE, 'utf8');
  try {
    const r = writeEnvFile(file, [{ key: 'CODE_REPO_PATH', value: 'D:/skt_project2' }, { key: 'SHARE_TTL_HOURS', value: '72' }], new Date('2026-11-05T10:00:00Z'));
    assert.ok(r.ok, r.error);
    assert.ok(r.backupPath && fs.existsSync(r.backupPath), '应留下备份');
    assert.equal(fs.readFileSync(r.backupPath!, 'utf8'), BASE, '备份内容是改动前的原文');
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(envValue(after, 'CODE_REPO_PATH'), 'D:/skt_project2');
    assert.equal(envValue(after, 'SHARE_TTL_HOURS'), '72');
    assert.equal(envValue(after, 'PORT'), '8600');
    assert.ok(after.includes('# 注释二：中文注释必须原样保留'));
    assert.ok(!after.includes('\uFFFD'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('没有改动时不写盘、不产生备份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, BASE, 'utf8');
  try {
    const before = fs.statSync(file).mtimeMs;
    const r = writeEnvFile(file, [{ key: 'PORT', value: '8600' }]);
    assert.ok(r.ok, r.error);
    assert.equal(r.backupPath, undefined);
    assert.equal(fs.statSync(file).mtimeMs, before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('env 路径按模块位置解析，不随启动目录漂移', () => {
  const p = envFilePath();
  assert.ok(p.endsWith(path.join('server', '.env')), p);
});

test('schema 自身完整性：键名唯一、标签分组齐全', () => {
  const keys = CONFIG_FIELDS.map(f => f.key);
  assert.equal(new Set(keys).size, keys.length, '配置键不能重复');
  for (const f of CONFIG_FIELDS) {
    assert.ok(f.label && f.group, f.key + ' 缺少 label/group');
    if (f.kind === 'enum') assert.ok(f.options && f.options.length > 0, f.key + ' 枚举为空');
  }
});
