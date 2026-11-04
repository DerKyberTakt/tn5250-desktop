package main

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ConnectOptions mirrors ConnectOptions in src/extension/connection.ts (without client certificates).
type ConnectOptions struct {
	Host                string `json:"host"`
	Port                int    `json:"port"`
	TLS                 bool   `json:"tls"`
	TrustAnyCertificate bool   `json:"trustAnyCertificate"`
	// SHA-256 fingerprint of the one certificate to accept (hex, colons optional); empty = none pinned.
	PinnedFingerprint string `json:"pinnedFingerprint"`
	// PEM file with CA certificates to trust in addition to the system roots.
	CAFile    string `json:"caFile"`
	TimeoutMs int    `json:"timeoutMs"`
	KeepAlive bool   `json:"keepAlive"`
}

// certRefusedPrefix marks a refused host certificate in the error text; the page turns it
// into a CertificateError with the fingerprint, so it can offer "Trust this certificate".
const certRefusedPrefix = "TLS_CERT_REFUSED"

func fingerprint256(raw []byte) string {
	sum := sha256.Sum256(raw)
	return strings.ToUpper(hex.EncodeToString(sum[:]))
}

func normalizeFingerprint(fp string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(fp) {
		if (r >= '0' && r <= '9') || (r >= 'A' && r <= 'F') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// verifyPeer decides whether the host certificate is acceptable: a pinned fingerprint
// wins, else the chain (system roots plus the CA file) and the host name, else anything
// when verification is off. The handshake has InsecureSkipVerify set so this runs instead.
func verifyPeer(o ConnectOptions, host string) func(cs tls.ConnectionState) error {
	return func(cs tls.ConnectionState) error {
		if len(cs.PeerCertificates) == 0 {
			return fmt.Errorf("%s  no certificate presented", certRefusedPrefix)
		}
		leaf := cs.PeerCertificates[0]
		fp := fingerprint256(leaf.Raw)
		if pinned := normalizeFingerprint(o.PinnedFingerprint); pinned != "" {
			if pinned == fp {
				return nil
			}
			return fmt.Errorf("%s %s the certificate is not the one trusted for this session (it changed, or another system answers on this address)", certRefusedPrefix, fp)
		}
		if o.TrustAnyCertificate {
			return nil
		}
		roots, err := x509.SystemCertPool()
		if err != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if o.CAFile != "" {
			pem, readErr := os.ReadFile(o.CAFile)
			if readErr != nil {
				return fmt.Errorf("CA certificate file not readable: %w", readErr)
			}
			if !roots.AppendCertsFromPEM(pem) {
				return errors.New("CA certificate file holds no PEM certificate")
			}
		}
		opts := x509.VerifyOptions{DNSName: host, Roots: roots, Intermediates: x509.NewCertPool()}
		for _, c := range cs.PeerCertificates[1:] {
			opts.Intermediates.AddCert(c)
		}
		if _, err := leaf.Verify(opts); err != nil {
			return fmt.Errorf("%s %s %s", certRefusedPrefix, fp, err.Error())
		}
		return nil
	}
}

// Emitter delivers socket events to the page; the Wails runtime in the app, a recorder in tests.
type Emitter func(event string, args ...interface{})

const maxConnections = 64

// Sockets owns every host connection. The page picks the id, so it can listen
// for data before the first byte arrives.
type Sockets struct {
	mu    sync.Mutex
	conns map[string]net.Conn
	emit  Emitter
}

func NewSockets(emit Emitter) *Sockets {
	return &Sockets{conns: map[string]net.Conn{}, emit: emit}
}

func validateTarget(id string, o ConnectOptions) error {
	if id == "" || len(id) > 64 {
		return errors.New("invalid connection id")
	}
	host := strings.TrimSpace(o.Host)
	if host == "" || len(host) > 253 || strings.ContainsAny(host, " /\\") {
		return errors.New("invalid host name")
	}
	if o.Port < 1 || o.Port > 65535 {
		return errors.New("invalid port")
	}
	return nil
}

// Connect dials the host and starts reading. Events: net:data (id, base64),
// net:closed (id, reason).
func (s *Sockets) Connect(id string, o ConnectOptions) error {
	if err := validateTarget(id, o); err != nil {
		return err
	}
	s.mu.Lock()
	if _, busy := s.conns[id]; busy {
		s.mu.Unlock()
		return errors.New("connection id already in use")
	}
	if len(s.conns) >= maxConnections {
		s.mu.Unlock()
		return errors.New("too many open connections")
	}
	s.mu.Unlock()

	timeout := time.Duration(o.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	host := strings.TrimSpace(o.Host)
	addr := net.JoinHostPort(host, strconv.Itoa(o.Port))
	dialer := &net.Dialer{Timeout: timeout, KeepAlive: -1}
	if o.KeepAlive {
		// Probe after 15 s idle, every 5 s, give up after 4 misses: a dropped
		// network (VPN, Wi-Fi) closes the session in about 35 s instead of minutes.
		dialer.KeepAliveConfig = net.KeepAliveConfig{Enable: true, Idle: 15 * time.Second, Interval: 5 * time.Second, Count: 4}
	}

	var conn net.Conn
	var err error
	if o.TLS {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
			ServerName:         host,
			MinVersion:         tls.VersionTLS12,
			InsecureSkipVerify: true, //nolint:gosec // VerifyConnection below does the check (pin, CA file, chain)
			VerifyConnection:   verifyPeer(o, host),
		})
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("%s: %w", addr, unwrapNetError(err))
	}

	s.mu.Lock()
	if _, busy := s.conns[id]; busy {
		s.mu.Unlock()
		_ = conn.Close()
		return errors.New("connection id already in use")
	}
	s.conns[id] = conn
	s.mu.Unlock()

	go s.read(id, conn)
	return nil
}

func (s *Sockets) read(id string, conn net.Conn) {
	buf := make([]byte, 64*1024)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			s.emit("net:data", id, base64.StdEncoding.EncodeToString(buf[:n]))
		}
		if err != nil {
			s.mu.Lock()
			current := s.conns[id] == conn
			if current {
				delete(s.conns, id)
			}
			s.mu.Unlock()
			if current {
				reason := ""
				if !errors.Is(err, net.ErrClosed) && err.Error() != "EOF" {
					reason = unwrapNetError(err).Error()
				}
				s.emit("net:closed", id, reason)
			}
			return
		}
	}
}

// Send writes base64-encoded bytes to the connection.
func (s *Sockets) Send(id string, data string) error {
	bytes, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return errors.New("invalid data")
	}
	s.mu.Lock()
	conn := s.conns[id]
	s.mu.Unlock()
	if conn == nil {
		return errors.New("not connected")
	}
	_, err = conn.Write(bytes)
	return err
}

// Close closes the connection without a net:closed event (the page asked for it).
func (s *Sockets) Close(id string) {
	s.mu.Lock()
	conn := s.conns[id]
	delete(s.conns, id)
	s.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (s *Sockets) CloseAll() {
	s.mu.Lock()
	conns := s.conns
	s.conns = map[string]net.Conn{}
	s.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

// unwrapNetError drops Go's "dial tcp x:y:" prefixes, which repeat the address.
func unwrapNetError(err error) error {
	var op *net.OpError
	if errors.As(err, &op) && op.Err != nil {
		return op.Err
	}
	return err
}
