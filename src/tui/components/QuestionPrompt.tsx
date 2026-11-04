import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { QuestionRequest } from '../../types/index.js';

interface QuestionPromptProps {
  request: QuestionRequest;
  onSelect: (answer: string) => void;
}

export const QuestionPrompt: React.FC<QuestionPromptProps> = ({ request, onSelect }) => {
  const q = request.questions?.[0] || {
    header: '平台与业务确认',
    question: '请确认该问题是否发生在我方系统内部？',
    options: [
      { label: '这是外部第三方平台截图', description: '由助手提供外部平台规则说明' },
      { label: '确认是我方系统页面/APP', description: '继续进行全链路排障' },
    ],
  };

  const rawOptions =
    q.options && q.options.length > 0
      ? q.options
      : [
          { label: '这是外部第三方平台截图', description: '由助手提供外部平台规则说明' },
          { label: '确认是我方系统页面/APP', description: '继续进行全链路排障' },
        ];

  const items = rawOptions.map((opt, idx) => ({
    label: `${idx + 1}. ${opt.label}${opt.description ? ` (${opt.description})` : ''}`,
    value: `${opt.label}${opt.description ? ` (${opt.description})` : ''}`,
  }));

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyanBright"
      paddingX={1}
      paddingY={1}
      marginTop={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyanBright">
          ❓  排障交互确认门 (Interactive Verification Gate)
        </Text>
        <Text color="yellowBright">分类: [{q.header || '平台确认'}]</Text>
      </Box>

      <Box marginBottom={1}>
        <Text bold color="white">
          {q.question}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">
          请使用 ↑ / ↓ 键选择对应选项并按回车确认:
        </Text>
        <SelectInput
          items={items}
          onSelect={(item) => onSelect(item.value)}
        />
      </Box>
    </Box>
  );
};
