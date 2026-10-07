import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/dist/index.js';
import { checkForUpdates, performAutoUpdate, CURRENT_CLIENT_VERSION } from '../dist/updater/index.js';

console.log('========================================================================');
console.log('🧪 开始进行「客户端无感自动升级与一键静默分发」端到端测试');
console.log('========================================================================\n');

const TEST_PORT = 8699;
process.env.PORT = String(TEST_PORT);
process.env.XKANG_TOKENS = 'tok_update_tester:UpdateUser';
process.env.XKANG_ADMIN_TOKENS = 'adm_boss:Boss';
process.env.XKANG_LLM_MOCK = '1';

// Ensure releases dir and dummy binary exist
const releasesDir = path.resolve(process.cwd(), 'server', 'data', 'releases');
if (!fs.existsSync(releasesDir)) {
  fs.mkdirSync(releasesDir, { recursive: true });
}
const releaseExePath = path.join(releasesDir, 'xhang.exe');
fs.writeFileSync(releaseExePath, Buffer.from(`MZ_SKT_STANDALONE_RELEASE_v1.1.0_BINARY_PAYLOAD_TEST_FULL_DATA_FOR_CUSTOMER_SERVICE_AUTO_UPDATER_STREAM`));

const { server } = startServer();
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runUpdaterTests() {
  try {
    // 1. Check version endpoint
    console.log('▶ [1/5] 测试服务端 /download/latest/version 版本检查接口 (免认证)...');
    const vResp = await fetch(`${BASE_URL}/download/latest/version`);
    if (!vResp.ok) throw new Error(`HTTP ${vResp.status}`);
    const vData = await vResp.json();
    console.log(`   服务端最新版本: v${vData.version}, 发布日期: ${vData.releaseDate}`);
    console.log(`   更新说明条数: ${vData.releaseNotes.length} 项`);
    console.log(`   安装包体积: ${vData.fileSize} 字节`);
    console.log('   ✅ 服务端版本接口响应正常！');

    // 2. Check install.bat endpoint
    console.log('\n▶ [2/5] 测试服务端 /download/install.bat 一键桌面部署脚本生成接口...');
    const batResp = await fetch(`${BASE_URL}/download/install.bat`);
    if (!batResp.ok) throw new Error(`HTTP ${batResp.status}`);
    const batText = await batResp.text();
    if (!batText.includes('小康') || !batText.includes('.lnk') || !batText.includes('xhang.exe')) {
      throw new Error('install.bat 脚本内容不符合预期');
    }
    console.log(`   生成 BAT 脚本大小: ${batText.length} 字符, 包含一键桌面快捷方式配置`);
    console.log('   ✅ 一键安装批处理生成接口验证通过！');

    // 3. Check client checkForUpdates
    console.log('\n▶ [3/5] 测试客户端 checkForUpdates() 智能比对逻辑...');
    const checkResult = await checkForUpdates(BASE_URL);
    console.log(`   本地当前版本: v${checkResult.currentVersion}`);
    console.log(`   检测到新版本: ${checkResult.hasUpdate ? '是 (v' + checkResult.latestVersion + ')' : '否'}`);
    console.log(`   更新包下载地址: ${checkResult.downloadUrl}`);

    if (!checkResult.hasUpdate || checkResult.latestVersion !== '1.1.0') {
      throw new Error('版本比对未成功识别到 1.1.0 新版本！');
    }
    console.log('   ✅ 客户端版本检测与升级判定逻辑正确！');

    // 4. Test client performAutoUpdate
    console.log('\n▶ [4/5] 测试客户端 performAutoUpdate() 自动下载与文件落盘...');
    const progressLogs = [];
    const updateRes = await performAutoUpdate(checkResult.downloadUrl, (msg) => {
      progressLogs.push(msg);
    });

    console.log('   更新过程进度回调:', progressLogs);
    console.log('   自动更新结果:', updateRes.message);

    if (!updateRes.success) {
      throw new Error(`自动更新执行失败: ${updateRes.message}`);
    }
    console.log('   ✅ 自动更新与最新可执行程序写入成功！');

    // 5. Test offline fallback
    console.log('\n▶ [5/5] 测试服务端离线/无网络时的客户端优雅降级...');
    const offlineResult = await checkForUpdates('http://127.0.0.1:59999'); // Non-existent port
    console.log(`   离线检测结果: hasUpdate = ${offlineResult.hasUpdate}, 错误捕获: ${offlineResult.error || '无'}`);
    if (offlineResult.hasUpdate !== false) {
      throw new Error('离线状态下判定异常！');
    }
    console.log('   ✅ 离线状态下静默降级，不阻塞客服正常使用！');

    console.log('\n========================================================================');
    console.log('🎉 客户端无感自动升级与一键静默分发测试全部通过！');
    console.log('========================================================================\n');
  } finally {
    server.close();
    // Cleanup test downloaded file if generated
    const downloadedMock = path.resolve(process.cwd(), 'xhang_latest.exe');
    if (fs.existsSync(downloadedMock)) {
      fs.unlinkSync(downloadedMock);
    }
  }
}

runUpdaterTests().catch((err) => {
  console.error('Updater test failed:', err);
  process.exit(1);
});
