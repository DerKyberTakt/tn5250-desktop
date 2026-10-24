import { describe, expect, it } from 'vitest';
import { explainToolError } from '../../src/desktop/toolErrors';

const host = 'pub400.com';

describe('explainToolError', () => {
  it('names the exit point when an exit program refused the sign-on', () => {
    const e = explainToolError('SQL', host, 'sign-on refused by an exit program on the host (return code 00050001)');
    expect(e.kind).toBe('refused');
    expect(e.message).toBe('SQL was refused by an exit program on pub400.com.');
    expect(e.hint).toContain('QIBM_QZDA_INIT');
    expect(e.raw).toContain('00050001');
  });

  it('points at the saved password for a wrong or expired password', () => {
    const e = explainToolError('IFS', host, 'sign-on refused: the password has expired; change it in a 5250 session (CHGPWD) and try again');
    expect(e.kind).toBe('password');
    expect(e.message).toMatch(/^Sign-on to pub400.com failed: the password has expired/);
    expect(e.hint).toContain('Saved Passwords');
  });

  it('explains unreachable host servers in network terms', () => {
    const e = explainToolError('CL', host, 'pub400.com:8475: connectex: No connection could be made because the target machine actively refused it.');
    expect(e.kind).toBe('network');
    expect(e.message).toContain('refused the connection');
    expect(e.message).toContain('STRHOSTSVR *ALL');
    expect(e.hint).toContain('8470-8476');
  });

  it('keeps the message id for authority problems', () => {
    const e = explainToolError('CL', host, 'CPF2207 Not authorized to use object QCMDEXC in library QSYS type *PGM.');
    expect(e.kind).toBe('authority');
    expect(e.message).toBe('You are not authorized to do that on pub400.com (CPF2207).');
    const sql = explainToolError('SQL', host, 'SQL0551 Not authorized to object SYSTABLES in QSYS2 type *FILE.');
    expect(sql.kind).toBe('authority');
    expect(sql.message).toContain('SQL0551');
  });

  it('recognises a missing Qshell', () => {
    const e = explainToolError('QSH', host, 'CPD0030 Command QSH in library *LIBL not found.');
    expect(e.kind).toBe('missing');
    expect(e.hint).toContain('option 30');
  });

  it('passes anything else through unchanged', () => {
    const e = explainToolError('SQL', host, 'SQL0204 NOSUCHTABLE in NOSUCHLIB type *FILE not found.');
    expect(e.kind).toBe('other');
    expect(e.message).toBe('SQL0204 NOSUCHTABLE in NOSUCHLIB type *FILE not found.');
    expect(e.hint).toBeUndefined();
  });
});
