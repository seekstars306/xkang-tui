export type CodeGraphQueryType =
  | 'definitions'
  | 'implementations'
  | 'callers'
  | 'callees'
  | 'references';

export type ProjectDomain = 'frontend' | 'backend' | 'all';

export interface SymbolDefinition {
  name: string;
  kind: 'class' | 'interface' | 'enum' | 'method' | 'function' | 'property';
  repo: string;
  domain: 'frontend' | 'backend';
  filePath: string;
  line: number;
  containerName?: string; // Class/interface name containing this method
  signature?: string;
  documentation?: string;
}

export interface ImplementationRelation {
  interfaceName: string;
  implementingClass: string;
  repo: string;
  domain: 'frontend' | 'backend';
  filePath: string;
  line: number;
}

export interface CallRelation {
  callerSymbol: string; // e.g. "OrderController.createOrder"
  callerFile: string;
  callerLine: number;
  calleeSymbol: string; // e.g. "OrderService.createOrder"
  repo: string;
  domain: 'frontend' | 'backend';
}

export interface SymbolReference {
  symbol: string;
  repo: string;
  domain: 'frontend' | 'backend';
  filePath: string;
  line: number;
  snippet: string;
}

export interface CodeGraphIndex {
  version: string;
  createdAt: string;
  rootPath: string;
  stats: {
    totalRepos: number;
    totalFiles: number;
    totalDefinitions: number;
    totalImplementations: number;
    totalCalls: number;
    totalReferences: number;
    frontendFiles?: number;
    backendFiles?: number;
  };
  definitions: Record<string, SymbolDefinition[]>;
  implementations: Record<string, ImplementationRelation[]>;
  callers: Record<string, CallRelation[]>;
  callees: Record<string, CallRelation[]>;
  references: Record<string, SymbolReference[]>;
}

export interface CodeGraphQueryResult {
  status: 'completed' | 'not_found' | 'error';
  symbol: string;
  queryType: CodeGraphQueryType;
  repo?: string;
  scope?: ProjectDomain;
  totalMatches: number;
  results: Array<any>;
  message?: string;
}
