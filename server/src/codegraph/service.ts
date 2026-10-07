import fs from 'node:fs';
import path from 'node:path';
import { CodeGraphIndexer } from './indexer.js';
import { CodeGraphIndex, CodeGraphQueryResult, CodeGraphQueryType, ProjectDomain } from './types.js';

export class CodeGraphService {
  private index: CodeGraphIndex | null = null;
  private dataDir: string;
  private targetProjectRoot: string;
  private isBuilding = false;

  constructor(targetProjectRoot = 'D:\\skt_project', dataDir = './data/codegraph') {
    this.targetProjectRoot = path.resolve(targetProjectRoot);
    this.dataDir = path.resolve(dataDir);
    this.loadIndex();
  }

  public loadIndex(): boolean {
    try {
      const statsFile = path.join(this.dataDir, 'stats.json');
      if (fs.existsSync(statsFile)) {
        const stats = JSON.parse(fs.readFileSync(statsFile, 'utf-8'));
        const definitions = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'definitions.json'), 'utf-8'));
        const implementations = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'implementations.json'), 'utf-8'));
        const callers = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'callers.json'), 'utf-8'));
        const callees = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'callees.json'), 'utf-8'));
        const references = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'references.json'), 'utf-8'));

        this.index = {
          version: '1.0.0',
          createdAt: stats.createdAt,
          rootPath: this.targetProjectRoot,
          stats: stats.stats,
          definitions,
          implementations,
          callers,
          callees,
          references,
        };

        console.log(`[CodeGraph] 已加载分块图谱索引 (涵盖 ${this.index.stats.totalFiles} 个文件，${this.index.stats.totalDefinitions} 个符号定义)`);
        return true;
      }
    } catch (err) {
      console.warn(`[CodeGraph] 读取缓存索引失败:`, err);
    }
    return false;
  }

  public async rebuildIndex(): Promise<CodeGraphIndex> {
    if (this.isBuilding) {
      throw new Error('CodeGraph 索引正在构建中，请稍候...');
    }
    this.isBuilding = true;
    try {
      const indexer = new CodeGraphIndexer(this.targetProjectRoot);
      const newIndex = await indexer.buildIndex();
      this.index = newIndex;

      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      fs.writeFileSync(
        path.join(this.dataDir, 'stats.json'),
        JSON.stringify({ version: newIndex.version, createdAt: newIndex.createdAt, stats: newIndex.stats }, null, 2),
        'utf-8'
      );
      fs.writeFileSync(path.join(this.dataDir, 'definitions.json'), JSON.stringify(newIndex.definitions), 'utf-8');
      fs.writeFileSync(path.join(this.dataDir, 'implementations.json'), JSON.stringify(newIndex.implementations), 'utf-8');
      fs.writeFileSync(path.join(this.dataDir, 'callers.json'), JSON.stringify(newIndex.callers), 'utf-8');
      fs.writeFileSync(path.join(this.dataDir, 'callees.json'), JSON.stringify(newIndex.callees), 'utf-8');
      fs.writeFileSync(path.join(this.dataDir, 'references.json'), JSON.stringify(newIndex.references), 'utf-8');

      return newIndex;
    } finally {
      this.isBuilding = false;
    }
  }

  public getStats() {
    return this.index ? this.index.stats : null;
  }

  public query(symbol: string, queryType: CodeGraphQueryType, repo?: string, scope: ProjectDomain = 'all'): CodeGraphQueryResult {
    if (!this.index) {
      return {
        status: 'error',
        symbol,
        queryType,
        totalMatches: 0,
        results: [],
        message: '【CodeGraph 服务端】当前图谱索引尚未初始化，请先执行索引构建。',
      };
    }

    const cleanSymbol = symbol.trim();
    const key = cleanSymbol.toLowerCase();
    let matches: any[] = [];

    const domainFilter = (item: any) => {
      if (repo && item.repo !== repo) return false;
      if (scope === 'all') return true;
      return item.domain === scope;
    };

    switch (queryType) {
      case 'definitions': {
        const defs = this.index.definitions[key] || [];
        matches = defs.filter(domainFilter);
        break;
      }
      case 'implementations': {
        const impls = this.index.implementations[key] || [];
        matches = impls.filter(domainFilter);
        break;
      }
      case 'callers': {
        const calls = this.index.callers[key] || [];
        matches = calls.filter(domainFilter);
        break;
      }
      case 'callees': {
        const calls = this.index.callees[key] || [];
        matches = calls.filter(domainFilter);
        break;
      }
      case 'references': {
        const refs = this.index.references[key] || [];
        matches = refs.filter(domainFilter);
        break;
      }
      default:
        return {
          status: 'error',
          symbol,
          queryType,
          totalMatches: 0,
          results: [],
          message: `未知的查询类型: ${queryType}`,
        };
    }

    const scopeDesc = scope === 'frontend' ? '前端工程 (skt-front)' : (scope === 'backend' ? '后端工程 (skt-back/remote)' : '全量前后端工程');

    if (matches.length === 0) {
      return {
        status: 'not_found',
        symbol,
        queryType,
        repo,
        scope,
        totalMatches: 0,
        results: [],
        message: `【CodeGraph 代码图谱】在已导入的 [${scopeDesc}] 中，未检索到符号 [${cleanSymbol}] 的 ${queryType} 关系。`,
      };
    }

    return {
      status: 'completed',
      symbol: cleanSymbol,
      queryType,
      repo,
      scope,
      totalMatches: matches.length,
      results: matches.slice(0, 25),
      message: `【CodeGraph 代码图谱 - ${scopeDesc}】成功检索到 [${cleanSymbol}] 的 ${queryType} 拓扑关联 (共 ${matches.length} 条匹配):`,
    };
  }
}
