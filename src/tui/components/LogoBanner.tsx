import React from 'react';
import { Box, Text } from 'ink';

export const LogoBanner: React.FC = () => {
  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      borderStyle="round"
      borderColor="cyanBright"
      paddingY={1}
      paddingX={2}
      marginY={1}
    >
      {/* AI Assistant Header Header */}
      <Box justifyContent="center" width="100%">
        <Text color="cyan">╭─────────── </Text>
        <Text color="greenBright" bold>🤖 小康 AI 智能排障 </Text>
        <Text color="cyan">───────────╮</Text>
      </Box>

      {/* XKANG Modern Block Art Logo */}
      <Box flexDirection="column" alignItems="center" marginY={1}>
        <Text color="cyanBright" bold>
          ██╗  ██╗██╗  ██╗ █████╗ ███╗   ██╗ ██████╗ 
        </Text>
        <Text color="cyanBright" bold>
          ╚██╗██╔╝██║ ██╔╝██╔══██╗████╗  ██║██╔════╝ 
        </Text>
        <Text color="cyanBright" bold>
          {' '}╚███╔╝ █████═╝ ███████║██╔██╗ ██║██║  ███╗
        </Text>
        <Text color="cyanBright" bold>
          {' '}██╔██╗ ██╔═██╗ ██╔══██║██║╚██╗██║██║   ██║
        </Text>
        <Text color="cyanBright" bold>
          ██╔╝ ██╗██║  ██╗██║  ██║██║ ╚████║╚██████╔╝
        </Text>
        <Text color="cyanBright" bold>
          ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝ 
        </Text>
      </Box>

      {/* Bottom Border */}
      <Box justifyContent="center" width="100%">
        <Text color="cyan">╰──────────────────────────────────────────╯</Text>
      </Box>

      {/* Chinese and Pinyin Typography */}
      <Box marginTop={1} justifyContent="center" width="100%">
        <Text bold color="white">
          【 小   康   T U I 】
        </Text>
      </Box>
      <Box justifyContent="center" width="100%">
        <Text color="blueBright" bold>
          X I A O   K A N G   T U I
        </Text>
      </Box>

      <Box marginTop={1} justifyContent="center" width="100%">
        <Text color="gray">
          ── 客服与技术支持代码业务智能排障终端 ──
        </Text>
      </Box>
    </Box>
  );
};
