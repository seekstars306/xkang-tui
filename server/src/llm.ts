import { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { ServerConfig } from './types.js';
import { AuditLogger } from './auth.js';
import { ActiveModelManager, ManagedModelId, classifyRequest, isHarnessReminderText, SERVER_COMPANY_MCP_TOOLS } from './model_state.js';
import { getServerBasePrompt } from './system_prompt.js';

export const PUBLIC_MODEL_ALIAS = 'xkang-managed';

export function getProviderClient(model: ManagedModelId, config: ServerConfig): { client: OpenAI; targetModel: string; reasoningEffort?: 'high' } {
  // 180 seconds generous timeout for large multi-modal reasoning & deep search calls
  const API_TIMEOUT_MS = 180000;
  // Retry transient upstream failures (502/503/429/conn reset) up to 4 times.
  // The OpenAI SDK retries non-streaming requests by default (maxRetries=2), but
  // streaming create() calls that fail at connection time are NOT retried by the
  // SDK — so we also wrap the streaming create() in our own retry loop below.
  const MAX_RETRIES = 4;

  if (model === 'deepseek') {
    if (!config.deepseekApiKey) {
      throw new Error('DEEPSEEK_API_KEY 未在服务端配置');
    }
    return {
      client: new OpenAI({
        apiKey: config.deepseekApiKey,
        baseURL: config.deepseekBaseUrl,
        timeout: API_TIMEOUT_MS,
        maxRetries: MAX_RETRIES,
      }),
      targetModel: config.deepseekModel || 'deepseek-chat',
    };
  } else if (model === 'grok') {
    if (!config.grokApiKey) {
      throw new Error('GROK_API_KEY 未在服务端配置');
    }
    return {
      client: new OpenAI({
        apiKey: config.grokApiKey,
        baseURL: config.grokBaseUrl,
        timeout: API_TIMEOUT_MS,
        maxRetries: MAX_RETRIES,
      }),
      targetModel: config.grokModel || 'grok-4.6-medium',
    };
  } else if (model === 'gemini') {
    const geminiKey = config.geminiApiKey;
    if (!geminiKey) {
      throw new Error('GEMINI_API_KEY 未在服务端配置');
    }
    return {
      client: new OpenAI({
        apiKey: geminiKey,
        baseURL: config.geminiBaseUrl,
        timeout: API_TIMEOUT_MS,
        maxRetries: MAX_RETRIES,
      }),
      targetModel: config.geminiModel || 'gemini-3.8-flash-high',
      reasoningEffort: config.geminiReasoningEffort === 'default' ? undefined : 'high',
    };
  }

  throw new Error(`未知或未配置的模型标识: "${model}"`);
}

/**
 * Whether an upstream error is transient and worth retrying.
 * Covers HTTP 408/409/429/5xx and common network errors (ECONNRESET, ETIMEDOUT, EAI_AGAIN).
 */
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b(408|409|429|500|502|503|504)\b/.test(msg)) return true;
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|fetch failed/i.test(msg)) return true;
  return false;
}

/**
 * Sleep with exponential backoff + jitter: base * 2^attempt + random(0, base)
 */
function backoffDelay(attempt: number, baseMs = 800): number {
  const exp = Math.min(baseMs * Math.pow(2, attempt), 8000);
  return exp + Math.floor(Math.random() * baseMs);
}

// Built-in mock stream generator for testing model switching and in-flight continuity without live API keys
async function* mockUpstreamStream(model: ManagedModelId, chunkDelayMs = 180) {
  const created = Math.floor(Date.now() / 1000);
  const makeChunk = (delta: any, usage?: any) => ({
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion.chunk',
    created,
    model: `real-${model}-backend-hidden`,
    choices: [{ index: 0, delta, finish_reason: null }],
    ...(usage ? { usage } : {}),
  });

  // DeepSeek emits reasoning chunks first
  if (model === 'deepseek') {
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, chunkDelayMs));
      yield makeChunk({ reasoning_content: `[mock-deepseek 深度推理思考片段 ${i}/3] ` });
    }
  }

  // All models emit content chunks
  for (let i = 1; i <= 5; i++) {
    await new Promise((r) => setTimeout(r, chunkDelayMs));
    yield makeChunk({ content: `[mock-${model} 业务排障分析片段 ${i}/5] ` });
  }

  // Final usage chunk
  yield makeChunk(
    {},
    {
      prompt_tokens: 120,
      completion_tokens: 45,
      total_tokens: 165,
      completion_tokens_details: {
        reasoning_tokens: model === 'deepseek' ? 25 : 0,
      },
    }
  );
}

