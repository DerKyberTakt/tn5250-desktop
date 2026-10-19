// Package ifstest is an in-memory IBM i file server for tests and local demos. Its reply
// layouts are the ones IBM's own client accepted from cmd/hsrecord.
package ifstest

import (
	"bytes"
	"net"
	"path"
	"sort"
	"strings"
	"sync"
	"unicode/utf16"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
)

// Server is an in-memory file server with a user profile and password.
type Server struct {
	l        net.Listener
	user     string
	password string
	level    byte
	Mu       sync.Mutex
	Files    map[string][]byte // path -> content
	Dirs     map[string]bool
	Handles  map[uint32]string
	next     uint32
	Writes   int
}

const (
	reqOpen      uint16 = 0x0002
	reqRead      uint16 = 0x0003
	reqWrite     uint16 = 0x0004
	reqClose     uint16 = 0x0009
	reqList      uint16 = 0x000A
	reqDelete    uint16 = 0x000C
	reqMkdir     uint16 = 0x000D
	reqRmdir     uint16 = 0x000E
	reqRename    uint16 = 0x000F
	reqExchange  uint16 = 0x0016
	repReturn    uint16 = 0x8001
	repOpen      uint16 = 0x8002
	repRead      uint16 = 0x8003
	repClose     uint16 = 0x8004
	repList      uint16 = 0x8005
	repExchange  uint16 = 0x8009
	repWrite     uint16 = 0x800B
	cpName       uint16 = 0x0002
	cpOldName    uint16 = 0x0003
	cpNewName    uint16 = 0x0004
	cpData       uint16 = 0x0020
	cpCCSIDs     uint16 = 0x000A
	rcNoMoreFile uint16 = 0x12
	rcNoMoreData uint16 = 0x16
)

func utf16Name(s string) []byte {
	u := utf16.Encode([]rune(s))
	out := make([]byte, 2*len(u))
	for i, v := range u {
		out[2*i] = byte(v >> 8)
		out[2*i+1] = byte(v)
	}
	return out
}

var seed = []byte{0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF}

// New starts a server on addr ("127.0.0.1:0" for any free port) with /home/<USER>.
func New(addr, user, password string, level byte) (*Server, error) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	home := "/home/" + strings.ToUpper(user)
	f := &Server{l: l, user: user, password: password, level: level,
		Files: map[string][]byte{}, Dirs: map[string]bool{"/": true, "/home": true, home: true}, Handles: map[uint32]string{}, next: 0x100}
	go f.serve()
	return f, nil
}

// Close stops the server.
func (f *Server) Close() error { return f.l.Close() }

// Port is the TCP port the server listens on.
func (f *Server) Port() int { return f.l.Addr().(*net.TCPAddr).Port }

func (f *Server) serve() {
	for {
		c, err := f.l.Accept()
		if err != nil {
			return
		}
		go f.conn(c)
	}
}

func rep(req *hs.Frame, id uint16, tmpl uint16, body []byte) *hs.Frame {
	return &hs.Frame{HeaderID: req.HeaderID, ServerID: req.ServerID, Correlation: req.Correlation, TemplateLen: tmpl, ReqRepID: id, Body: body}
}

func rc(req *hs.Frame, code uint16) *hs.Frame {
	return rep(req, repReturn, 4, (&hs.Builder{}).U16(0).U16(code).Bytes())
}

func nameOf(req *hs.Frame, off int) string {
	params, _ := hs.At(req.Body).Params(off)
	if len(params) == 0 {
		return ""
	}
	b := params[0].Data
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
	}
	return string(utf16.Decode(u))
}

func (f *Server) conn(c net.Conn) {
	defer c.Close()
	var clientSeed []byte
	for {
		req, err := hs.ReadFrame(c)
		if err != nil {
			return
		}
		out := f.answer(req, &clientSeed)
		for _, r := range out {
			if _, err := c.Write(r.Bytes()); err != nil {
				return
			}
		}
		if req.ReqRepID == 0x7002 && len(out) == 1 && hs.At(out[0].Body).U32(20) != 0 {
			return
		}
	}
}

func entry(req *hs.Frame, name string, dir bool, size int, more bool) *hs.Frame {
	b := &hs.Builder{}
	chain := uint16(0)
	if more {
		chain = 1
	}
	b.U16(chain).U32(1760000000).U32(0).U32(1760000060).U32(0).U32(1760000120).U32(0).U32(uint32(size))
	attrs, typ := uint32(0), uint16(1)
	if dir {
		attrs, typ = 0x10, 2
	}
	b.U32(attrs).U16(typ).U16(0).U32(0).U32(0).U32(1).U16(0).U8(0).U16(1200).U16(0).U32(0).U64(uint64(size)).U16(1).U8(0)
	tmpl := uint16(b.Len())
	return rep(req, repList, tmpl, b.Param(cpName, utf16Name(name)).Bytes())
}

