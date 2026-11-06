import type { ToolDefinition, RemoteSkill } from '../types/index.js';
import { getLocalEnvironmentContext } from '../utils/device.js';
export type PromptTier = 'l1' | 'l2';
export interface PromptSection { name: string; order: number; text: string }
export const SERVER_COMPANY_MCP_TOOLS = new Set(['lookup_order', 'company_db_query', 'search_code', 'read_file_lines', 'search_logs', 'codegraph_explore', 'git_inspect', 'list_log_apps']);
export function getPromptTierForModel(model: string): PromptTier { return model.includes('grok') ? 'l1' : 'l2'; }
export class SystemPromptBuilder {
  private sections = new Map<string, PromptSection>();
  constructor(options: PromptTier | { tier?: PromptTier; hasImages?: boolean } = 'l1') {
    const env = getLocalEnvironmentContext();
    this.addSection({ name: 'persona', order: 0, text: '你是独立本机助手，仅处理本机文档、文件与日常问题。只使用当前提供的本机工具；公司业务问题请用户切换到业务排障入口。本机会话无法访问公司业务记录，也不能凭空编造。编辑文件或执行命令必须经过审批。查询失败或超时的步骤保持未完成。' });
    this.addSection({ name: 'environment', order: 20, text: '当前运行平台：' + env.os + '；本机工作目录：' + env.cwd });
    if (typeof options === 'object' && options.hasImages) this.addSection({ name: 'images', order: 10, text: '本轮截图排障规则：根据用户提供的图片核对可见信息，不要把截图外的内容当作事实。' });
  }
  addSection(section: PromptSection) { this.sections.set(section.name, section); return this; }
  addToolGuidance(_name: string) { return this; }
  addRemoteSkill(_skill: RemoteSkill) { return this; }
  build(_tools?: ToolDefinition[], _skills?: RemoteSkill[]) { return [...this.sections.values()].sort((a, b) => a.order - b.order).map(s => s.text).join('\n\n'); }
}
export function buildSystemPrompt(tools?: ToolDefinition[], skills?: RemoteSkill[], tier: PromptTier = 'l1', options?: { hasImages?: boolean }) {
  return new SystemPromptBuilder({ tier, hasImages: options?.hasImages }).build(tools, skills);
}