/**
 * 严格清洗与归一化 OpenAI / Gemini / DeepSeek 消息序列，防止出现 400 Function call turn 错误：
 * 1. 确保系统提示词在最前，首条对话消息必为 'user'
 * 2. 移除无法匹配前序 tool_call 的孤立 'tool' 消息
 * 3. 自动闭合缺少 tool 响应的 assistant tool_calls (补全 synthetic 响应)
 * 4. 对于带 tool_calls 的 assistant 消息，content 设为 null 而非空字符串 ''
 * 5. 确保 tool_call_id 与参数合法
 */
export function sanitizeOpenAiMessages(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const systemMessages: any[] = [];
  const conversationMessages: any[] = [];

  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      systemMessages.push({ role: 'system', content: text });
    } else {
      conversationMessages.push(m);
    }
  }

  // 确保第一条对话消息为 'user'
  const firstUserIdx = conversationMessages.findIndex((m) => m.role === 'user');
  if (firstUserIdx === -1) {
    conversationMessages.unshift({ role: 'user', content: '请开始排障分析' });
  } else if (firstUserIdx > 0) {
    // 裁剪掉第一个 user 消息前遗留的孤立 tool/assistant 消息
    conversationMessages.splice(0, firstUserIdx);
  }

  const sanitized: any[] = [];
  // 维护尚未收到对应 tool 响应的 tool_call_id 集合
  const pendingToolCalls = new Map<string, string>(); // toolCallId -> functionName

  for (const m of conversationMessages) {
    const role = m.role;

    if (role === 'assistant') {
      let content =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? JSON.stringify(m.content)
            : null;

      let toolCalls: any[] | undefined = undefined;

      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        toolCalls = m.tool_calls.map((tc: any, idx: number) => {
          const id = tc.id || `call_${Date.now()}_${idx}`;
          const fnName = tc.function?.name || tc.name || 'unknown_tool';
          let args = tc.function?.arguments ?? tc.arguments ?? '{}';
          if (typeof args !== 'string') {
            try {
              args = JSON.stringify(args);
            } catch {
              args = '{}';
            }
          }
          return {
            id,
            type: 'function',
            function: {
              name: fnName,
              arguments: args || '{}',
            },
            // 透传供应商私有字段（如 Gemini 的 extra_content.google.thought_signature），
            // 丢失后多轮工具调用之间的推理链会断开，部分模型还会直接拒绝请求
            ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
          };
        });
      }

      // 如果前一个 assistant 包含 tool_calls 但后续未提供 tool 响应便迎来了新的 assistant，自动补全 synthetic tool 响应
      if (pendingToolCalls.size > 0) {
        for (const [missingId, missingFn] of pendingToolCalls.entries()) {
          sanitized.push({
            role: 'tool',
            tool_call_id: missingId,
            content: `[工具 ${missingFn} 调用已在客户端完成并自动跳过]`,
          });
        }
        pendingToolCalls.clear();
      }

      const item: any = {
        role: 'assistant',
        content: content || (toolCalls ? null : '...'),
      };

      if (toolCalls && toolCalls.length > 0) {
        item.tool_calls = toolCalls;
        toolCalls.forEach((tc) => pendingToolCalls.set(tc.id, tc.function.name));
      }

      sanitized.push(item);
    } else if (role === 'tool') {
      // 若有待响应的 toolCallId，优先使用匹配的或取第一个
      let toolCallId = m.tool_call_id;
      if (!toolCallId || !pendingToolCalls.has(toolCallId)) {
        if (pendingToolCalls.size > 0) {
          toolCallId = Array.from(pendingToolCalls.keys())[0];
        }
      }

      if (toolCallId && pendingToolCalls.has(toolCallId)) {
        pendingToolCalls.delete(toolCallId);
      }

      if (!toolCallId) {
        toolCallId = `call_synth_${Date.now()}`;
      }

      const contentText =
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');

      sanitized.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: contentText,
      });
    } else if (role === 'user') {
      // 如果前一个 assistant 包含 tool_calls 但未等到 tool 响应就插入了 user 消息，先闭合未完成的 tool calls
      if (pendingToolCalls.size > 0) {
        for (const [missingId, missingFn] of pendingToolCalls.entries()) {
          sanitized.push({
            role: 'tool',
            tool_call_id: missingId,
            content: `[工具 ${missingFn} 调用已在客户端完成并自动跳过]`,
          });
        }
        pendingToolCalls.clear();
      }

      sanitized.push({
        role: 'user',
        content: Array.isArray(m.content)
          ? m.content.map((p: any) => {
              if (p && p.type === 'image_url') {
                // 剥离内部辅助字段，只保留上游 API 认识的结构
                const { _savedLocalPath, ...rest } = p;
                return rest;
              }
              return p;
            })
          : m.content || '',
      });
    }
  }

  // 最终收尾：若结尾仍有未闭合的 tool calls（极端情况），补全 synthetic 响应
  if (pendingToolCalls.size > 0) {
    for (const [missingId, missingFn] of pendingToolCalls.entries()) {
      sanitized.push({
        role: 'tool',
        tool_call_id: missingId,
        content: `[工具 ${missingFn} 调用已在客户端完成]`,
      });
    }
    pendingToolCalls.clear();
  }

  return [...systemMessages, ...sanitized];
}

