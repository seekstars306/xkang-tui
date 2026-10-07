import React, { useState, useEffect } from 'react';
import { Box, useApp } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { Header } from './components/Header.js';
import { StatusBar } from './components/StatusBar.js';
import { ChatHistory, getFriendlyActionName } from './components/ChatHistory.js';
import { InputPrompt } from './components/InputPrompt.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { QuestionPrompt } from './components/QuestionPrompt.js';
import { KeyBindingPrompt } from './components/KeyBindingPrompt.js';
import { AVAILABLE_COMMANDS } from './components/CommandPalette.js';
import { AgentHarness } from '../harness/agent.js';
import { AgentStatus, ApprovalRequest, QuestionRequest, Message } from '../types/index.js';
import {
  checkForUpdates,
  performAutoUpdate,
  CURRENT_CLIENT_VERSION,
  CheckUpdateResult,
} from '../updater/index.js';
import {
  loadUserLocalConfig,
  saveUserLocalConfig,
  clearUserLocalConfig,
} from '../config/user_config.js';
import { restoreBadgesToFullPaths } from '../utils/format_user_content.js';

interface AppProps {
  harness: AgentHarness;
  serverUrl?: string;
  token?: string;
  isServerConnected?: boolean;
  onReconnect?: () => Promise<boolean>;
  onKeyActivated?: (token: string) => Promise<void>;
}

