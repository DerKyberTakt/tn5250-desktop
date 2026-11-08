import { describe, expect, it } from 'vitest';
import { importCodeForIbmi, type PortChoice } from '../../src/shared/c4iImport';

describe('importCodeForIbmi', () => {
  const saved: Record<string, PortChoice> = { 'pub400.com': { port: 992, tls: true } };
  const known = (host: string): PortChoice | undefined => saved[host.toLowerCase()];

  it('takes name, host and user, and the 5250 port of a host already saved (never the SSH port)', () => {
    const value = [
      { name: 'Test', host: ' PUB400.com ', port: 2222, username: 'DEMOUSER', privateKeyPath: '/keys/id', passphrase: 'x', readyTimeout: 20000 },
      { name: 'Dev', host: 'myibmi.example.com', port: 22, username: '' },
    ];
    expect(importCodeForIbmi(value, known)).toEqual([
      { ok: true, session: { name: 'Test', host: 'PUB400.com', port: 992, tls: true, signonUser: 'DEMOUSER' }, portKnown: true },
      { ok: true, session: { name: 'Dev', host: 'myibmi.example.com' }, portKnown: false },
    ]);
  });

  it('never carries a password, key or passphrase', () => {
    const [r] = importCodeForIbmi([{ name: 'A', host: 'h', username: 'U', password: 'p', privateKeyPath: 'k', passphrase: 'x' }]);
    expect(r).toEqual({ ok: true, session: { name: 'A', host: 'h', signonUser: 'U' }, portKnown: false });
  });

  it('names an unnamed connection after its host and reports entries without a host', () => {
    expect(importCodeForIbmi([{ host: 'h' }, { name: 'Broken' }, null, 'text'])).toEqual([
      { ok: true, session: { name: 'h', host: 'h' }, portKnown: false },
      { ok: false, name: 'Broken', reason: 'no host name' },
      { ok: false, name: '(unnamed)', reason: 'no host name' },
      { ok: false, name: '(unnamed)', reason: 'no host name' },
    ]);
  });

  it('gives nothing when the setting is missing or not an array', () => {
    expect(importCodeForIbmi(undefined)).toEqual([]);
    expect(importCodeForIbmi({ name: 'x' })).toEqual([]);
  });
});
