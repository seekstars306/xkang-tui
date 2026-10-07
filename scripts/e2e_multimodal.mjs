import fs from 'node:fs';
import path from 'node:path';
import { extractImagesFromInput } from '../dist/utils/image.js';
import { AgentHarness } from '../dist/harness/agent.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { LOCAL_TOOLS } from '../dist/tools/index.js';

console.log('======================================================');
console.log('🧪 开始进行「多模态图片输入与 Base64 视觉解析」端到端测试');
console.log('======================================================\n');

// 1. Prepare dummy image files for testing
const testDir = path.resolve(process.cwd(), 'test_multimodal_artifacts');
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

const samplePngPath = path.join(testDir, 'error_screenshot.png');
const sampleJpgPath = path.join(testDir, 'invoice_receipt.jpg');

// Minimal 1x1 PNG and JPG buffer
const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const jpgDummy = Buffer.from('ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333430ffd9', 'hex');

fs.writeFileSync(samplePngPath, png1x1);
fs.writeFileSync(sampleJpgPath, jpgDummy);

console.log('▶ [1/4] 测试纯文本输入的 extractImagesFromInput 解析...');
const textOnlyResult = extractImagesFromInput('请问订单 ERR_TIMEOUT 是什么原因？');
if (textOnlyResult.hasImages === false && textOnlyResult.parts.length === 1 && textOnlyResult.parts[0].type === 'text') {
  console.log('   ✅ 纯文本输入正确保持单一 text part，未触发多模态转换！');
} else {
  throw new Error('纯文本输入解析异常: ' + JSON.stringify(textOnlyResult));
}

console.log('\n▶ [2/4] 测试拖拽/输入图片绝对路径时的多模态解析...');
const mixedInput = `请排查一下这张报错截图 "${samplePngPath}" 里的异常信息`;
const imgResult = extractImagesFromInput(mixedInput);

if (
  imgResult.hasImages === true &&
  imgResult.imagePaths.length === 1 &&
  imgResult.parts.length === 2 &&
  imgResult.parts[0].type === 'text' &&
  imgResult.parts[1].type === 'image_url' &&
  imgResult.parts[1].image_url.url.startsWith('data:image/png;base64,')
) {
  console.log('   提取到的清理文本:', imgResult.cleanText);
  console.log('   多模态 Parts 数量:', imgResult.parts.length);
  console.log('   图片 Base64 前缀:', imgResult.parts[1].image_url.url.slice(0, 35) + '...');
  console.log('   ✅ 单图片路径成功提取并转码为 high-detail Base64 Data URL！');
} else {
  throw new Error('单图片解析异常: ' + JSON.stringify(imgResult));
}

console.log('\n▶ [3/4] 测试多图混排输入解析...');
const multiInput = `同时比对这两个凭证: ${samplePngPath} 和 ${sampleJpgPath}`;
const multiResult = extractImagesFromInput(multiInput);

if (
  multiResult.hasImages === true &&
  multiResult.imagePaths.length === 2 &&
  multiResult.parts.length === 3 &&
  multiResult.parts[1].image_url.url.startsWith('data:image/png;base64,') &&
  multiResult.parts[2].image_url.url.startsWith('data:image/jpeg;base64,')
) {
  console.log('   提取到的图片路径数量:', multiResult.imagePaths.length);
  console.log('   ✅ 多图混排正确识别不同 MIME 类型并按序构造 parts 数组！');
} else {
  throw new Error('多图片解析异常: ' + JSON.stringify(multiResult));
}

console.log('\n▶ [4/4] 验证 AgentHarness 对多模态输入的接收与上下文维护...');
let capturedEvents = [];
const mockGateway = {
  getCurrentModel: () => 'xkang-managed',
  switchModel: () => {},
  streamChat: async (messages, tools, onEvent) => {
    // Check that the last message has multimodal parts
    const lastMsg = messages[messages.length - 1];
    if (Array.isArray(lastMsg.content) && lastMsg.content.some((p) => p.type === 'image_url')) {
      onEvent({ type: 'content_chunk', chunk: '【视觉模型排障分析】已识别图片中的报错信息为网络超时。' });
      const doneMsg = {
        role: 'assistant',
        content: '【视觉模型排障分析】已识别图片中的报错信息为网络超时。',
      };
      onEvent({ type: 'done', finalMessage: doneMsg });
      return doneMsg;
    }
    throw new Error('未能正确接收到多模态 content parts 结构！');
  },
};

const registry = new ToolRegistry(LOCAL_TOOLS);
const harness = new AgentHarness({
  gateway: mockGateway,
  registry,
  context: { repoPath: process.cwd() },
});

const reply = await harness.run(mixedInput, (e) => capturedEvents.push(e.type));
console.log('   Harness 最终解答:', reply);
console.log('   Harness 触发事件:', capturedEvents);

if (reply.includes('视觉模型排障分析')) {
  console.log('   ✅ AgentHarness 成功驱动多模态消息传递与模型调用！');
} else {
  throw new Error('Harness 响应异常: ' + reply);
}

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });

console.log('\n======================================================');
console.log('🎉 多模态图像输入与解析端到端测试全部顺利通过！');
console.log('======================================================');
