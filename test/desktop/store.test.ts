// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/desktop/store';
import type { Macro } from '../../src/shared/macros';

/** A fake Go host with a user file and, optionally, the administrator's managed file. */
let userText = '';
let managedText: string | undefined;
let saved: string[] = [];

function install(withManaged = true): void {
  const app: Record<string, unknown> = {
    SettingsLoad: async () => userText,
    SettingsSave: async (text: string) => {
      saved.push(text);
      userText = text;
    },
  };
  if (withManaged) {
    app.ManagedSettingsLoad = async () => {
      if (managedText === 'THROW') throw new Error('access denied');
      return managedText ?? '';
    };
  }
  window.go = { main: { App: app as never } };
}

const lastSaved = (): { defaults: Record<string, unknown>; sessions: Array<Record<string, unknown>>; macros?: Macro[] } =>
  JSON.parse(saved[saved.length - 1] ?? '{}') as never;

const companyMacro: Macro = { id: 'company-1', name: 'Active jobs', key: 'Ctrl+Alt+1', steps: [{ type: 'text', text: 'wrkactjob' }, { type: 'key', action: 'enter' }] };
const ownMacro: Macro = { id: 'mine-1', name: 'Sign off', key: 'Ctrl+Alt+2', steps: [{ type: 'text', text: 'signoff' }] };

beforeEach(() => {
  userText = '';
  managedText = undefined;
  saved = [];
  install();
});

describe('Store without a managed file', () => {
  it('behaves as before: built-in defaults, own sessions only', async () => {
    userText = JSON.stringify({ version: 1, defaults: { codePage: 500 }, sessions: [{ name: 'Mine', host: 'a' }] });
    const store = new Store();
    await store.load();
    expect(store.hasManaged).toBe(false);
    expect(store.readDefaults().codePage).toBe(500);
    expect(store.resolvedSessions().map((s) => s.name)).toEqual(['Mine']);
    expect(store.managedSessions()).toEqual([]);
    expect(store.checkForUpdates).toBe(true);
    expect(store.updatesLocked).toBe(false);
  });

  it('works with a host that has no ManagedSettingsLoad (older fakes, tests)', async () => {
    install(false);
    const store = new Store();
    await store.load();
    expect(store.managedError).toBeUndefined();
    expect(store.hasManaged).toBe(false);
  });
});

