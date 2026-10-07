import { ModelGateway } from '../adapters/gateway.js';
import { buildSystemPrompt, getPromptTierForModel } from './system_prompt.js';
import { ToolRegistry } from '../tools/registry.js';
import {
  ApprovalRequest,
  HarnessContext,
  Message,
  MessageContentPart,
  ModelType,
  StreamEvent,
  TokenUsage,
} from '../types/index.js';
import { UNIFIED_COMPACTION_THRESHOLD, UNIFIED_CONTEXT_WINDOW } from '../config/models.js';
import { extractImagesFromInput } from '../utils/image.js';

export interface AgentOptions {
  gateway: ModelGateway;
  registry: ToolRegistry;
  context: HarnessContext;
}

export class AgentHarness {
  private gateway: ModelGateway;
  private registry: ToolRegistry;
  private context: HarnessContext;
  private messages: Message[] = [];
  private tokenUsage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
  private toolHallucinationRetries = 0;
  private l2EscalationUsed = false;
  private logGateRetries = 0;
  private dbDegradationHinted = false;

  constructor(options: AgentOptions) {
    this.gateway = options.gateway;
    this.registry = options.registry;
    this.context = options.context;

    this.initSystemPrompt();
  }

  private initSystemPrompt(): void {
    const activeTools = this.registry.getTools();
    const remoteSkills = this.registry.getRemoteSkills();
    const currentModel = this.getCurrentModel();
    const tier = getPromptTierForModel(currentModel);
    const systemPromptText = buildSystemPrompt(activeTools, remoteSkills, tier, { hasImages: false });

    this.messages = [
      {
        role: 'system',
        content: systemPromptText,
      },
    ];
  }

  public refreshSystemPrompt(): void {
    const activeTools = this.registry.getTools();
    const remoteSkills = this.registry.getRemoteSkills();
    const currentModel = this.getCurrentModel();
    const tier = getPromptTierForModel(currentModel);
    const hasImages = this.hasImagesInContext();
    const systemPromptText = buildSystemPrompt(activeTools, remoteSkills, tier, { hasImages });

    if (this.messages.length > 0 && this.messages[0].role === 'system') {
      this.messages[0].content = systemPromptText;
    } else {
      this.messages.unshift({
        role: 'system',
        content: systemPromptText,
      });
    }
  }

  private hasImagesInContext(): boolean {
    for (const msg of this.messages) {
      if (Array.isArray(msg.content)) {
        if (msg.content.some((p) => p.type === 'image_url')) return true;
      }
    }
    return false;
  }

  getCurrentModel(): ModelType {
    return this.gateway.getCurrentModel();
  }

  switchModel(model: ModelType): void {
    this.gateway.switchModel(model);
    // If conversation is at initial turn (only 1 system message), refresh with model's tier
    if (this.messages.length === 1 && this.messages[0].role === 'system') {
      this.initSystemPrompt();
    }
  }

  getMessages(): Message[] {
    return this.messages;
  }

  public restoreMessages(messages: Message[]): void {
    if (Array.isArray(messages) && messages.length > 0) {
      this.messages = messages;
    }
  }

