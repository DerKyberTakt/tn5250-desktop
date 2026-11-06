import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS, resolveSettings } from '../../src/shared/settings';
import type { RegistryEntry } from '../../src/desktop/relay';
import { buildTree, tabsBadge } from '../../src/desktop/sessionTree';

const session = (name: string, host: string) => resolveSettings(SETTINGS_DEFAULTS, { name, host });
const tab = (id: string, name: string, host: string, letter: string, status: RegistryEntry['status'] = 'connected', window = 'main'): RegistryEntry => ({
  tab: id,
  window,
  letter,
  title: `${letter} - ${name}`,
  name,
  host,
  port: 23,
  status,
});

describe('connections tree', () => {
  it('puts open tabs under their saved session, by letter, and ranks sessions with tabs first', () => {
    const sessions = [session('Dev', 'dev.example'), session('Prod', 'prod.example'), session('Test', 'test.example')];
    const registry = [tab('t2', 'Test', 'test.example', 'B'), tab('t1', 'Test', 'test.example', 'A'), tab('t3', 'Prod', 'prod.example', 'C', 'disconnected', 'win-x')];
    const tree = buildTree(sessions, registry);
    expect(tree.rows.map((r) => [r.profile.name, r.index, r.tabs.map((t) => t.letter), r.connected])).toEqual([
      ['Test', 2, ['A', 'B'], 2],
      ['Prod', 1, ['C'], 0],
      ['Dev', 0, [], 0],
    ]);
    expect(tree.others).toEqual([]);
    expect(tabsBadge(tree.rows[0]!)).toBe('2 connected');
    expect(tabsBadge(tree.rows[1]!)).toBe('1 open');
    expect(tabsBadge(tree.rows[2]!)).toBe('');
  });

  it('keeps the saved order among sessions of the same rank and groups tabs of no saved session', () => {
    const sessions = [session('B', 'b.example'), session('A', 'a.example')];
    const registry = [tab('q', 'quick.example', 'quick.example', 'A'), tab('z', 'A', 'other.example', 'B', 'connecting')];
    const tree = buildTree(sessions, registry);
    expect(tree.rows.map((r) => r.profile.name)).toEqual(['B', 'A']);
    // Same name, different host: not that session's tab.
    expect(tree.others.map((t) => t.tab)).toEqual(['q', 'z']);
  });

  it('sorts letters past Z numerically', () => {
    const sessions = [session('S', 's.example')];
    const registry = [tab('a', 'S', 's.example', '10'), tab('b', 'S', 's.example', '9'), tab('c', 'S', 's.example', 'Z')];
    expect(buildTree(sessions, registry).rows[0]?.tabs.map((t) => t.letter)).toEqual(['9', '10', 'Z']);
  });
});
