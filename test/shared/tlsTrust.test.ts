import { describe, expect, it } from 'vitest';
import { checkPeer, normalizeFingerprint } from '../../src/shared/tlsTrust';

const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

describe('TLS peer check', () => {
  it('normalises fingerprints (colons, case)', () => {
    expect(normalizeFingerprint(FP)).toBe(FP.replace(/:/g, ''));
    expect(normalizeFingerprint(FP.toLowerCase().replace(/:/g, ''))).toBe(FP.replace(/:/g, ''));
  });

  it('accepts a verified chain, refuses an unverified one with the reason', () => {
    expect(checkPeer({}, { fingerprint256: FP, authorized: true })).toBeUndefined();
    expect(checkPeer({}, { fingerprint256: FP, authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN' })).toBe('SELF_SIGNED_CERT_IN_CHAIN');
  });

  it('a pinned fingerprint stands in for the chain, and only that certificate passes', () => {
    expect(checkPeer({ pinnedFingerprint: FP.toLowerCase() }, { fingerprint256: FP, authorized: false })).toBeUndefined();
    expect(checkPeer({ pinnedFingerprint: FP }, { fingerprint256: FP.replace('AB', '00'), authorized: true })).toMatch(/not the one trusted/);
  });

  it('verification off accepts anything unless a pin says otherwise', () => {
    expect(checkPeer({ trustAnyCertificate: true }, { fingerprint256: FP, authorized: false })).toBeUndefined();
    expect(checkPeer({ trustAnyCertificate: true, pinnedFingerprint: '00' }, { fingerprint256: FP, authorized: false })).toMatch(/not the one trusted/);
  });
});
