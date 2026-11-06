import { HarnessContext, ToolDefinition } from '../types/index.js';

export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  question: string;
  header: string;
  options?: UserQuestionOption[];
  multiSelect?: boolean;
}

export const askUserQuestionTool: ToolDefinition = {
  name: 'ask_user_question',
  description: '向客服发起交互式澄清提问：当缺少关键排障信息（如环境、特定商户/租户类型、具体订单状态分支）或有多个可能方向需要客服确认时使用。',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: '需要向客服提出的结构化问题列表 (1-3 个)',
        items: {
          type: 'object',
          properties: {
            header: {
              type: 'string',
              description: '问题分类标签/芯片（例如 "业务类型", "报错环境", "订单状态"）',
            },
            question: {
              type: 'string',
              description: '具体的完整疑问句（如 "请问该订单的支付渠道是微信支付还是支付宝？"）',
            },
            options: {
              type: 'array',
              description: '可选的供客服快速选择的选项列表',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: '选项标签文本' },
                  description: { type: 'string', description: '该选项对应的业务含义说明' },
                },
                required: ['label'],
              },
            },
            multiSelect: {
              type: 'boolean',
              description: '是否允许多选（默认为 false）',
            },
          },
          required: ['header', 'question'],
        },
      },
    },
    required: ['questions'],
  },
  execute: async (args: Record<string, unknown>, _context: HarnessContext) => {
    const rawQuestions = args.questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return '错误: questions 参数必须为非空列表。';
    }

    const outputLines = ['【已向客服发起澄清提问】'];

    rawQuestions.forEach((q: any, idx: number) => {
      const header = String(q.header || '问题').trim();
      const question = String(q.question || '').trim();
      outputLines.push(`\n${idx + 1}. [${header}] ${question}`);

      if (Array.isArray(q.options) && q.options.length > 0) {
        outputLines.push('   候选选项:');
        q.options.forEach((opt: any, optIdx: number) => {
          const label = String(opt.label || '').trim();
          const desc = opt.description ? ` (${opt.description})` : '';
          outputLines.push(`   - [选项 ${optIdx + 1}] ${label}${desc}`);
        });
      }
    });

    outputLines.push('\n提示: 问题已呈现在排障会话中，请在当前思考结论中告知客服并等待其输入回复。');
    return outputLines.join('\n');
  },
};
