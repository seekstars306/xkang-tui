import { loadServiceMap, lookupService, listServices } from './service_lookup.js';

/**
 * lookup_service / list_services 的执行入口。
 * 数据文件缺失时返回可操作的提示，而不是抛错——工具不可用不应中断整轮排查。
 */

const MISSING_MAP =
  '服务映射数据不存在。请让维护者在项目根执行一次服务映射生成（产出 service_map.json），' +
  '再重试。在拿到映射之前，可以先用 list_log_apps 确认当前有哪些服务在打日志，' +
  '并用 search_code 直接按类名搜代码。';

export async function executeLookupService(args: { query?: string }): Promise<string> {
  const map = loadServiceMap();
  if (!map) return MISSING_MAP;
  const query = String(args?.query ?? '').trim();
  if (!query) return '请提供 query：部署名、类全名或仓库名。';
  const result = lookupService(map, query);
  return JSON.stringify(result, null, 1);
}

export async function executeListServices(): Promise<string> {
  const map = loadServiceMap();
  if (!map) return MISSING_MAP;
  return JSON.stringify(listServices(map), null, 1);
}
