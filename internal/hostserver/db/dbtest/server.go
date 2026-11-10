// Package dbtest is an in-memory database host server for tests: it signs the user
// on, answers the attribute exchange and runs statements through a handler the test
// provides, encoding formats, rows, SQLCAs and errors the way the host does (JTOpen
// DBSuperExtendedDataFormat, DBExtendedData, DBReplySQLCA are the references).
package dbtest

import (
	"bytes"
	"encoding/binary"
	"math"
	"net"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
)

// Col describes one result column; Type carries the nullable bit like the host.
type Col struct {
	Name      string
	Type      uint16
	Length    uint32 // slot bytes
	Scale     uint16
	Precision uint16
	CCSID     uint16
}

// Table is a query result: columns and rows of Go values (string, int64, float64,
// []byte, nil for NULL; decimals as "-123.45").
type Table struct {
	Cols []Col
	Rows [][]any
}

// Exec is a statement without rows and its update count.
type Exec struct{ Count int32 }

// Fail is an error reply: error class and return code of the template plus the
// diagnostics parameters.
type Fail struct {
	Class    uint16
	Code     int32
	ID       string
	Text     string
	SQLCode  int32
	SQLState string
}

// Handler answers one statement with a Table, an Exec or a Fail.
type Handler func(sql string) any

// Server is a fake database server on 127.0.0.1.
type Server struct {
	l        net.Listener
	user     string
	password string
	level    byte
	Handler  Handler
	// CloseAtEOF makes the server close the cursor itself on the last block and say
	// so with class 2 / code 700 (attribute 0x383F); otherwise it answers 1 / 100.
	CloseAtEOF bool
	// JobID is what the attribute exchange reports (26 characters).
	JobID string

	mu sync.Mutex
	// Statements the server prepared or executed, Blocks the blocking factors seen,
	// Requests every function id received (in order), Attributes the CPs of the
	// attribute exchange, Cancelled the job ids CANCEL named.
	Statements []string
	Blocks     []uint32
	Requests   []uint16
	Attributes map[uint16][]byte
	Cancelled  []string
}

var seed = []byte{0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF}

// New starts a server.
func New(addr, user, password string, level byte, h Handler) (*Server, error) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	s := &Server{l: l, user: user, password: password, level: level, Handler: h, JobID: "QZDASOINITQUSER     123456"}
	go s.serve()
	return s, nil
}

// Close stops the server.
func (s *Server) Close() error { return s.l.Close() }

// Seen returns the function ids received so far, in order.
func (s *Server) Seen() []uint16 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]uint16(nil), s.Requests...)
}

// Port is the TCP port the server listens on.
func (s *Server) Port() int { return s.l.Addr().(*net.TCPAddr).Port }

func (s *Server) serve() {
	for {
		c, err := s.l.Accept()
		if err != nil {
			return
		}
		go s.conn(c)
	}
}

// cursor is the open result of one connection.
type cursor struct {
	table *Table
	next  int
	open  bool
}

func (s *Server) conn(c net.Conn) {
	defer c.Close()
	var clientSeed []byte
	cur := &cursor{}
	for {
		req, err := hs.ReadFrame(c)
		if err != nil {
			return
		}
		s.mu.Lock()
		s.Requests = append(s.Requests, req.ReqRepID)
		s.mu.Unlock()
		out := s.answer(req, &clientSeed, cur)
		if out == nil {
			continue
		}
		if _, err := c.Write(out.Bytes()); err != nil {
			return
		}
		if req.ReqRepID == 0x7002 && hs.At(out.Body).U32(20) != 0 {
			return
		}
	}
}

func rep(req *hs.Frame, id uint16, tmpl uint16, body []byte) *hs.Frame {
	return &hs.Frame{HeaderID: req.HeaderID, ServerID: req.ServerID, Correlation: req.Correlation, TemplateLen: tmpl, ReqRepID: id, Body: body}
}

// dbReply builds a database reply: the 20-byte template (bitmap echo, return ORS,
// function id, error class, return code) and the parameters.
func dbReply(req *hs.Frame, class uint16, code int32, params *hs.Builder) *hs.Frame {
	b := hs.At(req.Body)
	body := (&hs.Builder{}).U32(b.U32(20)).U32(0).U16(b.U16(34)).U16(req.ReqRepID).U16(req.ReqRepID).U16(class).U32(uint32(code))
	if params != nil {
		body.Raw(params.Bytes())
	}
	return rep(req, 0x2800, 20, body.Bytes())
}

