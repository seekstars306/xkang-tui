import { ServerConfig } from '../types.js';

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchArgs {
  query: string;
  numResults?: number;
}

/** 只有服务端配置了搜索 API Key 时才注册 web_search（见 tools/index.ts） */
export function isWebSearchConfigured(): boolean {
  return Boolean(process.env.SEARCH_API_KEY || process.env.EXA_API_KEY);
}

/**
 * 互联网搜索。以前在未配置 Key 或请求失败时会拼凑出"看起来像真实结果"的假条目
 * （标题/摘要都是用关键词套模板生成的），模型会把它们当成证据引用。现在失败就如实报错。
 */
export async function executeWebSearch(
  args: WebSearchArgs,
  _config: ServerConfig,
  _user: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const query = String(args.query || '').trim();
  const numResults = Math.min(Math.max(Number(args.numResults || 5), 1), 10);

  if (!query) {
    return '错误: query 搜索关键词不能为空。';
  }

  const searchApiKey = process.env.SEARCH_API_KEY || process.env.EXA_API_KEY;
  if (!searchApiKey) {
    return '互联网搜索不可用：服务端未配置 SEARCH_API_KEY。本次没有任何搜索结果，请不要假设搜索到了内容。';
  }

  const searchEndpoint = process.env.SEARCH_API_ENDPOINT || 'https://api.exa.ai/search';
  try {
    const resp = await fetchImpl(searchEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${searchApiKey}`,
        'x-api-key': searchApiKey,
      },
      body: JSON.stringify({ query, numResults, useAutoprompt: true }),
    });
    if (!resp.ok) {
      return `互联网搜索失败: 搜索服务返回 HTTP ${resp.status}。本次没有任何搜索结果。`;
    }
    const data: any = await resp.json();
    const results: SearchResultItem[] = (data.results || []).map((r: any) => ({
      title: r.title || r.name || 'Untitled Result',
      url: r.url || r.link || '',
      snippet: String(r.text || r.snippet || r.highlight || ''),
    }));
    if (results.length === 0) {
      return `互联网搜索没有找到与 "${query}" 相关的结果。`;
    }
    const lines = [
      `【互联网搜索结果 - 关键词: "${query}" (共 ${results.length} 条)】`,
      ...results.map((r, i) => `\n${i + 1}. [${r.title}](${r.url})\n   链接: ${r.url}\n   摘要: ${r.snippet.slice(0, 300)}`),
      '\n提示: 可以通过本地工具 web_fetch(url: "...") 抓取具体链接的全文。',
    ];
    return lines.join('\n');
  } catch (err) {
    return `互联网搜索失败: ${err instanceof Error ? err.message : String(err)}。本次没有任何搜索结果。`;
  }
}
