import { describe, expect, it } from 'vitest';
import { closeOrphans, describeEntry, formatDuration, pushHistory, signonUser, touchEntries, type HistoryEntry } from '../../src/shared/history';

const entry = (id: string, start = 1_000): HistoryEntry => ({
  id,
  sessionName: 'Dev',
  host: 'pub400.com',
  port: 23,
  tls: false,
  screenSize: '24x80',
  deviceName: 'DEV01',
  user: 'JSMITH',
  tabTitle: 'A - Dev',
  start,
});

describe('history', () => {
  it('keeps the newest first, replaces by id and caps the list', () => {
    let list: HistoryEntry[] = [];
    list = pushHistory(list, entry('a'), 3);
    list = pushHistory(list, entry('b'), 3);
    list = pushHistory(list, { ...entry('a'), end: 5_000 }, 3);
    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
    expect(list[0]?.end).toBe(5_000);
    list = pushHistory(list, entry('c'), 3);
    list = pushHistory(list, entry('d'), 3);
    expect(list.map((e) => e.id)).toEqual(['d', 'c', 'a']);
  });

  it('formats durations', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(4 * 60_000)).toBe('4m');
    expect(formatDuration(65 * 60_000)).toBe('1h 05m');
    expect(formatDuration(27 * 3_600_000)).toBe('1d 3h');
  });

  it('describes an entry', () => {
    const e = { ...entry('a', Date.parse('2026-11-03T09:14:00')), end: Date.parse('2026-11-03T09:26:00') };
    const text = describeEntry(e);
    expect(text.startsWith('JSMITH@DEV01 · ')).toBe(true);
    expect(text.endsWith(' · 12m')).toBe(true);
    expect(describeEntry({ ...entry('b', 0), user: '', deviceName: '', end: 30_000 })).toMatch(/^\S.* · 30s$/);
    expect(describeEntry(entry('c', Date.now() - 5_000))).toMatch(/, open$/);
  });

  it('marks open entries alive and closes the ones a dead process left open', () => {
    const list = [entry('open'), { ...entry('done'), end: 2_000 }, entry('stale')];
    const touched = touchEntries(list, ['open'], 9_000);
    expect(touched[0]?.seen).toBe(9_000);
    expect(touched[1]?.seen).toBeUndefined();
    expect(touched[2]?.seen).toBeUndefined();
    const closed = closeOrphans(touched);
    expect(closed[0]).toMatchObject({ end: 9_000, endedBy: 'closed' });
    expect(closed[1]).toMatchObject({ end: 2_000 });
    expect(closed[1]?.endedBy).toBeUndefined();
    expect(closed[2]).toMatchObject({ end: 1_000, endedBy: 'closed' });
    expect(closeOrphans(closed)).toEqual(closed);
  });

  it('reads the user from a sign-on screen on Enter', () => {
    const screen = [
      '                                 Sign On',
      '                                            System  . . . . . :   PUB400',
      '                                            Subsystem . . . . :   QINTER',
      '                                            Display . . . . . :   QPADEV0001',
      '',
      '     User  . . . . . . . . . . . . . . :   jsmith',
      '     Password  . . . . . . . . . . . . :',
      '     Program/procedure . . . . . . . . :',
    ].join('\n');
    expect(signonUser(screen)).toBe('JSMITH');
    expect(signonUser(screen.replace('jsmith', ''))).toBe('');
    expect(signonUser('     Main Menu\n     User  . . . :   JSMITH')).toBe('');
  });
});
