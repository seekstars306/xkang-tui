import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { Message, AgentStatus } from '../../types/index.js';
import { LogoBanner } from './LogoBanner.js';
import { formatUserDisplayText, FormattedSegment } from '../../utils/format_user_content.js';

interface ChatHistoryProps {
  messages: Message[];
  currentReasoning?: string;
  currentContent?: string;
  activeActionName?: string;
  agentStatus?: AgentStatus;
}

function renderUserContent(content: unknown) {
  if (typeof content === 'string') {
    const segments = formatUserDisplayText(content);
    return (
      <Box flexDirection="column">
        {segments.map((seg, sIdx) => {
          if (seg.type === 'image_badge') {
            return (
              <Box key={sIdx} marginY={0}>
                <Text bold color="cyanBright">
                  {seg.badgeLabel}
                </Text>
              </Box>
            );
          }
          if (seg.type === 'file_badge') {
            return (
              <Box key={sIdx} marginY={0}>
                <Text bold color="yellowBright">
                  {seg.badgeLabel}
                </Text>
              </Box>
            );
          }
          const clean = seg.content.trim();
          if (!clean) return null;
          return (
            <Text key={sIdx} color="white">
              {clean}
            </Text>
          );
        })}
      </Box>
    );
  }

  if (Array.isArray(content)) {
    return (
      <Box flexDirection="column">
        {content.map((part, pIdx) => {
          if (part.type === 'text') {
            const segments = formatUserDisplayText(part.text);
            return (
              <Box key={pIdx} flexDirection="column">
                {segments.map((seg, sIdx) => {
                  if (seg.type === 'image_badge') {
                    return (
                      <Text key={sIdx} bold color="cyanBright">
                        {seg.badgeLabel}
                      </Text>
                    );
                  }
                  if (seg.type === 'file_badge') {
                    return (
                      <Text key={sIdx} bold color="yellowBright">
                        {seg.badgeLabel}
                      </Text>
                    );
                  }
                  const clean = seg.content.trim();
                  if (!clean) return null;
                  return (
                    <Text key={sIdx} color="white">
                      {clean}
                    </Text>
                  );
                })}
              </Box>
            );
          }
          if (part.type === 'image_url') {
            return (
              <Text key={pIdx} color="cyanBright" bold>
                🖼️ [已附加多模态图像 - 视觉排障解析中]
              </Text>
            );
          }
          return null;
        })}
      </Box>
    );
  }

  return <Text color="white">{String(content)}</Text>;
}

// Neutral, friendly display labels for tools
export function getFriendlyActionName(rawName?: string): string {
  if (!rawName) return '排障分析';
  const name = rawName.toLowerCase();
  if (name === 'search_code') return '代码全文检索';
  if (name === 'read_file_lines') return '代码按行查阅';
  if (name === 'write_file') return '文件新建/覆写';
  if (name === 'edit_file') return '代码精准修改';
  if (name === 'run_powershell') return '排障命令执行';
  if (name === 'todo_write') return '排障任务看板';
  if (name === 'ask_user_question') return '客服澄清提问';
  if (name === 'web_fetch') return '网页文档查阅';
  if (name === 'web_search') return '技术资料检索';
  if (name.includes('codegraph')) return '代码调用链分析';
  if (name.includes('db')) return '业务配置检索';
  if (name.includes('knowledge')) return '排障知识库检索';
  if (name.includes('kg')) return '业务图谱分析';
  return '排障数据检索';
}

