#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { App } from './tui/App.js';
import { BusinessApp } from './tui/BusinessApp.js';
import { loadConfig } from './config/models.js';
import { ModelGateway } from './adapters/gateway.js';
import { AgentHarness } from './harness/agent.js';
import { createDefaultToolRegistry } from './tools/index.js';
import { loadUserLocalConfig, saveUserLocalConfig } from './config/user_config.js';
import { startWebServer } from './web_server.js';
import { startLocalWebServer } from './local_web_server.js';
import { CURRENT_CLIENT_VERSION } from './updater/index.js';
const program = new Command();
program.name('xhang').alias('xkang').version(CURRENT_CLIENT_VERSION)
  .option('-s, --server <url>', '业务服务地址').option('-t, --token <token>', '员工授权')
  .option('--tui', '使用控制台界面').option('--local', '独立本机助手（不接公司业务数据）')
  .option('-p, --port <port>', '网页端口').option('--no-open', '不自动打开浏览器')
  .action(async options => {
    const config = loadConfig(), local = loadUserLocalConfig();
    config.serverUrl = options.server || config.serverUrl;
    config.token = options.token || config.token || local.token;
    // Remove the obsolete company checkout path from the employee configuration.
    saveUserLocalConfig({ serverUrl: config.serverUrl, token: config.token });
    const port = Number(options.port) || (options.local ? 8612 : 8611);
    if (!options.local) {
      if (config.token && !options.tui) await startWebServer({ port, autoOpen: options.open !== false, serverUrl: config.serverUrl, token: config.token });
      else render(<BusinessApp serverUrl={config.serverUrl || ''} token={config.token} />);
      return;
    }
    if (!options.tui && config.token) { await startLocalWebServer({ port, autoOpen: options.open !== false }); return; }
    const registry = createDefaultToolRegistry(), gateway = new ModelGateway(config);
    const harness = new AgentHarness({ gateway, registry, context: { repoPath: process.cwd(), localCwd: process.cwd() } });
    render(<App harness={harness} serverUrl={config.serverUrl} token={config.token} isServerConnected={true} />);
  });
program.parse(process.argv);
