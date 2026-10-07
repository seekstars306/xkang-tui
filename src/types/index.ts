export type ModelType =
  | 'xkang-managed'
  | 'deepseek-v4-flash'
  | 'gemini-3.7-flash'
  | 'grok-4.6-medium';

export interface ModelProfile {
  id: ModelType;
  displayName: string;
  provider: 'managed' | 'deepseek' | 'gemini' | 'grok';
  contextWindow: number;
  compactionThreshold: number;
  supportsNativeReasoning: boolean;
  supportsParallelTools: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | MessageContentPart[];
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<
    string,
    {
      type: string;
      description?: string;
      enum?: string[];
      items?: Record<string, unknown>;
    }
  >;
  required?: string[];
}

export interface HarnessContext {
  repoPath: string;
  localCwd: string;
  serverUrl?: string;
  token?: string;
  codeGraphEndpoint?: string;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  description: string;
  filePath: string;
  summary: string;
  diffPreview?: string;
}

export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  header?: string;
  question: string;
  options?: UserQuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionRequest {
  id: string;
  questions: UserQuestion[];
}

export interface RemoteSkill {
  id: string;
  name: string;
  targetTools: string[];
  title: string;
  description: string;
  guidanceText: string;
  version: string;
  updatedAt?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  execute: (args: Record<string, unknown>, context: HarnessContext) => Promise<unknown>;
  isRemote?: boolean;
  requiresApproval?: boolean;
  getApprovalInfo?: (
    args: Record<string, unknown>,
    context: HarnessContext
  ) => Promise<{ filePath: string; summary: string; diffPreview?: string }>;
}

export type StreamEvent =
  | { type: 'reasoning_chunk'; chunk: string }
  | { type: 'content_chunk'; chunk: string }
  | { type: 'tool_call_start'; toolCall: ToolCall }
  | { type: 'tool_call_result'; toolCallId: string; result: unknown; isError?: boolean }
  | {
      type: 'approval_requested';
      request: ApprovalRequest;
      resolve: (approved: boolean) => void;
    }
  | { type: 'approval_resolved'; id: string; approved: boolean }
  | {
      type: 'question_requested';
      request: QuestionRequest;
      resolve: (answer: string) => void;
    }
  | { type: 'question_resolved'; id: string; answer: string }
  | { type: 'usage_sync'; promptTokens: number; completionTokens: number; reasoningTokens?: number }
  | { type: 'server_status'; connected: boolean; message: string; remoteToolsCount: number }
  | { type: 'done'; finalMessage: Message }
  | { type: 'error'; error: string };

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'executing_tool'
  | 'waiting_approval'
  | 'waiting_question'
  | 'done'
  | 'error';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}