export const App: React.FC<AppProps> = ({
  harness,
  serverUrl = 'http://10.197.15.89:8600',
  token: initialToken,
  isServerConnected = false,
  onReconnect,
  onKeyActivated,
}) => {
  const { exit } = useApp();
  const [currentToken, setCurrentToken] = useState<string | undefined>(initialToken);
  const [isActivating, setIsActivating] = useState<boolean>(!initialToken);
  const [serverConnected, setServerConnected] = useState<boolean>(isServerConnected);
  const [messages, setMessages] = useState(harness.getMessages());
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [inputValue, setInputValue] = useState('');
  const [currentReasoning, setCurrentReasoning] = useState('');
  const [currentContent, setCurrentContent] = useState('');
  const [activeToolName, setActiveToolName] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [tokenUsage, setTokenUsage] = useState(harness.getTokenUsage());
  const [updateInfo, setUpdateInfo] = useState<CheckUpdateResult | null>(null);
  const [activeApproval, setActiveApproval] = useState<{
    request: ApprovalRequest;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [activeQuestion, setActiveQuestion] = useState<{
    request: QuestionRequest;
    resolve: (answer: string) => void;
  } | null>(null);

  // Background non-blocking update check on launch (only when authenticated)
  useEffect(() => {
    if (serverUrl && currentToken) {
      checkForUpdates(serverUrl).then((res) => {
        if (res.hasUpdate && res.latestVersion) {
          setUpdateInfo(res);
          setNotice(`✨ 发现新版本 v${res.latestVersion}，输入 /update 即可一键自动升级`);
        }
      });
    }
  }, [serverUrl, currentToken]);

  // Background auto-reconnect polling if server status is offline
  useEffect(() => {
    if (!onReconnect || !serverUrl || !currentToken) return;

    // Check right away if initial connection wasn't established
    if (!serverConnected) {
      onReconnect().then((ok) => {
        if (ok) setServerConnected(true);
      });
    }

    const interval = setInterval(async () => {
      if (!serverConnected) {
        const ok = await onReconnect();
        if (ok) setServerConnected(true);
      }
    }, 15000);

    return () => clearInterval(interval);
  }, [serverConnected, onReconnect, serverUrl, currentToken]);

  const addLocalSystemMessage = (text: string) => {
    const sysMsg: Message = {
      role: 'assistant',
      content: text,
    };
    setMessages((prev) => [...prev, sysMsg]);
  };

  const handleKeyActivated = async (
    activatedToken: string,
    _userName?: string,
    codeRepoPath?: string,
  ) => {
    setCurrentToken(activatedToken);

    const saveData: Parameters<typeof saveUserLocalConfig>[0] = {
      serverUrl,
      token: activatedToken,
      lastActivatedAt: new Date().toISOString(),
    };

    if (codeRepoPath) {
      saveData.codeRepoPath = codeRepoPath;
      (harness as any).context.repoPath = codeRepoPath;
    }

    saveUserLocalConfig(saveData);

    if (onKeyActivated) {
      await onKeyActivated(activatedToken);
    }

    if (onReconnect) {
      onReconnect().then((ok) => setServerConnected(ok));
    } else {
      setServerConnected(true);
    }

    setIsActivating(false);
    setStatus('idle');
    setNotice('🎉 身份认证成功！已锁定当前电脑设备，配置已自动保存。');
  };

  const handleSlashCommand = async (cmd: string): Promise<boolean> => {
    const parts = cmd.trim().split(/\s+/);
    const mainCmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim();

    if (mainCmd === '/exit' || mainCmd === '/quit') {
      exit();
      return true;
    }

    if (mainCmd === '/clear') {
      harness.clearHistory();
      setMessages(harness.getMessages());
      setCurrentReasoning('');
      setCurrentContent('');
      setActiveToolName(undefined);
      setNotice(undefined);
      setActiveApproval(null);
      setActiveQuestion(null);
      setTokenUsage(harness.getTokenUsage());
      return true;
    }

    if (mainCmd === '/key') {
      if (arg === 'reset' || arg === 'unbind') {
        clearUserLocalConfig();
        setCurrentToken(undefined);
        setIsActivating(true);
        setNotice('ℹ️ 本地 Key 已清除，请重新输入新 Key 激活。注意：原 Key 如需在其他电脑使用，必须联系管理员在服务端解绑。');
        return true;
      }

      const userConf = loadUserLocalConfig();
      addLocalSystemMessage(
        `🔑 **当前电脑授权 Key 信息**\n- 访问令牌: \`${currentToken || userConf.token || '未配置'}\`\n- 集中服务端: \`${serverUrl}\`\n- 绑定状态: 🔒 已锁定本机设备指纹\n\n📌 **换机与解绑安全说明**:\n- 若需在本机更换为新 Key，请输入: \`/key reset\`\n- 严禁私自将 Key 共享给他人使用。若需将当前 Key 转给新电脑使用，**必须联系系统管理员在服务端执行解绑**（客户端无法自行解除服务端的设备锁定）。`
      );
      return true;
    }

    if (mainCmd === '/version') {
      const check = await checkForUpdates(serverUrl);
      const lines = [
        `📌 **版本与更新状态**`,
        `- 当前客户端版本: \`v${CURRENT_CLIENT_VERSION}\``,
        `- 服务端最新发布: \`${check.latestVersion ? 'v' + check.latestVersion : '已是最新或离线'}\``,
      ];
      if (check.releaseNotes && check.releaseNotes.length > 0) {
        lines.push(`\n📋 **最新更新日志 (v${check.latestVersion}):**`);
        for (const note of check.releaseNotes) {
          lines.push(`- ${note}`);
        }
      }
      if (check.hasUpdate) {
        lines.push(`\n💡 输入 \`/update\` 即可立即一键自动下载并升级。`);
      }
      addLocalSystemMessage(lines.join('\n'));
      return true;
    }

    if (mainCmd === '/update') {
      if (!serverUrl) {
        addLocalSystemMessage('❌ 未配置公司服务端地址，无法自动拉取更新。');
        return true;
      }
      addLocalSystemMessage('⏳ 正在检查服务端最新版本并准备更新...');
      const check = await checkForUpdates(serverUrl);
      if (!check.hasUpdate || !check.downloadUrl) {
        addLocalSystemMessage(`✅ 当前客户端版本 (\`v${CURRENT_CLIENT_VERSION}\`) 已经是最新版本，无需更新。`);
        return true;
      }

      addLocalSystemMessage(
        `🚀 开始为客服终端下载更新包 (\`v${check.latestVersion}\`)...`
      );

      const updateRes = await performAutoUpdate(check.downloadUrl, (step) => {
        setNotice(`更新中: ${step}`);
      });

      setNotice(undefined);
      if (updateRes.success) {
        addLocalSystemMessage(`🎉 ${updateRes.message}`);
      } else {
        addLocalSystemMessage(`❌ ${updateRes.message}`);
      }
      return true;
    }

    if (mainCmd === '/model') {
      addLocalSystemMessage(
        `🤖 当前模型调度配置:\n- 服务端架构: ${
          isServerConnected ? '已连接公司统一排障网关 (集中管控调度)' : '本地直连基础模式'
        }\n- 公开别名: \`xkang-managed\` (128k 完整上下文)\n- 公司代码库与知识图谱由服务端统一托管，保障代码安全与排障准确性。`
      );
      return true;
    }

    if (mainCmd === '/help') {
      const helpText = [
        '💡 **可用快捷排障指令列表**:',
        ...AVAILABLE_COMMANDS.map(
          (c) => `- \`${c.command}\`: ${c.description} (用法: \`${c.example}\`)`
        ),
        '',
        '📌 **排障小贴士**:',
        '1. **图片识别**：支持直接将报错截图拖拽进终端，或粘贴图片文件路径，系统将自动转码并进行多模态视觉定位。',
        '2. **智能排障**：代码检索与知识库由公司服务端统一调度，直接输入业务问题、订单号或错误提示即可自动全链路溯源。',
        '3. **一键升级**：输入 `/update` 可随时检测并自动更新客户端。',
        '4. **Key 重置**：输入 `/key reset` 可一键更换当前电脑绑定的授权密钥。',
      ].join('\n');
      addLocalSystemMessage(helpText);
      return true;
    }

    // IMPORTANT: If not a known system slash command (e.g. user pasted an API URL like /aliBill/billTransaction),
    // return false so it passes through directly to the AI agent harness!
    return false;
  };

  const handleApprovalDecision = (approved: boolean) => {
    if (activeApproval) {
      activeApproval.resolve(approved);
      setActiveApproval(null);
      setStatus('executing_tool');
    }
  };

  const handleQuestionSelection = (answer: string) => {
    if (activeQuestion) {
      activeQuestion.resolve(answer);
      setActiveQuestion(null);
      setStatus('thinking');
    }
  };

  const handleSubmit = async (text: string) => {
    if (!text.trim() || status !== 'idle') return;

    setInputValue('');

    const resolvedText = restoreBadgesToFullPaths(text);

    // Check slash commands
    if (resolvedText.startsWith('/')) {
      const handled = await handleSlashCommand(resolvedText);
      if (handled) return;
    }

    // Attempt on-demand background reconnection if currently offline
    if (!serverConnected && onReconnect) {
      onReconnect().then((ok) => {
        if (ok) setServerConnected(true);
      });
    }

    setStatus('thinking');
    setCurrentReasoning('');
    setCurrentContent('');
    setActiveToolName(undefined);
    setNotice(undefined);
    setActiveApproval(null);

    try {
      await harness.run(resolvedText, (event) => {
        if (event.type === 'reasoning_chunk') {
          setStatus('thinking');
          setCurrentReasoning((prev) => prev + event.chunk);
        } else if (event.type === 'content_chunk') {
          setStatus('streaming');
          setCurrentContent((prev) => prev + event.chunk);
        } else if (event.type === 'tool_call_start') {
          setStatus('executing_tool');
          setActiveToolName(event.toolCall.name);
          setMessages([...harness.getMessages()]);
        } else if (event.type === 'approval_requested') {
          setStatus('waiting_approval');
          setActiveApproval({
            request: event.request,
            resolve: event.resolve,
          });
        } else if (event.type === 'approval_resolved') {
          setActiveApproval(null);
          setStatus('executing_tool');
        } else if (event.type === 'question_requested') {
          setStatus('waiting_question');
          setActiveQuestion({
            request: event.request,
            resolve: event.resolve,
          });
        } else if (event.type === 'question_resolved') {
          setActiveQuestion(null);
          setStatus('thinking');
        } else if (event.type === 'tool_call_result') {
          setActiveToolName(undefined);
          setStatus('thinking');
          setMessages([...harness.getMessages()]);
        } else if (event.type === 'usage_sync') {
          setTokenUsage(harness.getTokenUsage());
        } else if (event.type === 'done') {
          setStatus('idle');
          setActiveToolName(undefined);
          setActiveApproval(null);
          setActiveQuestion(null);
          setCurrentReasoning('');
          setCurrentContent('');
          setMessages([...harness.getMessages()]);
        }
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      addLocalSystemMessage(`❌ **排障调用发生异常**: ${errorMsg}\n\n💡 提示：如遇模型超时或网络波动，可尝试重新发送，或联系管理员切换后端模型。`);
      setStatus('error');
    } finally {
      setStatus('idle');
      setActiveToolName(undefined);
      setActiveApproval(null);
      setActiveQuestion(null);
      setCurrentReasoning('');
      setCurrentContent('');
      setMessages([...harness.getMessages()]);
      setTokenUsage(harness.getTokenUsage());
    }
  };

  // 1. First-launch interactive key activation screen
  if (isActivating || !currentToken) {
    return (
      <KeyBindingPrompt
        serverUrl={serverUrl}
        onActivated={handleKeyActivated}
        onExit={() => exit()}
      />
    );
  }

  const friendlyAction = activeToolName ? getFriendlyActionName(activeToolName) : undefined;

    return (
      <Box flexDirection="column" padding={1} width="100%">
        <Header
          serverUrl={serverUrl}
          isServerConnected={serverConnected}
        />

      <ChatHistory
        messages={messages}
        currentReasoning={currentReasoning}
        currentContent={currentContent}
        activeActionName={activeToolName}
        agentStatus={status}
      />

      <StatusBar
        status={status}
        tokenUsage={tokenUsage}
        activeActionName={friendlyAction}
        notice={notice}
      />

      {status === 'waiting_approval' && activeApproval ? (
        <ApprovalPrompt
          request={activeApproval.request}
          onDecision={handleApprovalDecision}
        />
      ) : status === 'waiting_question' && activeQuestion ? (
        <QuestionPrompt
          request={activeQuestion.request}
          onSelect={handleQuestionSelection}
        />
      ) : (
        <InputPrompt
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          disabled={status !== 'idle'}
        />
      )}
    </Box>
  );
};