describe('Store with a managed file', () => {
  it('layers the managed defaults under the user defaults and saves only the user deviation', async () => {
    managedText = JSON.stringify({ version: 1, defaults: { codePage: 1141, port: 992 } });
    userText = JSON.stringify({ version: 1, defaults: { codePage: 500 }, sessions: [] });
    const store = new Store();
    await store.load();
    expect(store.hasManaged).toBe(true);
    const d = store.readDefaults();
    expect(d.codePage).toBe(500); // the user's own
    expect(d.port).toBe(992); // the administrator's

    // The user sets the code page back to the company value and changes the port.
    await store.writeDefaults({ ...d, codePage: 1141, port: 23 });
    expect(lastSaved().defaults).toEqual({ port: 23 });
    expect(store.readDefaults().codePage).toBe(1141);
  });

  it('lists company sessions after the own ones, read-only, hidden by an own session of the same name', async () => {
    managedText = JSON.stringify({ version: 1, sessions: [{ name: 'Prod', host: 'prod.example.com', port: 992, tls: true }, { name: 'Test', host: 'test.example.com' }, { host: '   ' }] });
    userText = JSON.stringify({ version: 1, defaults: {}, sessions: [{ name: 'Mine', host: 'mine.example.com' }] });
    const store = new Store();
    await store.load();
    expect(store.resolvedSessions().map((s) => s.name)).toEqual(['Mine', 'Prod', 'Test']);
    expect(store.readSessions().map((s) => s.name)).toEqual(['Mine']);
    expect(store.isManagedSession({ name: 'Prod', host: 'prod.example.com' })).toBe(true);
    expect(store.isManagedSession({ name: 'Mine', host: 'mine.example.com' })).toBe(false);
    // Company defaults do not leak into the session list as a session.
    expect(store.managedSessions().every((s) => s.host.trim())).toBe(true);

    // The user copies Prod to their own list (same name): the copy takes its place.
    const prod = store.managedSessions()[0];
    if (!prod) throw new Error('no Prod');
    await store.saveSession(-1, { ...prod, port: 23 });
    expect(store.resolvedSessions().map((s) => `${s.name}:${s.port}`)).toEqual(['Mine:23', 'Prod:23', 'Test:23']);
    expect(store.managedSessions().map((s) => s.name)).toEqual(['Test']);
    expect(store.isManagedSession({ name: 'Prod', host: 'prod.example.com' })).toBe(false);
    expect(lastSaved().sessions).toHaveLength(2);
  });

  it('lists company macros after the own ones and never writes them to the user file', async () => {
    managedText = JSON.stringify({ version: 1, macros: [companyMacro] });
    userText = JSON.stringify({ version: 1, defaults: {}, sessions: [], macros: [ownMacro] });
    const store = new Store();
    await store.load();
    expect(store.macros.map((m) => m.id)).toEqual(['mine-1', 'company-1']);
    expect(store.isManagedMacro('company-1')).toBe(true);
    expect(store.isManagedMacro('mine-1')).toBe(false);

    // Editing or deleting a company macro changes nothing and saves nothing.
    await store.saveMacro({ ...companyMacro, name: 'Changed' });
    await store.removeMacro('company-1');
    expect(saved).toHaveLength(0);
    expect(store.macros.find((m) => m.id === 'company-1')?.name).toBe('Active jobs');

    // An import that carries the company macro (export includes it) keeps it out of the user's list.
    await store.replaceMacros([ownMacro, companyMacro, { ...ownMacro, id: 'mine-2', key: '' }]);
    expect(lastSaved().macros?.map((m) => m.id)).toEqual(['mine-1', 'mine-2']);
    expect(store.macros.map((m) => m.id)).toEqual(['mine-1', 'mine-2', 'company-1']);

    // A user file that already holds a macro with the company id (an older copy) wins and stays editable.
    userText = JSON.stringify({ version: 1, defaults: {}, sessions: [], macros: [{ ...companyMacro, name: 'My version' }] });
    await store.load();
    expect(store.macros.map((m) => m.name)).toEqual(['My version']);
    expect(store.isManagedMacro('company-1')).toBe(false);
  });

  it('lets the administrator turn the startup update check off for everyone', async () => {
    managedText = JSON.stringify({ version: 1, checkForUpdates: false });
    userText = JSON.stringify({ version: 1, defaults: {}, sessions: [], checkForUpdates: true });
    const store = new Store();
    await store.load();
    expect(store.updatesLocked).toBe(true);
    expect(store.checkForUpdates).toBe(false);
    expect(store.hasManaged).toBe(true);
  });

  it('starts on the user settings when the managed file is broken or unreadable, and says why', async () => {
    managedText = '{ not json';
    userText = JSON.stringify({ version: 1, defaults: {}, sessions: [{ name: 'Mine', host: 'a' }] });
    const store = new Store();
    await store.load();
    expect(store.managedError).toMatch(/not valid JSON/);
    expect(store.resolvedSessions().map((s) => s.name)).toEqual(['Mine']);

    managedText = 'THROW';
    await store.load();
    expect(store.managedError).toBe('not readable: access denied');
    expect(store.hasManaged).toBe(false);

    // A byte-order mark from Notepad is fine.
    managedText = '﻿' + JSON.stringify({ version: 1, sessions: [{ name: 'Prod', host: 'p' }] });
    await store.load();
    expect(store.managedError).toBeUndefined();
    expect(store.managedSessions().map((s) => s.name)).toEqual(['Prod']);
  });
});
