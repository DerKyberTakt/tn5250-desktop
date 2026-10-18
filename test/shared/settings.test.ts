import { describe, expect, it } from 'vitest';
import { ACS_KEYMAP } from '../../src/shared/keymap';
import { SETTINGS_DEFAULTS, diffSettings, effectiveKeymap, resolveSettings } from '../../src/shared/settings';

describe('settings', () => {
  it('sessions inherit defaults and keep only differences', () => {
    const defaults = { ...SETTINGS_DEFAULTS, screenSize: '27x132' as const, host: 'default-host' };
    const resolved = resolveSettings(defaults, { host: 'box1', port: 2323 });
    expect(resolved.screenSize).toBe('27x132');
    expect(resolved.port).toBe(2323);
    expect(resolved.name).toBe('box1:2323');
    const diff = diffSettings(defaults, resolved);
    expect(diff).toEqual({ host: 'box1', port: 2323, name: 'box1:2323' });
  });

  it('keymap overrides add and remove keys on top of the ACS layout', () => {
    const map = effectiveKeymap({ NumpadAdd: 'fieldExit', Escape: null, 'Ctrl+Q': 'sysreq' });
    expect(map.NumpadAdd).toBe('fieldExit');
    expect(map.Escape).toBeUndefined();
    expect(map['Ctrl+Q']).toBe('sysreq');
    expect(map.F3).toBe(ACS_KEYMAP.F3);
    expect(effectiveKeymap({})).toEqual(ACS_KEYMAP);
  });

  it('session keymaps merge with default keymaps', () => {
    const defaults = { ...SETTINGS_DEFAULTS, keymap: { NumpadAdd: 'fieldExit' as const } };
    const resolved = resolveSettings(defaults, { host: 'x', keymap: { 'Shift+Enter': 'newline' } });
    expect(resolved.keymap).toEqual({ NumpadAdd: 'fieldExit', 'Shift+Enter': 'newline' });
  });
});
