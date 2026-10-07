import { todoWriteTool } from './todo.js';
import { askUserQuestionTool } from './ask_user.js';
import { webFetchTool } from './web_fetch.js';
import { writeFileTool } from './write.js';
import { editFileTool } from './edit.js';
import { runPowershellTool } from './powershell.js';
import { queryDatabaseTool } from './database.js';
import { ToolDefinition } from '../types/index.js';
import { ToolRegistry } from './registry.js';

// 客服排障终端内置工具列表
// 本地工具：用于客服日常处理本地办公文档、表格、文本整理与受控脚本操作
// 公司代码与日志：通过服务端 MCP 工具（search_code、search_logs、codegraph_explore）执行
export const LOCAL_TOOLS: ToolDefinition[] = [
  todoWriteTool,
  askUserQuestionTool,
  webFetchTool,
  writeFileTool,
  editFileTool,
  runPowershellTool,
  queryDatabaseTool,
];

// Backwards compatibility alias
export const ALL_TOOLS = LOCAL_TOOLS;

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry(LOCAL_TOOLS);
}

export {
  todoWriteTool,
  askUserQuestionTool,
  webFetchTool,
  writeFileTool,
  editFileTool,
  runPowershellTool,
  queryDatabaseTool,
  ToolRegistry,
};
