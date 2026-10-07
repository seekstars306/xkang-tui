import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/dist/index.js';
import { TokenManager } from '../server/dist/token_manager.js';

console.log('========================================================================');
console.log('🧪 开始进行「1人1机1Key 设备绑定与防多人共用」端到端安全测试');
console.log('========================================================================\n');

const TEST_PORT = 8799;
const testTokensPath = path.resolve(process.cwd(), 'server/data/test_device_tokens.json');

process.env.PORT = String(TEST_PORT);
process.env.XKANG_ADMIN_TOKENS = 'adm_security_master:MasterAdmin';
process.env.XKANG_LLM_MOCK = '1';
process.env.TOKENS_JSON_PATH = testTokensPath;

const tokenManager = new TokenManager(testTokensPath);

// Create a new key for testing
const testRecord = tokenManager.createToken('测试客服-小张');
const testKey = testRecord.token;

const { server } = startServer();
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runDeviceLockTests() {
  try {
    const DEVICE_A = 'COMPUTER_ZHANG_LAPTOP_HASH_AAA111';
    const DEVICE_B = 'COMPUTER_LI_DESKTOP_HASH_BBB222';

    console.log(`▶ [1/4] 测试客服在设备 A (电脑1) 上首次使用 Key: ${testKey} ...`);
    const respA = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testKey}`,
        'x-device-id': DEVICE_A,
      },
      body: JSON.stringify({
        model: 'xkang-managed',
        messages: [{ role: 'user', content: '测试排障请求' }],
        stream: false,
      }),
    });

    console.log(`   设备 A 首次请求 HTTP 状态码: ${respA.status}`);
    if (respA.status !== 200) {
      throw new Error(`设备 A 首次使用失败 (HTTP ${respA.status})`);
    }
    console.log('   ✅ 设备 A 首次使用成功，服务端已自动锁定该设备指纹！');

    console.log(`\n▶ [2/4] 测试其他人使用同一 Key 在设备 B (电脑2) 上尝试共用/顶号 ...`);
    const respB = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testKey}`,
        'x-device-id': DEVICE_B,
      },
      body: JSON.stringify({
        model: 'xkang-managed',
        messages: [{ role: 'user', content: '非授权设备共用' }],
        stream: false,
      }),
    });

    console.log(`   设备 B 跨设备请求 HTTP 状态码: ${respB.status}`);
    const errJson = await respB.json();
    console.log(`   服务端拦截返回信息: ${errJson.error}`);

    if (respB.status !== 403 || !errJson.error.includes('设备绑定拦截')) {
      throw new Error('防多人共用拦截未生效！');
    }
    console.log('   ✅ 成功拦截跨设备共用！非授权电脑被绝对阻断 (100% 拦截)');

    console.log(`\n▶ [3/4] 验证设备 A (原合法电脑) 依然能正常使用不受影响 ...`);
    const respA2 = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testKey}`,
        'x-device-id': DEVICE_A,
      },
      body: JSON.stringify({
        model: 'xkang-managed',
        messages: [{ role: 'user', content: '继续正常排障' }],
        stream: false,
      }),
    });

    if (respA2.status !== 200) {
      throw new Error(`原设备 A 使用异常 (HTTP ${respA2.status})`);
    }
    console.log('   ✅ 原设备 A 访问畅通，合法权限不受干扰！');

    console.log(`\n▶ [4/4] 模拟管理员后台解绑 (客服正常换电脑流程) ...`);
    const unbindResp = await fetch(`${BASE_URL}/admin/tokens/unbind`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer adm_security_master`,
      },
      body: JSON.stringify({ token: testKey }),
    });

    const unbindJson = await unbindResp.json();
    console.log(`   管理员解绑结果: ${unbindJson.message}`);

    // Now Device B should be able to bind and use
    const respBAfterUnbind = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testKey}`,
        'x-device-id': DEVICE_B,
      },
      body: JSON.stringify({
        model: 'xkang-managed',
        messages: [{ role: 'user', content: '新电脑重新绑定激活' }],
        stream: false,
      }),
    });

    if (respBAfterUnbind.status !== 200) {
      throw new Error(`解绑后新设备 B 激活失败 (HTTP ${respBAfterUnbind.status})`);
    }
    console.log('   ✅ 管理员解绑后，新电脑 B 成功重新激活绑定并可用！');

    console.log('\n========================================================================');
    console.log('🎉 1人1机1Key 设备绑定与防多人共用测试全部通过！');
    console.log('========================================================================\n');
  } finally {
    server.close();
    if (fs.existsSync(testTokensPath)) {
      fs.unlinkSync(testTokensPath);
    }
  }
}

runDeviceLockTests().catch((err) => {
  console.error('Device lock test failed:', err);
  process.exit(1);
});
