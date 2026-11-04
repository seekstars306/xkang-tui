import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageContentPart } from '../types/index.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/png';
}

function normalizeLocalPath(rawPath: string): string {
  let cleaned = rawPath.trim();
  
  // Handle file:/// or file:// URIs
  if (cleaned.startsWith('file:///') || cleaned.startsWith('file://')) {
    try {
      cleaned = fileURLToPath(cleaned);
    } catch {
      // Fallback manual strip
      cleaned = cleaned.replace(/^file:\/\/\/?/, '');
      if (/^[a-zA-Z]:/.test(cleaned)) {
        // Windows drive letter
      } else if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(cleaned)) {
        cleaned = cleaned.slice(1);
      }
    }
  }

  // Normalize slashes
  cleaned = path.normalize(cleaned);
  return cleaned;
}

export interface ExtractedImageResult {
  hasImages: boolean;
  cleanText: string;
  parts: MessageContentPart[];
  imagePaths: string[];
}

/**
 * Parses user input (including dragged/dropped file paths, file:// URLs, quotes in shell)
 * and turns valid local image files into base64 data URLs for multimodal vision.
 */
export function extractImagesFromInput(input: string): ExtractedImageResult {
  const imagePaths: string[] = [];
  const matchedSubstrings: string[] = [];

  // Match:
  // 1. file:///... or file://... URIs ending with image extensions
  // 2. Quoted paths: "..." or '...' ending with image extensions
  // 3. Unquoted Windows/Unix absolute paths ending with image extensions (supports spaces in path/file names)
  const IMAGE_EXTS_PATTERN = '(?:png|jpg|jpeg|webp|gif|bmp|svg|ico|heic|jfif|tif|tiff)';
  const pathRegex = new RegExp(
    `(?:` +
    `file:\\/\\/\\/[^\\r\\n\"']+\\.${IMAGE_EXTS_PATTERN}|file:\\/\\/[^\\r\\n\"']+\\.${IMAGE_EXTS_PATTERN}|` +
    `\\\"([^\\\"\\r\\n]+?\\.${IMAGE_EXTS_PATTERN})\\\"|'([^'\\r\\n]+?\\.${IMAGE_EXTS_PATTERN})'|` +
    `(?:[a-zA-Z]:[\\\\\\/]|\\/(?:Users|home|root|tmp|var|opt|usr|etc|AppData|wxfile|private)[\\\\\\/])(?:[^\\r\\n\"'\\t]| (?! [a-zA-Z]:[\\\\\\/]|\\/[a-zA-Z]))+?\\.${IMAGE_EXTS_PATTERN}` +
    `)`,
    'gi'
  );

  const matches = Array.from(input.matchAll(pathRegex));

  for (const match of matches) {
    const rawMatch = match[0];
    const rawPath = match[1] || match[2] || rawMatch;
    if (!rawPath) continue;

    let cleanPath = rawPath.replace(/^[\"']|[\"']$/g, '');
    try {
      if (cleanPath.startsWith('file://')) {
        cleanPath = decodeURIComponent(cleanPath);
      }
    } catch {}

    const normalized = normalizeLocalPath(cleanPath);
    if (fs.existsSync(normalized)) {
      try {
        const stat = fs.statSync(normalized);
        if (stat.isFile()) {
          imagePaths.push(normalized);
          matchedSubstrings.push(rawMatch);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  if (imagePaths.length === 0) {
    return {
      hasImages: false,
      cleanText: input,
      parts: [{ type: 'text', text: input }],
      imagePaths: [],
    };
  }

  let cleanText = input;
  for (const sub of matchedSubstrings) {
    cleanText = cleanText.replace(sub, '').trim();
  }

  const parts: MessageContentPart[] = [];
  const textPrompt = cleanText || '请仔细阅读并分析这张图片中的文字、报错信息、页面提示或业务数据：';
  parts.push({ type: 'text', text: textPrompt });

  for (const imgPath of imagePaths) {
    try {
      const buffer = fs.readFileSync(imgPath);
      const mime = getMimeType(imgPath);
      const base64 = buffer.toString('base64');
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${mime};base64,${base64}`,
          detail: 'high',
        },
      });
    } catch {
      // Ignore conversion errors
    }
  }

  return {
    hasImages: true,
    cleanText: textPrompt,
    parts,
    imagePaths,
  };
}
