import { describe, expect, it } from 'vitest';
import { friendlyNetError } from '../../src/shared/netErrors';

const f = (m: string): string => friendlyNetError(m, 'pub400.com', 23);

describe('friendlyNetError', () => {
  it('explains refused connections (Node and Windows/Go wording)', () => {
    expect(f('connect ECONNREFUSED 127.0.0.1:23')).toMatch(/refused the connection/);
    expect(f('pub400.com:23: connectex: No connection could be made because the target machine actively refused it.')).toMatch(/^pub400\.com:23 refused/);
  });

  it('explains unknown hosts, timeouts, unreachable networks and resets', () => {
    expect(f('getaddrinfo ENOTFOUND pub400.con')).toMatch(/^Host name not found: pub400\.com/);
    expect(f('lookup x: no such host')).toMatch(/Host name not found/);
    expect(f('connection to pub400.com:23 timed out')).toMatch(/^No answer from pub400\.com:23/);
    expect(f('dial tcp 1.2.3.4:23: i/o timeout')).toMatch(/No answer/);
    expect(f('connect ENETUNREACH 10.0.0.1:23')).toMatch(/not reachable/);
    expect(f('read ECONNRESET')).toMatch(/was reset/);
    expect(f('wsarecv: An existing connection was forcibly closed by the remote host.')).toMatch(/was reset/);
  });

  it('explains TLS problems', () => {
    expect(f('self-signed certificate in certificate chain')).toMatch(/Verify certificate/);
    expect(f('tls: failed to verify certificate: x509: certificate signed by unknown authority')).toMatch(/Verify certificate/);
    expect(f('tls: first record does not look like a TLS handshake')).toMatch(/not be a TLS port/);
  });

  it('passes unknown messages through', () => {
    expect(f('connection closed by host')).toBe('connection closed by host');
  });
});
