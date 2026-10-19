/**
 * Turns socket errors from Node (ECONNREFUSED ...), Go ("connectex: ...",
 * "i/o timeout") and the OS into short, plain messages for the status line and
 * the connection overlay. Unknown messages pass through unchanged.
 */
export function friendlyNetError(message: string, host: string, port: number): string {
  const m = message.toLowerCase();
  const where = `${host}:${port}`;
  if (/econnrefused|actively refused|connection refused/.test(m)) return `${where} refused the connection. Check the host name and port, and that the telnet server is running.`;
  if (/enotfound|no such host|eai_again|getaddrinfo|name or service not known|no address associated/.test(m)) return `Host name not found: ${host}. Check the spelling, the VPN or the DNS.`;
  if (/etimedout|timed out|i\/o timeout|did not properly respond|deadline exceeded/.test(m)) return `No answer from ${where}. The host may be down, or a firewall or VPN is blocking the port.`;
  if (/enetunreach|ehostunreach|network is unreachable|host is unreachable|unreachable network|unreachable host/.test(m)) return `${where} is not reachable from this network. Check the VPN or Wi-Fi.`;
  if (/econnreset|forcibly closed|connection reset|broken pipe|epipe|wsarecv|wsasend/.test(m)) return `The connection to ${where} was reset (network dropped or the host ended the session).`;
  if (/certificate|x509|self[- ]signed|unable to verify|cert_|hostname\/ip does not match/.test(m)) return `The TLS certificate of ${where} was not accepted (${message}). Turn off "Verify certificate" for this session if the host uses a self-signed certificate.`;
  if (/wrong version number|first record does not look like a tls handshake|tls: |ssl/.test(m)) return `TLS failed with ${where}: the port may not be a TLS port (use 992 for TLS, 23 without).`;
  return message;
}
