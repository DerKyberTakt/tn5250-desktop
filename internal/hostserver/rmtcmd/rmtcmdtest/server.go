// Package rmtcmdtest is an in-memory remote command server for tests: it signs the
// user on, answers the attribute exchange, and runs commands through a handler the
// test provides, encoding the messages the way the client expects them.
package rmtcmdtest

import (
	"bytes"
	"encoding/binary"
	"net"
	"sync"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
)

// Message mirrors rmtcmd.Message without importing it (the client tests import both).
type Message struct {
	ID       string
	Type     uint16
	Severity uint16
	File     string
	Library  string
	Text     string
	Help     string
}

// Handler answers one command: the return code (0 = ran, 0x0400 = failed) and the messages.
type Handler func(command string) (uint16, []Message)

// Server is a fake remote command server on 127.0.0.1.
type Server struct {
	l        net.Listener
	user     string
	password string
	level    byte
	Handler  Handler
	// WithHelp encodes messages as CP 0x1106 (with a help-text length); else CP 0x1102.
	WithHelp bool
	// Garble makes the message layout unknown (an extra byte), to test the fallback.
	Garble bool

	mu       sync.Mutex
	Commands []string
}

var seed = []byte{0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF}

// New starts a server; the handler may be nil (every command then succeeds silently).
func New(addr, user, password string, level byte, h Handler) (*Server, error) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	s := &Server{l: l, user: user, password: password, level: level, Handler: h, WithHelp: true}
	go s.serve()
	return s, nil
}

// Close stops the server.
func (s *Server) Close() error { return s.l.Close() }

// Port is the TCP port the server listens on.
func (s *Server) Port() int { return s.l.Addr().(*net.TCPAddr).Port }

// Ran returns the commands received so far.
func (s *Server) Ran() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.Commands...)
}

func (s *Server) serve() {
	for {
		c, err := s.l.Accept()
		if err != nil {
			return
		}
		go s.conn(c)
	}
}

func rep(req *hs.Frame, id uint16, tmpl uint16, body []byte) *hs.Frame {
	return &hs.Frame{HeaderID: req.HeaderID, ServerID: req.ServerID, Correlation: req.Correlation, TemplateLen: tmpl, ReqRepID: id, Body: body}
}

func (s *Server) conn(c net.Conn) {
	defer c.Close()
	var clientSeed []byte
	for {
		req, err := hs.ReadFrame(c)
		if err != nil {
			return
		}
		out := s.answer(req, &clientSeed)
		if out == nil {
			return
		}
		if _, err := c.Write(out.Bytes()); err != nil {
			return
		}
		if req.ReqRepID == 0x7002 && hs.At(out.Body).U32(20) != 0 {
			return
		}
	}
}

func ebcdic(s string, n int) []byte {
	b, _ := hs.EBCDIC(s)
	for len(b) < n {
		b = append(b, 0x40)
	}
	return b[:n]
}

// EncodeMessage builds one message parameter the way the host sends it.
func EncodeMessage(m Message, withHelp, garble bool) []byte {
	text, _ := hs.EBCDIC(m.Text)
	help, _ := hs.EBCDIC(m.Help)
	b := &hs.Builder{}
	b.Raw(ebcdic(m.ID, 7)).U16(m.Type).U16(m.Severity).Raw(ebcdic(m.File, 10)).Raw(ebcdic(m.Library, 10))
	b.U16(0).U16(uint16(len(text)))
	if withHelp {
		b.U16(uint16(len(help)))
	}
	b.Raw(text)
	if withHelp {
		b.Raw(help)
	}
	if garble {
		b.U8(0)
	}
	return b.Bytes()
}

func (s *Server) answer(req *hs.Frame, clientSeed *[]byte) *hs.Frame {
	b := hs.At(req.Body)
	switch req.ReqRepID {
	case 0x7001:
		*clientSeed = append([]byte(nil), req.Body[:8]...)
		r := rep(req, 0xF001, 12, (&hs.Builder{}).U32(0).Raw(seed).Bytes())
		r.HeaderID = req.HeaderID&0xFF00 | uint16(s.level)
		return r
	case 0x7002:
		params, _ := b.Params(22)
		got, _ := hs.Find(params, 0x1105)
		_, want, _ := hs.Substitute(s.level, s.user, s.password, *clientSeed, seed)
		code := uint32(0)
		if !bytes.Equal(got, want) {
			code = 0x0003000B
		}
		return rep(req, 0xF002, 4, (&hs.Builder{}).U32(code).Bytes())
	case 0x1001:
		// rc, server CCSID 37, NLV, version, datastream level 10
		body := (&hs.Builder{}).U16(0).U32(37).Raw(ebcdic("2924", 4)).U32(1).U16(10).Bytes()
		return rep(req, 0x8001, 16, body)
	case 0x1002:
		params, _ := b.Params(hs.HeaderLen + int(req.TemplateLen))
		data, _ := hs.Find(params, 0x1104)
		command := ""
		if len(data) > 4 {
			command = hs.FromEBCDIC(data[4:])
		}
		s.mu.Lock()
		s.Commands = append(s.Commands, command)
		s.mu.Unlock()
		code, msgs := uint16(0), []Message(nil)
		if s.Handler != nil {
			code, msgs = s.Handler(command)
		}
		out := (&hs.Builder{}).U16(code)
		cp := uint16(0x1102)
		if s.WithHelp {
			cp = 0x1106
		}
		for _, m := range msgs {
			out.Param(cp, EncodeMessage(m, s.WithHelp, s.Garble))
		}
		return rep(req, 0x8002, 2, out.Bytes())
	}
	return rep(req, 0x8002, 2, binary.BigEndian.AppendUint16(nil, 0x0001))
}
