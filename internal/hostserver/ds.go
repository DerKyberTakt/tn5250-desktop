// Package hostserver talks to the IBM i host servers (sign-on, file, database, ...)
// the way IBM i Access clients do: a 20-byte header, a fixed template and
// chained LL/CP parameters, all big-endian.
package hostserver

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// HeaderLen is the size of the common datastream header.
const HeaderLen = 20

// Server IDs (header offset 6).
const (
	ServerCentral  uint16 = 0xE000
	ServerFile     uint16 = 0xE002
	ServerDatabase uint16 = 0xE004
	ServerDataQ    uint16 = 0xE007
	ServerCommand  uint16 = 0xE008
	ServerSignon   uint16 = 0xE009
)

// maxFrame bounds a single datastream; file server blocks are well below this.
const maxFrame = 16 * 1024 * 1024

// Frame is one datastream: header fields plus the bytes after the header.
type Frame struct {
	HeaderID    uint16
	ServerID    uint16
	CSInstance  uint32
	Correlation uint32
	TemplateLen uint16
	ReqRepID    uint16
	// Body is everything after the 20-byte header (template, then LL/CP parameters).
	Body []byte
}

// Bytes encodes the frame, header included.
func (f *Frame) Bytes() []byte {
	out := make([]byte, HeaderLen+len(f.Body))
	binary.BigEndian.PutUint32(out[0:], uint32(len(out)))
	binary.BigEndian.PutUint16(out[4:], f.HeaderID)
	binary.BigEndian.PutUint16(out[6:], f.ServerID)
	binary.BigEndian.PutUint32(out[8:], f.CSInstance)
	binary.BigEndian.PutUint32(out[12:], f.Correlation)
	binary.BigEndian.PutUint16(out[16:], f.TemplateLen)
	binary.BigEndian.PutUint16(out[18:], f.ReqRepID)
	copy(out[HeaderLen:], f.Body)
	return out
}

// ReadFrame reads one length-prefixed datastream.
func ReadFrame(r io.Reader) (*Frame, error) {
	var head [HeaderLen]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return nil, err
	}
	total := binary.BigEndian.Uint32(head[0:])
	if total < HeaderLen || total > maxFrame {
		return nil, fmt.Errorf("host server datastream length %d is invalid", total)
	}
	if head[6] != 0xE0 {
		return nil, fmt.Errorf("not a host server datastream (server id %02x%02x)", head[6], head[7])
	}
	body := make([]byte, total-HeaderLen)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return &Frame{
		HeaderID:    binary.BigEndian.Uint16(head[4:]),
		ServerID:    binary.BigEndian.Uint16(head[6:]),
		CSInstance:  binary.BigEndian.Uint32(head[8:]),
		Correlation: binary.BigEndian.Uint32(head[12:]),
		TemplateLen: binary.BigEndian.Uint16(head[16:]),
		ReqRepID:    binary.BigEndian.Uint16(head[18:]),
		Body:        body,
	}, nil
}

// At reads big-endian integers by absolute datastream offset (header included),
// which is how the protocol documents its fields.
type At []byte

func (b At) ok(off, n int) bool { return off >= HeaderLen && off-HeaderLen+n <= len(b) }

func (b At) U8(off int) uint8 {
	if !b.ok(off, 1) {
		return 0
	}
	return b[off-HeaderLen]
}

func (b At) U16(off int) uint16 {
	if !b.ok(off, 2) {
		return 0
	}
	return binary.BigEndian.Uint16(b[off-HeaderLen:])
}

func (b At) U32(off int) uint32 {
	if !b.ok(off, 4) {
		return 0
	}
	return binary.BigEndian.Uint32(b[off-HeaderLen:])
}

func (b At) U64(off int) uint64 {
	if !b.ok(off, 8) {
		return 0
	}
	return binary.BigEndian.Uint64(b[off-HeaderLen:])
}

func (b At) Slice(off, n int) []byte {
	if !b.ok(off, n) {
		return nil
	}
	return b[off-HeaderLen : off-HeaderLen+n]
}

// Param is one LL/CP parameter: 4-byte length (6 + data), 2-byte code point, data.
type Param struct {
	CP   uint16
	Data []byte
}

// Params walks the LL/CP parameters that start at absolute offset off.
func (b At) Params(off int) ([]Param, error) {
	var out []Param
	for off+6 <= HeaderLen+len(b) {
		ll := int(b.U32(off))
		if ll < 6 || off+ll > HeaderLen+len(b) {
			return out, errors.New("malformed LL/CP parameter")
		}
		out = append(out, Param{CP: b.U16(off + 4), Data: b.Slice(off+6, ll-6)})
		off += ll
	}
	return out, nil
}

// Find returns the first parameter with the code point, if any.
func Find(params []Param, cp uint16) ([]byte, bool) {
	for _, p := range params {
		if p.CP == cp {
			return p.Data, true
		}
	}
	return nil, false
}

// Builder assembles a request body (template, then LL/CP parameters).
type Builder struct{ buf []byte }

func (b *Builder) U8(v uint8) *Builder { b.buf = append(b.buf, v); return b }
func (b *Builder) U16(v uint16) *Builder {
	b.buf = binary.BigEndian.AppendUint16(b.buf, v)
	return b
}
func (b *Builder) U32(v uint32) *Builder {
	b.buf = binary.BigEndian.AppendUint32(b.buf, v)
	return b
}
func (b *Builder) U64(v uint64) *Builder {
	b.buf = binary.BigEndian.AppendUint64(b.buf, v)
	return b
}
func (b *Builder) Raw(p []byte) *Builder { b.buf = append(b.buf, p...); return b }

// Param appends an LL/CP parameter.
func (b *Builder) Param(cp uint16, data []byte) *Builder {
	b.U32(uint32(6 + len(data))).U16(cp)
	return b.Raw(data)
}

func (b *Builder) Len() int      { return len(b.buf) }
func (b *Builder) Bytes() []byte { return b.buf }
