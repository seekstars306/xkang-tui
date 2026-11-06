import { HarnessContext, ToolDefinition } from '../types/index.js';

// Simple SSRF check for private/loopback IP addresses
function isPrivateIpOrHost(hostname: string): boolean {
  const host = hostname.toLowerCase().trim();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '169.254.169.254'
  ) {
    return true;
  }

  // IPv4 private ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  const ipMatch = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const octet1 = parseInt(ipMatch[1], 10);
    const octet2 = parseInt(ipMatch[2], 10);
    if (octet1 === 10) return true;
    if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return true;
    if (octet1 === 192 && octet2 === 168) return true;
    if (octet1 === 127) return true;
  }

  return false;
}

export function cleanHtmlToMarkdown(html: string): string {
  let text = html;

  // 1. Remove dangerous and unneeded structural tags completely
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');
  text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');
  text = text.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '');
  text = text.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');

  // 2. Convert common semantic tags to markdown
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n\n');
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n\n');
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n\n');
  text = text.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n#### $1\n\n');
  text = text.replace(/<pre[^>]*><code[^>]*>(.*?)<\/code><\/pre>/gis, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, ' `$1` ');
  text = text.replace(/<p[^>]*>/gi, '\n\n');
  text = text.replace(/<\/p>/gi, '');
  text = text.replace(/<br\s*[\/]?>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n* ');
  text = text.replace(/<\/li>/gi, '');
  text = text.replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // 3. Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // 4. Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—');

  // 5. Clean up redundant empty lines
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: '抓取并阅读指定 URL 网页的全文正文内容（自动清洗 HTML 并转为 Markdown 纯文本）。适用于阅读第三方官方排障文档、RFC 规范、开源组件 Issue 或具体报错详情页面。',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '要抓取的完整网页 URL 地址（如 "https://docs.spring.io/..."）',
      },
      prompt: {
        type: 'string',
        description: '可选：针对该网页希望提取关注的核心技术问题或关键词',
      },
    },
    required: ['url'],
  },
  execute: async (args: Record<string, unknown>, _context: HarnessContext) => {
    const rawUrl = String(args.url || '').trim();
    if (!rawUrl) {
      return '错误: url 参数不能为空。';
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return `错误: "${rawUrl}" 不是一个有效的 URL 地址。`;
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return '错误: 仅支持 http 或 https 协议的 URL。';
    }

    // SSRF protection
    if (isPrivateIpOrHost(parsedUrl.hostname)) {
      return `安全拦截: 禁止访问本地环回地址或内网私有 IP (${parsedUrl.hostname})。`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(rawUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) xkang-tui/1.0.0 (+https://github.com/xkang)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return `抓取失败: HTTP 状态码 ${response.status} (${response.statusText})`;
      }

      const contentType = response.headers.get('content-type') || '';
      const textBody = await response.text();

      let markdownContent = '';
      if (contentType.includes('html') || textBody.includes('<html') || textBody.includes('<body')) {
        markdownContent = cleanHtmlToMarkdown(textBody);
      } else {
        markdownContent = textBody.trim();
      }

      if (!markdownContent) {
        return `网页抓取成功，但未解析出有效正文内容 (URL: ${rawUrl})`;
      }

      // Max output limit: 16000 chars to avoid exceeding context
      const MAX_CHARS = 16000;
      if (markdownContent.length > MAX_CHARS) {
        markdownContent =
          markdownContent.slice(0, MAX_CHARS) +
          `\n\n... [网页正文已截断，已提取前 ${MAX_CHARS} 个字符 (共 ${markdownContent.length} 字符)]`;
      }

      return `【网页全文抓取结果 (URL: ${rawUrl})】\n\n${markdownContent}`;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return `网页抓取异常: ${errorMsg}`;
    }
  },
};
