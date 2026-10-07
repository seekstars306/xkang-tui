import path from 'node:path';
import chalk from 'chalk';

export interface FormattedSegment {
  type: 'text' | 'image_badge' | 'file_badge' | 'table_badge' | 'archive_badge' | 'media_badge';
  content: string;
  badgeLabel?: string;
  originalPath?: string;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.ico', '.heic', '.jfif', '.tif', '.tiff']);
const TABLE_EXTS = new Set(['.xlsx', '.xls', '.csv', '.tsv', '.parquet']);
const ARCHIVE_EXTS = new Set(['.zip', '.tar', '.gz', '.7z', '.rar', '.tgz']);
const MEDIA_EXTS = new Set(['.mp4', '.avi', '.mov', '.mp3', '.wav', '.flac']);

const ALL_MATCHED_EXTS_REGEX = '(?:png|jpg|jpeg|webp|gif|bmp|svg|ico|heic|jfif|tif|tiff|xlsx|xls|csv|tsv|parquet|zip|tar|gz|7z|rar|tgz|mp4|avi|mov|mp3|wav|flac|pdf|docx|txt|json|xml|java|ts|js|py|log|md|sql|yml|yaml)';

/**
 * Universal Regex matching any file path or file URI:
 * 1. file:///... or file://...
 * 2. Quoted paths: "..." or '...'
 * 3. Windows drive absolute paths: C:\... or D:/... (supports spaces in path/file names up to extension)
 * 4. Unix absolute paths: /Users/... or /home/...
 */
export const UNIVERSAL_PATH_REGEX = new RegExp(
  `(?:` +
  `file:\\/\\/\\/[^\\r\\n\"']+|file:\\/\\/[^\\r\\n\"']+|` +
  `\\\"([^\\\"\\r\\n]+?\\.${ALL_MATCHED_EXTS_REGEX})\\\"|'([^'\\r\\n]+?\\.${ALL_MATCHED_EXTS_REGEX})'|` +
  `(?:[a-zA-Z]:[\\\\\\/]|\\/(?:Users|home|root|tmp|var|opt|usr|etc|AppData|wxfile|private)[\\\\\\/])(?:[^\\r\\n\"'\\t]| (?! [a-zA-Z]:[\\\\\\/]|\\/[a-zA-Z]))+?\\.${ALL_MATCHED_EXTS_REGEX}` +
  `)`,
  'gi'
);

/**
 * Badge matching regex in input text
 */
export const BADGE_REGEX = /(?:🖼️|📄|📊|📦|🎬)\s*\[(?:图片|文件|表格|压缩包|媒体):\s*[^\]]+\]/g;

/**
 * Global attachment mapping registry (badgeLabel -> original full path)
 */
export const globalAttachmentRegistry = new Map<string, string>();

function getShortFileName(fileName: string, maxLen = 26): string {
  if (!fileName) return '未知文件';
  if (fileName.length <= maxLen) return fileName;
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const leftLen = Math.floor((maxLen - ext.length - 3) * 0.6);
  const rightLen = Math.max(2, (maxLen - ext.length - 3) - leftLen);
  return `${base.slice(0, leftLen)}...${base.slice(-rightLen)}${ext}`;
}

/**
 * Transforms raw input text containing file paths into clean badge representations
 * and registers them into the attachment registry.
 */
