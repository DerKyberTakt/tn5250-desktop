package main

import (
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
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
	TimeoutMs           int    `json:"timeoutMs"`
	KeepAlive           bool   `json:"keepAlive"`
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
	keepAlive := -1 * time.Second
	if o.KeepAlive {
		keepAlive = 60 * time.Second
	}
	host := strings.TrimSpace(o.Host)
	addr := net.JoinHostPort(host, strconv.Itoa(o.Port))
	dialer := &net.Dialer{Timeout: timeout, KeepAlive: keepAlive}

	var conn net.Conn
	var err error
	if o.TLS {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
			ServerName:         host,
			MinVersion:         tls.VersionTLS12,
			InsecureSkipVerify: o.TrustAnyCertificate, //nolint:gosec // per-profile option for self-signed hosts
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