/** 把（已归一化的）消息序列中的系统提示词替换为 L1 提示词，原地修改 */
export function applyL1SystemPrompt(openAiMessages: any[]): void {
  const l1Prompt = getServerBasePrompt('l1');
  const firstSystemIdx = openAiMessages.findIndex((m) => m.role === 'system');
  if (firstSystemIdx >= 0) {
    openAiMessages[firstSystemIdx] = { role: 'system', content: l1Prompt };
    for (let i = openAiMessages.length - 1; i > firstSystemIdx; i--) {
      if (openAiMessages[i].role === 'system') openAiMessages.splice(i, 1);
    }
  } else {
    openAiMessages.unshift({ role: 'system', content: l1Prompt });
  }
}

function saveBase64ImagesToDiskAndExtractPaths(messages: any[], baseDir: string = './data/uploads'): string[] {
  const savedPaths: string[] = [];
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const targetDir = path.resolve(baseDir, monthStr);

  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      console.error('[ImageSaver] 创建截图目录失败:', err);
    }
  }

  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          const urlStr = String(part.image_url.url);
          if (urlStr.startsWith('data:image/')) {
            const matches = urlStr.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
            if (matches) {
              const ext = matches[1].toLowerCase() === 'jpeg' ? 'jpg' : matches[1].toLowerCase();
              const base64Data = matches[2];
              const fileName = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
              const filePath = path.join(targetDir, fileName);
              try {
                fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
                savedPaths.push(filePath);
                part._savedLocalPath = filePath;
              } catch (e) {
                console.error('[ImageSaver] 保存图片到服务端失败:', e);
              }
            }
          }
        }
      }
    }
  }
  return savedPaths;
}

function extractUserPromptSummary(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        if (isHarnessReminderText(m.content)) continue;
        return m.content;
      }
      if (Array.isArray(m.content)) {
        const textParts: string[] = [];
        const imagePaths: string[] = [];
        for (const p of m.content) {
          if (p.type === 'text' && p.text) {
            textParts.push(p.text);
          } else if (p.type === 'image_url') {
            if (p._savedLocalPath) {
              imagePaths.push(`[截图: ${p._savedLocalPath}]`);
            } else {
              imagePaths.push('[图片截图]');
            }
          }
        }
        return [...imagePaths, ...textParts].join(' ');
      }
    }
  }
  return '';
}

