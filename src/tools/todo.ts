import { HarnessContext, ToolDefinition } from '../types/index.js';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

// 按会话隔离的待办状态（以前是模块级全局变量，网页端多个会话会互相覆盖）
const todosByContext = new WeakMap<object, TodoItem[]>();
const DEFAULT_CONTEXT_KEY = {};

function keyOf(context?: HarnessContext): object {
  return context || DEFAULT_CONTEXT_KEY;
}

export function getCurrentTodos(context?: HarnessContext): TodoItem[] {
  return [...(todosByContext.get(keyOf(context)) || [])];
}

export function resetTodos(context?: HarnessContext): void {
  todosByContext.delete(keyOf(context));
}

export const todoWriteTool: ToolDefinition = {
  name: 'todo_write',
  description: '排障任务看板：只在需要 3 个以上相互独立的排查步骤时使用，记录步骤与进度。每次传入完整的最新任务列表；只有拿到该步骤所需证据后才能标记 completed，失败或超时的步骤不要标记完成。',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '完整的更新后待办事项列表。每一项包含 content（步骤简述）、status（pending | in_progress | completed）和可选的 priority（high | medium | low）',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: '排障任务或步骤描述',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: '当前状态：pending(待办), in_progress(进行中), completed(已完成)',
            },
            priority: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: '优先级：high(高), medium(中), low(低)',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  execute: async (args: Record<string, unknown>, context: HarnessContext) => {
    const rawTodos = args.todos;
    if (!Array.isArray(rawTodos)) {
      return '错误: todos 参数必须为列表数组。';
    }

    const newTodos: TodoItem[] = rawTodos.map((item: any) => ({
      content: String(item.content || '').trim(),
      status: ['pending', 'in_progress', 'completed'].includes(item.status)
        ? item.status
        : 'pending',
      priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
    }));

    todosByContext.set(keyOf(context), newTodos);

    const completed = newTodos.filter((t) => t.status === 'completed').length;
    const inProgress = newTodos.filter((t) => t.status === 'in_progress').length;
    const pending = newTodos.filter((t) => t.status === 'pending').length;

    const lines = [
      '【排障任务进度看板已更新】',
      ...newTodos.map((t, idx) => {
        let tag = '[ ] 待办';
        if (t.status === 'completed') tag = '[x] 已完成';
        if (t.status === 'in_progress') tag = '[-] 进行中';
        const priorityTag = t.priority === 'high' ? ' (高优)' : '';
        return `${idx + 1}. ${tag} ${t.content}${priorityTag}`;
      }),
      `统计: 共 ${newTodos.length} 项步骤 (已完成: ${completed}, 进行中: ${inProgress}, 待办: ${pending})`,
    ];

    return lines.join('\n');
  },
};
