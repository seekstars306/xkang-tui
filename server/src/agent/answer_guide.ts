/**
 * 答案写法开关 ANSWER_GUIDE（v2 / off，缺省 off）。
 *
 * 2026-10-30 两件事促成：
 *  - 桌面版同模型对照里只评结论：xkang 成因正确度最高，但易懂度低于 zcode，主要是"句子过长、没说怎么办"；
 *  - 线上 c4a2f188（"票为什么不在客人订票人账单里"）：代码的筛选条件和本单数据都已查到，结论却写成
 *    "……尚未定位"，问题里给的手机号没有查，四条"还需确认"里有两条用工具就能查清。
 * 原因在提示词：BUSINESS_PROMPT 只要求"结论只概括一两句"，没有要求先回答问题、说明怎么办，
 * 也没有说明"尚未定位"的适用范围，模型把成因纪律套到了与问题无关的细节上。
 *
 * 开启时（v2）：去掉"结论只概括一两句"这一句（不在冻结清单内），追加下面的通用写法规则；
 * BUSINESS_PROMPT 其余文字（含冻结锚点）一字不改。关闭时与引入前逐字节一致。
 */
export const ANSWER_GUIDE = `【答案写法】读答案的是不懂代码、不懂数据库的一线客服，他要把结论转述给客人或同事。
1. conclusion 第一句直接回答客服问的那个问题（是不是、能不能、为什么、要不要做），用客服听得懂的话；接着用一两句说清原因；最后一句说明现在的状态或客服接下来怎么做。问题里有几件事就分条写成"1. ……2. ……"，每句尽量不超过 40 字。
2. 结论里不写状态码、英文代号、库表字段名和内部编号；时间、单号、金额等细节放进 businessData，结论只保留理解所必需的部分。
3. 问题里给出的人名、手机号、单号、账号，都要查到对应的记录，并在答案里说明它们各自对应什么；同名或同号对应多条记录时要逐一区分，说明哪一条与问题有关。
4. 代码里的处理条件和本单的数据都已查实时，这就是成因，直接写进结论；"成因尚未定位"只用于问题本身的原因确实没有查到的情况，不要用与问题无关的细节（例如具体是哪一次执行）去否定已经查实的原因。
5. pendingItems 只放用工具查不到、或必须由人确认和决定的事项，每条写明找谁、确认什么；能用工具查清的先查完再作答，不要把排查工作留给客服。`;

const REPLACED_SENTENCE = '结论只概括一两句，具体数据放在 businessData，客服话术不要再次重复整个资料清单。';
const REPLACEMENT = '具体数据放在 businessData，客服话术不要再次重复整个资料清单。';

export type AnswerGuide = 'off' | 'v2';

/** 运行期读取；写错按 off（与 review_mode 一致，启动校验在 config） */
export function answerGuide(env: NodeJS.ProcessEnv = process.env): AnswerGuide {
  const v = (env.ANSWER_GUIDE || '').trim().toLowerCase();
  return v === 'v2' ? 'v2' : 'off';
}

export function validateAnswerGuide(env: NodeJS.ProcessEnv = process.env): AnswerGuide {
  const v = (env.ANSWER_GUIDE || '').trim().toLowerCase();
  if (v && v !== 'v2' && v !== 'off') throw new Error('ANSWER_GUIDE 只能是 v2 或 off，当前值：' + env.ANSWER_GUIDE);
  return v === 'v2' ? 'v2' : 'off';
}

/** 按开关得到业务提示词：off 原样返回；v2 去掉一句并追加写法规则 */
export function businessPrompt(base: string, guide: AnswerGuide): string {
  if (guide === 'off') return base;
  if (!base.includes(REPLACED_SENTENCE)) throw new Error('BUSINESS_PROMPT 中找不到要替换的句子，答案写法规则需要同步更新');
  return base.replace(REPLACED_SENTENCE, REPLACEMENT) + '\n' + ANSWER_GUIDE;
}
