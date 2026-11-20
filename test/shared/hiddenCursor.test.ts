import { describe, expect, it } from 'vitest';
import { Session5250 } from '../../src/engine/session';
import { cursorInHiddenField } from '../../src/shared/macros';
import { snapshotCursorHidden } from '../../src/shared/hiddenCursor';
import { hexToBytes } from '../helpers/fixture';

const h = (n: number): string => n.toString(16).padStart(2, '0');
const SBA = (row: number, col: number): string => '11' + h(row) + h(col);

function frame(hex: string): Uint8Array {
  const payload = hexToBytes(hex);
  const total = 10 + payload.length;
  const header = [(total >> 8) & 0xff, total & 0xff, 0x12, 0xa0, 0, 0, 4, 0, 0, 0x03];
  return Uint8Array.from([...header, ...payload, 0xff, 0xef]);
}

/** A visible user field (row 6) and a non-display password field (row 7). */
const SIGNON = '04110008' + SBA(6, 10) + '1d4000200010' + SBA(7, 10) + '1d4000270010' + '0452' + '0000';

describe('snapshotCursorHidden', () => {
  it('agrees with the engine on a real screen: visible field no, password field yes, also while typing', () => {
    const session = new Session5250({ codePage: 37 }, { send: () => undefined });
    session.feed(frame(SIGNON));
    expect(cursorInHiddenField(session.screen)).toBe(false);
    expect(snapshotCursorHidden(session.snapshot())).toBe(false);
    session.type('alex');
    expect(snapshotCursorHidden(session.snapshot())).toBe(false);
    session.press('tab');
    expect(cursorInHiddenField(session.screen)).toBe(true);
    expect(snapshotCursorHidden(session.snapshot())).toBe(true);
    session.type('s3c');
    expect(snapshotCursorHidden(session.snapshot())).toBe(true);
  });

  it('no snapshot, or a cursor outside every field: not hidden', () => {
    expect(snapshotCursorHidden(undefined)).toBe(false);
    expect(snapshotCursorHidden({ rows: 24, cols: 80, fields: [], attrs: [], cursor: { row: 0, col: 0 } })).toBe(false);
  });
});
