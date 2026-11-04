import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { ApprovalRequest } from '../../types/index.js';
import { getFriendlyActionName } from './ChatHistory.js';

interface ApprovalPromptProps {
  request: ApprovalRequest;
  onDecision: (approved: boolean) => void;
}

export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({ request, onDecision }) => {
  const items = [
    {
      label: '✅ 批准执行 (Approve & Proceed)',
      value: 'approve',
    },
    {
      label: '❌ 拒绝本次操作 (Reject & Cancel)',
      value: 'reject',
    },
  ];

  const friendlyAction = getFriendlyActionName(request.toolName);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellowBright"
      paddingX={1}
      paddingY={1}
      marginTop={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="yellowBright">
          ⚠️  操作审批门 (Approval Gate): 检测到代码修改或命令执行操作
        </Text>
        <Text color="cyanBright">操作类型: [{friendlyAction}]</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="gray">目标路径/目录: </Text>
        <Text bold color="white">{request.filePath}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="gray">操作内容: </Text>
        <Text color="greenBright">{request.summary}</Text>
      </Box>

      {request.diffPreview && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
        >
          <Text bold color="cyan">
            📝 变更/命令详情预览:
          </Text>
          <Text color="white">{request.diffPreview}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">
          请使用 ↑ / ↓ 键选择并按回车确认:
        </Text>
        <SelectInput
          items={items}
          onSelect={(item) => onDecision(item.value === 'approve')}
        />
      </Box>
    </Box>
  );
};
