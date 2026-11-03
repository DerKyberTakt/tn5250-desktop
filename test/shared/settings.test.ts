import { describe, expect, it } from 'vitest';
import { ACS_KEYMAP } from '../../src/shared/keymap';
import { SETTINGS_DEFAULTS, connectionChanges, describeChange, diffSettings, effectiveKeymap, reloadPlan, resolveSettings } from '../../src/shared/settings';

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

  it('lists the connection fields that changed, with readable rows', () => {
    const before = { ...SETTINGS_DEFAULTS, host: 'pub400.com' };
    const after = { ...before, screenSize: '27x132' as const, colorGreen: '#00ff00', tls: true };
    expect(connectionChanges(before, after)).toEqual(['tls', 'screenSize']);
    expect(describeChange('screenSize', before, after)).toBe('Screen Size: 24x80 -> 27x132');
    expect(describeChange('tls', before, after)).toBe('Protocol: Telnet -> Telnet over TLS');
    expect(connectionChanges(before, { ...before, fontSize: 20 })).toEqual([]);
  });

  it('plans a reload for the open tabs a save leaves behind', () => {
    const defaults = { ...SETTINGS_DEFAULTS };
    const sessions = [
      { host: 'pub400.com', name: 'Dev', deviceName: 'DEV*' },
      { host: 'pub400.com', name: 'Wide', screenSize: '27x132' as const },
    ];
    const dev = resolveSettings(defaults, sessions[0]!);
    const wide = resolveSettings(defaults, sessions[1]!);
    const adhoc = resolveSettings(defaults, { host: 'other.example', port: 23, tls: false, name: '' });
    const tabs = [
      { tab: 'dev', profile: { ...dev, deviceName: 'DEV01' }, deviceTemplate: 'DEV*' },
      { tab: 'wide', profile: wide, deviceTemplate: '' },
      { tab: 'adhoc', profile: adhoc, deviceTemplate: '' },
    ];
    // Saving the Dev session with a new screen size: only the Dev tab, with the new values.
    const devWide = { ...dev, screenSize: '27x132' as const };
    expect(reloadPlan(0, devWide, sessions, tabs, ['screenSize']).map((p) => [p.tab, p.profile.screenSize])).toEqual([['dev', '27x132']]);
    // The same template is not a change (the tab holds the expanded name).
    expect(reloadPlan(0, dev, sessions, tabs, ['deviceName'])).toEqual([]);
    // Saving the defaults with 27x132: the ad-hoc tab and Dev follow; Wide already overrides the key.
    const plan = reloadPlan(-1, { ...defaults, screenSize: '27x132' }, sessions, tabs, ['screenSize']);
    expect(plan.map((p) => p.tab).sort()).toEqual(['adhoc', 'dev']);
    expect(plan.every((p) => p.profile.screenSize === '27x132')).toBe(true);
    // A defaults change on a field nobody uses differently still reloads only the tabs it reaches.
    expect(reloadPlan(-1, { ...defaults, codePage: 500 }, sessions, tabs, ['codePage']).map((p) => p.tab).sort()).toEqual(['adhoc', 'dev', 'wide']);
  });

  it('session keymaps merge with default keymaps', () => {
    const defaults = { ...SETTINGS_DEFAULTS, keymap: { NumpadAdd: 'fieldExit' as const } };
    const resolved = resolveSettings(defaults, { host: 'x', keymap: { 'Shift+Enter': 'newline' } });
    expect(resolved.keymap).toEqual({ NumpadAdd: 'fieldExit', 'Shift+Enter': 'newline' });
  });
});
