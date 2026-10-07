/**
 * 独立 Key 绑定入口:npm run bind
 * 与 Web UI 共用同一套本地绑定配置 (~/.xkang/config.json)。
 */
import { runBindWizard } from './bind_wizard.js';
import { loadUserLocalConfig } from '../src/config/user_config.js';

const existing = loadUserLocalConfig();
if (existing.token) {
  console.log('ℹ️  当前电脑已绑定 Key。如需更换,请先在 TUI 中执行 /key reset,或联系管理员解绑后重试。');
  process.exit(0);
}

const ok = await runBindWizard();

if (ok) {
  console.log('\n✅ Key 绑定成功,配置已保存到本机 (~/.xkang/config.json)。');
  process.exit(0);
} else {
  console.log('\n❌ 未完成 Key 绑定,已退出。');
  process.exit(1);
}
