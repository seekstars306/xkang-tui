import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../server/dist/index.js';
import { TokenManager } from '../server/dist/token_manager.js';
import {
  loadUserLocalConfig,
  saveUserLocalConfig,
  clearUserLocalConfig,
  getUserConfigPath,
} from '../dist/config/user_config.js';
import { loadConfig } from '../dist/config/models.js';

console.log('========================================================================');
console.log('🧪 开始进行「首次启动无 Key 交互式引导与本地持久化秒开」端到端测试');
console.log('========================================================================\n');

const TEST_PORT = 8899;
const testTokensPath = path.resolve(process.cwd(), 'server/data/test_first_launch_tokens.json');

process.env.PORT = String(TEST_PORT);
process.env.XKANG_ADMIN_TOKENS = 'adm_first_launch:AdminBoss';
process.env.XKANG_LLM_MOCK = '1';
process.env.TOKENS_JSON_PATH = testTokensPath;

const tokenManager = new TokenManager(testTokensPath);
const newEmployeeRecord = tokenManager.createToken('新入职客服-小赵');
const validKey = newEmployeeRecord.token;

// 测试实例不能执行定时代码同步（会对 D:\\skt_project 执行 git pull / reset）
process.env.CODE_SYNC_ENABLED = 'false';
const { server } = startServer();
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runFirstLaunchTests() {
  try {
    // 1. Clean local user config to simulate pure first-launch state
    console.log('▶ [1/4] 模拟首次纯净启动环境 (清理本地 ~/.xkang/config.json)...');
    clearUserLocalConfig();
    const cleanConfig = loadUserLocalConfig();
    console.log(`   本地配置状态: token = ${cleanConfig.token || '无 (触发首次引导弹窗)'}`);
    if (cleanConfig.token) {
      throw new Error('首次纯净环境配置未成功清空');
    }
    console.log('   ✅ 首次纯净启动环境准备就绪！');

    // 2. Simulate user pasting Key and activating via network
    console.log(`\n▶ [2/4] 模拟客服在交互引导界面粘贴 Key (${validKey}) 并发起网络激活...`);
    const activateResp = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validKey}`,
        'x-device-id': 'ZHAO_LAPTOP_FIRST_LAUNCH_DEVICE_ID',
      },
      body: JSON.stringify({
        model: 'xkang-managed',
        messages: [{ role: 'user', content: 'probe' }],
        stream: false,
      }),
    });

    if (activateResp.status !== 200) {
      throw new Error(`激活请求失败 (HTTP ${activateResp.status})`);
    }
    console.log('   ✅ 服务端身份校验通过并成功绑定当前电脑！');

    // 3. Simulate client saving configuration locally
    console.log('\n▶ [3/4] 模拟客户端将激活的 Key 写入本地用户配置 (~/.xkang/config.json)...');
    saveUserLocalConfig({
      serverUrl: BASE_URL,
      token: validKey,
      userName: '新入职客服-小赵',
      lastActivatedAt: new Date().toISOString(),
    });

    const savedConfig = loadUserLocalConfig();
    console.log(`   本地保存的 Key: ${savedConfig.token}`);
    console.log(`   本地保存的服务端地址: ${savedConfig.serverUrl}`);
    console.log(`   配置文件落盘绝对路径: ${getUserConfigPath()}`);

    if (savedConfig.token !== validKey) {
      throw new Error('本地配置写入不一致！');
    }
    console.log('   ✅ 本地配置持久化成功！');

    // 4. Simulate second-time launch (loadConfig automatic discovery)
    console.log('\n▶ [4/4] 模拟客服后续再次双击 xhang.exe 启动 (免输入自动秒开)...');
    // Clear process.env override so loadConfig takes from ~/.xkang/config.json
    delete process.env.XKANG_TOKEN;
    delete process.env.XKANG_SERVER_URL;

    const runtimeConfig = loadConfig();
    console.log(`   运行时自动探测到的 Token: ${runtimeConfig.token}`);
    console.log(`   运行时自动探测到的 Server: ${runtimeConfig.serverUrl}`);

    if (runtimeConfig.token !== validKey) {
      throw new Error('后续启动未自动读取本地 Key！');
    }
    console.log('   ✅ 后续启动自动识别本地 Key，成功实现免输入直接秒开！');

    console.log('\n========================================================================');
    console.log('🎉 首次启动交互引导与本地持久化测试全部通过！');
    console.log('========================================================================\n');
  } finally {
    server.close();
    clearUserLocalConfig();
    if (fs.existsSync(testTokensPath)) {
      fs.unlinkSync(testTokensPath);
    }
  }
}

runFirstLaunchTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
