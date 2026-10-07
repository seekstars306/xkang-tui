import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ToolDefinition, RemoteSkill } from '../types/index.js';
import { getDeviceId } from '../utils/device.js';

export interface McpClientOptions {
  serverUrl: string;
  token?: string;
  timeoutMs?: number;
}

export class McpRemoteClient {
  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;
  private serverUrl: string;
  private token?: string;
  private timeoutMs: number;
  private connected = false;

  constructor(options: McpClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs || 10000;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<boolean> {
    try {
      const deviceId = getDeviceId();
      const sseUrl = new URL(`${this.serverUrl}/mcp/sse`);
      sseUrl.searchParams.set('deviceId', deviceId);

      const headers: Record<string, string> = {
        'Accept': 'text/event-stream',
        'x-device-id': deviceId,
      };
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      this.transport = new SSEClientTransport(sseUrl, {
        eventSourceInit: {
          headers,
        } as any,
        requestInit: {
          headers: {
            'Content-Type': 'application/json',
            'x-device-id': deviceId,
            ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}),
          },
        },
      });

      this.client = new Client(
        {
          name: 'xkang-tui-client',
          version: '1.0.0',
        },
        {
          capabilities: {},
        }
      );

      // Connect with timeout
      await Promise.race([
        this.client.connect(this.transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('MCP Server 连接超时 (10s)')), this.timeoutMs)
        ),
      ]);

      this.connected = true;
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (!this.client || !this.connected) {
      return [];
    }

    try {
      const response = await this.client.listTools();
      return (response.tools || []).map((t) => ({
        name: t.name,
        description: t.description || '',
        parameters: (t.inputSchema as any) || { type: 'object', properties: {} },
        execute: async (args: Record<string, unknown>) => {
          return this.callTool(t.name, args);
        },
        isRemote: true,
      }));
    } catch {
      return [];
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client || !this.connected) {
      throw new Error(`MCP Client 尚未连接到服务端，无法执行远程工具 [${name}]。`);
    }

    const result: any = await this.client.callTool({
      name,
      arguments: args,
    });

    if (result.isError) {
      const errorContent = result.content
        ?.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
        .join('\n');
      throw new Error(errorContent || `远程工具 [${name}] 执行失败。`);
    }

    const textParts = (result.content || [])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => (c as { type: 'text'; text: string }).text);

    return textParts.join('\n');
  }

  async fetchSkills(): Promise<RemoteSkill[]> {
    try {
      const resp = await fetch(`${this.serverUrl}/mcp/skills`, {
        headers: {
          'x-device-id': getDeviceId(),
          ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}),
        },
      });
      if (!resp.ok) return [];
      const json = (await resp.json()) as { skills?: RemoteSkill[] };
      return json.skills || [];
    } catch {
      return [];
    }
  }

  async fetchRemoteSkills(): Promise<RemoteSkill[]> {
    return this.fetchSkills();
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore close error
      }
      this.client = null;
      this.connected = false;
    }
  }
}
