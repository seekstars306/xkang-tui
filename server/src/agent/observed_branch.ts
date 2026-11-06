/**
 * 复核口径开关「材料原文可确认分支」：默认关闭，只用于对照实验（2026-10-29 a12c3554），是否上线要看对照数据。
 *
 * 要对照的误判：REVIEW_PROMPT 里"代码机制不能证明本次事件发生""用户截图只证明截图显示的内容"被字面套用时，
 * "材料原文只可能由某一个分支输出 → 该分支当时被执行"这种直接证据也被当成"用代码机制推断事件"打回；
 * REVISION_DISCIPLINE 第 2 条又要求缺直接证据的成因只能写成"成因尚未定位"，第一稿已经说清的成因就被改成空结论。
 *
 * 为什么必须是"运行时追加"而不是改原文：REVIEW_PROMPT 的成因规则与 REVISION_DISCIPLINE 都登记在
 * tests/eval/frozen-rules.json（review.prompt.cause_assertion / review.revision_discipline），
 * tests/server/rule_freeze.test.ts 按逐字 anchor 守门。开关只拦"追加"这一步，关闭时发给复核模型的 system
 * 与修订反馈都和改动前逐字节一致（tests/server/review_observed_branch.test.ts 用改动前生成的 golden 守门）。
 *
 * 语义：只认一个 env `REVIEW_OBSERVED_BRANCH`，`on` / `1` / `true`（大小写不敏感、去空格）为开启，其余（含未设置）一律关闭。
 * 开启时同时作用于两处：复核两个阶段（challenge 与 citations）的 system 末尾追加 OBSERVED_BRANCH_RULE，
 * 修订反馈在【修订纪律】第 4 条之后追加第 5 条 OBSERVED_BRANCH_REVISION。
 * 一个开关管两处是刻意的：只放宽复核而纪律仍要求写成"成因尚未定位"，模型照样会把成因删掉，对照就没意义了。
 */
export function observedBranchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.REVIEW_OBSERVED_BRANCH ?? '').trim().toLowerCase();
  return value === 'on' || value === '1' || value === 'true';
}

/** 开启时追加在复核两个阶段 system 末尾的口径。只认"材料原文 → 唯一输出它的分支"这一种直接证据，其余成因限制不变。 */
export const OBSERVED_BRANCH_RULE = '【材料原文可确认分支】截图文字、报错原文、导出内容等材料里出现的文案或数值，若代码中只有一个分支会输出它（同一处判断的其他分支输出不同内容），这一对应关系就是该分支当时被执行的直接证据，不属于“用代码机制推断本次事件”。核验时逐环检查：材料原文（引用其证据）→ 代码中输出该原文的那一行及其判断条件 → 该分支的处理逻辑 → 与材料中观察到的现象一致；每一环都有引文支持时可判 supported。若只缺某个前提（如操作的精确时刻），指出该前提，并要求写成带前提的说明、把前提列入待确认事项，而不是否定整个解释。依据时间间隔、记录条数、经办人或创建人字段推断成因的限制不变。';

/** 开启时接在【修订纪律】第 4 条之后的第 5 条：第 2 条"只能写成成因尚未定位"的例外，与 OBSERVED_BRANCH_RULE 配对。 */
export const OBSERVED_BRANCH_REVISION = '5. 例外：材料原文（截图文字、报错原文等）只可能由某一个代码分支输出时，该分支已有直接证据；由该分支逻辑推出的成因可以保留，但要逐环引用（材料原文、输出它的代码行、分支逻辑、相关数据）；只缺某个前提时，写成带前提的说明并把前提放进待确认事项，不要整句改成“成因尚未定位”。';
