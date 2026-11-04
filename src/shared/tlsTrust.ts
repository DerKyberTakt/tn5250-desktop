/**
 * TLS trust decisions shared by the VS Code extension (Node sockets) and the desktop app
 * (Go sockets): pure, no platform imports.
 */

/** A host certificate that was not accepted; carries what "Trust this certificate" needs. */
export class CertificateError extends Error {
  constructor(
    message: string,
    readonly fingerprint: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'CertificateError';
  }
}

/** "AB:CD:..." and "abcd..." compare equal. */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

/**
 * Decides whether a TLS peer is acceptable: a pinned fingerprint wins, else the chain
 * verification result, else anything when verification is off. Returns the error text
 * for a refusal, undefined when accepted.
 */
export function checkPeer(opts: { trustAnyCertificate?: boolean; pinnedFingerprint?: string }, peer: { fingerprint256: string; authorized: boolean; authorizationError?: string }): string | undefined {
  const pinned = opts.pinnedFingerprint ? normalizeFingerprint(opts.pinnedFingerprint) : '';
  if (pinned) {
    if (normalizeFingerprint(peer.fingerprint256) === pinned) return undefined;
    return 'the certificate is not the one trusted for this session (it changed, or another system answers on this address)';
  }
  if (peer.authorized || opts.trustAnyCertificate) return undefined;
  return peer.authorizationError || 'the certificate could not be verified';
}