export function transformInputWithBadges(
  rawInput: string,
  registry = globalAttachmentRegistry
): { transformedText: string; addedBadges: string[] } {
  if (!rawInput) return { transformedText: '', addedBadges: [] };

  const addedBadges: string[] = [];
  const transformedText = rawInput.replace(UNIVERSAL_PATH_REGEX, (matchStr) => {
    let cleanPath = matchStr.replace(/^[\"']|[\"']$/g, '').replace(/^file:\/\/(\/)?/, '');
    try {
      cleanPath = decodeURIComponent(cleanPath);
    } catch {}

    const ext = path.extname(cleanPath).toLowerCase();
    const rawFileName = path.basename(cleanPath) || cleanPath;
    const shortFileName = getShortFileName(rawFileName);

    let prefix = '📄 [文件:';
    if (IMAGE_EXTS.has(ext)) {
      prefix = '🖼️ [图片:';
    } else if (TABLE_EXTS.has(ext)) {
      prefix = '📊 [表格:';
    } else if (ARCHIVE_EXTS.has(ext)) {
      prefix = '📦 [压缩包:';
    } else if (MEDIA_EXTS.has(ext)) {
      prefix = '🎬 [媒体:';
    }

    let badge = `${prefix} ${shortFileName}]`;
    // Prevent collision if two different files share the same badge label
    let collisionIdx = 2;
    while (registry.has(badge) && registry.get(badge) !== matchStr.trim()) {
      badge = `${prefix} ${shortFileName} (${collisionIdx})]`;
      collisionIdx++;
    }

    registry.set(badge, matchStr.trim());
    addedBadges.push(badge);
    return badge;
  });

  return { transformedText, addedBadges };
}

/**
 * Restores any badges inside the text back to their full paths for submission
 */
export function restoreBadgesToFullPaths(
  text: string,
  registry = globalAttachmentRegistry
): string {
  if (!text) return text;
  return text.replace(BADGE_REGEX, (badge) => {
    return registry.get(badge) || badge;
  });
}

export interface BadgeMatch {
  badge: string;
  start: number;
  end: number;
  type: 'image' | 'file' | 'table' | 'archive' | 'media';
}

/**
 * Finds all badges in a string with their exact offsets and types
 */
export function findBadgesInText(text: string): BadgeMatch[] {
  const badges: BadgeMatch[] = [];
  for (const match of text.matchAll(BADGE_REGEX)) {
    const badge = match[0];
    const start = match.index ?? 0;
    const end = start + badge.length;
    let type: BadgeMatch['type'] = 'file';
    if (badge.startsWith('🖼️')) type = 'image';
    else if (badge.startsWith('📊')) type = 'table';
    else if (badge.startsWith('📦')) type = 'archive';
    else if (badge.startsWith('🎬')) type = 'media';
    badges.push({ badge, start, end, type });
  }
  return badges;
}

/**
 * Handles backspace deletion with atomic badge removal (一删整个标识)
 */
export function handleBadgeBackspace(
  value: string,
  cursorOffset: number,
  registry = globalAttachmentRegistry
): { nextValue: string; nextCursorOffset: number; deletedBadge?: string } {
  const badges = findBadgesInText(value);
  const targetBadge = badges.find((b) => cursorOffset > b.start && cursorOffset <= b.end);

  if (targetBadge) {
    const nextValue = value.slice(0, targetBadge.start) + value.slice(targetBadge.end);
    registry.delete(targetBadge.badge);
    return {
      nextValue,
      nextCursorOffset: targetBadge.start,
      deletedBadge: targetBadge.badge,
    };
  }

  if (cursorOffset > 0) {
    const prevCode = value.charCodeAt(cursorOffset - 1);
    const isLowSurrogate = prevCode >= 0xdc00 && prevCode <= 0xdfff;
    const deleteLen = isLowSurrogate && cursorOffset >= 2 ? 2 : 1;
    const nextValue = value.slice(0, cursorOffset - deleteLen) + value.slice(cursorOffset);
    return {
      nextValue,
      nextCursorOffset: Math.max(0, cursorOffset - deleteLen),
    };
  }

  return { nextValue: value, nextCursorOffset: 0 };
}

/**
 * Handles delete key with atomic badge removal
 */
export function handleBadgeDelete(
  value: string,
  cursorOffset: number,
  registry = globalAttachmentRegistry
): { nextValue: string; nextCursorOffset: number; deletedBadge?: string } {
  const badges = findBadgesInText(value);
  const targetBadge = badges.find((b) => cursorOffset >= b.start && cursorOffset < b.end);

  if (targetBadge) {
    const nextValue = value.slice(0, targetBadge.start) + value.slice(targetBadge.end);
    registry.delete(targetBadge.badge);
    return {
      nextValue,
      nextCursorOffset: targetBadge.start,
      deletedBadge: targetBadge.badge,
    };
  }

  if (cursorOffset < value.length) {
    const charCode = value.charCodeAt(cursorOffset);
    const isHighSurrogate = charCode >= 0xd800 && charCode <= 0xdbff;
    const deleteLen = isHighSurrogate && cursorOffset + 1 < value.length ? 2 : 1;
    const nextValue = value.slice(0, cursorOffset) + value.slice(cursorOffset + deleteLen);
    return {
      nextValue,
      nextCursorOffset: cursorOffset,
    };
  }

  return { nextValue: value, nextCursorOffset: cursorOffset };
}

export function handleBadgeLeftArrow(value: string, cursorOffset: number): number {
  const badges = findBadgesInText(value);
  const target = badges.find((b) => cursorOffset > b.start && cursorOffset <= b.end);
  if (target) {
    return target.start;
  }
  return Math.max(0, cursorOffset - 1);
}

export function handleBadgeRightArrow(value: string, cursorOffset: number): number {
  const badges = findBadgesInText(value);
  const target = badges.find((b) => cursorOffset >= b.start && cursorOffset < b.end);
  if (target) {
    return target.end;
  }
  return Math.min(value.length, cursorOffset + 1);
}

/**
 * Renders the input text with rich syntax-highlighted badges and inline inverse cursor
 */
export function renderHighlightedInput(
  value: string,
  cursorOffset: number,
  placeholder = '',
  showCursor = true
): string {
  if (!value) {
    if (!showCursor) return chalk.grey(placeholder);
    return placeholder.length > 0
      ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
      : chalk.inverse(' ');
  }

  const badges = findBadgesInText(value);
  let rendered = '';

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const isCursor = showCursor && i === cursorOffset;
    const badge = badges.find((b) => i >= b.start && i < b.end);

    if (isCursor) {
      rendered += chalk.inverse(char);
    } else if (badge) {
      if (badge.type === 'image') rendered += chalk.cyanBright.bold(char);
      else if (badge.type === 'table') rendered += chalk.greenBright.bold(char);
      else rendered += chalk.yellowBright.bold(char);
    } else {
      rendered += char;
    }
  }

  if (showCursor && cursorOffset >= value.length) {
    rendered += chalk.inverse(' ');
  }

  return rendered;
}

/**
 * Parses user message text and turns verbose file paths into clean, stylish badges for ChatHistory
 */
export function formatUserDisplayText(rawInput: string): FormattedSegment[] {
  if (!rawInput) return [];

  const segments: FormattedSegment[] = [];
  let lastIndex = 0;

  for (const match of rawInput.matchAll(UNIVERSAL_PATH_REGEX)) {
    const matchStr = match[0];
    const matchIndex = match.index ?? 0;

    // Push text before the matched path
    if (matchIndex > lastIndex) {
      const textBefore = rawInput.slice(lastIndex, matchIndex);
      if (textBefore) {
        segments.push({ type: 'text', content: textBefore });
      }
    }

    let cleanPath = matchStr.replace(/^["']|["']$/g, '').replace(/^file:\/\/\/?/, '');
    try {
      cleanPath = decodeURIComponent(cleanPath);
    } catch {}

    const ext = path.extname(cleanPath).toLowerCase();
    const rawFileName = path.basename(cleanPath) || cleanPath;
    const shortFileName = getShortFileName(rawFileName);

    if (IMAGE_EXTS.has(ext)) {
      segments.push({
        type: 'image_badge',
        content: cleanPath,
        badgeLabel: `🖼️ [图片: ${shortFileName}]`,
        originalPath: cleanPath,
      });
    } else if (TABLE_EXTS.has(ext)) {
      segments.push({
        type: 'table_badge',
        content: cleanPath,
        badgeLabel: `📊 [表格: ${shortFileName}]`,
        originalPath: cleanPath,
      });
    } else if (ARCHIVE_EXTS.has(ext)) {
      segments.push({
        type: 'archive_badge',
        content: cleanPath,
        badgeLabel: `📦 [压缩包: ${shortFileName}]`,
        originalPath: cleanPath,
      });
    } else if (MEDIA_EXTS.has(ext)) {
      segments.push({
        type: 'media_badge',
        content: cleanPath,
        badgeLabel: `🎬 [媒体: ${shortFileName}]`,
        originalPath: cleanPath,
      });
    } else {
      segments.push({
        type: 'file_badge',
        content: cleanPath,
        badgeLabel: `📄 [文件: ${shortFileName}]`,
        originalPath: cleanPath,
      });
    }

    lastIndex = matchIndex + matchStr.length;
  }

  // Push remaining text
  if (lastIndex < rawInput.length) {
    const textAfter = rawInput.slice(lastIndex);
    if (textAfter) {
      segments.push({ type: 'text', content: textAfter });
    }
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', content: rawInput });
  }

  return segments;
}

/**
 * Replaces long paths inside the input text with concise badges for clean live typing preview
 */
export function formatInputDisplayPreview(rawInput: string): string {
  if (!rawInput) return '';
  const segments = formatUserDisplayText(rawInput);
  return segments.map((s) => s.badgeLabel || s.content).join('');
}

