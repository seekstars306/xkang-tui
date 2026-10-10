import { AgentCore, type AgentOptions as CoreOptions } from '@xkang/agent-core';
import { buildSystemPrompt } from './system_prompt.js';
import { extractImagesFromInput } from '../utils/image.js';
import { sanitizeUserParts, sanitizeUserText } from '../utils/sanitize_input.js';
export type AgentOptions = Omit<CoreOptions, 'buildPrompt' | 'prepareInput'>;
/** Client host: local tools only. Company investigations use the remote business API. */
export class AgentHarness extends AgentCore {
  constructor(options: AgentOptions) {
    super({ ...options,
      buildPrompt: (tools, skills, input) => buildSystemPrompt(tools, skills, 'l1', { hasImages: Array.isArray(input?.content) && input.content.some(p => p.type === 'image_url') }),
      prepareInput: input => {
        if (typeof input !== 'string') return { role: 'user', content: sanitizeUserParts(input).parts };
        const { text } = sanitizeUserText(input);
        const images = extractImagesFromInput(text);
        return { role: 'user', content: images.hasImages ? images.parts : text };
      },
    });
  }
}
