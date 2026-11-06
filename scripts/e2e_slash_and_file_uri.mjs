import fs from 'node:fs';
import path from 'node:path';
import { extractImagesFromInput } from '../dist/utils/image.js';
import { AVAILABLE_COMMANDS } from '../dist/tui/components/CommandPalette.js';

console.log('======================================================');
console.log('🧪 开始进行「file:/// 格式图片解析与快捷指令系统」回归测试');
console.log('======================================================\n');

// 1. Prepare sample image file
const testDir = path.resolve(process.cwd(), 'test_image_lark_artifacts');
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

const sampleLarkImg = path.join(testDir, 'img_v3_0214l_test.jpg');
const jpgDummy = Buffer.from('ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333430ffd9', 'hex');
fs.writeFileSync(sampleLarkImg, jpgDummy);

console.log('▶ [1/3] 测试飞书/浏览器粘贴的 file:/// 格式路径解析...');
const fileUriInput = `file:///${sampleLarkImg.replace(/\\/g, '/')} 为什么会出现如图中的增值税问题？`;
const uriResult = extractImagesFromInput(fileUriInput);

if (
  uriResult.hasImages === true &&
  uriResult.imagePaths.length === 1 &&
  uriResult.parts.length === 2 &&
  uriResult.parts[1].type === 'image_url' &&
  uriResult.parts[1].image_url.url.startsWith('data:image/jpeg;base64,')
) {
  console.log('   提取到的清理文本:', uriResult.cleanText);
  console.log('   解析出的本地文件路径:', uriResult.imagePaths[0]);
  console.log('   ✅ 成功将 file:/// 协议图片提取并转码为 Base64 Data URL！');
} else {
  throw new Error('file:/// 格式解析失败: ' + JSON.stringify(uriResult));
}

console.log('\n▶ [2/3] 测试双引号包含的文件路径与普通文本混合输入...');
const quotedInput = `"D:\\fake\\path\\not_exist.xlsx" file:///${sampleLarkImg.replace(/\\/g, '/')} 为什么导出报错？`;
const quotedResult = extractImagesFromInput(quotedInput);

if (
  quotedResult.hasImages === true &&
  quotedResult.imagePaths.length === 1 &&
  quotedResult.parts.length === 2
) {
  console.log('   提取到的文本:', quotedResult.cleanText);
  console.log('   ✅ 成功容错不存在的非图片路径，并准确提取真实图片文件！');
} else {
  throw new Error('混合输入解析失败: ' + JSON.stringify(quotedResult));
}

console.log('\n▶ [3/3] 验证预设 Slash 指令集合与描述格式...');
console.log('   支持的指令列表:');
for (const cmd of AVAILABLE_COMMANDS) {
  console.log(`   - ${cmd.command}: ${cmd.description} (${cmd.example})`);
}

if (AVAILABLE_COMMANDS.some((c) => c.command === '/clear') &&
    AVAILABLE_COMMANDS.some((c) => c.command === '/repo') &&
    AVAILABLE_COMMANDS.some((c) => c.command === '/model') &&
    AVAILABLE_COMMANDS.some((c) => c.command === '/help') &&
    AVAILABLE_COMMANDS.some((c) => c.command === '/exit')) {
  console.log('   ✅ 预设指令集合完整，支持 Tab 补全与帮助说明！');
} else {
  throw new Error('预设指令定义缺失！');
}

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });

console.log('\n======================================================');
console.log('🎉 file:/// 图片解析与指令系统测试全部顺利通过！');
console.log('======================================================');
