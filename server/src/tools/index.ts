import { z } from 'zod';
import { executeCodeGraph } from './codegraph.js';
import { executeWebSearch } from './web_search.js';
import { executeDatabaseTool } from './database.js';
import { executeSearchCode, executeReadFileLines, executeGitInspect } from './code_search.js';
import { executeSearchLogs, executeListLogApps } from './log_search.js';
import { ServerConfig } from '../types.js';

export interface CompanyToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  execute: (args: any, config: ServerConfig, user: string) => Promise<string>;
}

export function createCompanyTools(config: ServerConfig): CompanyToolDefinition[] {
  return [
    // 0. 代码全文检索工具（服务端统一执行 ripgrep，客户端不接触代码文件）
    {
      name: 'search_code',
      description: '在本地代码仓库中高速搜索关键字、错误码、提示文案或 API 路由（支持 scope: frontend/backend 前后端分域定向过滤，基于内置 ripgrep，由服务端统一执行）',
      schema: z.object({
        keyword: z.string().describe('搜索关键字。支持多词任一匹配，用 " OR " 分隔（如 "退票费 OR refundFee OR refund_fee"），也支持正则表达式（如 "checkPrice\\(\\w+\\)"）。搜索报错文案时直接粘贴完整文案片段即可。'),
        scope: z.enum(['frontend', 'backend', 'all']).optional().default('all')
          .describe('可选的搜索工程范围：frontend(优先在前端工程 skt-front 中查找页面文案与接口), backend(在后端微服务 skt-back 中查找业务逻辑), all(全量搜索，默认)'),
        filePattern: z.string().optional()
          .describe('可选的文件过滤通配符，例如 "*.vue", "*.java", "*.xml", "*.yml"'),
      }),
      execute: async (args, cfg) => {
        return executeSearchCode(args, cfg);
      },
    },

    // 0b. 代码按行查阅工具（服务端统一读取，沙箱安全管控）
    {
      name: 'read_file_lines',
      description: '读取指定源文件、配置文件或 XML 的代码内容，支持指定起止行号（受服务端工作区安全沙箱管控）',
      schema: z.object({
        filePath: z.string().describe('文件路径（支持绝对路径或相对于代码库根目录的相对路径）'),
        startLine: z.number().optional().describe('起始行号（从 1 开始，可选）'),
        endLine: z.number().optional().describe('结束行号（可选）'),
      }),
      execute: async (args, cfg) => {
        return executeReadFileLines(args, cfg);
      },
    },

    // 0c. Git 提交历史/Blame 查询工具（服务端统一执行）
    {
      name: 'git_inspect',
      description: '查询代码的 Git 提交历史（Log）或代码行变更作者与原因（Blame），用于排查业务规则是何时以及为何变更的（受服务端工作区安全沙箱管控）',
      schema: z.object({
        action: z.enum(['log', 'blame']).describe('操作类型：log（查看近期提交记录）或 blame（查看指定行修改原因）'),
        filePath: z.string().describe('相关代码文件的相对路径'),
        lineRange: z.string().optional().describe('blame 操作时的行号范围，例如 "50,70"（可选）'),
      }),
      execute: async (args, cfg) => {
        return executeGitInspect(args, cfg);
      },
    },

    // 1. 公司代码图谱结构追踪工具（已落地）
    {
      name: 'codegraph_explore',
      description: '代码知识图谱结构追踪工具：查询类/方法定义、接口实现类、调用方/被调方调用链以及引用关系（支持 frontend/backend 分域过滤，由服务端统一托管）',
      schema: z.object({
        symbol: z.string().describe('要查询的符号名称，例如类名、方法名或接口名（如 "InvoiceApplyService", "checkOrderCancelRule"）'),
        queryType: z.enum(['definitions', 'implementations', 'callers', 'callees', 'references'])
          .describe('查询类型：definitions(定义), implementations(接口实现类), callers(调用方), callees(被调方), references(引用位置)'),
        scope: z.enum(['frontend', 'backend', 'all']).optional().default('all')
          .describe('查询范围：frontend(优先在前端项目 skt-front 中查找), backend(在后端微服务 skt-back 中查找), all(全量搜索)'),
        repo: z.string().optional().describe('可选的目标仓库标识（默认查询全量或指定工程）'),
      }),
      execute: async (args, cfg) => {
        return executeCodeGraph(args, cfg);
      },
    },

    // 2. 互联网公开技术与已知 Issue 检索工具（服务端托管 API Key）
    {
      name: 'web_search',
      description: '【公司核心工具】通过搜索引擎检索互联网公开技术文档、报错讨论、开源组件已知 Issue 与故障解决方案（由服务端统一持有付费 Search API Key）',
      schema: z.object({
        query: z.string().describe('搜索关键词、技术组件名或错误日志片段（如 "Spring Cloud Gateway 504", "Dubbo provider threadpool exhausted"）'),
        numResults: z.number().optional().default(5).describe('期望返回的搜索结果条数 (1-10)'),
      }),
      execute: async (args, cfg, user) => {
        return executeWebSearch(args, cfg, user);
      },
    },

    // 3. 日志查询工具（Grafana/Loki 生产日志检索，内置 2 小时窗口安全护栏）
    {
      name: 'search_logs',
      description: '【排障必用】生产微服务日志检索（Grafana/Loki）。当用户反馈"查不到航班/不展示/白屏/转圈/失败/超时"等异常时，【即使没有订单号和确切时间，也必须立即调用本工具进行盲查】：\n- 航班查不到/不展示 -> {"app":"cxy-ibe","keyword":"过滤","minutes_ago":60}\n- 订单转圈/提交失败 -> {"app":"cxy-web","keyword":"ERROR","minutes_ago":60}\n- 退票/改签异常 -> {"app":"cxy-booking","keyword":"Exception","minutes_ago":60}\n严禁仅凭推测给出纯文字解释，必须至少盲查一次微服务日志获取真实运行证据。',
      schema: z.object({
        app: z.string().optional().describe('目标微服务应用名（如 "cxy-web", "cxy-booking", "cxy-ibe", "cxy-hotel"）。建议先用 list_log_apps 确认应用名'),
        keyword: z.string().optional().describe('日志关键词过滤（如订单号、异常关键字 "Exception"/"ERROR"/"timeout"、接口路径、航班号等）'),
        target_time: z.string().optional().describe('【推荐】事件发生的大致时间锚点（格式 "YYYY-MM-DD HH:mm:ss"，可从数据库记录的创建时间获取），将查询该时间前后的窗口'),
        window_minutes: z.number().optional().default(10).describe('围绕 target_time 的窗口半径分钟数（默认10，最大30）'),
        minutes_ago: z.number().optional().default(30).describe('未提供 target_time 时：查询最近 N 分钟（默认30，最大120）'),
        start_time: z.string().optional().describe("自定义开始时间 'YYYY-MM-DD HH:mm:ss'（与 end_time 配合，跨度≤2小时）"),
        end_time: z.string().optional().describe('自定义结束时间'),
        namespace: z.string().optional().default('cxy').describe('K8s 命名空间（默认 cxy）'),
        limit: z.number().optional().default(50).describe('返回日志条数上限（默认50，最大200）'),
      }),
      execute: async (args, cfg, user) => {
        return executeSearchLogs(args, cfg, user);
      },
    },
    {
      name: 'list_log_apps',
      description: '列出日志系统中指定命名空间下所有可查询的微服务应用名（用于确认 search_logs 的 app 参数取值）',
      schema: z.object({
        namespace: z.string().optional().default('cxy').describe('K8s 命名空间（默认 cxy）'),
      }),
      execute: async (args, cfg, user) => {
        return executeListLogApps(args, cfg, user);
      },
    },

    // 3. 数据库检索工具（真实直连公司内部 MyCat/MySQL 数据库，严格只读与审计管控）
    {
      name: 'company_db_query',      description: '【公司核心工具】内部数据库只读检索工具：支持查询数据库清单、表清单、表结构与字段注释、跨库表名搜索、以及执行安全的只读 SELECT/SHOW 语句。注意：底层为 MyCat 中间件，执行 query 时必须通过 database 参数指定目标库（或 SQL 中使用 `库名.表名`），否则会报 "No MyCAT Database selected"。',
      schema: z.object({
        action: z.enum(['list_databases', 'list_tables', 'describe_table', 'search_schema', 'query'])
          .describe('操作类型：list_databases(查看所有库), list_tables(查看某库的所有表), describe_table(查看表结构和字段注释), search_schema(按关键词搜索表名), query(执行只读SQL查询)'),
        database: z.string().optional()
          .describe('目标数据库名称（如 "payment", "skt", "myibe", "skt_project_hotel" 等）。action 为 query/describe_table 时必填（MyCat 要求先选库）；search_schema/list_tables 可选，不传则跨所有库搜索或报错'),
        tableName: z.string().optional()
          .describe('表名（当 action 为 describe_table 时必填，如 "payment_flow"）。注意公司表多为业务前缀，如用户表为 sys_user_info 而非 skt_user_info，建议先用 search_schema 确认真实表名'),
        keyword: z.string().optional()
          .describe('搜索关键词（当 action 为 search_schema 或 list_tables 进行过滤时使用）。支持多关键词：可用 "A OR B"、"a|b|c"、"a,b,c" 或空格分隔，任一命中即返回'),
        sql: z.string().optional()
          .describe('只读 SQL 语句（当 action 为 query 时使用，只支持 SELECT/SHOW/EXPLAIN，强制只读）。若未传 database 参数，可在 SQL 中使用 `库名.表名` 形式（如 SELECT * FROM skt.finance_bill）自动解析目标库'),
        limit: z.number().optional().default(50)
          .describe('SQL 查询返回的最大行数限制（默认 50，最大 200）'),
      }),
      execute: async (args, cfg, user) => {
        return executeDatabaseTool(args, cfg, user);
      },
    },

    // 4. 知识库/排障 Playbook 检索工具（扩展点脚手架）
    {
      name: 'knowledge_search',
      description: '【公司核心工具】客服与二线排障知识库检索：查询已知故障解决手册、SOP、常见报错话术与对应建议',
      schema: z.object({
        query: z.string().describe('排障关键词或错误码（如 "ERR_INVOICE_TIMEOUT", "发票开具重试超限"）'),
        topK: z.number().optional().default(3).describe('返回最相关的条目数'),
      }),
      execute: async (args, _cfg, user) => {
        return JSON.stringify({
          status: 'success',
          queriedBy: user,
          query: args.query,
          results: [
            {
              title: `排障知识库手册匹配: ${args.query}`,
              sopSummary: '建议优先检查服务网关超时配置与下游重试幂等键。',
            },
          ],
        }, null, 2);
      },
    },

    // 5. 业务知识图谱检索工具（扩展点脚手架）
    {
      name: 'kg_query',
      description: '【公司核心工具】业务知识图谱多跳检索：查询业务实体（如商户-订单-结算规则-费率体系）之间的关联关系',
      schema: z.object({
        entityName: z.string().describe('业务实体名称（如 "商户签约", "开票规则"）'),
        relationType: z.string().optional().describe('关联网型（如 "依赖", "包含", "触发"）'),
      }),
      execute: async (args, _cfg, user) => {
        return JSON.stringify({
          status: 'success',
          queriedBy: user,
          entity: args.entityName,
          relations: [],
          message: `业务知识图谱已完成对 [${args.entityName}] 的拓扑检索。`,
        }, null, 2);
      },
    },
  ];
}
