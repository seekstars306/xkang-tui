// 同题全流程单次运行：喂真实客服原始提问，跑完整 AgentCore（排查+复核+装配），
// 复核的部分发布开关、时间预算与生产配置（FEATURE_PARTIAL_PUBLISH / FEATURE_TIME_BUDGET）一致。输出只写 git 忽略目录。
// 用法：DRY=1 node --import tsx tests/eval/reports/_retest/full_ticket_run.ts  仅装配不调用模型
//       RUN_LABEL=R6-... WITH_SECOND_TURN=1 node --import tsx <同上>          正式付费运行
//       INPUT_FILE=<{messages:[…]} 的 JSON> SOURCE_SESSION=<来源会话 id>     换题（默认 D001 酒店重复开票，s_2adc1696）
//       ARM=control node --import tsx --import ./tests/eval/reports/_retest/control_arm/register.mjs <同上>
//                                                                          同题配对的对照组（改动前：G3C 版 review.ts + HEAD 版工具层）
//       RUN_TOKEN_CAP=<token 数>                                            单次运行 token 硬上限（默认 8,000,000，超过即中止）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AgentCore, type Message, type MessageContentPart, type StreamEvent } from '@xkang/agent-core';
import { startIsolatedServer, loadServerEnv } from '../../../../tests/helpers/isolated_server.ts';
import { McpRemoteClient } from '../../../../src/mcp/client.ts';
import { ToolRegistry } from '../../../../src/tools/registry.ts';
import { BusinessModel } from '../../../../server/src/agent/model.ts';
import * as reviewModule from '../../../../server/src/agent/review.ts';
import { BUSINESS_PROMPT } from '../../../../server/src/agent/service.ts';
import { buildSystemPrompt } from '../../../../server/src/agent/investigation_prompt.ts';
import { getCompanyServerSkills } from '../../../../server/src/skills.ts';
import { appendUsageLedger } from '../../../../scripts/eval/usage_ledger.ts';
import { ruleLayerEnabled } from '../../../../server/src/agent/rule_layer.ts';
import { collectRepoStates } from '../../../../server/src/codegraph/version_trust.ts';
import { CONTROL_REDIRECTS } from './control_arm/redirects.mjs';

// 同题配对：control = 改动前（A 同名提示、B 按仓库轮流、C"成因尚未定位"补查三项都不在），new = 当前代码
if (process.env.ARM && !['control', 'new'].includes(process.env.ARM)) throw new Error('ARM 只能是 control 或 new');
const ARM: 'control' | 'new' = process.env.ARM === 'control' ? 'control' : 'new';
const { reviewAnswer } = reviewModule;
// 改动前的 review.ts 没有这个导出：本进程实际载入的是哪一版，以它为准自证
const CAUSE_UNKNOWN_FOLLOWUP = (reviewModule as Record<string, unknown>).CAUSE_UNKNOWN_FOLLOWUP as string | undefined;
const runnerReviewHasC = typeof CAUSE_UNKNOWN_FOLLOWUP === 'string';
// G3④ 的 C 已在 2026-10-19 随 A/B/C 一起撤回，CAUSE_UNKNOWN_FOLLOWUP 不再存在，
// 这条自证只对「对照/实验两臂」的同题配对有意义。SKIP_ARM_PROOF=1 用于单题能力核查（只有一臂）。
if (process.env.SKIP_ARM_PROOF !== '1' && (ARM === 'control') === runnerReviewHasC) {
  throw new Error(ARM === 'control' ? '对照组没生效：命令行要在 tsx 之后加 --import ./tests/eval/reports/_retest/control_arm/register.mjs' : '实验组却载入了改动前的 review.ts');
}

