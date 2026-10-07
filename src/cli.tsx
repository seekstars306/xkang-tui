#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { App } from './tui/App.js';
import { loadConfig } from './config/models.js';
import { ModelGateway } from './adapters/gateway.js';
import { AgentHarness } from './harness/agent.js';
import { createDefaultToolRegistry } from './tools/index.js';
import { McpRemoteClient } from './mcp/client.js';
import { loadUserLocalConfig } from './config/user_config.js';
import { startWebServer } from './web_server.js';
import { CURRENT_CLIENT_VERSION } from './updater/index.js';

const program = new Command();

program
  .name('xhang')
  .alias('xkang')
  .description('小康 - 客服与技术支持代码业务排障智能终端')
  .version(CURRENT_CLIENT_VERSION)
  .option('-s, --server <url>', '指定服务端地址 (默认 http://10.197.15.89:8600)')
  .option('-t, --token <token>', '指定访问令牌')
  .option('--tui', '强制以纯控制台 TUI 界面运行')
  .option('-p, --port <port>', 'Web UI 运行端口 (默认 8611)', '8611')
  .option('--no-open', '启动 Web UI 时不自动打开默认浏览器')
  .action(async (options) => {
    const config = loadConfig();

    if (options.server) {
      config.serverUrl = options.server;
    }
    if (options.token) {
      config.token = options.token;
    }

    const localCfg = loadUserLocalConfig();
    const effectiveToken = options.token || config.token || localCfg.token;

    // 1. 如果已经绑定了 Key，且没有显式指定 --tui 模式，则直接启动 Web UI 并在浏览器中打开
    if (effectiveToken && !options.tui) {
      const port = Number(options.port) || 8611;
      const autoOpen = options.open !== false;
      await startWebServer({ port, autoOpen });
      return;
    }

    // 2. 如果未绑定 Key 或显式指定了 --tui 模式，则启动 Ink TUI（首次打开展示激活绑定向导）
    const registry = createDefaultToolRegistry();
    let isServerConnected = false;

    if (config.serverUrl && effectiveToken) {
      const mcpClient = new McpRemoteClient({
        serverUrl: config.serverUrl,
        token: effectiveToken,
      });

      const syncResult = await registry.syncWithRemote(mcpClient);
      isServerConnected = syncResult.connected;
    }

    let gateway = new ModelGateway(config);

    const harness = new AgentHarness({
      gateway,
      registry,
      context: {
        repoPath: config.codeRepoPath,
        localCwd: process.cwd(),
        serverUrl: config.serverUrl,
        token: effectiveToken,
      },
    });

    const reconnectServer = async (): Promise<boolean> => {
      const currentToken = config.token || loadUserLocalConfig().token;
      if (!config.serverUrl || !currentToken) return false;
      try {
        const mcpClient = new McpRemoteClient({
          serverUrl: config.serverUrl,
          token: currentToken,
        });
        const syncResult = await registry.syncWithRemote(mcpClient);
        return syncResult.connected;
      } catch {
        return false;
      }
    };

    const onKeyActivated = async (activatedToken: string) => {
      config.token = activatedToken;
      (harness as any).context.token = activatedToken;

      gateway = new ModelGateway(config);
      (harness as any).gateway = gateway;

      if (config.serverUrl) {
        const mcpClient = new McpRemoteClient({
          serverUrl: config.serverUrl,
          token: activatedToken,
        });
        await registry.syncWithRemote(mcpClient);
      }

      // 绑定成功后，提示用户并可自动启动 Web UI
      console.log('\n🎉 Key 激活绑定成功！下次打开将直接在浏览器中拉起 Web UI。');
      console.log('正在为您启动 Web 界面...');
      setTimeout(async () => {
        try {
          await startWebServer({ port: Number(options.port) || 8611, autoOpen: true });
        } catch (e) {
          // ignore
        }
      }, 1000);
    };

    render(
      <App
        harness={harness}
        serverUrl={config.serverUrl}
        token={effectiveToken}
        isServerConnected={isServerConnected}
        onReconnect={reconnectServer}
        onKeyActivated={onKeyActivated}
      />
    );
  });

program.parse(process.argv);
