import React from 'react';
import { Box, Text } from 'ink';

export interface SlashCommand {
  command: string;
  description: string;
  example: string;
}

export const AVAILABLE_COMMANDS: SlashCommand[] = [
  { command: '/clear', description: '清空当前排障会话与历史上下文', example: '/clear' },
  { command: '/key', description: '查看或重新绑定/重置当前电脑授权 Key', example: '/key 或 /key reset' },
  { command: '/update', description: '检测并一键自动更新客户端到最新版本', example: '/update' },
  { command: '/version', description: '查看客户端与服务端版本及发布说明', example: '/version' },
  { command: '/model', description: '查看当前服务端/本地模型调度模式', example: '/model' },
  { command: '/help', description: '查看可用指令与排障使用指引', example: '/help' },
  { command: '/exit', description: '退出当前排障助手终端', example: '/exit' },
];

interface CommandPaletteProps {
  query: string;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ query }) => {
  const filtered = AVAILABLE_COMMANDS.filter((cmd) =>
    cmd.command.toLowerCase().startsWith(query.toLowerCase())
  );

  if (filtered.length === 0) {
    return null;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginY={1}
    >
      <Box marginBottom={0}>
        <Text bold color="cyanBright">
          💡 预设快捷指令提示 (按 Tab 或直接输入命令):
        </Text>
      </Box>
      {filtered.map((item) => (
        <Box key={item.command} paddingLeft={1} justifyContent="space-between">
          <Box>
            <Text bold color="yellow">
              {item.command}
            </Text>
            <Text color="gray"> - {item.description}</Text>
          </Box>
          <Box marginLeft={2}>
            <Text color="gray">用法: {item.example}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
};
