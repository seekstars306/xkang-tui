import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  serverUrl?: string;
  isServerConnected?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  serverUrl,
  isServerConnected,
}) => {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text bold color="greenBright">
          🤖 小康 TUI 客服智能排障助手
        </Text>
        <Text color="cyan">
          服务端连接: <Text bold color={isServerConnected || !serverUrl ? 'greenBright' : 'yellow'}>{isServerConnected || !serverUrl ? '● 正常' : '○ 离线'}</Text>
        </Text>
      </Box>
      <Box marginTop={0} justifyContent="space-between">
        <Text color="gray">
          公司排障大脑已就绪 (前后端代码图谱与知识库实时联动) | 指令: <Text color="cyan">/clear</Text> 清空, <Text color="cyan">/key</Text> 密钥, <Text color="cyan">/exit</Text> 退出
        </Text>
      </Box>
    </Box>
  );
};
