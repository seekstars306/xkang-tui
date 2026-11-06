import { z } from 'zod';
import { executeCodeGraph } from './codegraph.js';
import { executeLookupService, executeListServices } from './service_lookup_exec.js';
import { executeWebSearch, isWebSearchConfigured } from './web_search.js';
import { executeDatabaseTool, executeDbStats, executeExportQuery, executeDbSchema } from './database.js';
import { executeSearchCode, executeReadFileLines, executeGitInspect } from './code_search.js';
import { executeSearchLogs, executeListLogApps } from './log_search.js';
import { executeLookupOrder } from './order_lookup.js';
import { executeWriteFile, executeWriteXlsx, fileOutputDir } from './file_write.js';
import { ServerConfig } from '../types.js';
import { redactToolResult } from '../agent/input_guard.js';

export interface CompanyToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  execute: (args: any, config: ServerConfig, user: string) => Promise<string>;
}

/**
 * 只注册真正可用的工具：以前的 knowledge_search / kg_query 是返回固定"成功"文案的脚手架，
 * web_search 在未配置 Key 时会编造搜索结果，都会被模型当成真实证据引用，现已移除/按配置启用。
 */
export function createCompanyTools(config: ServerConfig): CompanyToolDefinition[] {
  const tools: CompanyToolDefinition[] = [
    {
      name: 'db_schema',
      description:
        '【表结构探查】写 SQL 前先确认真实库名/表名/列名，不要靠猜。三种用法：传 keyword 按列名或注释模糊搜（如“护照”“passport”“生日”），回答“这个字段在哪张表”；传 table 列出该表所有列；都不传则列出表清单。只读 information_schema。',
      schema: z.object({
        keyword: z.string().optional().describe('按列名/列注释模糊搜，例如 “护照” “passport” “birth”'),
        table: z.string().optional().describe('表名，列出它的所有列'),
        database: z.string().optional().describe('限定库名'),
        limit: z.number().optional().describe('返回条数上限，默认 200，最大 500'),
      }),
      execute: async (args, cfg) => executeDbSchema(args, cfg),
    },
    {
      name: 'export_query',
      description:
        '【按 SQL 导出文件】在服务端执行只读 SQL 并直接写成 xlsx/csv，只返回行数和下载链接，行数据不进入模型上下文。用于导出几千上万行明细（company_db_query 最多 200 行、db_stats 只返回聚合，都做不到）。上限 20 万行；SQL 必须只读；filename 只写文件名即可。',
      schema: z.object({
        sql: z.string().describe('只读 SELECT，建议带 WHERE 缩小范围；结果直接落盘不返回给模型'),
        filename: z.string().describe('文件名，例如 "users-20261103.xlsx"；扩展名可省略'),
        format: z.enum(['xlsx', 'csv']).optional().describe('默认 xlsx'),
        sheetName: z.string().optional().describe('xlsx 工作表名'),
      }),
      execute: async (args, cfg) => executeExportQuery(args, cfg),
    },
    {
      name: 'db_stats',
      description:
        '【统计/汇总】用聚合 SQL 得到数量、分布、按天汇总等结论，不受明细行数限制（明细查 company_db_query 只有 200 行，全量统计会被截断，结论就会错）。SQL 必须是 SELECT 且含 COUNT/SUM/AVG/MIN/MAX 或 GROUP BY；结果行上限 1000。表名建议写全库名，例如 SELECT COUNT(*) FROM skt_order.t_order WHERE ...',
      schema: z.object({
        sql: z.string().describe('只读聚合 SQL，必须含聚合函数或 GROUP BY'),
        db: z.string().optional().describe('库名，可省略（在 SQL 里写全库名即可）'),
      }),
      execute: async (args, cfg) => executeDbStats(args, cfg),
    },
    {
      name: 'export_file',
      description:
        '【服务端导出】把文本内容写成可下载的导出文件（CSV / JSON / TXT），返回下载链接，客服点链接即可取走。与客户端本机写文件无关：只写服务端导出目录，只接受相对路径，绝对路径或越界路径会被拒绝。需要给客服一份文件时使用。',
      schema: z.object({
        path: z.string().describe('相对路径，例如 "users-20261103.csv" 或 "export/users.csv"；不能是绝对路径'),
        content: z.string().describe('要写入的完整内容（UTF-8 文本）'),
        append: z.boolean().optional().describe('true=追加到文件末尾（分批导出时使用）；默认 false 覆盖写入'),
      }),
      execute: async (args, cfg) => executeWriteFile(args, cfg),
    },
    {
      name: 'export_xlsx',
      description:
        '【服务端导出】把二维数组写成 xlsx（第一行作为表头），返回下载链接，客服点链接即可下载 Excel。行数上限 20 万；路径必须以 .xlsx 结尾，只接受相对路径。需要给客服一份 Excel 时使用。',
      schema: z.object({
        path: z.string().describe('相对路径，例如 "users-20261103.xlsx"'),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).describe('二维数组，第一行为表头'),
        sheetName: z.string().optional().describe('工作表名，默认 Sheet1'),
      }),
      execute: async (args, cfg) => executeWriteXlsx(args, cfg),
    },
    {
      name: 'lookup_order',
      description:
        '【单号定位，查单第一步】输入我方订单号/系统 ID（17-20 位数字）、机票票号（13 位）、PNR、供应商单号或 12306 订单号，按索引列确定性地查找主订单、机票、酒店、火车票、打车各业务主表，返回所属业务线、关键字段、时间点和关联表。拿到单号后先调用本工具，不要自己猜表名去撒网查询。',
      schema: z.object({
        id: z.string().describe('单号/票号/PNR，例如 "1541491413412347905"、"9993903209296"、"HVBJEE"'),
      }),
      execute: async (args, cfg) => executeLookupOrder(args, cfg),
    },
    {
      name: 'search_code',
      description:
        '在公司代码库中检索关键字、报错文案、接口路由或类/方法名（skt-front 为前端工程；skt-back、skt-back-new、skt-remote 为后端工程）。返回命中文件总数和匹配内容；命中较多时列出其余文件并说明如何翻页，不会静默丢弃结果。',
      schema: z.object({
        keyword: z
          .string()
          .describe('搜索关键字。多个词任一命中用 " OR " 连接（如 "退票费 OR refundFee"）；要求同一文件同时包含用 " AND "；也支持正则。搜索报错文案时直接粘贴文案片段。'),
        scope: z
          .enum(['frontend', 'backend', 'all'])
          .optional()
          .default('all')
          .describe('frontend=前端工程 skt-front；backend=后端工程 skt-back / skt-back-new / skt-remote；all=全部（默认）'),
        filePattern: z
          .string()
          .optional()
          .describe('可选文件过滤，如 "*.vue"、"*.java"、"*.vue OR *.js"；不含通配符时按"文件名包含"匹配（如 "OrderAirOperationServiceImpl"）'),
        output_mode: z
          .enum(['content', 'files_with_matches', 'count'])
          .optional()
          .default('content')
          .describe('content=展示匹配行及上下文（默认）；files_with_matches=只列出全部命中文件和匹配数，适合先摸清范围；count=按仓库统计'),
        offset: z.number().optional().describe('翻页：跳过前 N 个命中文件（按路径排序），用于查看后续文件的内容'),
      }),
      execute: async (args, cfg) => executeSearchCode(args, cfg),
    },
    {
      name: 'read_file_lines',
      description:
        '读取代码库文件内容（带行号）。请求窗口小于 120 行时会自动扩大，单次最多 400 行，没读完会提示下一次的 startLine；同名文件有多个时返回候选路径。定位到关键代码后请读完整个方法，确认后续没有对同一字段的再次赋值或分支覆盖。',
      schema: z.object({
        filePath: z.string().describe('相对代码库根目录的路径（如 "skt-back/skt_cxy/.../Foo.java"）；只给文件名时，若唯一会自动定位'),
        startLine: z.number().optional().describe('起始行号（从 1 开始，可选）'),
        endLine: z.number().optional().describe('结束行号（可选）'),
      }),
      execute: async (args, cfg) => executeReadFileLines(args, cfg),
    },
    {
      name: 'git_inspect',
      description: '查询代码文件的 Git 提交历史（log）、逐行作者与修改记录（blame）或指定版本下的文件内容（show），自动定位文件所属的子仓库。',
      schema: z.object({
        action: z.enum(['log', 'blame', 'show']).describe('log=文件的提交历史（配合 lineRange 时只看改过这些行的提交）；blame=逐行最后修改人与提交；show=ref 指定版本下的文件内容'),
        filePath: z.string().describe('代码文件路径（相对代码库根目录，或唯一的文件名）'),
        ref: z.string().optional().describe('action=show 时必填：标签（如 P1.2.1）、提交号，或 before:YYYY-MM-DD（该日期前的最后一个提交）'),
        lineRange: z.string().optional().describe('行号范围，例如 "50,70"（可选）'),
        maxCount: z.number().optional().describe('log 返回的提交条数（默认 10，最多 30）'),
      }),
      execute: async (args, cfg) => executeGitInspect(args, cfg),
    },
    {
      name: 'codegraph_explore',
      description:
        '代码知识图谱查询：类/方法定义、接口实现类、调用方 (callers)、被调方 (callees)、引用位置。图谱基于静态解析，查不到不代表代码中不存在该关系，需要时用 search_code 交叉验证。',
      schema: z.object({
        symbol: z.string().describe('符号名称，例如类名、方法名或接口名（如 "InvoiceApplyService", "checkOrderCancelRule"）'),
        queryType: z
          .enum(['definitions', 'implementations', 'callers', 'callees', 'references'])
          .describe('查询类型：definitions(定义), implementations(接口实现类), callers(调用方), callees(被调方), references(引用位置)'),
        scope: z
          .enum(['frontend', 'backend', 'all'])
          .optional()
          .default('all')
          .describe('查询范围：frontend(前端工程), backend(后端工程), all(全部)'),
        repo: z.string().optional().describe('可选的目标仓库标识'),
      }),
      execute: async (args, cfg) => executeCodeGraph(args, cfg),
    },
    {
      name: 'search_logs',
      description:
        '查询生产微服务运行日志（Grafana/Loki），单次时间窗最长 2 小时。推荐用法：先从数据库拿到事件时间（如 create_time / order_time）作为 target_time，再用单号、接口路径或异常类名作为 keyword。没有时间点时可用 minutes_ago 看最近的日志，但最近出现的报错不一定与当前问题有关，不能直接当作本案证据。返回 0 条不代表没有发生。',
      schema: z.object({
        app: z.string().optional().describe('微服务应用名（如 "cxy-web", "cxy-booking", "cxy-ibe", "cxy-hotel"），不确定时先用 list_log_apps'),
        keyword: z.string().optional().describe('关键词；多个词任一命中用 " OR " 连接；英文不区分大小写，数字按字面精确匹配'),
        target_time: z.string().optional().describe('事件发生的大致时间（"YYYY-MM-DD HH:mm:ss"，直接使用数据库返回的本地时间），查询其前后窗口'),
        window_minutes: z.number().optional().default(10).describe('围绕 target_time 的窗口半径分钟数（默认 10，最大 60）'),
        minutes_ago: z.number().optional().describe('未提供 target_time 时：查询最近 N 分钟（默认 30，最大 120）'),
        start_time: z.string().optional().describe("自定义开始时间 'YYYY-MM-DD HH:mm:ss'（与 end_time 配合，跨度≤2小时）"),
        end_time: z.string().optional().describe('自定义结束时间'),
        namespace: z.string().optional().default('cxy').describe('K8s 命名空间（默认 cxy）'),
        limit: z.number().optional().default(50).describe('返回日志条数上限（默认 50，最大 200）'),
      }),
      execute: async (args, cfg, user) => executeSearchLogs(args, cfg, user),
    },
    {
      name: 'lookup_service',
      description:
        '查询「部署名 ↔ 配置目录 ↔ 代码仓库 ↔ 包根」的对应关系。' +
        '本系统的部署名、配置目录名、仓库名经常不一致（例：部署名 cxy-booking 的配置在 prod-config/cxy-dpxt 目录；仓库 skt_dpxt_background 同时承载 cxy-booking / cxy-booking-test / cxy-booking-timer）。' +
        '当你要判断「某个类跑在哪个服务」「某个服务对应哪个仓库」「查日志该用哪个 app 名」时先调本工具，不要靠名字猜。' +
        '支持三种查法：传部署名（cxy-booking）、传类全名（com.company.project.hotel.remote.service.HotelQueryService，取前 3 段包根反查）、传仓库名（skt_dpxt_background，反查它承载哪些服务）。' +
        '返回里的 repoConfidence 表示仓库归属证据强度：high=有 jar 或 app 名直接证据，low=仅目录名推测，none=未找到；low/none 不要当结论使用。',
      schema: z.object({
        query: z.string().describe('部署名（如 "cxy-booking"）、类全名（如 "com.company.project.hotel.remote.service.HotelQueryService"）或仓库名（如 "skt_dpxt_background"）'),
      }),
      execute: async (args) => executeLookupService(args),
    },
    {
      name: 'list_services',
      description:
        '列出全部已知服务及其配置目录、代码仓库、仓库归属置信度。当你不知道服务叫什么名字时先用它浏览，再用 lookup_service 查细节。' +
        '注意：这里只包含有部署配置（prod-config）的服务，基础组件与未纳管的服务不在其中。',
      schema: z.object({}),
      execute: async () => executeListServices(),
    },
    {
      name: 'list_log_apps',
      description: '列出日志系统中指定命名空间下所有可查询的微服务应用名（用于确认 search_logs 的 app 参数）。与 list_services 的区别：这里返回的是「当前实际在打日志」的服务，可能包含 list_services 里没有的（如定时任务、MQ 消费端），也可能缺少当前没有流量的服务。',
      schema: z.object({
        namespace: z.string().optional().default('cxy').describe('K8s 命名空间（默认 cxy）'),
      }),
      execute: async (args, cfg, user) => executeListLogApps(args, cfg, user),
    },
    {
      name: 'company_db_query',
      description:
        '公司内部数据库只读查询（MyCat）。action: list_databases / list_tables / describe_table（含索引）/ search_schema（按表名找表）/ query（只读 SELECT/SHOW/EXPLAIN）。query 默认最多返回 50 行；结果不完整时会标注 complete=false 并说明原因，不能当作全量。日期时间为数据库本地时间。',
      schema: z.object({
        action: z
          .enum(['list_databases', 'list_tables', 'describe_table', 'search_schema', 'query'])
          .describe('list_databases(所有库), list_tables(某库的表), describe_table(表结构、字段注释与索引), search_schema(按表名关键词找表), query(执行只读 SQL)'),
        database: z
          .string()
          .optional()
          .describe('目标数据库（如 "skt", "payment", "myibe", "skt_project_hotel"）。query 时可省略并在 SQL 中写 `库名.表名`，都没有时默认 skt'),
        tableName: z.string().optional().describe('表名（describe_table 时必填，如 "order_air"）'),
        keyword: z.string().optional().describe('search_schema / list_tables 的表名关键词，支持 "A OR B"、"a|b"、"a,b"'),
        sql: z
          .string()
          .optional()
          .describe('只读 SQL（action=query 时使用）。请写 `库名.表名`；单号/ID/手机号等长数字按字符串比较（工具会自动加引号）；大表用索引列等值条件或时间窗口，避免 LIKE "%x%" 和多列 OR'),
        limit: z.number().optional().default(50).describe('query 最多返回的行数（默认 50，最大 200）'),
      }),
      execute: async (args, cfg, user) => executeDatabaseTool(args, cfg, user),
    },
  ];

  if (isWebSearchConfigured()) {
    tools.push({
      name: 'web_search',
      description: '检索互联网公开技术文档、报错讨论与开源组件已知 Issue（由服务端统一持有搜索 API Key）',
      schema: z.object({
        query: z.string().describe('搜索关键词、技术组件名或错误日志片段（如 "Spring Cloud Gateway 504"）'),
        numResults: z.number().optional().default(5).describe('期望返回的搜索结果条数 (1-10)'),
      }),
      execute: async (args, cfg, user) => executeWebSearch(args, cfg, user),
    });
  }

  // 输入侧脱敏：工具结果进入模型前统一过一遍（S2 是"搜不到"，这里是"即使搜到了也不送进模型"）。
  // 开关 inputGuard 默认 true（S6 是已合入的安全修复）；仅显式 FEATURE_INPUT_GUARD=0 时回到基线行为。
  // 未提供 features 的旧调用方（部分单测替身 config）按默认开启处理。
  for (const tool of tools) {
    const inner = tool.execute;
    tool.execute = async (args, cfg, user) => {
      const guarded = cfg?.features ? cfg.features.inputGuard : true;
      const result = await inner(args, cfg, user);
      return guarded ? redactToolResult(tool.name, result) : result;
    };
  }

  return tools;
}
