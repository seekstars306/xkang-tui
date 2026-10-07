import fs from 'node:fs';
import path from 'node:path';
import {
  CodeGraphIndex,
  SymbolDefinition,
  ImplementationRelation,
  CallRelation,
  SymbolReference,
} from './types.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.java',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.vue',
  '.xml',
  '.yml',
  '.yaml',
  '.properties',
]);

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.idea',
  '.vscode',
  'bin',
]);

function determineDomain(repo: string, filePath: string): 'frontend' | 'backend' {
  const lower = (repo + '/' + filePath).toLowerCase().replace(/\\/g, '/');
  if (
    lower.includes('skt-front') ||
    lower.includes('skt_front') ||
    lower.includes('webview') ||
    lower.includes('_mobile') ||
    lower.includes('_pc') ||
    lower.includes('dpxt_h5') ||
    filePath.endsWith('.vue')
  ) {
    return 'frontend';
  }
  return 'backend';
}

export class CodeGraphIndexer {
  private rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
  }

  public async buildIndex(): Promise<CodeGraphIndex> {
    console.log(`[CodeGraph] 开始扫描构建代码图谱索引 (区分前后端)，根路径: ${this.rootPath} ...`);
    const startTime = Date.now();

    const defsMap = new Map<string, SymbolDefinition[]>();
    const implsMap = new Map<string, ImplementationRelation[]>();
    const callersMap = new Map<string, CallRelation[]>();
    const calleesMap = new Map<string, CallRelation[]>();
    const refsMap = new Map<string, SymbolReference[]>();

    let totalFiles = 0;
    let frontendFiles = 0;
    let backendFiles = 0;
    const repoSet = new Set<string>();

    const walkDir = (currentDir: string, currentRepo: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;

          let nextRepo = currentRepo;
          if (!currentRepo) {
            const rel = path.relative(this.rootPath, fullPath);
            const parts = rel.split(path.sep);
            if (parts.length <= 2) {
              nextRepo = parts.join('/');
              repoSet.add(nextRepo);
            }
          }
          walkDir(fullPath, nextRepo || entry.name);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.has(ext)) {
            totalFiles++;
            const repo = currentRepo || 'root';
            repoSet.add(repo);
            const domain = determineDomain(repo, fullPath);
            if (domain === 'frontend') frontendFiles++;
            else backendFiles++;

            this.parseFile(fullPath, repo, domain, defsMap, implsMap, callersMap, calleesMap, refsMap);
          }
        }
      }
    };

    walkDir(this.rootPath, '');

    // Convert Maps to plain objects
    const defsObj: Record<string, SymbolDefinition[]> = Object.create(null);
    let totalDefs = 0;
    for (const [k, v] of defsMap.entries()) {
      defsObj[k] = v;
      totalDefs += v.length;
    }

    const implsObj: Record<string, ImplementationRelation[]> = Object.create(null);
    let totalImpls = 0;
    for (const [k, v] of implsMap.entries()) {
      implsObj[k] = v;
      totalImpls += v.length;
    }

    const callersObj: Record<string, CallRelation[]> = Object.create(null);
    let totalCalls = 0;
    for (const [k, v] of callersMap.entries()) {
      callersObj[k] = v;
      totalCalls += v.length;
    }

    const calleesObj: Record<string, CallRelation[]> = Object.create(null);
    for (const [k, v] of calleesMap.entries()) {
      calleesObj[k] = v;
    }

    const refsObj: Record<string, SymbolReference[]> = Object.create(null);
    let totalRefs = 0;
    for (const [k, v] of refsMap.entries()) {
      refsObj[k] = v;
      totalRefs += v.length;
    }

    const index: CodeGraphIndex = {
      version: '1.1.0',
      createdAt: new Date().toISOString(),
      rootPath: this.rootPath,
      stats: {
        totalRepos: repoSet.size,
        totalFiles,
        frontendFiles,
        backendFiles,
        totalDefinitions: totalDefs,
        totalImplementations: totalImpls,
        totalCalls,
        totalReferences: totalRefs,
      },
      definitions: defsObj,
      implementations: implsObj,
      callers: callersObj,
      callees: calleesObj,
      references: refsObj,
    };

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[CodeGraph] 索引构建完成！耗时: ${duration}s, 源码文件: ${totalFiles} (前端: ${frontendFiles}, 后端: ${backendFiles}), 符号定义: ${totalDefs}, 调用链路: ${totalCalls}`);

    return index;
  }

  private parseFile(
    filePath: string,
    repo: string,
    domain: 'frontend' | 'backend',
    defsMap: Map<string, SymbolDefinition[]>,
    implsMap: Map<string, ImplementationRelation[]>,
    callersMap: Map<string, CallRelation[]>,
    calleesMap: Map<string, CallRelation[]>,
    refsMap: Map<string, SymbolReference[]>
  ): void {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const lines = content.split('\n');
    const relativePath = path.relative(this.rootPath, filePath);

    let currentClass = '';

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue;
      }

      // 1. Class & Interface definitions
      if (ext === '.java' || ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.vue') {
        const classMatch = trimmed.match(/(?:public\s+|private\s+|protected\s+|export\s+|default\s+)*(?:class|interface|enum)\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$,\s]+))?(?:\s+implements\s+([A-Za-z0-9_$,\s]+))?/);
        if (classMatch) {
          const className = classMatch[1];
          const kind = trimmed.includes('interface') ? 'interface' : (trimmed.includes('enum') ? 'enum' : 'class');
          currentClass = className;

          this.addDefinition(defsMap, className, {
            name: className,
            kind,
            repo,
            domain,
            filePath: relativePath,
            line: lineNum,
            signature: trimmed.slice(0, 100),
          });

          // Check implements
          if (classMatch[3]) {
            const ifaces = classMatch[3].split(',').map((s) => s.trim().split('<')[0]);
            for (const iface of ifaces) {
              if (!iface) continue;
              this.addImplementation(implsMap, iface, {
                interfaceName: iface,
                implementingClass: className,
                repo,
                domain,
                filePath: relativePath,
                line: lineNum,
              });
            }
          }
          continue;
        }

        // 2. Method definitions
        const methodMatch = trimmed.match(/(?:public|private|protected|static|final|native|synchronized|abstract|async|\s)+\s+([A-Za-z0-9_$<>,\[\]]+)\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*(?:throws\s+[A-Za-z0-9_$,\s]+)?\s*[{;]/);
        if (methodMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while') && !trimmed.startsWith('switch')) {
          const returnType = methodMatch[1];
          const methodName = methodMatch[2];
          const params = methodMatch[3];

          if (methodName !== 'if' && methodName !== 'for' && methodName !== 'while' && methodName !== 'catch') {
            const fullSymbol = currentClass ? `${currentClass}.${methodName}` : methodName;
            this.addDefinition(defsMap, methodName, {
              name: methodName,
              containerName: currentClass,
              kind: 'method',
              repo,
              domain,
              filePath: relativePath,
              line: lineNum,
              signature: `${returnType} ${methodName}(${params.slice(0, 80)})`,
            });
            if (currentClass) {
              this.addDefinition(defsMap, fullSymbol, {
                name: fullSymbol,
                containerName: currentClass,
                kind: 'method',
                repo,
                domain,
                filePath: relativePath,
                line: lineNum,
                signature: `${returnType} ${methodName}(${params.slice(0, 80)})`,
              });
            }
          }
        }

        // 3. Method Calls detection
        const callMatches = trimmed.matchAll(/([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)\s*\(/g);
        for (const cm of callMatches) {
          const targetObj = cm[1];
          const targetMethod = cm[2];

          if (['this', 'super', 'Math', 'System', 'String', 'Arrays', 'Collections', 'Objects', 'log', 'logger', 'console', 'JSON'].includes(targetObj)) {
            continue;
          }

          const callerSymbol = currentClass ? `${currentClass}` : relativePath;
          const calleeSymbol = `${targetObj}.${targetMethod}`;

          const rel: CallRelation = {
            callerSymbol,
            callerFile: relativePath,
            callerLine: lineNum,
            calleeSymbol,
            repo,
            domain,
          };

          this.addCall(callersMap, targetMethod, rel);
          this.addCall(callersMap, calleeSymbol, rel);
          this.addCall(calleesMap, callerSymbol, rel);
        }
      }

      // 4. General Symbol References
      const idMatches = trimmed.matchAll(/\b([A-Z][A-Za-z0-9_$]{2,}|[a-z]+[A-Z][A-Za-z0-9_$]+)\b/g);
      for (const idm of idMatches) {
        const sym = idm[1];
        if (sym.length < 3) continue;
        this.addReference(refsMap, sym, {
          symbol: sym,
          repo,
          domain,
          filePath: relativePath,
          line: lineNum,
          snippet: trimmed.slice(0, 120),
        });
      }
    }
  }

  private addDefinition(map: Map<string, SymbolDefinition[]>, key: string, def: SymbolDefinition): void {
    const k = key.toLowerCase();
    let list = map.get(k);
    if (!list) {
      list = [];
      map.set(k, list);
    }
    if (list.length < 50) {
      list.push(def);
    }
  }

  private addImplementation(map: Map<string, ImplementationRelation[]>, key: string, impl: ImplementationRelation): void {
    const k = key.toLowerCase();
    let list = map.get(k);
    if (!list) {
      list = [];
      map.set(k, list);
    }
    if (list.length < 50) {
      list.push(impl);
    }
  }

  private addCall(map: Map<string, CallRelation[]>, key: string, call: CallRelation): void {
    const k = key.toLowerCase();
    let list = map.get(k);
    if (!list) {
      list = [];
      map.set(k, list);
    }
    if (list.length < 50) {
      list.push(call);
    }
  }

  private addReference(map: Map<string, SymbolReference[]>, key: string, ref: SymbolReference): void {
    const k = key.toLowerCase();
    let list = map.get(k);
    if (!list) {
      list = [];
      map.set(k, list);
    }
    if (list.length < 30) {
      list.push(ref);
    }
  }
}
