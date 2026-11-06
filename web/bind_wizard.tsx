/**
 * 复用 TUI 的 KeyBindingPrompt,在终端内独立完成 Key 激活绑定。
 * 供 `npm run bind` 与 Web 服务启动前置校验调用。
 */
import React from 'react';
import { render } from 'ink';
import { KeyBindingPrompt } from '../src/tui/components/KeyBindingPrompt.js';
import {
  loadUserLocalConfig,
  saveUserLocalConfig,
} from '../src/config/user_config.js';

export function runBindWizard(): Promise<boolean> {
  return new Promise((resolve) => {
    const localCfg = loadUserLocalConfig();
    let settled = false;

    const finish = (ok: boolean, instance: ReturnType<typeof render>) => {
      if (settled) return;
      settled = true;
      try {
        instance.unmount();
      } catch {
        // ignore
      }
      resolve(ok);
    };

    const instance = render(
      <KeyBindingPrompt
        serverUrl={localCfg.serverUrl}
        onActivated={(token, userName, codeRepoPath) => {
          const saveData: Parameters<typeof saveUserLocalConfig>[0] = {
            serverUrl: localCfg.serverUrl,
            token,
            lastActivatedAt: new Date().toISOString(),
          };
          if (userName) saveData.userName = userName;
          if (codeRepoPath) saveData.codeRepoPath = codeRepoPath;
          saveUserLocalConfig(saveData);
          finish(true, instance);
        }}
        onExit={() => finish(false, instance)}
      />
    );
  });
}
