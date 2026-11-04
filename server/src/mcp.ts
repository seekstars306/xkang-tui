import { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ServerConfig } from './types.js';
import { AuditLogger } from './auth.js';
import { createCompanyTools } from './tools/index.js';
import { getCompanyServerSkills } from './skills.js';

export function createConfiguredMcpServer(
  config: ServerConfig,
  audit: AuditLogger
): McpServer {
  const mcpServer = new McpServer({
    name: 'xkang-company-mcp-server',
    version: '1.0.0',
  });

  const companyTools = createCompanyTools(config);

  // Register each company tool with McpServer using registerTool
  for (const tool of companyTools) {
    mcpServer.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
      },
      async (args: any, extra: any) => {
        const startTime = Date.now();
        const user = extra?.user || 'mcp-session-user';
        try {
          const resultText = await tool.execute(args, config, user);
          audit.log({
            timestamp: new Date().toISOString(),
            user,
            type: 'tool_call',
            toolName: tool.name,
            details: {
              args,
              resultPreview: resultText.length > 500 ? resultText.slice(0, 500) + '...' : resultText,
            },
            durationMs: Date.now() - startTime,
            success: true,
          });
          return {
            content: [{ type: 'text', text: resultText }],
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          audit.log({
            timestamp: new Date().toISOString(),
            user,
            type: 'tool_call',
            toolName: tool.name,
            details: { args },
            durationMs: Date.now() - startTime,
            success: false,
            error: errMsg,
          });
          return {
            isError: true,
            content: [{ type: 'text', text: `[服务端执行错误] ${errMsg}` }],
          };
        }
      }
    );
  }

  return mcpServer;
}

export function setupMcpServer(
  app: Express,
  config: ServerConfig,
  audit: AuditLogger
): void {
  const companyTools = createCompanyTools(config);

  // Manage active MCP SSE sessions (each session has its own isolated McpServer instance & transport)
  const activeSessions = new Map<
    string,
    { transport: SSEServerTransport; server: McpServer; user: string }
  >();

  // MCP SSE Connection Endpoint
  app.get('/mcp/sse', async (req: Request, res: Response) => {
    const user = req.user?.name || 'unknown';
    const transport = new SSEServerTransport('/mcp/messages', res);
    const sessionId = transport.sessionId;

    // Guard: socket errors on this SSE stream must not crash the process
    res.on('error', (err: Error) => {
      console.warn(`[MCP] SSE 连接 [${sessionId}] 发生流错误 (已安全忽略): ${err?.message || err}`);
    });

    const serverInstance = createConfiguredMcpServer(config, audit);
    activeSessions.set(sessionId, { transport, server: serverInstance, user });

    res.on('close', async () => {
      const sess = activeSessions.get(sessionId);
      if (sess) {
        try {
          await sess.server.close();
        } catch {
          // ignore close error
        }
        activeSessions.delete(sessionId);
      }
    });

    try {
      await serverInstance.connect(transport);
    } catch (err: unknown) {
      console.warn(`[MCP] SSE 会话 [${sessionId}] 建立失败 (已安全忽略): ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // MCP Messages Endpoint (client POSTs JSON-RPC messages here)
  app.post('/mcp/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const session = activeSessions.get(sessionId);

    if (!session) {
      res.status(404).json({ error: `MCP session "${sessionId}" not found or expired.` });
      return;
    }

    res.on('error', (err: Error) => {
      console.warn(`[MCP] 消息通道 [${sessionId}] 流错误 (已安全忽略): ${err?.message || err}`);
    });

    try {
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (err: unknown) {
      console.warn(`[MCP] 消息处理 [${sessionId}] 异常 (已安全忽略): ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Centralized Skills API: Dynamic skill & guidance dispatch to clients
  app.get('/mcp/skills', (_req: Request, res: Response) => {
    const skills = getCompanyServerSkills();
    res.json({
      status: 'success',
      count: skills.length,
      skills,
    });
  });

  // Direct inspection endpoint for tools list (convenience for lightweight inspection)
  app.get('/mcp/tools/list', (_req: Request, res: Response) => {
    const list = companyTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.schema.shape).map(([k, v]: [string, any]) => [
            k,
            {
              type: v._def?.typeName?.toLowerCase()?.replace('zod', '') || 'string',
              description: v.description,
            },
          ])
        ),
      },
    }));
    res.json({ tools: list });
  });
}