export const ChatHistory: React.FC<ChatHistoryProps> = ({
  messages,
  currentReasoning,
  currentContent,
  activeActionName,
  agentStatus = 'idle',
}) => {
  // Filter out system prompt for user display
  const displayMessages = messages.filter((m) => m.role !== 'system');

  return (
    <Box flexDirection="column">
      {/* Show SKT Brand Logo Banner when session starts or history is cleared */}
      {displayMessages.length === 0 && !currentContent && !currentReasoning && (
        <LogoBanner />
      )}

      {displayMessages.map((msg, index) => {
        if (msg.role === 'user') {
          return (
            <Box key={index} flexDirection="column" marginY={1}>
              <Text bold color="greenBright">
                👤 业务咨询/排障诉求:
              </Text>
              <Box paddingLeft={2} flexDirection="column">
                {renderUserContent(msg.content)}
              </Box>
            </Box>
          );
        }

        if (msg.role === 'tool') {
          const friendlyName = getFriendlyActionName(msg.name);
          const rawText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          return (
            <Box key={index} flexDirection="column" marginY={0} paddingLeft={2}>
              <Text color="gray">
                🔍 [{friendlyName}] 处理结果:
              </Text>
              <Box borderStyle="round" borderColor="gray" paddingX={1}>
                <Text color="gray">
                  {rawText.slice(0, 150) + (rawText.length > 150 ? '...' : '')}
                </Text>
              </Box>
            </Box>
          );
        }

        if (msg.role === 'assistant') {
          const assistantContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
          return (
            <Box key={index} flexDirection="column" marginY={1}>
              {msg.reasoning_content && (
                <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
                  <Text color="magentaBright">🧠 分析推演过程:</Text>
                  <Box borderStyle="classic" borderColor="magenta" paddingX={1}>
                    <Text color="gray">{msg.reasoning_content.slice(0, 200) + '...'}</Text>
                  </Box>
                </Box>
              )}
              {msg.tool_calls && msg.tool_calls.length > 0 && (
                <Box paddingLeft={2} marginY={0}>
                  <Text color="yellow">
                    ⚡ 执行操作:{' '}
                    {msg.tool_calls.map((tc) => getFriendlyActionName(tc.name)).join(', ')}
                  </Text>
                </Box>
              )}
              {assistantContent && (
                <Box flexDirection="column">
                  <Text bold color="cyanBright">
                    🤖 排障分析解答:
                  </Text>
                  <Box paddingLeft={2}>
                    <Text color="white">{assistantContent}</Text>
                  </Box>
                </Box>
              )}
            </Box>
          );
        }

        return null;
      })}

      {/* Streaming live reasoning */}
      {currentReasoning && (
        <Box flexDirection="column" paddingLeft={2} marginY={1}>
          <Text color="magentaBright">
            <Spinner type="dots" /> 🧠 实时深度推理与逻辑推演中:
          </Text>
          <Box borderStyle="round" borderColor="magenta" paddingX={1}>
            <Text color="gray">{currentReasoning.slice(-300)}</Text>
          </Box>
        </Box>
      )}

      {/* Active tool in-flight indicator (High Visibility) */}
      {agentStatus === 'executing_tool' && (
        <Box
          flexDirection="column"
          paddingLeft={2}
          marginY={1}
          borderStyle="single"
          borderColor="yellowBright"
        >
          <Text bold color="yellowBright">
            <Spinner type="dots" /> ⚡ 正在执行操作: [
            {activeActionName ? getFriendlyActionName(activeActionName) : '代码与业务数据检索'}
            ] - 正在调用底层服务探索中，请稍候...
          </Text>
        </Box>
      )}

      {/* Thinking state indicator when no tool is running but model is reasoning/looping */}
      {agentStatus === 'thinking' && !currentReasoning && (
        <Box
          flexDirection="column"
          paddingLeft={2}
          marginY={1}
          borderStyle="single"
          borderColor="cyanBright"
        >
          <Text bold color="cyanBright">
            <Spinner type="dots" /> 🧠 正在深入比对业务规则与代码调用链...
          </Text>
        </Box>
      )}

      {/* Streaming live content */}
      {currentContent && (
        <Box flexDirection="column" marginY={1}>
          <Text bold color="cyanBright">
            <Spinner type="line" /> 🤖 正在生成解答:
          </Text>
          <Box paddingLeft={2}>
            <Text color="white">{currentContent}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
