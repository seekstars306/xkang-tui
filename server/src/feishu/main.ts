import { startFeishu } from './client.js';
import { FeishuDispatcher } from './dispatcher.js';
import { HttpAgentRunner } from './runner.js';
import { getMonitorDb } from './monitor_db.js';

/**
 * 飞书接入进程入口。
 *
 * 单独进程而不是塞进 server/index.ts：长连接是常驻的，和 HTTP 服务的启停节奏不同；
 * 出问题也只影响飞书通道，不会把 xkang 主服务带下去。
 *
 * 需要环境变量：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET   飞书应用凭据
 *   XKANG_BASE_URL                       xkang 服务端地址，默认 http://127.0.0.1:8090
 *   XKANG_FEISHU_TOKEN                   服务端员工令牌（对应一个固定员工身份）
 *   FEISHU_MAX_CONCURRENT                并发排查上限，默认 3
 */

const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);

async function main(): Promise<void> {
  const baseUrl = (process.env.XKANG_BASE_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
  const token = process.env.XKANG_FEISHU_TOKEN;
  if (!token) {
    console.error('缺少 XKANG_FEISHU_TOKEN：需要一个服务端员工令牌来代表飞书通道调用 xkang');
    process.exit(1);
  }

  const runner = new HttpAgentRunner({ baseUrl, token, log });
  let dispatcher: FeishuDispatcher | null = null;

  // 只有通道进程知道哪些任务属于自己：重启前正在跑的本通道任务标记为中断。
  // 服务端(8600)共用同一个库但不调用它，避免误伤这里正在执行的任务。
  const interrupted = getMonitorDb().recoverInterruptedTasks();
  if (interrupted > 0) log(`启动恢复：${interrupted} 个上次中断的排查已标记为失败`);

  const bundle = await startFeishu({
    log,
    onMessage: async event => {
      if (!dispatcher) return;
      await dispatcher.handleEvent(event);
    },
  });
  if (!bundle) {
    console.error('未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，飞书接入未启动');
    process.exit(1);
  }

  dispatcher = new FeishuDispatcher(bundle, runner, {
    maxConcurrent: Number(process.env.FEISHU_MAX_CONCURRENT || 3),
    beforeCount: Number(process.env.FEISHU_BEFORE_COUNT || 20),
    publicBaseUrl: process.env.XKANG_PUBLIC_BASE_URL,
    log,
  });

  log(`已就绪：${bundle.bot.appName}，等待群内 @`);
}

process.on('SIGTERM', () => { log('收到 SIGTERM，退出'); process.exit(0); });
process.on('SIGINT', () => { log('收到 SIGINT，退出'); process.exit(0); });

main().catch(error => {
  console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
