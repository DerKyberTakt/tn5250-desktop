/**
 * How the "PC command from host" confirmation shows what the host wants to run: a short
 * preview with an explicit count of what is not shown, and the whole command with every
 * invisible or direction-changing character written out, so padding cannot push the real
 * command out of sight and nothing in it can reorder or hide text.
 */

/** Characters of the command shown in the message itself. */
export const PREVIEW_CHARS = 160;

// Control characters, line and paragraph separators, zero-width and bidi controls, BOM,
// variation selectors and the tag block: all written as \u{XXXX} instead of drawn.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}⠀ㅤᅟᅠ]/gu;

/** The text with invisible and direction-changing characters spelled out. */
export function visibleText(s: string): string {
  return s.replace(INVISIBLE, (c) => {
    const cp = c.codePointAt(0) ?? 0;
    if (cp === 0x0a) return '\\n';
    if (cp === 0x0d) return '\\r';
    if (cp === 0x09) return '\\t';
    return `\\u{${cp.toString(16).toUpperCase()}}`;
  });
}

export interface CommandView {
  /** The first PREVIEW_CHARS characters, escaped; for the message. */
  preview: string;
  /** How many characters of the command the preview leaves out. */
  more: number;
  /** The whole command, escaped; for the scrollable area. */
  full: string;
  /** The number of characters in the command. */
  length: number;
}

export function commandView(command: string): CommandView {
  const chars = [...command];
  return {
    preview: visibleText(chars.slice(0, PREVIEW_CHARS).join('')),
    more: Math.max(0, chars.length - PREVIEW_CHARS),
    full: visibleText(command),
    length: chars.length,
  };
}

/** The message line: what the host wants, the preview and the "N more characters" marker. */
export function commandMessage(who: string, what: string, command: string): { text: string; detail: string } {
  const v = commandView(command);
  const marker = v.more > 0 ? `\n... (${v.more} more characters, the whole command is below)` : '';
  return {
    text: `${who}: ${what} (${v.length} characters):\n${v.preview}${marker}`,
    detail: v.full,
  };
}