func ebcdic(s string, n int) []byte {
	b, _ := hs.EBCDIC(s)
	for len(b) < n {
		b = append(b, 0x40)
	}
	if n > 0 {
		return b[:n]
	}
	return b
}

func utf16be(s string) []byte {
	var out []byte
	for _, w := range utf16.Encode([]rune(s)) {
		out = binary.BigEndian.AppendUint16(out, w)
	}
	return out
}

// SQLCA builds the 136-byte communication area.
func SQLCA(code int32, state string, errd3 int32) []byte {
	ca := make([]byte, 136)
	copy(ca, ebcdic("SQLCA", 8))
	binary.BigEndian.PutUint32(ca[8:], 136)
	binary.BigEndian.PutUint32(ca[12:], uint32(code))
	binary.BigEndian.PutUint32(ca[104:], uint32(errd3))
	if state == "" {
		state = "00000"
	}
	copy(ca[131:], ebcdic(state, 5))
	return ca
}

func (s *Server) statementOf(params []hs.Param) string {
	if d, ok := hs.Find(params, 0x3831); ok && len(d) >= 6 {
		ccsid := binary.BigEndian.Uint16(d)
		n := int(binary.BigEndian.Uint32(d[2:]))
		if n > len(d)-6 {
			n = len(d) - 6
		}
		if ccsid == 13488 || ccsid == 1200 {
			u := make([]uint16, 0, n/2)
			for i := 6; i+1 < 6+n; i += 2 {
				u = append(u, binary.BigEndian.Uint16(d[i:]))
			}
			return string(utf16.Decode(u))
		}
		return "<statement in CCSID " + strconv.Itoa(int(ccsid)) + ">"
	}
	if d, ok := hs.Find(params, 0x3807); ok && len(d) >= 4 {
		return hs.FromEBCDIC(d[4:])
	}
	return ""
}

func (s *Server) answer(req *hs.Frame, clientSeed *[]byte, cur *cursor) *hs.Frame {
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
	}
	ors := b.U32(20)
	params, _ := b.Params(40)
	wantReply := ors&0x80000000 != 0
	switch req.ReqRepID {
	case 0x1F80: // set attributes
		s.mu.Lock()
		s.Attributes = map[uint16][]byte{}
		for _, p := range params {
			s.Attributes[p.CP] = p.Data
		}
		s.mu.Unlock()
		return dbReply(req, 0, 0, (&hs.Builder{}).Param(0x3804, s.serverAttributes()))
	case 0x1D00: // create RPB: no reply unless asked
		if !wantReply {
			return nil
		}
		return dbReply(req, 0, 0, nil)
	case 0x1803, 0x1806: // prepare+describe / execute immediate
		sql := s.statementOf(params)
		s.mu.Lock()
		s.Statements = append(s.Statements, sql)
		s.mu.Unlock()
		var res any = Exec{}
		if s.Handler != nil {
			res = s.Handler(sql)
		}
		switch v := res.(type) {
		case Fail:
			return s.fail(req, v)
		case Table:
			if req.ReqRepID == 0x1806 {
				return s.fail(req, Fail{Class: 7, Code: -1, ID: "SQL0001", Text: "a query cannot be executed immediately", SQLCode: -1, SQLState: "42601"})
			}
			cur.table, cur.next, cur.open = &v, 0, false
			p := &hs.Builder{}
			if ors&0x08000000 != 0 {
				p.Param(0x3812, Format(v.Cols))
			}
			if ors&0x02000000 != 0 {
				p.Param(0x3807, SQLCA(0, "00000", int32(len(v.Rows))))
			}
			return dbReply(req, 0, 0, p)
		case Exec:
			p := &hs.Builder{}
			if ors&0x02000000 != 0 {
				code := int32(0)
				if v.Count == 0 {
					code = 100
				}
				p.Param(0x3807, SQLCA(code, "00000", v.Count))
			}
			return dbReply(req, 0, 0, p)
		}
		return dbReply(req, 0, 0, nil)
	case 0x180E, 0x180B: // open+fetch / fetch
		if cur.table == nil {
			return s.fail(req, Fail{Class: 7, Code: -501, ID: "SQL0501", Text: "The cursor is not open.", SQLCode: -501, SQLState: "24501"})
		}
		if req.ReqRepID == 0x180E {
			cur.open = true
		} else if !cur.open {
			return s.fail(req, Fail{Class: 7, Code: -501, ID: "SQL0501", Text: "The cursor is not open.", SQLCode: -501, SQLState: "24501"})
		}
		block, _ := hs.Find(params, 0x380C)
		n := len(cur.table.Rows) - cur.next
		if len(block) == 4 {
			want := int(binary.BigEndian.Uint32(block))
			s.mu.Lock()
			s.Blocks = append(s.Blocks, uint32(want))
			s.mu.Unlock()
			if want < n {
				n = want
			}
		}
		rows := cur.table.Rows[cur.next : cur.next+n]
		cur.next += n
		p := &hs.Builder{}
		if n > 0 && ors&0x04000000 != 0 {
			p.Param(0x380E, Data(cur.table.Cols, rows))
		}
		if ors&0x02000000 != 0 {
			p.Param(0x3807, SQLCA(0, "00000", int32(len(cur.table.Rows))))
		}
		if cur.next >= len(cur.table.Rows) {
			if s.CloseAtEOF {
				cur.open = false
				return dbReply(req, 2, 700, p)
			}
			return dbReply(req, 1, 100, p)
		}
		return dbReply(req, 0, 0, p)
	case 0x180A: // close
		cur.open = false
		if !wantReply {
			return nil
		}
		return dbReply(req, 0, 0, nil)
	case 0x1818: // cancel
		if d, ok := hs.Find(params, 0x3826); ok && len(d) >= 4 {
			s.mu.Lock()
			s.Cancelled = append(s.Cancelled, strings.TrimRight(hs.FromEBCDIC(d[4:]), " "))
			s.mu.Unlock()
		}
		return dbReply(req, 0, 0, nil)
	}
	if !wantReply {
		return nil
	}
	return dbReply(req, 8, -1, nil)
}

