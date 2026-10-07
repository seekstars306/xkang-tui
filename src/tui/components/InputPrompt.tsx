import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { CommandPalette, AVAILABLE_COMMANDS } from './CommandPalette.js';
import {
  transformInputWithBadges,
  restoreBadgesToFullPaths,
  handleBadgeBackspace,
  handleBadgeDelete,
  handleBadgeLeftArrow,
  handleBadgeRightArrow,
  renderHighlightedInput,
} from '../../utils/format_user_content.js';

interface InputPromptProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
}

export const InputPrompt: React.FC<InputPromptProps> = ({
  value,
  onChange,
  onSubmit,
  disabled = false,
}) => {
  const [cursorOffset, setCursorOffset] = useState<number>(value.length);

  // Sync cursor when value is externally reset (e.g. on submit)
  useEffect(() => {
    if (cursorOffset > value.length) {
      setCursorOffset(value.length);
    }
  }, [value, cursorOffset]);

  // Slash commands mode detection
  const knownPrefixes = ['/clear', '/key', '/update', '/version', '/model', '/help', '/exit', '/quit'];
  const firstWord = (value.split(/\s+/)[0] || '').toLowerCase();
  const isCommandMode = value.startsWith('/') && (value.length <= 1 || knownPrefixes.some((p) => p.startsWith(firstWord)));

  useInput((input, key) => {
    if (disabled) return;

    // 1. Slash command tab completion
    if (key.tab && isCommandMode) {
      const match = AVAILABLE_COMMANDS.find((c) =>
        c.command.toLowerCase().startsWith(value.toLowerCase())
      );
      if (match) {
        const nextVal = match.command + ' ';
        onChange(nextVal);
        setCursorOffset(nextVal.length);
      }
      return;
    }

    // 2. Submit on Enter
    if (key.return) {
      if (!value.trim()) return;

      if (isCommandMode) {
        onSubmit(value);
      } else {
        const fullSubmittedText = restoreBadgesToFullPaths(value);
        onSubmit(fullSubmittedText);
      }
      setCursorOffset(0);
      return;
    }

    // 3. Arrow navigation
    if (key.leftArrow) {
      const nextOffset = handleBadgeLeftArrow(value, cursorOffset);
      setCursorOffset(nextOffset);
      return;
    }

    if (key.rightArrow) {
      const nextOffset = handleBadgeRightArrow(value, cursorOffset);
      setCursorOffset(nextOffset);
      return;
    }

    // 4. Backspace (atomic badge deletion)
    if (key.backspace) {
      const { nextValue, nextCursorOffset } = handleBadgeBackspace(value, cursorOffset);
      onChange(nextValue);
      setCursorOffset(nextCursorOffset);
      return;
    }

    // 5. Delete (forward atomic badge deletion)
    if (key.delete) {
      const { nextValue, nextCursorOffset } = handleBadgeDelete(value, cursorOffset);
      onChange(nextValue);
      setCursorOffset(nextCursorOffset);
      return;
    }

    // Ignore up/down arrows and ctrl keys (except paste)
    if (key.upArrow || key.downArrow || (key.ctrl && input === 'c')) {
      return;
    }

    // 6. Typing or Pasting content (automatically converts pasted file paths to badges)
    if (input) {
      const { transformedText } = transformInputWithBadges(input);
      const nextValue =
        value.slice(0, cursorOffset) +
        transformedText +
        value.slice(cursorOffset);
      const nextCursorOffset = cursorOffset + transformedText.length;

      onChange(nextValue);
      setCursorOffset(nextCursorOffset);
    }
  }, { isActive: !disabled });

  const placeholder = disabled
    ? '助手正在深入分析代码与业务规则中，请稍候...'
    : '输入排障问题、粘贴报错/图片路径，或键入 / 调出快捷指令';

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* 1. Slash Command Palette */}
      {isCommandMode && !disabled && <CommandPalette query={value.split(' ')[0]} />}

      {/* 2. Unified Input Box with Inline Styled Badges & Cursor */}
      <Box
        borderStyle="round"
        borderColor={disabled ? 'yellow' : 'green'}
        paddingX={1}
      >
        <Box marginRight={1}>
          {disabled ? (
            <Text bold color="yellow">
              <Spinner type="dots" /> 正在分析排障中 &gt;
            </Text>
          ) : (
            <Text bold color="greenBright">
              💬 问题输入 &gt;
            </Text>
          )}
        </Box>
        <Box flexGrow={1}>
          <Text>
            {renderHighlightedInput(value, cursorOffset, placeholder, !disabled)}
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
