/**
 * company_db_query 查询结果的列注释附注（columnNotes）。
 *
 * 背景：查询结果里的编码列只给数值（例如 carrier=1002），数值含义写在 MySQL 列注释里，
 * 只有显式 describe_table 才看得到；模型没看注释时会按字面去猜含义，结论就会出错。
 * 这里为「本次返回的、注释里带数字编码映射」的列附上注释原文；普通说明型注释（订单号、创建时间）不附，避免撑大结果。
 *
 * 本文件只有纯函数与进程内缓存，不依赖数据库驱动：
 * - isCodeMappingComment：判断注释是不是编码映射型（通用规则，不含任何具体业务值或表名）
 * - resolveColumnSources：由驱动字段元数据得到「结果列 → 来源 (库, 表, 列)」；同名列来源不一致时判为无法归属
 * - buildColumnNotes：组合上面两者与注释查询函数构造 columnNotes；任何失败都只会少注，不会抛错
 * - createColumnCommentCache：按表缓存注释，带 TTL；失败也短暂缓存，避免每次查询都被同一个失败拖慢
 */

export interface ColumnSource {
  schema: string;
  table: string;
  column: string;
}

/** 单条附注的最大长度（字符），超出截断并以「…」结尾 */
export const COLUMN_NOTE_MAX_CHARS = 200;
/** 一次结果里所有附注的总长度上限：宽表 SELECT * 时避免注释挤占结果行的输出预算 */
export const COLUMN_NOTES_TOTAL_MAX_CHARS = 3000;
/** 判定时最多扫描的注释长度 */
const COMMENT_SCAN_MAX_CHARS = 2000;

/** MySQL 自带的系统库：其中的列不会有业务编码注释，不必查 */
const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

/**
 * 「代码在前」的一项：独立的整数代码（前面不能紧挨字母、数字、小数点或连字符，排除 MD5、v2、1.5、2020-01 这类），
 * 可选的分隔符（: ： = - . 、 ) -> → 等），再接以汉字或英文字母开头的含义（H5、APP、PC端 都算一个含义），
 * 含义之后到下一个分隔字符之前的附加说明（如「(已下线)」）也归入这一项。
 */
const CODE_FIRST_ITEM = /(?<![\w.\-])(-?\d{1,6})(?!\d)(\s*(?:->|=>|[:：=\-.、)）\]】→])?\s*)((?:[\u3400-\u4dbf\u4e00-\u9fff]+|[A-Za-z][A-Za-z0-9_]*)+)([^\d\s,，;；、/|\-]*)/g;
/** 「含义在前」的一项：含义(代码)，如「待审核(0)」 */
const LABEL_FIRST_ITEM = /((?:[\u3400-\u4dbf\u4e00-\u9fff]+|[A-Za-z][A-Za-z0-9_]*)+)\s*[(（]\s*(-?\d{1,6})\s*[)）]/g;
/** 同一个枚举里相邻两项之间只允许出现分隔字符（也可以紧挨着，如「0否1是」） */
const ITEM_GAP = /^[\s,，;；、/|]*$/;
/** 明确表示「代码→含义」的分隔符：有它时单独一项也足以认定为编码映射（如「1:H5」） */
const EXPLICIT_SEPARATOR = /[:：=→]|->/;
/**
 * 通用计量单位 / 量词（与具体业务无关）。数字后直接跟这些字、中间没有分隔符时是数量表达而不是编码含义，
 * 用来排除「2019年12月新增」「重试间隔10秒、30秒」「身份证18位」这类说明文字。
 */
const MEASURE_WORDS = new Set([
  // 时间
  '年', '月', '日', '号', '天', '周', '时', '点', '分', '秒', '刻', '小时', '分钟', '毫秒', '星期', '季度', '个月',
  // 数量、量词
  '个', '位', '次', '种', '条', '张', '份', '件', '笔', '倍', '期', '层', '页', '字', '字节', '项', '晚', '间', '岁',
  // 货币、计量
  '元', '角', '块', '米', '厘米', '毫米', '公里', '千米', '克', '千克', '公斤', '斤', '吨', '升', '度',
  // 英文单位
  'ms', 's', 'sec', 'min', 'h', 'hr', 'd', 'm', 'km', 'cm', 'mm', 'kg', 'g', 'px', 'b', 'kb', 'mb', 'gb', 'tb', 'k', 'w',
]);

interface CodeItem {
  code: string;
  label: string;
  start: number;
  end: number;
  /** 代码与含义之间有明确分隔符（且含义不是单个字母，排除「1:N」这类比例写法） */
  explicit: boolean;
  /** 数字后直接跟计量单位（如「30秒」「2019年」）：数量表达，不是编码 */
  quantity: boolean;
}