func (s *Server) fail(req *hs.Frame, f Fail) *hs.Frame {
	p := &hs.Builder{}
	if f.ID != "" {
		p.Param(0x3801, (&hs.Builder{}).U16(37).Raw(ebcdic(f.ID, 0)).Bytes())
	}
	if f.Text != "" {
		t := ebcdic(f.Text, 0)
		p.Param(0x3802, (&hs.Builder{}).U16(37).U16(uint16(len(t))).Raw(t).Bytes())
	}
	p.Param(0x3807, SQLCA(f.SQLCode, f.SQLState, 0))
	return dbReply(req, f.Class, f.Code, p)
}

// serverAttributes is the structure after the CCSID of parameter 0x3804.
func (s *Server) serverAttributes() []byte {
	a := make([]byte, 120)
	binary.BigEndian.PutUint16(a[0:], 5)  // date format ISO
	binary.BigEndian.PutUint16(a[2:], 1)  // '-'
	binary.BigEndian.PutUint16(a[4:], 4)  // time JIS
	binary.BigEndian.PutUint16(a[8:], 0)  // '.'
	binary.BigEndian.PutUint16(a[10:], 0) // SQL naming
	binary.BigEndian.PutUint16(a[19:], 37)
	copy(a[50:], ebcdic("V7R5M00014", 10))
	copy(a[60:], ebcdic("*N", 18))
	copy(a[78:], ebcdic("QGPL", 10))
	copy(a[88:], ebcdic(s.JobID, 26))
	binary.BigEndian.PutUint16(a[114:], 4)
	copy(a[116:], ebcdic("QGPL", 4))
	return (&hs.Builder{}).U16(37).Raw(a).Bytes()
}

// Format encodes a super-extended data format (CP 0x3812) for the columns.
func Format(cols []Col) []byte {
	var record uint32
	for _, c := range cols {
		record += c.Length
	}
	head := (&hs.Builder{}).U32(0x12345678).U32(uint32(len(cols))).U8(5).U8(4).U8(1).U8(0).U32(record)
	descs := &hs.Builder{}
	vars := &hs.Builder{}
	varBase := 16 + 48*len(cols)
	for i, c := range cols {
		name := ebcdic(c.Name, 0)
		item := (&hs.Builder{}).U32(uint32(8 + len(name))).U16(0x3840).U16(37).Raw(name).Bytes()
		off := varBase + vars.Len() - (16 + 48*i)
		d := (&hs.Builder{}).U16(48).U16(c.Type).U32(c.Length).U16(c.Scale).U16(c.Precision).U16(c.CCSID)
		d.U8(0).U16(0).U32(0).U8(0).U32(0).U32(0).U16(0) // +14 .. +31
		d.U32(uint32(off)).U32(uint32(len(item))).U64(0)
		descs.Raw(d.Bytes())
		vars.Raw(item)
	}
	return head.Raw(descs.Bytes()).Raw(vars.Bytes()).Bytes()
}

