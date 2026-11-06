import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { AgentStatus, TokenUsage } from '../../types/index.js';

interface StatusBarProps {
  status: AgentStatus;
  tokenUsage: TokenUsage;
  activeActionName?: string;
  notice?: string;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  status,
  tokenUsage,
  activeActionName,
  notice,
}) => {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
      justifyContent="space-between"
    >
      <Box>
        {status === 'thinking' && (
          <Text color="cyanBright">
            <Spinner type="dots" /> <Text bold>正在分析业务逻辑与排障路径...</Text>
          </Text>
        )}
        {status === 'executing_tool' && (
          <Text color="yellowBright">
            <Spinner type="dots" />{' '}
            <Text bold>
              正在检索与分析: {activeActionName ? `[${activeActionName}]` : '代码及业务数据'}...
            </Text>
          </Text>
        )}
        {status === 'waiting_approval' && (
          <Text color="yellowBright">
            <Spinner type="dots" /> <Text bold>⚠️  等待员工在操作审批门中确认文件或命令执行...</Text>
          </Text>
        )}
        {status === 'streaming' && (
          <Text color="blueBright">
            <Spinner type="line" /> 正在生成排障业务解答...
          </Text>
        )}
        {status === 'idle' && notice && (
          <Text color="yellowBright">⚠ {notice}</Text>
        )}
        {status === 'idle' && !notice && (
          <Text color="green">● 就绪 (输入排障问题回车发送)</Text>
        )}
        {status === 'error' && (
          <Text color="red">✖ 排障处理异常</Text>
        )}
      </Box>

      <Box>
        <Text color="gray">
          上下文: <Text color="white">{tokenUsage.totalTokens}</Text> Tokens
        </Text>
      </Box>
    </Box>
  );
};
