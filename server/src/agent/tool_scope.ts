import { ServerConfig } from '../types.js';

/**
 * 暂时屏蔽“本机工具”相关内容。
 *
 * 背景：write_file / edit_file / run_powershell / read_tool_result 只在有客户端时存在，
 * 由客户端在本机执行。飞书链路没有客户端，提示词里却写着“全程可用”，
 * 模型于是会答应客服“我帮你改本机文件/查本机 IP”，实际上无工具可调。
 *
 * 这里按链路屏蔽：默认从飞书/服务端会话里去掉这些描述；
 * 将来恢复客户端时设 XKANG_CLIENT_TOOLS=1 即可原样放开，提示词文本本身不删。
 */
const LOCAL_TOOL_PATTERNS = [
  /run_powershell/,
  /write_file/,
  /edit_file/,
  /read_tool_result/,
  /本机/,
  /本地文件/,
  /本地工具/,
];

export function clientToolsEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test(String(process.env.XKANG_CLIENT_TOOLS ?? '').trim());
}

/** 按行过滤：命中小节标题或本机工具描述的行整行去掉，避免留下孤立的分点 */
export function maskClientToolSections(prompt: string, config?: ServerConfig): string {
  if (clientToolsEnabled()) return prompt;
  const lines = prompt.split(/\r?\n/);
  const kept = lines.filter(line => !LOCAL_TOOL_PATTERNS.some(re => re.test(line)));
  // 两个以上连续空行压成一个，避免删行后留下大段空白
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

export const EXPORT_GUIDE = '【导出类请求的操作规程】客服要导出/要一份 Excel 时：1) 先调 db_schema 确认库表列名，不知道字段在哪就用 keyword 搜（如 passport、birth、english），不要猜表名；2) 再用 export_query 直接导文件，行数据不进上下文，可导数万行；导出成功后必须把 export_query 返回的 url 原样写进【业务信息】单独一行，完整可点击，只写文件名等于客服拿不到文件；3) company_db_query 只有 200 行上限，严禁用它取导出数据，否则导出的量一定是错的；4) 导出失败要如实说明，不要凑一份近似结果。';