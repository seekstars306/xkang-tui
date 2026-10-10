import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { getDeviceId } from '../../utils/device.js';

interface KeyBindingPromptProps {
  serverUrl: string;
  onActivated: (token: string, userName?: string, codeRepoPath?: string) => void;
  onExit: () => void;
}

export const KeyBindingPrompt: React.FC<KeyBindingPromptProps> = ({
  serverUrl,
  onActivated,
  onExit,
}) => {
  const [tokenInput, setTokenInput] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleKeySubmit = async (val: string) => {
    const rawKey = val.trim();
    if (!rawKey || isVerifying) return;

    setIsVerifying(true);
    setErrorMessage(null);

    const deviceId = getDeviceId();
    const cleanServer = serverUrl.replace(/\/+$/, '');

    try {
      // Send lightweight probe to verify key & bind device
      const resp = await fetch(`${cleanServer}/agent/sessions`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${rawKey}`,
          'x-device-id': deviceId,
        },
      });

      if (resp.status === 200) {
        setIsVerifying(false);
        onActivated(rawKey);
        return;
      }

      const errJson = (await resp.json().catch(() => ({}))) as { error?: string };
      const detail = errJson.error || `HTTP ${resp.status}`;

      setIsVerifying(false);
      if (resp.status === 403) {
        if (String(detail).includes('设备绑定拦截')) {
          setErrorMessage('❌ 该 Key 已在其他电脑上激活锁定。严禁多人共用一个 Key！如需换机请联系管理员解绑。');
        } else if (String(detail).includes('停用')) {
          setErrorMessage('❌ 该 Key 已被管理员停用，请联系技术管理员。');
        } else {
          setErrorMessage(`❌ 激活失败：${detail}`);
        }
      } else if (resp.status === 401) {
        setErrorMessage('❌ 密钥格式错误或无效，请仔细核对管理员发给您的 Key。');
      } else {
        setErrorMessage(`❌ 服务端响应异常 (${resp.status})：${detail}`);
      }
    } catch (err: unknown) {
      setIsVerifying(false);
      setErrorMessage('❌ 无法连接业务服务，请检查网络或联系管理员。');
    }
  };

  return (
    <Box flexDirection="column" padding={1} width="100%">
      {/* Brand Header */}
      <Box borderStyle="round" borderColor="cyanBright" paddingX={2} paddingY={1} flexDirection="column">
        <Text bold color="cyanBright">
          🤖 小康 TUI 客服智能排障助手 - 首次启动激活向导
        </Text>
        <Text color="gray">请输入管理员提供的员工授权。</Text>
      </Box>

      {/* Guide Info */}
      <Box flexDirection="column" marginY={1} paddingX={1}>
        <Text color="white" bold>
          👋 您好！检测到当前电脑是首次使用本排障终端。
        </Text>
        <Text color="gray">
          请向系统管理员获取您的专属访问密钥 (Key)，输入并回车后将自动与当前电脑绑定并保存，后续双击即可直接免密使用。
        </Text>
      </Box>

      {/* Error Notice */}
      {errorMessage && (
        <Box borderStyle="single" borderColor="red" paddingX={1} marginBottom={1}>
          <Text color="redBright" bold>
            {errorMessage}
          </Text>
        </Box>
      )}

      {/* Input Box */}
      <Box
        borderStyle="round"
        borderColor={isVerifying ? 'yellow' : (errorMessage ? 'red' : 'greenBright')}
        paddingX={1}
      >
        <Box marginRight={1}>
          {isVerifying ? (
            <Text color="yellowBright" bold>
              <Spinner type="dots" /> 正在验证密钥并绑定当前设备...
            </Text>
          ) : (
            <Text bold color="greenBright">
              🔑 请输入您的专属 Key &gt;
            </Text>
          )}
        </Box>
        <Box flexGrow={1}>
          <TextInput
            value={tokenInput}
            onChange={setTokenInput}
            onSubmit={handleKeySubmit}
            placeholder="例如: tok_skt_a1b2c3d4e5f67890 (直接按 Ctrl+V 粘贴后回车)"
            focus={!isVerifying}
          />
        </Box>
      </Box>

      {/* Tips footer */}
      <Box marginTop={1} paddingX={1}>
        <Text color="gray">
          提示：按 Ctrl+C 可退出向导。每个 Key 仅限绑定一台电脑使用（1人1机1Key 安全管控）。
        </Text>
      </Box>
    </Box>
  );
};
