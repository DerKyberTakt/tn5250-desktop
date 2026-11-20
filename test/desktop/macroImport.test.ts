import { describe, expect, it } from 'vitest';
import { macroImportPreview, cleanName } from '../../src/desktop/macroImport';
import { macrosFromJson, type Macro } from '../../src/shared/macros';

const file = (macros: unknown[]): string => JSON.stringify({ tn5250Macros: 1, macros });

describe('macro import preview (g3-2)', () => {
  const saved: Macro[] = [{ id: 'a', name: 'Old one', key: '', steps: [{ type: 'text', text: 'x' }] }];

  it('lists names, keys, step counts and the saved macros that get replaced', () => {
    const refused: string[] = [];
    const incoming = macrosFromJson(
      file([
        { id: 'a', name: 'Sign on', key: 'Ctrl+1', steps: [{ type: 'text', text: 'hi' }, { type: 'key', action: 'enter' }] },
        { id: 'b', name: 'Sneaky', key: 'Enter', steps: [{ type: 'text', text: 'y' }] },
      ]),
      refused,
    ) as Macro[];
    const p = macroImportPreview(incoming, saved, refused);
    expect(p.title).toBe('Import 2 macros?');
    expect(p.detail).toContain('REPLACES "Old one" with "Sign on" on Ctrl+1: 2 steps');
    expect(p.detail).toContain('adds "Sneaky": 1 step');
    expect(p.detail).not.toContain('on Enter');
    expect(p.note).toContain('Sneaky: Enter');
  });

  it('caps the list at 15 lines and strips control and bidi characters from names', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, name: `M${i}`, key: '', steps: [{ type: 'text', text: 'x' }] }));
    const p = macroImportPreview(macrosFromJson(file(many)) as Macro[], [], []);
    expect(p.detail.split('\n')).toHaveLength(16);
    expect(p.detail).toContain('... and 5 more');
    expect(cleanName('a‮b\nc')).toBe('a b c');
  });
});
