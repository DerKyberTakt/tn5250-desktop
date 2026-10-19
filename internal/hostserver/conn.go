package hostserver

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DialOptions describes the host and the user profile.
type DialOptions struct {
	Host string
	// Port 0 asks the port mapper (449), then falls back to the well-known port.
	Port                int
	TLS                 bool
	TrustAnyCertificate bool
	Timeout             time.Duration
	User                string
	Password            string
}

// Conn is an authenticated connection to one host server.
type Conn struct {
	c             net.Conn
	server        uint16
	mu            sync.Mutex
	corr          uint32
	PasswordLevel byte
	JobName       string
}

var defaultPorts = map[string]int{
	"as-central": 8470, "as-database": 8471, "as-dtaq": 8472, "as-file": 8473, "as-netprt": 8474, "as-rmtcmd": 8475, "as-signon": 8476,
}

// serviceName returns the port-mapper name, e.g. "as-file" or "as-file-s".
func serviceName(service string, useTLS bool) string {
	if useTLS {
		return service + "-s"
	}
	return service
}

// LookupPort asks the port mapper (TCP 449) for a service port.
func LookupPort(host, service string, timeout time.Duration) (int, error) {
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, "449"), timeout)
	if err != nil {
		return 0, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(timeout))
	if _, err := c.Write([]byte(service)); err != nil {
		return 0, err
	}
	var reply [5]byte
	if _, err := io.ReadFull(c, reply[:]); err != nil {
		return 0, err
	}
	if reply[0] != '+' {
		return 0, fmt.Errorf("the IBM i does not offer %s (is the host server started? STRHOSTSVR)", service)
	}
	return int(binary.BigEndian.Uint32(reply[1:])), nil
}

func resolvePort(o DialOptions, service string) int {
	if o.Port > 0 {
		return o.Port
	}
	name := serviceName(service, o.TLS)
	if p, err := LookupPort(o.Host, name, o.Timeout); err == nil && p > 0 {
		return p
	}
	p := defaultPorts[service]
	if o.TLS {
		p += 1000
	}
	return p
}

// Dial connects to a host server ("as-file", ...) and signs on with the user profile.
func Dial(server uint16, service string, o DialOptions) (*Conn, error) {
	if o.Timeout <= 0 {
		o.Timeout = 15 * time.Second
	}
	host := strings.TrimSpace(o.Host)
	if host == "" {
		return nil, errors.New("no host name")
	}
	o.Host = host
	addr := net.JoinHostPort(host, strconv.Itoa(resolvePort(o, service)))
	dialer := &net.Dialer{Timeout: o.Timeout, KeepAliveConfig: net.KeepAliveConfig{Enable: true, Idle: 15 * time.Second, Interval: 5 * time.Second, Count: 4}}
	var nc net.Conn
	var err error
	if o.TLS {
		nc, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12, InsecureSkipVerify: o.TrustAnyCertificate}) //nolint:gosec // per-profile option
	} else {
		nc, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %w", addr, err)
	}
	c := &Conn{c: nc, server: server}
	_ = nc.SetDeadline(time.Now().Add(o.Timeout))
	if err := c.signon(o.User, o.Password); err != nil {
		_ = nc.Close()
		return nil, err
	}
	_ = nc.SetDeadline(time.Time{})
	return c, nil
}

func (c *Conn) signon(user, password string) error {
	clientSeed := make([]byte, 8)
	if _, err := rand.Read(clientSeed); err != nil {
		return err
	}
	// Header byte 4 = 0x02, as IBM's toolbox sends it; the reply's byte 5 carries the password level.
	seedReq := &Frame{HeaderID: 0x0200, ServerID: c.server, TemplateLen: 8, ReqRepID: reqExchangeSeed, Body: clientSeed}
	rep, err := c.Request(seedReq)
	if err != nil {
		return fmt.Errorf("sign-on: %w", err)
	}
	b := At(rep.Body)
	if rc := b.U32(20); rc != 0 {
		return SignonError(rc)
	}
	serverSeed := b.Slice(24, 8)
	if serverSeed == nil {
		return errors.New("sign-on: the host sent no seed")
	}
	c.PasswordLevel = byte(rep.HeaderID & 0xFF)

	scheme, auth, err := Substitute(c.PasswordLevel, user, password, clientSeed, serverSeed)
	if err != nil {
		return err
	}
	uid, _ := UserIDBytes(user)
	body := (&Builder{}).U8(scheme).U8(0x01).Param(cpPassword, auth).Param(cpUserID, uid).Bytes()
	rep, err = c.Request(&Frame{HeaderID: 0x0200, ServerID: c.server, TemplateLen: 2, ReqRepID: reqStartServer, Body: body})
	if err != nil {
		return fmt.Errorf("sign-on: %w", err)
	}
	b = At(rep.Body)
	if rc := b.U32(20); rc != 0 {
		return SignonError(rc)
	}
	if params, err := b.Params(24); err == nil {
		if job, ok := Find(params, cpJobName); ok && len(job) > 4 {
			if s, err := cp037.NewDecoder().Bytes(job[4:]); err == nil {
				c.JobName = strings.TrimSpace(string(s))
			}
		}
	}
	return nil
}

// Send writes a request; the connection fills in the server id and correlation id.
func (c *Conn) Send(f *Frame) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.corr++
	f.ServerID = c.server
	f.Correlation = c.corr
	_, err := c.c.Write(f.Bytes())
	return err
}

// Read reads the next reply.
func (c *Conn) Read() (*Frame, error) { return ReadFrame(c.c) }

// Request sends a request and reads one reply.
func (c *Conn) Request(f *Frame) (*Frame, error) {
	if err := c.Send(f); err != nil {
		return nil, err
	}
	return c.Read()
}

// SetDeadline bounds the next reads and writes.
func (c *Conn) SetDeadline(t time.Time) { _ = c.c.SetDeadline(t) }

func (c *Conn) Close() error { return c.c.Close() }

var signonMessages = map[uint32]string{
	0x00020001: "the user profile does not exist",
	0x00020002: "the user profile is disabled",
	0x00020003: "the user profile does not match",
	0x0003000B: "the password is not correct",
	0x0003000C: "the password is not correct; the profile will be disabled after the next failed attempt",
	0x0003000D: "the password has expired; change it in a 5250 session (CHGPWD) and try again",
	0x0003000E: "the password is not correct (pre-V2R2 encryption)",
	0x00030010: "the user profile has password *NONE",
	0x00040000: "general security error on the host",
}

// SignonError turns a sign-on return code into a plain message.
func SignonError(rc uint32) error {
	if m, ok := signonMessages[rc]; ok {
		return fmt.Errorf("sign-on refused: %s", m)
	}
	switch rc >> 16 {
	case 0x0001:
		return fmt.Errorf("sign-on refused: protocol error (return code %08X)", rc)
	case 0x0003:
		return fmt.Errorf("sign-on refused: password problem (return code %08X)", rc)
	case 0x0004:
		return fmt.Errorf("sign-on refused by the host server (return code %08X); check that the server job can start", rc)
	case 0x0005:
		return fmt.Errorf("sign-on refused by an exit program on the host (return code %08X)", rc)
	}
	return fmt.Errorf("sign-on refused (return code %08X)", rc)
}