// .env 兜底：只在外部没有显式设置时才写入。否则命令行传入的 REVIEWER / OBSERVE_INTENT_ROUTER
// 会被 .env 的默认值覆盖，两臂实际跑成同一份配置，对比就失去意义。
for (const [key, value] of Object.entries(loadServerEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}
const { loadServerConfig } = await import('../../../../server/src/config.ts');
const config = loadServerConfig();

const DRY = process.env.DRY === '1';
const LABEL = process.env.RUN_LABEL || 'R6-full-ticket';
const WITH_SECOND_TURN = process.env.WITH_SECOND_TURN === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(`tests/eval/reports/_retest/full-ticket-run-${DRY ? 'dry-' : ''}${ARM}-${stamp}`);
if (fs.existsSync(out)) throw new Error('输出目录已存在，换目录名');
fs.mkdirSync(out, { recursive: true });

// 输入：与真实会话同一份客服提问原文（截图按原样作为分段内容传入）；第二条 user 轮由开关决定
const INPUT_FILE = process.env.INPUT_FILE || 'tests/eval/reports/_retest/retest-private.json';
const SOURCE_SESSION = process.env.SOURCE_SESSION || 's_2adc1696';
const priv = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
const contentText = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => p?.type === 'text' ? p.text : '').join('') : '';
const userTurns: Array<string | MessageContentPart[]> = (Array.isArray(priv) ? priv : priv.messages || [])
  .filter((m: any) => m.role === 'user' && !m.internal && !m.isReminder && !/^<system-reminder>/.test(contentText(m.content)))
  .map((m: any) => (Array.isArray(m.content) ? m.content : String(m.content ?? '').trim()))
  .filter((c: string | MessageContentPart[]) => (Array.isArray(c) ? c.length > 0 : Boolean(c)));
