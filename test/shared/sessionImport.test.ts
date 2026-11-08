import { describe, expect, it } from 'vitest';
import { isSaved, mergeImported, savedIndex } from '../../src/shared/sessionImport';
import type { SessionOverrides } from '../../src/shared/settings';

const s = (name: string, host: string, extra: Partial<SessionOverrides> = {}): SessionOverrides => ({ name, host, ...extra });

describe('mergeImported', () => {
  it('appends new connections and replaces a saved one in place (same host and name, any case)', () => {
    const saved = [s('Prod', 'prod.example.com', { port: 23 }), s('QC', 'qc.example.com')];
    const r = mergeImported(saved, [s('PROD', 'Prod.Example.com', { port: 992, tls: true }), s('Dev', 'dev.example.com')]);
    expect(r.sessions).toEqual([s('Prod', 'Prod.Example.com', { port: 992, tls: true }), s('QC', 'qc.example.com'), s('Dev', 'dev.example.com')]);
    expect(r.added).toEqual([s('Dev', 'dev.example.com')]);
    expect(r.replaced).toEqual([s('Prod', 'Prod.Example.com', { port: 992, tls: true })]);
    expect(r.touched).toEqual([0, 2]);
  });

  it('keeps what only the emulator has when it replaces a saved connection', () => {
    const saved = [s('Prod', 'prod.example.com', { port: 992, tlsPinnedCertificate: 'AA:BB', demoMode: true, colorGreen: '#cc9900' })];
    const r = mergeImported(saved, [s('Prod', 'prod.example.com', { port: 992, colorGreen: '#00ff00' })]);
    expect(r.sessions).toEqual([s('Prod', 'prod.example.com', { port: 992, tlsPinnedCertificate: 'AA:BB', demoMode: true, colorGreen: '#00ff00' })]);
  });

  it('keeps two profiles of the same host with different names', () => {
    const r = mergeImported([], [s('Prod', 'prod.example.com'), s('Prod - Release', 'prod.example.com', { deviceName: 'REL*' })]);
    expect(r.added.map((x) => x.name)).toEqual(['Prod', 'Prod - Release']);
  });

  it('makes a name unique when another host already uses it, and replaces that entry on the next import', () => {
    const saved = [s('Prod', 'a.example.com')];
    const first = mergeImported(saved, [s('Prod', 'b.example.com'), s('Prod', 'c.example.com')]);
    expect(first.added.map((x) => x.name)).toEqual(['Prod (2)', 'Prod (3)']);
    const again = mergeImported(first.sessions, [s('Prod', 'b.example.com', { port: 992 }), s('Prod', 'c.example.com')]);
    expect(again.added).toEqual([]);
    expect(again.replaced.map((x) => [x.name, x.host, x.port])).toEqual([
      ['Prod (2)', 'b.example.com', 992],
      ['Prod (3)', 'c.example.com', undefined],
    ]);
    expect(again.sessions).toHaveLength(3);
  });

  it('merges a duplicate inside the same import into one entry', () => {
    const r = mergeImported([], [s('Dev', 'dev.example.com'), s('Dev', 'dev.example.com', { port: 992 })]);
    expect(r.sessions).toEqual([s('Dev', 'dev.example.com', { port: 992 })]);
    expect(r.added).toHaveLength(1);
    expect(r.replaced).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.touched).toEqual([0]);
  });

  it('leaves every saved connection alone with updateSaved false and only adds the new ones', () => {
    const saved = [s('Prod', 'prod.example.com', { port: 23, colorGreen: '#00ff00' })];
    const r = mergeImported(saved, [s('Prod', 'prod.example.com', { port: 992, tls: true }), s('Dev', 'dev.example.com')], { updateSaved: false });
    expect(r.sessions).toEqual([s('Prod', 'prod.example.com', { port: 23, colorGreen: '#00ff00' }), s('Dev', 'dev.example.com')]);
    expect(r.skipped).toEqual([s('Prod', 'prod.example.com', { port: 992, tls: true })]);
    expect(r.replaced).toEqual([]);
    expect(r.added).toEqual([s('Dev', 'dev.example.com')]);
    expect(r.touched).toEqual([1]);
    // A duplicate inside the same import still merges into the entry this import added.
    const twice = mergeImported([], [s('Dev', 'd'), s('Dev', 'd', { port: 992 })], { updateSaved: false });
    expect(twice.sessions).toEqual([s('Dev', 'd', { port: 992 })]);
    expect(twice.skipped).toEqual([]);
  });

  it('does not change the list it was given', () => {
    const saved = [s('Prod', 'prod.example.com')];
    mergeImported(saved, [s('Prod', 'prod.example.com', { port: 992 }), s('Dev', 'dev.example.com')]);
    expect(saved).toEqual([s('Prod', 'prod.example.com')]);
  });
});

describe('savedIndex and isSaved', () => {
  it('treats a saved session without a name as named after its host', () => {
    expect(isSaved([{ host: 'h' }], s('h', 'H'))).toBe(true);
    expect(isSaved([s('Prod (x)', 'h')], s('Prod', 'h'))).toBe(false);
    expect(savedIndex([s('A', 'x'), s('Prod (2)', 'h')], s('Prod', 'h'))).toBe(1);
  });
});