function codeFirstItems(text: string): CodeItem[] {
  const items: CodeItem[] = [];
  for (const m of text.matchAll(CODE_FIRST_ITEM)) {
    const start = m.index ?? 0;
    const separator = m[2].trim();
    const label = m[3];
    items.push({
      code: m[1],
      label,
      start,
      end: start + m[0].length,
      explicit: EXPLICIT_SEPARATOR.test(separator) && !/^[A-Za-z]$/.test(label),
      quantity: separator === '' && MEASURE_WORDS.has(label.toLowerCase()),
    });
  }
  return items;
}

function labelFirstItems(text: string): CodeItem[] {
  const items: CodeItem[] = [];
  for (const m of text.matchAll(LABEL_FIRST_ITEM)) {
    const start = m.index ?? 0;
    items.push({ code: m[2], label: m[1], start, end: start + m[0].length, explicit: false, quantity: false });
  }
  return items;
}

/** 一组相邻的项构成枚举：至少两项，代码与含义各至少两种（排除「10秒、30秒、60秒」这种同一含义的重复） */
function isEnumerationRun(run: CodeItem[]): boolean {
  return run.length >= 2 && new Set(run.map((item) => item.code)).size >= 2 && new Set(run.map((item) => item.label)).size >= 2;
}

function containsCodeMapping(text: string, items: CodeItem[]): boolean {
  let run: CodeItem[] = [];
  for (const item of items) {
    if (item.explicit) return true;
    if (item.quantity) {
      if (isEnumerationRun(run)) return true;
      run = [];
      continue;
    }
    const prev = run[run.length - 1];
    if (prev && !ITEM_GAP.test(text.slice(prev.end, item.start))) {
      if (isEnumerationRun(run)) return true;
      run = [];
    }
    run.push(item);
  }
  return isEnumerationRun(run);
}

/**
 * 注释是否为「编码映射型」：注释里出现「数字代码 + 含义」的枚举。满足其一即可：
 * 1. 至少两项相邻的「代码+含义」（如「1001携程,1002华住」「0否1是」「1.微信 2.支付宝」「待审核(0),已通过(1)」），
 *    且代码、含义各至少两种；
 * 2. 单独一项但代码与含义之间有明确分隔符「: ： = -> →」（如「1:H5」「0：关闭」）。
 * 单独一个「数字+文字」（如「12306订单号」「保留2位小数」）与计量表达（如「2019年12月」「30秒」）不算。
 */
export function isCodeMappingComment(comment: unknown): boolean {
  if (typeof comment !== 'string') return false;
  const text = comment.slice(0, COMMENT_SCAN_MAX_CHARS);
  if (!/\d/.test(text)) return false;
  return containsCodeMapping(text, codeFirstItems(text)) || containsCodeMapping(text, labelFirstItems(text));
}

/** 截断到 maxChars 个字符（按码点，不会截断代理对），超出时以「…」结尾 */
export function truncateNote(comment: string, maxChars = COLUMN_NOTE_MAX_CHARS): string {
  const text = comment.trim();
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text;
}

