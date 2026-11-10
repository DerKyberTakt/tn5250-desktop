// Package rmtcmdtest is an in-memory remote command server for tests: it signs the
// user on, answers the attribute exchange, and runs commands through a handler the
// test provides, encoding the messages the way the host does at each datastream level
// (JTOpen RemoteCommandImplRemote.parseMessages is the reference for the layouts).
package rmtcmdtest

import (
	"bytes"
	"encoding/binary"
	"net"
	"sync"
	"unicode/utf16"

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
	// DSL is the datastream level the server announces (11 = a current IBM i; 10 and 7
	// select the older command and message layouts).
	DSL uint16
	// Garble makes the fixed message layout not add up (an extra byte), to test the fallback.
	Garble bool

	mu       sync.Mutex
	Commands []string
	// Options are the message option bytes seen, one per run request.
	Options []byte
}

var seed = []byte{0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF}

// New starts a server; the handler may be nil (every command then succeeds silently).
func New(addr, user, password string, level byte, h Handler) (*Server, error) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	s := &Server{l: l, user: user, password: password, level: level, Handler: h, DSL: 11}
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

func digits(t uint16) []byte { return ebcdic(string(rune('0'+t/10))+string(rune('0'+t%10)), 2) }

func lstr(b *hs.Builder, s string) {
	e, _ := hs.EBCDIC(s)
	b.U32(uint32(len(e))).Raw(e)
}

func lu32(b *hs.Builder, v uint32) { b.U32(4).U32(v) }

// EncodeMessage builds one message parameter's data (after LL/CP) in the layout of cp.
func EncodeMessage(m Message, cp uint16, garble bool) []byte {
	b := &hs.Builder{}
	switch cp {
	case 0x1107:
		lu32(b, uint32(m.Severity))
		lstr(b, m.ID)
		b.U32(2).Raw(digits(m.Type))
		b.U32(4).Raw([]byte{0, 0, 0, 1}) // message key
		lstr(b, m.File)
		lstr(b, "*LIBL")
		lstr(b, m.Library)
		for _, filler := range []string{"", "", "", "QCMD", "", "1120260109", "123456", "QZRCSRVS", "", "*PGM", "*PGM"} {
			lstr(b, filler)
		}
		lu32(b, 0)
		lu32(b, 0)
		lstr(b, "*NO")
		lu32(b, 37)                            // CCSID of the text
		lu32(b, 37)                            // CCSID of the replacement data
		b.U32(3).Raw([]byte{0xC1, 0xC2, 0xC3}) // replacement data
		lstr(b, m.Text)
		lstr(b, m.Help)
	case 0x1106:
		b.U32(37).U32(37).U16(m.Severity)
		b.U32(2).Raw(digits(m.Type))
		lstr(b, m.ID)
		lstr(b, m.File)
		lstr(b, m.Library)
		lstr(b, m.Text)
		b.U32(3).Raw([]byte{0xC1, 0xC2, 0xC3})
		lstr(b, m.Help)
	default:
		text, _ := hs.EBCDIC(m.Text)
		b.Raw(ebcdic(m.ID, 7)).Raw(digits(m.Type)).U16(m.Severity).Raw(ebcdic(m.File, 10)).Raw(ebcdic(m.Library, 10))
		b.U16(3).U16(uint16(len(text))).Raw([]byte{0xC1, 0xC2, 0xC3}).Raw(text)
		if garble {
			b.U8(0)
		}
	}
	return b.Bytes()
}

// messageCP is the layout the host answers with for a message option byte.
func messageCP(option byte) uint16 {
	switch option {
	case 5, 6:
		return 0x1107
	case 3, 4:
		return 0x1106
	default:
		return 0x1102
	}
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
		// rc, server CCSID 37, NLV, version, datastream level
		body := (&hs.Builder{}).U16(0).U32(37).Raw(ebcdic("2924", 4)).U32(1).U16(s.DSL).Bytes()
		return rep(req, 0x8001, 16, body)
	case 0x1002:
		option := b.U8(20)
		params, _ := b.Params(hs.HeaderLen + int(req.TemplateLen))
		command := ""
		if data, ok := hs.Find(params, 0x1104); ok {
			// The host takes only CCSID 1200 here; anything else is "invalid CCSID value".
			if len(data) < 4 || binary.BigEndian.Uint32(data) != 1200 {
				return rep(req, 0x8002, 2, (&hs.Builder{}).U16(0x0401).U16(0).Bytes())
			}
			u := make([]uint16, 0, len(data)/2)
			for i := 4; i+1 < len(data); i += 2 {
				u = append(u, binary.BigEndian.Uint16(data[i:]))
			}
			command = string(utf16.Decode(u))
		} else if data, ok := hs.Find(params, 0x1101); ok {
			command = hs.FromEBCDIC(data)
		}
		s.mu.Lock()
		s.Commands = append(s.Commands, command)
		s.Options = append(s.Options, option)
		s.mu.Unlock()
		code, msgs := uint16(0), []Message(nil)
		if s.Handler != nil {
			code, msgs = s.Handler(command)
		}
		cp := messageCP(option)
		out := (&hs.Builder{}).U16(code).U16(uint16(len(msgs)))
		for _, m := range msgs {
			out.Param(cp, EncodeMessage(m, cp, s.Garble))
		}
		return rep(req, 0x8002, 2, out.Bytes())
	}
	return rep(req, 0x8002, 2, binary.BigEndian.AppendUint16(nil, 0x0001))
}
