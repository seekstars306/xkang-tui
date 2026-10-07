import { HarnessContext, ToolDefinition, RemoteSkill } from '../types/index.js';
import { McpRemoteClient } from '../mcp/client.js';

export class ToolRegistry {
  private localTools = new Map<string, ToolDefinition>();
  private remoteTools = new Map<string, ToolDefinition>();
  private remoteSkills: RemoteSkill[] = [];
  private mcpClient: McpRemoteClient | null = null;

  constructor(localTools: ToolDefinition[] = []) {
    for (const tool of localTools) {
      this.registerLocal(tool);
    }
  }

  registerLocal(tool: ToolDefinition): void {
    this.localTools.set(tool.name, { ...tool, isRemote: false });
  }

  registerRemote(tool: ToolDefinition): void {
    this.remoteTools.set(tool.name, { ...tool, isRemote: true });
  }

  setRemoteSkills(skills: RemoteSkill[]): void {
    this.remoteSkills = skills;
  }

  getRemoteSkills(): RemoteSkill[] {
    return this.remoteSkills;
  }

  clearRemote(): void {
    this.remoteTools.clear();
    this.remoteSkills = [];
  }

  getTools(): ToolDefinition[] {
    return [...this.localTools.values(), ...this.remoteTools.values()];
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.localTools.get(name) || this.remoteTools.get(name);
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: HarnessContext
  ): Promise<unknown> {
    const tool = this.getTool(name);
    if (!tool) {
      throw new Error(`未找到名为 "${name}" 的排障工具。`);
    }
    return tool.execute(args, context);
  }

  async syncWithRemote(mcpClient: McpRemoteClient): Promise<{ connected: boolean; count: number; error?: string }> {
    this.mcpClient = mcpClient;
    try {
      const connected = await mcpClient.connect();
      if (!connected) {
        return { connected: false, count: 0, error: '未能连接到服务端，已启用本地基础模式。' };
      }

      const remoteDefs = await mcpClient.listTools();
      const remoteSkills = await mcpClient.fetchSkills();

      this.clearRemote();
      for (const def of remoteDefs) {
        this.registerRemote(def);
      }
      this.setRemoteSkills(remoteSkills);

      return { connected: true, count: remoteDefs.length };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { connected: false, count: 0, error: errMsg };
    }
  }

  get summary(): { count: number; toolNames: string[] } {
    const tools = this.getTools();
    return {
      count: tools.length,
      toolNames: tools.map((t) => t.name),
    };
  }
}