func (f *Server) answer(req *hs.Frame, clientSeed *[]byte) []*hs.Frame {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	b := hs.At(req.Body)
	switch req.ReqRepID {
	case 0x7001:
		*clientSeed = append([]byte(nil), req.Body[:8]...)
		r := rep(req, 0xF001, 12, (&hs.Builder{}).U32(0).Raw(seed).Bytes())
		r.HeaderID = req.HeaderID&0xFF00 | uint16(f.level)
		return []*hs.Frame{r}
	case 0x7002:
		params, _ := b.Params(22)
		got, _ := hs.Find(params, 0x1105)
		_, want, _ := hs.Substitute(f.level, f.user, f.password, *clientSeed, seed)
		code := uint32(0)
		if !bytes.Equal(got, want) {
			code = 0x0003000B // password not correct
		}
		return []*hs.Frame{rep(req, 0xF002, 4, (&hs.Builder{}).U32(code).Bytes())}
	case reqExchange:
		body := (&hs.Builder{}).U16(0).U16(16).U16(0).U32(65535).U32(8).U16(cpCCSIDs).U16(1200).Bytes()
		return []*hs.Frame{rep(req, repExchange, 16, body)}
	case reqList:
		name := nameOf(req, 40)
		if strings.HasSuffix(name, "/*") {
			dir := path.Clean(strings.TrimSuffix(name, "/*"))
			if dir == "" {
				dir = "/"
			}
			if !f.Dirs[dir] {
				return []*hs.Frame{rc(req, 0x03)}
			}
			var names []string
			for p := range f.Dirs {
				if p != "/" && path.Dir(p) == dir {
					names = append(names, p)
				}
			}
			for p := range f.Files {
				if path.Dir(p) == dir {
					names = append(names, p)
				}
			}
			sort.Strings(names)
			out := []*hs.Frame{entry(req, ".", true, 0, true), entry(req, "..", true, 0, true)}
			for _, p := range names {
				out = append(out, entry(req, path.Base(p), f.Dirs[p], len(f.Files[p]), true))
			}
			return append(out, rc(req, rcNoMoreFile))
		}
		if f.Dirs[name] {
			return []*hs.Frame{entry(req, path.Base(name), true, 0, false)}
		}
		if data, ok := f.Files[name]; ok {
			return []*hs.Frame{entry(req, path.Base(name), false, len(data), false)}
		}
		return []*hs.Frame{rc(req, 0x02)}
	case reqOpen:
		name := nameOf(req, hs.HeaderLen+int(req.TemplateLen))
		access, options := b.U16(30), b.U16(36)
		if _, ok := f.Files[name]; !ok {
			if options != 0x02 {
				return []*hs.Frame{rc(req, 0x02)}
			}
			if !f.Dirs[path.Dir(name)] {
				return []*hs.Frame{rc(req, 0x03)}
			}
		}
		if access == 0x02 {
			f.Files[name] = nil
		}
		f.next++
		f.Handles[f.next] = name
		return []*hs.Frame{rep(req, repOpen, 8, (&hs.Builder{}).U16(0).U32(f.next).U16(0).Bytes())}
	case reqRead:
		name := f.Handles[b.U32(22)]
		off, n := int(b.U64(50)), int(b.U32(34))
		data := f.Files[name]
		if off >= len(data) {
			return []*hs.Frame{rc(req, rcNoMoreData)}
		}
		end := min(len(data), off+n)
		// Split big reads into two chained replies, as a real server may.
		mid := off + (end-off)/2
		if end-off < 2 {
			mid = end
		}
		first := rep(req, repRead, 4, (&hs.Builder{}).U16(1).U16(0xFFFF).Param(cpData, data[off:mid]).Bytes())
		second := rep(req, repRead, 4, (&hs.Builder{}).U16(0).U16(0xFFFF).Param(cpData, data[mid:end]).Bytes())
		if mid == end {
			first = rep(req, repRead, 4, (&hs.Builder{}).U16(0).U16(0xFFFF).Param(cpData, data[off:end]).Bytes())
			return []*hs.Frame{first}
		}
		return []*hs.Frame{first, second}
	case reqWrite:
		name := f.Handles[b.U32(22)]
		off := int(b.U64(46))
		params, _ := b.Params(hs.HeaderLen + int(req.TemplateLen))
		data, _ := hs.Find(params, cpData)
		buf := f.Files[name]
		for len(buf) < off {
			buf = append(buf, 0)
		}
		f.Files[name] = append(buf[:off], data...)
		f.Writes++
		return []*hs.Frame{rep(req, repWrite, 12, (&hs.Builder{}).U16(0).U16(0).U32(0).U32(0).Bytes())}
	case reqClose:
		delete(f.Handles, b.U32(22))
		return []*hs.Frame{rep(req, repClose, 4, (&hs.Builder{}).U16(0).U16(0).Bytes())}
	case reqMkdir:
		name := nameOf(req, 28)
		if f.Dirs[name] || f.Files[name] != nil {
			return []*hs.Frame{rc(req, 0x04)}
		}
		f.Dirs[name] = true
		return []*hs.Frame{rc(req, 0)}
	case reqDelete:
		name := nameOf(req, 28)
		if _, ok := f.Files[name]; !ok {
			return []*hs.Frame{rc(req, 0x02)}
		}
		delete(f.Files, name)
		return []*hs.Frame{rc(req, 0)}
	case reqRmdir:
		name := nameOf(req, 28)
		for p := range f.Files {
			if path.Dir(p) == name {
				return []*hs.Frame{rc(req, 0x09)}
			}
		}
		delete(f.Dirs, name)
		return []*hs.Frame{rc(req, 0)}
	case reqRename:
		params, _ := b.Params(36)
		from, _ := hs.Find(params, cpOldName)
		to, _ := hs.Find(params, cpNewName)
		dec := func(x []byte) string {
			u := make([]uint16, len(x)/2)
			for i := range u {
				u[i] = uint16(x[2*i])<<8 | uint16(x[2*i+1])
			}
			return string(utf16.Decode(u))
		}
		src, dst := dec(from), dec(to)
		data, ok := f.Files[src]
		if !ok {
			return []*hs.Frame{rc(req, 0x02)}
		}
		if _, exists := f.Files[dst]; exists && b.U16(34) == 0 {
			return []*hs.Frame{rc(req, 0x04)}
		}
		delete(f.Files, src)
		f.Files[dst] = data
		return []*hs.Frame{rc(req, 0)}
	}
	return []*hs.Frame{rc(req, 0x10)}
}