  getTokenUsage(): TokenUsage {
    return this.tokenUsage;
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  clearHistory(): void {
    this.messages = [];
    this.initSystemPrompt();
    this.tokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
  }

  private estimateMessagesTokens(): number {
    let totalChars = 0;
    for (const msg of this.messages) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            totalChars += part.text.length;
          } else if (part.type === 'image_url') {
            // High-res images in OpenAI / Gemini format roughly consume ~800-1600 tokens
            totalChars += 2000;
          }
        }
      }
      if (msg.reasoning_content) totalChars += msg.reasoning_content.length;
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          totalChars += (tc.name || '').length;
          totalChars += typeof tc.arguments === 'string' ? tc.arguments.length : JSON.stringify(tc.arguments || {}).length;
        }
      }
    }
    // Conservative token estimation: ~2.5 characters per token for mixed bilingual + code
    return Math.ceil(totalChars / 2.5);
  }

  private compactHistory(): void {
    // 128k unified context window: Do NOT prematurely compress tool outputs.
    // Full search results & code files are critical for complex multi-turn troubleshooting.
    // Only drop oldest historical turn groups if strictly approaching the 110k safety boundary.
    const SAFETY_COMPACTION_LIMIT = 110000;
    let currentTokens = this.estimateMessagesTokens();

    while (currentTokens > SAFETY_COMPACTION_LIMIT && this.messages.length > 4) {
      // Find the first user message (skip system prompt at index 0)
      const firstUserIdx = this.messages.findIndex((m, idx) => idx > 0 && m.role === 'user');
      if (firstUserIdx === -1) break;

      // Find the second user message (end of the oldest complete turn)
      const nextUserIdx = this.messages.findIndex((m, idx) => idx > firstUserIdx && m.role === 'user');
      if (nextUserIdx === -1) break;

      // Atomically remove the entire oldest user turn (including all intermediate tool calls/responses)
      const countToRemove = nextUserIdx - firstUserIdx;
      this.messages.splice(firstUserIdx, countToRemove);
      currentTokens = this.estimateMessagesTokens();
    }
  }

  async run(userInput: string | MessageContentPart[], onEvent: (event: StreamEvent) => void): Promise<string> {
    if (typeof userInput === 'string') {
      const imgResult = extractImagesFromInput(userInput);
      if (imgResult.hasImages) {
        this.messages.push({
          role: 'user',
          content: imgResult.parts,
        });
      } else {
        this.messages.push({
          role: 'user',
          content: userInput,
        });
      }
    } else {
      this.messages.push({
        role: 'user',
        content: userInput,
      });
    }

    // 动态根据当前会话是否包含图片刷新系统提示词（纯文本保持精简，检测到图片时按需加载视觉排障与防误导规则）
    this.refreshSystemPrompt();
    // 每轮新输入重置纠偏计数、L2 升级标记与通道降级提醒标记
    this.toolHallucinationRetries = 0;
    this.l2EscalationUsed = false;
    this.logGateRetries = 0;
    this.dbDegradationHinted = false;

    let finalAssistantReply = '';
    let turnCount = 0;
    const MAX_TURNS = 50;

    while (turnCount < MAX_TURNS) {
      turnCount++;
      this.compactHistory();

      const activeTools = this.registry.getTools();
      let assistantMessage: Message;

      try {
        assistantMessage = await this.gateway.streamChat(
          this.messages,
          activeTools,
          (event) => {
            if (event.type === 'usage_sync') {
              this.tokenUsage.promptTokens = event.promptTokens;
              this.tokenUsage.completionTokens += event.completionTokens;
              this.tokenUsage.reasoningTokens += event.reasoningTokens || 0;
              this.tokenUsage.totalTokens =
                this.tokenUsage.promptTokens + this.tokenUsage.completionTokens;
            }
            onEvent(event);
          }
        );
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        onEvent({ type: 'error', error: `模型调用发生错误: ${errorMsg}` });
        return `[错误] 模型调用异常: ${errorMsg}`;
      }

      this.messages.push(assistantMessage);

      // If no tool calls requested, we reached the final answer
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        finalAssistantReply =
          typeof assistantMessage.content === 'string'
            ? assistantMessage.content
            : (assistantMessage.content == null ? '' : JSON.stringify(assistantMessage.content));

        // If content is empty but model produced reasoning_content, use reasoning_content as final answer
        if (!finalAssistantReply.trim() && assistantMessage.reasoning_content && assistantMessage.reasoning_content.trim()) {
          finalAssistantReply = assistantMessage.reasoning_content;
          assistantMessage.content = assistantMessage.reasoning_content;
          onEvent({ type: 'content_chunk', chunk: assistantMessage.reasoning_content });
          onEvent({ type: 'done', finalMessage: assistantMessage });
          break;
        }

        // Fallback for completely empty reply: nudge model to continue
        if (!finalAssistantReply.trim()) {
          assistantMessage.content = '[已完成工具调用并收集到排障证据]';
          this.messages.push({
            role: 'user',
            content: '请根据前面工具调用的检索结果，直接输出结构化三段式排障报告（结论分析 + 核心代码/数据佐证 + 客服话术与处理建议）。',
          });
          continue;
        }

        // 工具调用幻觉兜底：模型用文字描述"工具调用中/已执行/教命令"却未真正发起 tool_calls 时，纠偏重试
        if (
          this.toolHallucinationRetries < 2 &&
          /工具调用中|正在调用工具|正在执行工具|我来帮你(调用|执行)|我已(经)?为你?(执行|调用|运行)|已成功执行(命令|工具)|(测试|查询|执行)命令[：:]{0,2}\s*```|请(您|你)(手动|自行|在终端|打开\s*(cmd|powershell))/i.test(finalAssistantReply)
        ) {
          this.toolHallucinationRetries++;
          // 该幻觉文本不进入会话历史，替换为标记后注入纠偏指令
          assistantMessage.content = '[上一条回复仅用文字描述了工具调用，未真正发起]';
          this.messages.push({
            role: 'user',
            content: '你刚才只是用文字"描述"了工具调用，并没有真正发起 tool_calls，且编造了执行结果，这是严格禁止的！请立即重新发起真实的工具调用（如 run_powershell / write_file / edit_file），不要输出任何"工具调用中"之类的文字描述。若任务确实无需工具，直接给出最终答案。',
          });
          continue;
        }

        // L1 能力升级协议：L1 声明无法处理（需要内部数据/深度排障）时，自动升级 L2 重新处理，用户无需重试
        if (!this.l2EscalationUsed && finalAssistantReply.includes('[[ESCALATE_TO_L2]]')) {
          this.l2EscalationUsed = true;
          onEvent({
            type: 'content_chunk',
            chunk: '⏫ 该问题需要查询内部业务数据，正在自动升级至深度排障引擎，请稍候…\n\n',
          });
          // L1 的升级声明不作为最终答案保留，替换为标记后注入升级指令（服务端据此路由至 L2）
          assistantMessage.content = '[本请求已自动升级至 L2 深度排障引擎处理]';
          this.messages.push({
            role: 'user',
            content: '[[ESCALATE_TO_L2]] 请以深度排障引擎重新完整处理我上面的原始请求：直接查证内部数据库/日志并输出结构化排障结论，不要重复询问已经提供过的信息。',
          });
          continue;
        }

        // =========================================================================
        // 通用系统稳定性与智能引导守卫（非硬编码业务拦截）
        // 1. 如果模型回答为空或仅有思考，进行轻度提示
        // 2. 正常完成所有工具交互后直接输出结论
        // =========================================================================
        onEvent({ type: 'done', finalMessage: assistantMessage });
        break;
      }

      // Execute requested tool calls (either locally or via remote MCP server)
      for (const toolCall of assistantMessage.tool_calls) {
        let resultString = '';
        const tool = this.registry.getTool(toolCall.name);

        if (!tool) {
          // L1 通道模型尝试调用 L2 专属工具（如 search_code, search_logs 等）时，harness 强制自动升级至 L2
          if (!this.l2EscalationUsed) {
            this.l2EscalationUsed = true;
            resultString = `错误: 当前通道未加载工具 "${toolCall.name}"（该工具属于 L2 深度排障通道）。系统正在为您自动升级至深度排障引擎...`;
            onEvent({
              type: 'tool_call_result',
              toolCallId: toolCall.id,
              result: resultString,
              isError: true,
            });
            this.messages.push({
              role: 'tool',
              name: toolCall.name,
              tool_call_id: toolCall.id,
              content: resultString,
            });
            onEvent({
              type: 'content_chunk',
              chunk: `\n\n⏫ 检测到需要使用深度排障工具 [${toolCall.name}]，正在自动升级至深度排障引擎，请稍候…\n\n`,
            });
            this.messages.push({
              role: 'user',
              content: '[[ESCALATE_TO_L2]] 请以深度排障引擎重新完整处理我上面的原始请求：直接调用 search_code / search_logs / company_db_query 等企业级排障工具完成查证并输出三段式排障报告。',
            });
            continue;
          }

          resultString = `错误: 当前通道未加载工具 "${toolCall.name}"。`;
          onEvent({
            type: 'tool_call_result',
            toolCallId: toolCall.id,
            result: resultString,
            isError: true,
          });
          this.messages.push({
            role: 'tool',
            name: toolCall.name,
            tool_call_id: toolCall.id,
            content: resultString,
          });
          continue;
        }

        try {
          const args =
            typeof toolCall.arguments === 'string'
              ? JSON.parse(toolCall.arguments)
              : toolCall.arguments;

          // Check if tool execution requires employee approval gate (e.g. write_file, edit_file)
          if (tool.requiresApproval) {
            let approvalInfo: {
              filePath: string;
              summary: string;
              diffPreview?: string;
            } = {
              filePath: String(args.file_path || '未知文件'),
              summary: `准备对文件执行 ${tool.name} 操作`,
              diffPreview: undefined,
            };

            if (tool.getApprovalInfo) {
              try {
                approvalInfo = await tool.getApprovalInfo(args, this.context);
              } catch (infoErr: unknown) {
                const infoErrMsg = infoErr instanceof Error ? infoErr.message : String(infoErr);
                resultString = `操作参数预检失败: ${infoErrMsg}`;
                onEvent({
                  type: 'tool_call_result',
                  toolCallId: toolCall.id,
                  result: resultString,
                  isError: true,
                });
                this.messages.push({
                  role: 'tool',
                  name: toolCall.name,
                  tool_call_id: toolCall.id,
                  content: resultString,
                });
                continue;
              }
            }

            const approvalRequest: ApprovalRequest = {
              id: `req_${Date.now()}_${toolCall.id}`,
              toolName: tool.name,
              description: tool.description,
              filePath: approvalInfo.filePath,
              summary: approvalInfo.summary,
              diffPreview: approvalInfo.diffPreview,
            };

            // Suspend execution and wait for employee decision via Promise
            const isApproved = await new Promise<boolean>((resolve) => {
              onEvent({
                type: 'approval_requested',
                request: approvalRequest,
                resolve: (decision: boolean) => {
                  onEvent({
                    type: 'approval_resolved',
                    id: approvalRequest.id,
                    approved: decision,
                  });
                  resolve(decision);
                },
              });
            });

            if (!isApproved) {
              resultString = `[操作未执行：员工在操作审批门中拒绝了本次修改请求 (目标文件: ${approvalInfo.filePath})]`;
              onEvent({
                type: 'tool_call_result',
                toolCallId: toolCall.id,
                result: resultString,
                isError: false,
              });
              this.messages.push({
                role: 'tool',
                name: toolCall.name,
                tool_call_id: toolCall.id,
                content: resultString,
              });
              continue;
            }
          }

          // 针对 ask_user_question 发起交互式确认门（Question Gate），挂起并等待客服在 TUI 中用方向键选择
          if (toolCall.name === 'ask_user_question') {
            // 反问兜底：若本会话尚未做过任何查证（查库/查日志/查码），注入纠偏防止模型以反问代替自查
            const hasInvestigated = this.messages.some(
              (m) => m.role === 'tool' && m.name && ['company_db_query', 'search_logs', 'search_code', 'codegraph_explore'].includes(m.name)
            );
            const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
            const questionReq = {
              id: `q_${Date.now()}_${toolCall.id}`,
              questions: rawQuestions,
            };

            const selectedAnswer = await new Promise<string>((resolve) => {
              onEvent({
                type: 'question_requested',
                request: questionReq,
                resolve: (answer: string) => {
                  onEvent({
                    type: 'question_resolved',
                    id: questionReq.id,
                    answer,
                  });
                  resolve(answer);
                },
              });
            });

            resultString = `[客服已通过交互选项确认结果]: ${selectedAnswer}`;
            onEvent({
              type: 'tool_call_result',
              toolCallId: toolCall.id,
              result: resultString,
              isError: false,
            });
            this.messages.push({
              role: 'tool',
              name: toolCall.name,
              tool_call_id: toolCall.id,
              content: resultString,
            });
            if (!hasInvestigated) {
              this.messages.push({
                role: 'user',
                content: '【系统提醒】在向客服提问之前，你必须先自行查证：用 company_db_query 查数据库、用 search_logs 查服务端日志（无单号时用 minutes_ago 查相关服务最近日志）、用 search_code 查代码。严禁把可以通过查证获取的信息反问客服。请立即基于已有线索发起查证工具调用。',
              });
            }
            continue;
          }

          // Execute tool after approval or for read-only tools (with 20s timeout protection)
          const toolTimeoutMs = 20000;
          let timer: NodeJS.Timeout | null = null;
          const toolResult = await Promise.race([
            this.registry.executeTool(toolCall.name, args, this.context),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`工具 [${toolCall.name}] 执行超时 (20s)，已安全熔断`)),
                toolTimeoutMs
              );
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          });

          resultString =
            typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);

          // Hard safety limit: Clamp tool result to 15,000 chars to protect against token overflow
          if (resultString.length > 15000) {
            resultString =
              resultString.slice(0, 15000) +
              '\n... [系统提示: 工具返回结果超过 15000 字符，已安全截断，请结合上文线索继续分析]';
          }

          onEvent({
            type: 'tool_call_result',
            toolCallId: toolCall.id,
            result: resultString,
            isError: false,
          });
        } catch (toolErr: unknown) {
          const errStr = toolErr instanceof Error ? toolErr.message : String(toolErr);
          resultString = `工具执行失败: ${errStr}`;
          onEvent({
            type: 'tool_call_result',
            toolCallId: toolCall.id,
            result: resultString,
            isError: true,
          });
        }

        // Add tool response to history
        this.messages.push({
          role: 'tool',
          name: toolCall.name,
          tool_call_id: toolCall.id,
          content: resultString,
        });
      }

      // 通道降级守卫（通用，无业务语义）：最近工具结果中多次出现超时/连接异常时，
      // 提醒模型停止在同一通道反复重试同形态查询，切换到日志/代码通道继续排查
      if (!this.dbDegradationHinted) {
        const recentToolResults = this.messages.filter((m) => m.role === 'tool').slice(-4);
        const degradedCount = recentToolResults.filter(
          (m) =>
            typeof m.content === 'string' &&
            /超时|ECONNRESET|EPIPE|No MyCAT Database selected/i.test(m.content)
        ).length;
        if (degradedCount >= 3) {
          this.dbDegradationHinted = true;
          onEvent({
            type: 'content_chunk',
            chunk: '⚠️ 检测到数据查询通道连续异常，正在自动切换排查通道…\n\n',
          });
          this.messages.push({
            role: 'user',
            content: '【通道降级提醒】数据库通道近期连续超时/异常，继续重试同形态查询只会浪费轮次并加剧连接池恶化。请立即切换排查通道：1) 用 search_logs 以 keyword="单号" 或时间窗口检索微服务运行日志；2) 用 search_code 检索报错文案定位代码逻辑。若必须查库，先 SHOW INDEX 确认索引列并改用等值查询或窄时间窗口。',
          });
        }
      }
    }

    if (!finalAssistantReply && turnCount >= MAX_TURNS) {
      const fallbackMsg = '⚠️ 很抱歉，系统在可用探索轮次（50 轮）内未找到该问题的关键信息。请补充更多可用线索（如业务类型、大致时间、相关联的单号、用户手机号或报错截图等）后再次查询，系统将基于新线索重新排查。';
      onEvent({ type: 'content_chunk', chunk: fallbackMsg });
      onEvent({ type: 'done', finalMessage: { role: 'assistant', content: fallbackMsg } });
      finalAssistantReply = fallbackMsg;
    }

    return finalAssistantReply;
  }
}