export function setupLlmProxy(
  config: ServerConfig,
  audit: AuditLogger,
  modelManager: ActiveModelManager,
  options: { localOnly?: boolean } = {}
) {
  return async (req: Request, res: Response): Promise<void> => {
    const user = req.user?.name || 'unknown';
    const startTime = Date.now();
    const { messages, tools, stream = true } = req.body;

    // 当用户上传/粘贴截图时，自动提取 Base64 图片保存至服务端持久化目录，避免大体积 Base64 塞满 SQLite
    saveBase64ImagesToDiskAndExtractPaths(messages || [], './data/uploads');

    // Guard: abrupt client disconnects on this SSE stream must not crash the process
    res.on('error', (err: Error) => {
      console.warn(`[LLM Proxy] 客户端 SSE 流错误 (已安全忽略): ${err?.message || err}`);
    });

    // Snapshot the active model mode (e.g. 'auto' or explicit 'grok'/'gemini')
    const activeSetting = modelManager.getActive();
    const classification = classifyRequest(messages || [], tools, activeSetting, {
      enableL1: config.enableL1,
      enableL2: config.enableL2,
    });
    if (options.localOnly) {
      classification.tier = 'l1';
      classification.matchedRule = 'LOCAL_ASSISTANT_ONLY';
      classification.reason = '员工模型接口仅处理独立本机会话';
    }
    const actualModel = classification.targetModel;

    console.log(
      `[LLM Router] 请求调度: 模型=[${actualModel}] (级别: ${classification.tier.toUpperCase()} | 规则: ${classification.matchedRule}) -> ${classification.reason}`
    );

    let accumulatedPromptTokens = 0;
    let accumulatedCompletionTokens = 0;
    let accumulatedReasoningTokens = 0;
    let reportedTotalTokens: number | undefined;
    let cachedInputTokens: number | undefined;
    let accumulatedResponseText = '';
    const toolCallNames = new Set<string>();

    try {
      // Transform and sanitize messages for upstream providers (OpenAI, Gemini, DeepSeek, Grok)
      const openAiMessages = sanitizeOpenAiMessages(messages || []);

      let openAiTools: any[] | undefined = tools && tools.length > 0 ? tools : undefined;
      if (options.localOnly && openAiTools) {
        const localNames = new Set(['todo_write', 'ask_user_question', 'web_fetch', 'write_file', 'edit_file', 'run_powershell', 'read_tool_result']);
        openAiTools = openAiTools.filter(tool => localNames.has(tool.function?.name));
        if (!openAiTools.length) openAiTools = undefined;
      }

      // When request is routed to L1 (Grok), completely strip server-side company code/DB tools from tool definitions
      if (classification.tier === 'l1') {
        if (openAiTools) {
          openAiTools = openAiTools.filter((t: any) => {
            const fnName = t.function?.name || t.name;
            return !SERVER_COMPANY_MCP_TOOLS.has(fnName);
          });
          if (openAiTools.length === 0) {
            openAiTools = undefined;
          }
        }
        // 客户端在托管模式下总是发送 L2 提示词；L1 通道必须换成带升级协议的 L1 提示词，
        // 否则 L1 模型会被要求使用它根本拿不到的查库/查码工具
        applyL1SystemPrompt(openAiMessages);
      }

      // Set headers for SSE stream with no-buffering guarantees
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Send periodic keep-alive SSE ping comments every 15s to keep intermediate proxy & client sockets active
      const pingInterval = setInterval(() => {
        if (!res.writableEnded) {
          try {
            res.write(': ping\n\n');
          } catch {}
        }
      }, 15000);

      let upstreamStream: AsyncIterable<any> | null = null;

      try {
        if (config.mockLlm) {
          upstreamStream = mockUpstreamStream(actualModel);
        } else {
          const { client, targetModel, reasoningEffort } = getProviderClient(actualModel, config);
          // The OpenAI SDK does NOT retry streaming create() calls that fail at
          // connection time (e.g. upstream 502). Wrap in our own retry loop so a
          // transient upstream hiccup doesn't immediately surface as an error
          // to the client. We only retry BEFORE any bytes have been streamed to
          // the client — once streaming starts, a mid-stream failure is passed
          // through (partial output is already committed to the SSE response).
          const MAX_STREAM_RETRIES = 4;
          let lastErr: unknown;
          for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
            try {
              upstreamStream = (await client.chat.completions.create({
                model: targetModel,
                ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
                messages: openAiMessages,
                tools: openAiTools,
                stream: true,
                stream_options: { include_usage: true },
              })) as unknown as AsyncIterable<any>;
              break;
            } catch (err: unknown) {
              lastErr = err;
              if (attempt < MAX_STREAM_RETRIES && isTransientError(err)) {
                const delay = backoffDelay(attempt);
                console.warn(`[LLM Proxy] 上游连接失败 (第${attempt + 1}次), ${delay}ms 后重试: ${err instanceof Error ? err.message : err}`);
                await new Promise((r) => setTimeout(r, delay));
                continue;
              }
              throw err;
            }
          }
          if (!upstreamStream) throw lastErr;
        }

        for await (const chunk of upstreamStream) {
          // Intercept usage if present
          if (chunk.usage) {
            accumulatedPromptTokens = chunk.usage.prompt_tokens || 0;
            accumulatedCompletionTokens = chunk.usage.completion_tokens || 0;
            accumulatedReasoningTokens =
              chunk.usage.completion_tokens_details?.reasoning_tokens || 0;
            reportedTotalTokens = chunk.usage.total_tokens;
            cachedInputTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
          }

          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            accumulatedResponseText += delta.content;
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.function?.name) toolCallNames.add(tc.function.name);
            }
          }

          // HIDE REAL MODEL: Always rewrite model field to public alias 'xkang-managed'
          const sanitizedChunk = {
            ...chunk,
            model: PUBLIC_MODEL_ALIAS,
          };

          // Write sanitized SSE chunk
          res.write(`data: ${JSON.stringify(sanitizedChunk)}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } finally {
        clearInterval(pingInterval);
      }

      // Audit LLM call: 存储用户输入、AI回复/工具调用、模型级别等核心排障审计流水
      const userPrompt = extractUserPromptSummary(messages || []);
      const outputText = accumulatedResponseText.trim();
      const toolsInvoked = Array.from(toolCallNames);

      audit.log({
        timestamp: new Date().toISOString(),
        user,
        type: 'llm_chat',
        model: `${actualModel} [${classification.tier.toUpperCase()}]`,
        details: {
          tier: classification.tier,
          reasoningEffort: actualModel === 'gemini' && config.geminiReasoningEffort !== 'default' ? 'high' : 'default',
          reasoningTokens: accumulatedReasoningTokens,
          cachedInputTokens,
          userInput: userPrompt.length > 500 ? userPrompt.slice(0, 500) + '...' : userPrompt,
          assistantOutput: outputText.length > 500 ? outputText.slice(0, 500) + '...' : outputText,
          toolCalls: toolsInvoked.length > 0 ? toolsInvoked : undefined,
        },
        tokensUsed: {
          promptTokens: accumulatedPromptTokens,
          completionTokens: accumulatedCompletionTokens,
          reasoningTokens: accumulatedReasoningTokens,
          totalTokens: reportedTotalTokens ?? accumulatedPromptTokens + accumulatedCompletionTokens,
        },
        durationMs: Date.now() - startTime,
        success: true,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      audit.log({
        timestamp: new Date().toISOString(),
        user,
        type: 'llm_chat',
        model: `${PUBLIC_MODEL_ALIAS} (实际调度: ${actualModel})`,
        durationMs: Date.now() - startTime,
        success: false,
        error: errorMsg,
      });

      if (!res.headersSent) {
        res.status(500).json({ error: options.localOnly ? '模型服务暂时未完成请求，请稍后重试。' : `[xkang 服务端 LLM 代理错误] ${errorMsg}` });
      } else {
        res.write(`data: ${JSON.stringify({ error: { message: options.localOnly ? '模型服务暂时未完成请求，请稍后重试。' : errorMsg } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  };
}
