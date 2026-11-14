import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { CMD_CLEAR_UNIT, CMD_SAVE_PARTIAL_SCREEN, CMD_SAVE_SCREEN, CMD_WTD, DataStreamProcessor, ESC } from '../../src/engine/datastream';
import { OP_SAVE_SCREEN } from '../../src/engine/gds';
import { Screen } from '../../src/engine/screen';
import { TerminalState } from '../../src/engine/state';

const cp = CodePage.get(37);
const O_SBA = 0x11;
const text = (s: string): number[] => [...cp.encodeString(s)];
const wtd = (...orders: number[]): Uint8Array => Uint8Array.from([ESC, CMD_WTD, 0x00, 0x00, ...orders]);

function setup() {
  const screen = new Screen();
  const state = new TerminalState();
  const proc = new DataStreamProcessor(screen, state, { terminalType: 'IBM-3477-FC' }, cp, { alarm: () => undefined });
  proc.process(Uint8Array.from([ESC, CMD_CLEAR_UNIT]));
  proc.process(wtd(O_SBA, 1, 1, ...text('MAIN MENU'), O_SBA, 22, 1, ...text('===> command line'), O_SBA, 23, 1, ...text('F3=Exit   F12=Cancel')));
  const row = (r: number): string => screen.rowText(r, cp);
  return { screen, state, proc, row };
}

/**
 * The assist menus (and Esc out of them) make the host save the screen, paint over it,
 * then send the saved image back: the command line and the function-key rows must come
 * back exactly, for a partial save as for a full one.
 */
describe('save and restore screen', () => {
  for (const [name, cmd, extra] of [
    ['Save Screen / Restore Screen', CMD_SAVE_SCREEN, []],
    ['Save Partial Screen / Restore Partial Screen', CMD_SAVE_PARTIAL_SCREEN, [0x00, 20, 1, 5, 80]],
  ] as const) {
    it(`${name}: the rows painted over come back`, () => {
      const { proc, row } = setup();
      const saved = proc.process(Uint8Array.from([ESC, cmd, ...extra]));
      expect(saved).toHaveLength(1);
      expect(saved[0]?.opcode).toBe(OP_SAVE_SCREEN);
      // The host paints a menu over the bottom rows.
      proc.process(wtd(O_SBA, 22, 1, ...text(' '.repeat(80)), O_SBA, 23, 1, ...text('   Select one of the following'.padEnd(80))));
      expect(row(21).trim()).toBe('');
      expect(row(22)).toContain('Select one');
      // Then sends back what it saved.
      proc.process(saved[0]?.data as Uint8Array);
      expect(row(0)).toContain('MAIN MENU');
      expect(row(21)).toContain('===> command line');
      expect(row(22)).toContain('F3=Exit   F12=Cancel');
    });
  }

  it('a restore after the screen was cleared and rewritten still brings every row back', () => {
    const { proc, row } = setup();
    const saved = proc.process(Uint8Array.from([ESC, CMD_SAVE_PARTIAL_SCREEN, 0x00, 1, 1, 24, 80]));
    proc.process(Uint8Array.from([ESC, CMD_CLEAR_UNIT]));
    proc.process(wtd(O_SBA, 1, 1, ...text('SOMETHING ELSE')));
    expect(row(21).trim()).toBe('');
    proc.process(saved[0]?.data as Uint8Array);
    expect(row(0)).toContain('MAIN MENU');
    expect(row(21)).toContain('===> command line');
    expect(row(22)).toContain('F3=Exit   F12=Cancel');
  });
});