if (!userTurns.length) throw new Error(`未从 ${INPUT_FILE} 取到客服提问`);
if (WITH_SECOND_TURN && userTurns.some(turn => Array.isArray(turn))) throw new Error('带截图的提问不支持 WITH_SECOND_TURN 拼接');
const input: string | MessageContentPart[] = WITH_SECOND_TURN ? (userTurns as string[]).join('\n') : userTurns[0];
const imageCount = Array.isArray(input) ? input.filter(part => part.type === 'image_url').length : 0;
const inputSerialized = typeof input === 'string' ? input : JSON.stringify(input);

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const frozen: Record<string, string> = {};
for (const file of [
  'server/src/agent/review.ts', 'server/src/agent/publication.ts', 'server/src/agent/service.ts',
  'server/src/agent/investigation_prompt.ts', 'server/src/agent/model.ts', 'server/src/config.ts',
  'server/src/agent/rule_layer.ts', 'server/src/skills.ts', 'src/tools/registry.ts', 'src/mcp/client.ts',
  'server/src/tools/code_search.ts', 'server/src/tools/index.ts', 'server/src/codegraph/version_trust.ts', 'server/src/codegraph/path_policy.ts',
  'packages/agent-core/src/core.ts', 'packages/agent-core/src/context.ts', 'tests/eval/frozen-rules.json',
  // @xkang/agent-core 的 exports 指向 dist：运行时真正载入的是编译产物，一并记录
  'packages/agent-core/dist/core.js', 'packages/agent-core/dist/context.js', 'packages/agent-core/dist/public.js',
  'tests/helpers/isolated_server.ts', 'tests/eval/reports/_retest/full_ticket_run.ts',
  'tests/eval/reports/_retest/control_arm/redirects.mjs', 'tests/eval/reports/_retest/control_arm/register.mjs',
  ...CONTROL_REDIRECTS.map((r: { copy: string }) => r.copy),
]) frozen[file] = hash(fs.readFileSync(file));
// 与生产 service.ts 的注入一致：开启 FEATURE_TIME_BUDGET 时下发 15 分钟活跃预算（复核打回后 4 轮只读补查）
const budget = config.features?.timeBudget ? { activeMs: 15 * 60 * 1000, extensions: 0, turnsPerExtension: 10, reviewsPerExtension: 1, repairTurnsPerReview: 4 } : undefined;
const partialPublish = Boolean(config.features?.partialPublish);
// 单次运行 token 硬上限（输入+输出+思考，按逐调用审计累加），超过即中止；低于台账「单任务超 10M 暂停请示」线
const RUN_TOKEN_CAP = Number(process.env.RUN_TOKEN_CAP) || 8_000_000;
// 镜像版本前后各记一次（只读 git，--no-optional-locks）：生产 8600 的定时同步会改镜像，配对两次若跑在不同代码上只能判「环境不一致」
const mirrorSnapshot = () => collectRepoStates(config.codeRepoPath || '').map(r => ({ repo: r.relativePath, head: r.headSha, dirty: r.dirty }));
const mirrorStart = mirrorSnapshot();
const manifest: any = {
  createdAt: new Date().toISOString(), label: LABEL, dryRun: DRY, withSecondTurn: WITH_SECOND_TURN,
  // 对照组换掉的文件（原文件 → 改动前副本及其哈希）；armProof 在连上隔离服务端后回填
  arm: ARM, redirects: ARM === 'control' ? CONTROL_REDIRECTS : [],
  inputLength: inputSerialized.length, inputHash: hash(inputSerialized), imageCount, userTurnCount: userTurns.length, frozen,
  mirror: { root: config.codeRepoPath || '', repos: mirrorStart.length, stateHash: hash(JSON.stringify(mirrorStart)), start: mirrorStart },
  // ruleLayer 是 G3③ 消融对照的自变量；promptHasRepeatSteps 在装配后回填，用来自证 OFF 臂真的关掉了
  flags: { partialPublish, timeBudget: budget ?? null, jsonMode: true, ruleLayer: ruleLayerEnabled() ? 'on' : 'off', reviewReasoningEffort: config.reviewReasoningEffort, modelCallTimeoutMs: config.modelCallTimeoutMs, reviewTimeoutMs: config.answerReviewTimeoutMs, runAbortMs: 18 * 60 * 1000, runTokenCap: RUN_TOKEN_CAP },
  controls: `同题对照：输入取自真实会话 ${SOURCE_SESSION} 的客服提问原文（${INPUT_FILE}）。空白会话、只读工具、隔离服务端(临时工作目录，不碰 server/data)。`,
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('输出目录', out);
console.log('输入长度', inputSerialized.length, '| 截图', imageCount, '| user 轮数', userTurns.length, '| 复核档位', config.reviewReasoningEffort, '| 复核超时(ms)', config.answerReviewTimeoutMs, '| 部分发布', partialPublish, '| 时间预算', budget ? '15 分钟/补查 4 轮' : '无');

// 对照组的隔离服务端追加同一个替换钩子（子进程继承 ARM=control），工具层换回 HEAD 版
const registerUrl = pathToFileURL(path.resolve('tests/eval/reports/_retest/control_arm/register.mjs')).href;
const server = await startIsolatedServer(8693, 'gemini', ARM === 'control' ? { imports: [registerUrl] } : {});
// 自证探针用的检索词：两个后端仓库都有这组类，改动前按路径排序时前 10 块全是 skt_cxy、没有同名提示；
// 改动后两仓库轮流出现并带【同名文件】提示（2026-10-17 用 probe_keyword.ts 在本机镜像上核对过）
const PROBE_KEYWORD = 'InvoiceCustomerInfoService';
const audit: any[] = [];
const started = Date.now();
let core: any, answer = '', error: string | null = null, calls = 0, reviewCalls = 0, toolCalls = 0, passedSeen = 0;
let promptChars = 0, toolCount = 0, aborted = false, abortReason: 'time' | 'token_cap' | null = null, lastRunState: unknown = null;
const client = new McpRemoteClient({ serverUrl: server.url, token: server.adminToken });
const controller = new AbortController();
const abortRun = (reason: 'time' | 'token_cap') => { if (aborted) return; aborted = true; abortReason = reason; controller.abort(); };
const timer = setTimeout(() => abortRun('time'), 18 * 60 * 1000);
// 逐调用写台账（不等跑完再补）：子进程被批量脚本的外部超时杀掉时台账也不缺；同时累加 token，超过单次上限就中止
const detailsOf = (e: any) => { try { return (typeof e?.details === 'string' ? JSON.parse(e.details) : e?.details) || {}; } catch { return {}; } };
const ledgerEntryOf = (e: any) => ({ ts: e?.timestamp || new Date().toISOString(), task: LABEL, model: typeof e?.model === 'string' ? e.model : 'gemini', purpose: detailsOf(e).purpose === 'answer_review' ? 'answer_review' : 'investigation', inputTokens: Number(e?.tokensUsed?.promptTokens) || 0, outputTokens: Number(e?.tokensUsed?.completionTokens) || 0, reasoningTokens: Number(e?.tokensUsed?.reasoningTokens) || 0, cachedTokens: Number(detailsOf(e).cachedInputTokens) || 0, durationMs: Number(e?.durationMs) || 0, ok: e?.success !== false, detail: `full-ticket-${stamp}` });
const ledgerPending: Array<ReturnType<typeof ledgerEntryOf>> = [];
let tokensSoFar = 0;
const recordAudit = (e: any) => {
  audit.push(e);
  if (DRY) return;
  const entry = ledgerEntryOf(e);
  try { appendUsageLedger(entry as any); } catch { ledgerPending.push(entry); }
  tokensSoFar += entry.inputTokens + entry.outputTokens + entry.reasoningTokens;
  if (tokensSoFar > RUN_TOKEN_CAP) abortRun('token_cap');
};
try {
  if (!(await client.connect())) throw new Error('隔离 MCP 不可用');
  const registry = new ToolRegistry();
  const allowed = new Set(['lookup_order', 'company_db_query', 'search_code', 'read_file_lines', 'git_inspect', 'codegraph_explore', 'search_logs', 'list_log_apps', 'lookup_service', 'list_services']);
  const remoteTools = await client.listTools();
  for (const tool of remoteTools) if (allowed.has(tool.name)) registry.registerRemote(tool);
  // 自证：隔离服务端实际在用哪一版工具层——offset 参数描述（B 改过）与一次固定检索的输出形状（A 加提示、B 改顺序）。
  // 探针在模型调用之前、两组都跑，不进入模型上下文；不符就在花钱之前中止
  const offsetDescription = String((remoteTools.find(t => t.name === 'search_code')?.parameters as any)?.properties?.offset?.description || '');
  const probeText = String(await client.callTool('search_code', { keyword: PROBE_KEYWORD }));
  const heads = [...probeText.matchAll(/^### (.+?)(?:@[^（\s]+)?（\d+ 处匹配）$/gm)].map(m => m[1].split('/').slice(0, 2).join('/'));
  const probe = { keyword: PROBE_KEYWORD, blocks: heads.length, twinHints: (probeText.match(/【同名文件】/g) || []).length, firstTwoReposDiffer: heads.length > 1 && heads[0] !== heads[1] };
  const serverHasAB = offsetDescription.includes('按仓库轮流') && probe.twinHints > 0 && probe.firstTwoReposDiffer;
  const serverLacksAB = !offsetDescription.includes('按仓库轮流') && probe.twinHints === 0 && probe.blocks > 1 && !probe.firstTwoReposDiffer;
  manifest.armProof = { runnerReviewHasC, offsetDescription, probe };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('组别', ARM, '| 本进程 review 含 C', runnerReviewHasC, '| 探针', JSON.stringify(probe));
  // 这道探针校验的是 G3④ 的 A（同名文件提示）与 B（按仓库轮流展示），两项已在 2026-10-19 撤回，
  // 探针期望值仍按当时的两臂写死。单题能力核查只有一臂，用 SKIP_ARM_PROOF=1 跳过。
  if (process.env.SKIP_ARM_PROOF !== '1' && (ARM === 'control' ? !serverLacksAB : !serverHasAB)) throw new Error(`隔离服务端的工具层与 ARM=${ARM} 不符：${JSON.stringify(manifest.armProof)}`);
  registry.setRemoteSkills(getCompanyServerSkills());
  registry.registerLocal({ name: 'ask_user_question', description: '仅询问无法查到的必要业务信息', parameters: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } } }, execute: async () => '' });
  toolCount = registry.getTools().length;
  const model = new BusinessModel(config, 'gemini', { log: recordAudit } as any, LABEL, controller.signal, true);
  const gateway: any = { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async (messages: Message[], tools: any[], emit: (e: StreamEvent) => void, options?: any) => { calls++; if (options?.signal) reviewCalls++; return await model.streamChat(messages, tools, emit, options); } };
  const event = (e: StreamEvent) => {
    if (e.type === 'tool_call_start') toolCalls++;
    if (e.type === 'question_requested') e.resolve('本题未提供额外信息，请核对已有资料并如实说明无法确认的部分。');
  };
  const context = { repoPath: config.codeRepoPath || '', localCwd: '' };
  // 显式把开关传进提示词构建：保证 manifest 记录的取值与实际提示词逐字一致（env 缺省路径仍然生效）；
  // 截图判定与生产 service.ts 相同：取最近一条客服输入是否带 image_url 分段
  const buildPrompt = (tools: any, _skills?: unknown, latest?: Message) => buildSystemPrompt(tools, getCompanyServerSkills(), 'l2', { hasImages: Array.isArray(latest?.content) && latest.content.some(part => part.type === 'image_url'), ruleLayer: ruleLayerEnabled() }) + '\n\n' + BUSINESS_PROMPT;
  core = new AgentCore({ gateway, registry, context, buildPrompt,
    repairTools: new Set([...allowed, 'read_tool_result']),
    ...(budget ? { budget } : {}),
    onStateChange: (state: unknown) => { lastRunState = state; },
    review: async (candidate: any, history: Message[], attempt: number) => {
      const decision = await reviewAnswer(gateway, candidate, history, attempt, `ticket_${DRY ? 'dry' : stamp}`, event, { timeoutMs: config.answerReviewTimeoutMs, partialPublish });
      // core 的 passed 择优分支只由新版 (C) 触发；对照组这里应恒为 0
      if ((decision as { passed?: boolean }).passed) passedSeen++;
      return decision;
    } });
  const promptText = buildPrompt(registry.getTools(), undefined, { role: 'user', content: input });
  promptChars = promptText.length;
  // 自证：OFF 臂的提示词里不该出现四步标题；结果回填进 manifest，避免"以为关了其实没关"
  manifest.promptHasRepeatSteps = promptText.includes('【重复、并发类问题的排查步骤】');
  manifest.promptHasImageSection = imageCount > 0 ? promptText !== buildPrompt(registry.getTools(), undefined, { role: 'user', content: '' }) : null;
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('规则层', manifest.flags.ruleLayer, '| 提示词含四步', manifest.promptHasRepeatSteps, '| 截图提示段', manifest.promptHasImageSection);
  if (DRY) {
    console.log('装配完成，未调用模型：工具', toolCount, '个 | 系统提示', promptChars, '字符 | 审计日志可用', typeof audit.push === 'function');
    console.log('DRY 通过（下一步去掉 DRY=1 即产生真实调用）');
  } else {
    answer = await core.run(input, event);
  }
} catch (e) { error = e instanceof Error ? e.message : String(e); }
finally {
  clearTimeout(timer);
  const messages = core?.getMessages() || [];
  fs.writeFileSync(path.join(out, 'messages.json'), JSON.stringify(messages, null, 2));
  fs.writeFileSync(path.join(out, 'answer.txt'), answer);
  fs.writeFileSync(path.join(out, 'audit.json'), JSON.stringify(audit, null, 2));
  await client.close();
  await server.stop();
  // 镜像结束态与起点比对：列出运行期间 HEAD 或工作区状态变了的仓库
  const mirrorEnd = mirrorSnapshot();
  const startByRepo = new Map(mirrorStart.map(r => [r.repo, r]));
  const endRepos = new Set(mirrorEnd.map(r => r.repo));
  const mirrorDrifted = [
    ...mirrorEnd.filter(r => { const s = startByRepo.get(r.repo); return !s || s.head !== r.head || s.dirty !== r.dirty; }).map(r => r.repo),
    ...mirrorStart.filter(r => !endRepos.has(r.repo)).map(r => r.repo),
  ];
  const mirror = { stateHash: manifest.mirror.stateHash as string, endStateHash: hash(JSON.stringify(mirrorEnd)), drifted: mirrorDrifted };
  manifest.mirror.end = { stateHash: mirror.endStateHash, drifted: mirrorDrifted };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('镜像', mirrorStart.length, '个仓库 | 起点状态哈希', mirror.stateHash.slice(0, 12), '| 运行期间变动', mirrorDrifted.length ? mirrorDrifted.join(', ') : '无');
  if (!DRY) {
    let inputTokens = 0, outputTokens = 0, reasoningTokens = 0, cachedTokens = 0;
    for (const e of audit) {
      const entry = ledgerEntryOf(e);
      inputTokens += entry.inputTokens; outputTokens += entry.outputTokens; reasoningTokens += entry.reasoningTokens; cachedTokens += entry.cachedTokens;
    }
    // 运行中没写进台账的记录（写盘失败）补写一次
    for (const entry of ledgerPending) { try { appendUsageLedger(entry as any); } catch { /* ignore */ } }
    let reviewStatus: string | null = null;
    try { const parsed = JSON.parse(answer); reviewStatus = parsed?.reviewStatus ?? null; } catch { /* plain text */ }
    // 复核侧开关的自证：【定向补查】若出现在消息里说明 OFF 臂没关掉复核那一半
    const allText = messages.filter((m: any) => typeof m.content === 'string').map((m: any) => m.content).join('\n');
    const digFollowups = allText.split('【定向补查】').length - 1;
    // 2026-10-17 新触发条件（通过稿写了"成因尚未定位"）单独计数：真正回给模型的提醒次数，与复核记录里的标记次数
    const causeUnknownFollowups = CAUSE_UNKNOWN_FOLLOWUP ? messages.filter((m: any) => m.isReminder && typeof m.content === 'string' && m.content.includes(CAUSE_UNKNOWN_FOLLOWUP)).length : 0;
    const causeUnknownMarked = messages.filter((m: any) => m.role === 'assistant' && m.internal && m.review?.followup === 'cause_unknown').length;
    const reviewRecords = messages.filter((m: any) => m.role === 'assistant' && m.internal && m.review).map((m: any) => m.review.status);
    const publishedRecord = [...messages].reverse().find((m: any) => m.role === 'assistant' && !m.internal);
    // 读过哪些文件（只有代码路径）：判定线里"是否读到写入循环/去重分支"按这份清单核对
    const argsOf = (c: any) => { let a = c.arguments ?? c.function?.arguments ?? {}; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } } return a; };
    const toolCallsMade = messages.flatMap((m: any) => (m.role === 'assistant' && Array.isArray(m.tool_calls) ? m.tool_calls : []));
    const filesRead = [...new Set(toolCallsMade.filter((c: any) => (c.name || c.function?.name) === 'read_file_lines').map((c: any) => String(argsOf(c).filePath || argsOf(c).file_path || '')).filter(Boolean))];
    const result = { label: LABEL, arm: ARM, seconds: Math.round((Date.now() - started) / 1000), modelCalls: calls, reviewCalls, toolCalls, digFollowups, causeUnknownFollowups, causeUnknownMarked, passedSeen, reviewRecords, publishedReviewStatus: publishedRecord?.review?.status ?? null, runState: lastRunState, filesRead, error, aborted, abortReason, reviewStatus, completed: Boolean(answer) && !error && !aborted,
      tokens: { input: inputTokens, output: outputTokens, reasoning: reasoningTokens, cached: cachedTokens }, tokenCap: RUN_TOKEN_CAP, ledgerRetried: ledgerPending.length, mirror,
      messageCount: messages.length, toolCallMessages: messages.filter((m: any) => m.role === 'tool').length, inputHash: manifest.inputHash };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
}
if (error) process.exitCode = 1;
