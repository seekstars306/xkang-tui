import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 服务归属查询工具。
 *
 * 解决的问题：这套系统的部署名、配置目录名、代码仓库名三者经常对不上，
 * 排查时靠名字猜会直接查错地方。真实例子：
 *   - 部署名 cxy-booking 的配置在 prod-config/cxy-dpxt 目录下（不是 cxy-dpxt 猜不到）
 *   - 一个仓库 skt_dpxt_background 同时支撑 cxy-booking / cxy-booking-test / cxy-booking-timer
 *   - 一个包根 com.llb.cxy 被 cxy-crm / cxy-web / cxy-web-timer 共用
 *
 * 数据来源（每一条都可回溯，不是猜的）：
 *   - 部署名 -> 配置目录：k8s yaml 的 app: 字段
 *   - 配置目录 -> 镜像/端口：k8s yaml 的 image: / containerPort: / nodePort:
 *   - 仓库 -> 模块/包：各仓库 src/main/java 下的实际 package 声明
 *   - 服务 -> 仓库：jar artifactId 或 spring.application.name 与 prod-config 一致（置信度见字段）
 */

export interface ServiceInfo {
  deployName: string;
  configDir: string;
  image: string | null;
  containerPort: number | null;
  nodePort: number | null;
  repo: string;
  repoConfidence: 'high' | 'low' | 'none';
  repoEvidence: string;
  packageRoots?: string[];
}

export interface ServiceMap {
  generatedAt: string;
  logicalRoot: string;
  warnings: string[];
  services: Record<string, ServiceInfo>;
  packageRootToServices?: Record<string, string[]>;
  repoModules?: Record<string, Array<{ module: string; package: string | null }>>;
}

let cache: ServiceMap | null = null;
let cachePath: string | null = null;

/**
 * 依次尝试几个常见位置。
 *
 * 关键：隔离运行的服务端 cwd 可能不是项目根，所以除了 cwd 相对路径，
 * 还要用本模块自身的 URL 反推项目根——本文件在 server/src/tools/ 下，
 * 向上两级就是 server/，再上一级就是项目根。
 */
function candidatePaths(): string[] {
  const fromCwd = [
    'tests/eval/reports/_retest/service_map.json',
    'server/data/service_map.json',
    'service_map.json',
  ].map((r) => path.resolve(process.cwd(), r));

  const fromModule: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // server/src/tools -> server -> 项目根
    const serverDir = path.resolve(here, '..', '..');
    fromModule.push(path.join(serverDir, 'data', 'service_map.json'));
    const root = path.resolve(serverDir, '..');
    fromModule.push(path.join(root, 'server', 'data', 'service_map.json'));
    fromModule.push(path.join(root, 'tests', 'eval', 'reports', '_retest', 'service_map.json'));
  } catch { /* 拿不到模块路径时只用 cwd 结果 */ }

  return [...fromModule, ...fromCwd];
}

export function loadServiceMap(explicitPath?: string): ServiceMap | null {
  const target = explicitPath ?? candidatePaths().find((p) => fs.existsSync(p));
  if (!target || !fs.existsSync(target)) return null;
  if (cache && cachePath === target) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(target, 'utf8')) as ServiceMap;
    cachePath = target;
    return cache;
  } catch {
    return null;
  }
}

export interface LookupServiceArgs {
  /** 部署名，如 cxy-booking；或类全名，如 com.company.project.hotel.remote.service.HotelQueryService */
  query: string;
}

export interface LookupServiceResult {
  found: boolean;
  query: string;
  matchedBy: 'deployName' | 'className' | 'packageRoot' | 'repo' | 'none';
  services: ServiceInfo[];
  /** 命中的包根（按类名查询时给出），用于说明为什么匹配到这些服务 */
  packageRoot?: string;
  /** 给调用方的下一步提示，避免拿到结果还不知道怎么用 */
  hint: string;
}

/**
 * 支持三种查法：
 * 1. 部署名（cxy-booking）—— 直接命中
 * 2. 类全名（com.company.project.hotel.remote.service.HotelQueryService）—— 取前 3 段包根反查
 * 3. 仓库名（skt_dpxt_background）—— 反查该仓库承载了哪些服务
 */
export function lookupService(map: ServiceMap, query: string): LookupServiceResult {
  const q = query.trim();
  const empty: LookupServiceResult = { found: false, query: q, matchedBy: 'none', services: [], hint: '' };

  // 1) 部署名精确匹配（大小写不敏感）
  const byName = Object.values(map.services).find((s) => s.deployName.toLowerCase() === q.toLowerCase());
  if (byName) {
    return {
      found: true, query: q, matchedBy: 'deployName', services: [byName],
      hint: byName.repoConfidence === 'high'
        ? `配置在 ${byName.configDir}，代码仓库 ${byName.repo}（证据：${byName.repoEvidence}）。查日志用 app="${byName.deployName}"。`
        : `配置在 ${byName.configDir}；仓库归属置信度 ${byName.repoConfidence}，证据：${byName.repoEvidence}。查日志仍可用 app="${byName.deployName}"，但定位代码前请再确认仓库。`,
    };
  }

  // 2) 类全名：取前 3 段包根反查
  if (q.includes('.')) {
    const root = q.split('.').slice(0, 3).join('.');
    const names = map.packageRootToServices?.[root] ?? [];
    if (names.length) {
      const services = names.map((n) => map.services[n]).filter(Boolean);
      return {
        found: true, query: q, matchedBy: 'className', services, packageRoot: root,
        hint: `包根 ${root} 出现在 ${services.length} 个服务中：${names.join(', ')}。日志里若能看到该类的 logger 名，直接用 search_logs 按 app 逐个试，或先查这几个服务的日志确认哪一个在跑这个类。`,
      };
    }
  }

  // 3) 仓库名：反查承载的服务
  const byRepo = Object.values(map.services).filter((s) => s.repo && s.repo.toLowerCase() === q.toLowerCase());
  if (byRepo.length) {
    return {
      found: true, query: q, matchedBy: 'repo', services: byRepo,
      hint: `仓库 ${q} 承载 ${byRepo.length} 个服务：${byRepo.map((s) => s.deployName).join(', ')}。同一个仓库多个服务时，日志要按 deployName 分别查。`,
    };
  }

  // 4) 子串兜底，方便只记得一半名字的情况
  const fuzzy = Object.values(map.services).filter((s) => s.deployName.includes(q) || q.includes(s.deployName));
  if (fuzzy.length) {
    return {
      found: true, query: q, matchedBy: 'deployName', services: fuzzy,
      hint: `按子串匹配到 ${fuzzy.length} 个服务，请确认具体是哪一个。`,
    };
  }

  return { ...empty, hint: '未匹配到任何服务。可先用 list_log_apps 看当前有哪些服务在跑，再用本工具按部署名查配置目录与仓库。' };
}

/** 列出全部服务，供“我不知道叫什么”的场景使用 */
export function listServices(map: ServiceMap): { count: number; services: Array<{ deployName: string; configDir: string; repo: string; repoConfidence: string }>; warnings: string[] } {
  const services = Object.values(map.services).map((s) => ({
    deployName: s.deployName,
    configDir: s.configDir.replace(/^skt-back\/prod-config\//, ''),
    repo: s.repo,
    repoConfidence: s.repoConfidence,
  }));
  return { count: services.length, services, warnings: map.warnings ?? [] };
}