// Data encodes rows as extended result data (CP 0x380E).
func Data(cols []Col, rows [][]any) []byte {
	var record uint32
	for _, c := range cols {
		record += c.Length
	}
	b := (&hs.Builder{}).U32(0x12345678).U32(uint32(len(rows))).U16(uint16(len(cols))).U16(2).U32(0).U32(record)
	for _, r := range rows {
		for i := range cols {
			if i < len(r) && r[i] == nil {
				b.U16(0xFFFF)
			} else {
				b.U16(0)
			}
		}
	}
	for _, r := range rows {
		for i, c := range cols {
			var v any
			if i < len(r) {
				v = r[i]
			}
			b.Raw(Encode(c, v))
		}
	}
	return b.Bytes()
}

// Encode fills one field's slot with a Go value.
func Encode(c Col, v any) []byte {
	slot := make([]byte, c.Length)
	if v == nil {
		return slot
	}
	switch c.Type &^ 1 {
	case 452: // CHAR
		copy(slot, ebcdic(v.(string), int(c.Length)))
	case 448, 456: // VARCHAR
		t := ebcdic(v.(string), 0)
		binary.BigEndian.PutUint16(slot, uint16(len(t)))
		copy(slot[2:], t)
	case 468: // GRAPHIC (UCS-2)
		t := utf16be(v.(string))
		for i := range slot {
			slot[i] = 0
		}
		for i := 0; i+1 < len(slot); i += 2 {
			slot[i+1] = 0x20
		}
		copy(slot, t)
	case 464, 472: // VARGRAPHIC
		t := utf16be(v.(string))
		binary.BigEndian.PutUint16(slot, uint16(len(t)/2))
		copy(slot[2:], t)
	case 384, 388, 392: // DATE, TIME, TIMESTAMP
		copy(slot, ebcdic(v.(string), int(c.Length)))
	case 484: // packed
		digits, neg := digitsOf(v.(string), int(c.Scale), int(c.Precision))
		nibbles := make([]byte, 0, len(digits)+1)
		for _, d := range digits {
			nibbles = append(nibbles, byte(d-'0'))
		}
		sign := byte(0x0F)
		if neg {
			sign = 0x0D
		}
		nibbles = append(nibbles, sign)
		for len(nibbles) < int(2*c.Length) {
			nibbles = append([]byte{0}, nibbles...)
		}
		for i := 0; i < int(c.Length); i++ {
			slot[i] = nibbles[2*i]<<4 | nibbles[2*i+1]
		}
	case 488: // zoned
		digits, neg := digitsOf(v.(string), int(c.Scale), int(c.Length))
		for i, d := range digits {
			slot[i] = 0xF0 | byte(d-'0')
		}
		if neg {
			slot[len(slot)-1] = 0xD0 | (slot[len(slot)-1] & 0x0F)
		}
	case 500:
		binary.BigEndian.PutUint16(slot, uint16(int16(v.(int64))))
	case 496:
		binary.BigEndian.PutUint32(slot, uint32(int32(v.(int64))))
	case 492:
		binary.BigEndian.PutUint64(slot, uint64(v.(int64)))
	case 480:
		if c.Length == 4 {
			binary.BigEndian.PutUint32(slot, math.Float32bits(float32(v.(float64))))
		} else {
			binary.BigEndian.PutUint64(slot, math.Float64bits(v.(float64)))
		}
	case 912, 904: // BINARY, ROWID
		copy(slot, v.([]byte))
	case 908: // VARBINARY
		raw := v.([]byte)
		binary.BigEndian.PutUint16(slot, uint16(len(raw)))
		copy(slot[2:], raw)
	case 2436:
		slot[0] = 0xF0
		if v.(bool) {
			slot[0] = 0xF1
		}
	case 408: // CLOB inline
		t := ebcdic(v.(string), 0)
		binary.BigEndian.PutUint32(slot, uint32(len(t)))
		copy(slot[4:], t)
	}
	return slot
}

// digitsOf turns "-123.45" into exactly width digits with the scale applied.
func digitsOf(s string, scale, width int) (string, bool) {
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	intPart, frac, _ := strings.Cut(s, ".")
	for len(frac) < scale {
		frac += "0"
	}
	frac = frac[:scale]
	digits := intPart + frac
	for len(digits) < width {
		digits = "0" + digits
	}
	if len(digits) > width {
		digits = digits[len(digits)-width:]
	}
	return digits, neg
}