/** 读取字段元数据里的字符串属性（mysql2 的 ColumnDefinition 用原型上的惰性 getter 提供 schema/db/orgTable/orgName） */
function metaString(field: unknown, key: string): string {
  if (!field || typeof field !== 'object') return '';
  try {
    const value = (field as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * 由驱动返回的字段元数据得到「结果列名 → 来源 (库, 原表, 原列)」。
 * - 来源只认元数据：库取 schema（mysql2 的 db 是它的别名），表取 orgTable（真实表名，不是 SQL 里的别名），列取 orgName；
 * - 三者缺一（表达式列、聚合列、驱动/代理没给元数据）时该列为 null，不注；
 * - 同名结果列出现多次且来源不一致（多表 JOIN 的 a.status 与 b.status）时为 null：结果行里只剩其中一个值，无法可靠归属。
 * 不解析 SQL，也不猜别名。
 */
export function resolveColumnSources(fields: unknown): Map<string, ColumnSource | null> {
  const sources = new Map<string, ColumnSource | null>();
  if (!Array.isArray(fields)) return sources;
  for (const field of fields) {
    const name = metaString(field, 'name');
    if (!name) continue;
    const schema = metaString(field, 'schema') || metaString(field, 'db');
    const table = metaString(field, 'orgTable');
    const column = metaString(field, 'orgName');
    const source = schema && table && column ? { schema, table, column } : null;
    if (!sources.has(name)) {
      sources.set(name, source);
      continue;
    }
    const prev = sources.get(name);
    if (!prev || !source || prev.schema !== source.schema || prev.table !== source.table || prev.column !== source.column) {
      sources.set(name, null);
    }
  }
  return sources;
}

/** 按 (库, 表) 取该表的列注释（列名 → 注释）；返回 null/undefined 或抛错都视为拿不到 */
export type ColumnCommentLookup = (schema: string, table: string) => Promise<ReadonlyMap<string, string> | null | undefined>;

export interface BuildColumnNotesInput {
  /** 本次结果返回的列名（顺序即输出顺序） */
  columns: readonly string[];
  /** 全为 NULL 的列：没有值需要解释，不附注释 */
  allNullColumns?: readonly string[];
  /** 驱动返回的字段元数据（mysql2 query() 的第二个返回值）；拿不到时传 undefined */
  fields: unknown;
  lookupComments: ColumnCommentLookup;
  maxNoteChars?: number;
  maxTotalChars?: number;
}

async function loadTableComments(lookup: ColumnCommentLookup, schema: string, table: string): Promise<Map<string, string> | null> {
  try {
    const result = await lookup(schema, table);
    if (!result || typeof result.forEach !== 'function') return null;
    const byLowerName = new Map<string, string>();
    result.forEach((comment, name) => {
      if (typeof name === 'string' && typeof comment === 'string' && comment.trim()) byLowerName.set(name.toLowerCase(), comment);
    });
    return byLowerName;
  } catch {
    return null;
  }
}

/**
 * 构造 columnNotes：{ 列名: 注释原文(截断) }，只含来源可靠、注释为编码映射型、且不是全空的返回列。
 * 每张来源表只查一次注释；注释查询失败的表跳过；没有可附的注释时返回 undefined。永不抛错。
 */
export async function buildColumnNotes(input: BuildColumnNotesInput): Promise<Record<string, string> | undefined> {
  try {
    const sources = resolveColumnSources(input.fields);
    if (sources.size === 0) return undefined;
    const allNull = new Set(input.allNullColumns ?? []);
    const maxNoteChars = input.maxNoteChars ?? COLUMN_NOTE_MAX_CHARS;
    const maxTotalChars = input.maxTotalChars ?? COLUMN_NOTES_TOTAL_MAX_CHARS;
    const tableComments = new Map<string, Map<string, string> | null>();
    const notes = new Map<string, string>();
    let total = 0;
    for (const column of input.columns) {
      if (allNull.has(column) || notes.has(column)) continue;
      const source = sources.get(column);
      if (!source || SYSTEM_SCHEMAS.has(source.schema.toLowerCase())) continue;
      const key = `${source.schema}\u0000${source.table}`;
      if (!tableComments.has(key)) tableComments.set(key, await loadTableComments(input.lookupComments, source.schema, source.table));
      const comment = tableComments.get(key)?.get(source.column.toLowerCase());
      if (!comment || !isCodeMappingComment(comment)) continue;
      const note = truncateNote(comment, maxNoteChars);
      if (total + note.length > maxTotalChars) continue;
      notes.set(column, note);
      total += note.length;
    }
    return notes.size ? Object.fromEntries(notes) : undefined;
  } catch {
    return undefined;
  }
}

export interface ColumnCommentCacheOptions {
  /** 成功结果（包括「该表没有注释」）的缓存时长，默认 1 小时 */
  ttlMs?: number;
  /** 失败（超时、无权限等）的缓存时长，默认 5 分钟：期间直接跳过该表，不再反复拖慢查询 */
  failureTtlMs?: number;
  /** 最多缓存的表数，超出时淘汰最早写入的，默认 500 */
  maxTables?: number;
  now?: () => number;
}

export type ColumnCommentCacheHit = { hit: true; comments: ReadonlyMap<string, string> | null } | { hit: false };

export interface ColumnCommentCache {
  /** 只读查看缓存：命中且未过期时 hit=true（comments 为 null 表示最近一次查询失败、仍在冷却期内） */
  peek(schema: string, table: string): ColumnCommentCacheHit;
  /** 命中且未过期直接返回；否则调用 load 并缓存。load 失败返回 null（并短暂缓存这次失败），不抛错 */
  get(schema: string, table: string, load: () => Promise<ReadonlyMap<string, string>>): Promise<ReadonlyMap<string, string> | null>;
  clear(): void;
  readonly size: number;
}

/** 进程内按表缓存列注释（注释是库表结构知识，不含业务数据，各会话共享无副作用） */
export function createColumnCommentCache(options: ColumnCommentCacheOptions = {}): ColumnCommentCache {
  const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  const failureTtlMs = options.failureTtlMs ?? 5 * 60 * 1000;
  const maxTables = Math.max(1, options.maxTables ?? 500);
  const now = options.now ?? Date.now;
  const entries = new Map<string, { at: number; ttl: number; comments: ReadonlyMap<string, string> | null }>();
  const keyOf = (schema: string, table: string) => `${schema}\u0000${table}`;
  const peek = (schema: string, table: string): ColumnCommentCacheHit => {
    const entry = entries.get(keyOf(schema, table));
    return entry && now() - entry.at < entry.ttl ? { hit: true, comments: entry.comments } : { hit: false };
  };
  return {
    peek,
    async get(schema, table, load) {
      const cached = peek(schema, table);
      if (cached.hit) return cached.comments;
      const key = keyOf(schema, table);
      let comments: ReadonlyMap<string, string> | null = null;
      try {
        comments = (await load()) ?? null;
      } catch {
        comments = null;
      }
      entries.delete(key);
      entries.set(key, { at: now(), ttl: comments ? ttlMs : failureTtlMs, comments });
      while (entries.size > maxTables) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return comments;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
