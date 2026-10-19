// Package ifs is a client for the IBM i file server (the integrated file system),
// the host server ACS uses for its IFS browser. Path names travel as UTF-16
// (CCSID 1200); file data is transferred as binary.
package ifs

import (
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
)

// Request ids.
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
	cpDirName    uint16 = 0x0001
	cpOldName    uint16 = 0x0003
	cpNewName    uint16 = 0x0004
	cpData       uint16 = 0x0020
	cpCCSIDs     uint16 = 0x000A
	nameCCSID    uint16 = 1200
	rcNoMoreFile uint16 = 0x12
	rcNoMoreData uint16 = 0x16
)

// chunk is the transfer block size: large enough to be fast, small enough for smooth progress.
const chunk = 256 * 1024

// Entry is one directory entry.
type Entry struct {
	Name     string    `json:"name"`
	Dir      bool      `json:"dir"`
	Symlink  bool      `json:"symlink"`
	Size     uint64    `json:"size"`
	Modified time.Time `json:"modified"`
	Created  time.Time `json:"created"`
	// Type: 1 file, 2 directory, 3 symbolic link, 4 native object (QSYS.LIB), 5 FIFO, ...
	Type     uint16 `json:"type"`
	ReadOnly bool   `json:"readOnly"`
	Hidden   bool   `json:"hidden"`
}

// Client is one signed-on file server connection. Calls are serialised.
type Client struct {
	mu       sync.Mutex
	c        *hs.Conn
	level    uint16
	maxBlock uint32
}

// Error is a file server return code.
type Error struct {
	Code uint16
	Op   string
	Path string
}

var codeText = map[uint16]string{
	0x01: "the file is in use",
	0x02: "not found",
	0x03: "the path was not found",
	0x04: "an entry with that name already exists",
	0x05: "access denied",
	0x06: "invalid file handle",
	0x07: "the name is not valid",
	0x09: "the directory is not empty",
	0x0B: "a resource limit was exceeded",
	0x0C: "the resource is not available",
	0x0D: "access denied",
	0x0E: "the directory entry is damaged",
	0x10: "the request is not valid",
	0x13: "not supported by this file system",
	0x14: "not supported by this file system",
	0x17: "not supported by this file system",
	0x18: "the user profile is not valid",
	0x20: "sharing violation (the file is open elsewhere)",
	0x21: "lock violation (the file is locked)",
}

func (e *Error) Error() string {
	t, ok := codeText[e.Code]
	if !ok {
		t = fmt.Sprintf("file server error %d", e.Code)
	}
	if e.Path != "" {
		return fmt.Sprintf("%s %s: %s", e.Op, e.Path, t)
	}
	return fmt.Sprintf("%s: %s", e.Op, t)
}

// IsNotFound reports whether err means the file or path does not exist.
func IsNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && (e.Code == 0x02 || e.Code == 0x03)
}

// Open signs on to the file server and negotiates attributes.
func Open(o hs.DialOptions) (*Client, error) {
	c, err := hs.Dial(hs.ServerFile, "as-file", o)
	if err != nil {
		return nil, err
	}
	cl := &Client{c: c}
	body := (&hs.Builder{}).U16(0).U16(16).U16(0x0006).U32(0xFFFFFFFF).Param(cpCCSIDs, []byte{0x04, 0xB0, 0x34, 0xB0, 0xF2, 0x00}).Bytes()
	rep, err := c.Request(&hs.Frame{TemplateLen: 10, ReqRepID: reqExchange, Body: body})
	if err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("file server: %w", err)
	}
	if rep.ReqRepID != repExchange {
		_ = c.Close()
		return nil, fmt.Errorf("file server refused the session (reply %04X, code %d)", rep.ReqRepID, hs.At(rep.Body).U16(22))
	}
	b := hs.At(rep.Body)
	cl.level = b.U16(22)
	cl.maxBlock = b.U32(26)
	return cl, nil
}

// Close ends the session.
func (cl *Client) Close() error { return cl.c.Close() }

// Level is the negotiated datastream level.
func (cl *Client) Level() uint16 { return cl.level }

func utf16Name(s string) []byte {
	u := utf16.Encode([]rune(s))
	out := make([]byte, 2*len(u))
	for i, v := range u {
		out[2*i] = byte(v >> 8)
		out[2*i+1] = byte(v)
	}
	return out
}

func decodeName(b []byte, ccsid uint16) string {
	if ccsid == 1200 || ccsid == 13488 || ccsid == 61952 || ccsid == 0 {
		u := make([]uint16, len(b)/2)
		for i := range u {
			u[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
		}
		return string(utf16.Decode(u))
	}
	return string(b)
}

// Clean normalises an IFS path: absolute, forward slashes, no trailing slash.
func Clean(p string) string {
	p = strings.ReplaceAll(strings.TrimSpace(p), "\\", "/")
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return path.Clean(p)
}

func (cl *Client) returnCode(rep *hs.Frame, op, p string) error {
	if rep.ReqRepID != repReturn {
		return nil
	}
	if code := hs.At(rep.Body).U16(22); code != 0 {
		return &Error{Code: code, Op: op, Path: p}
	}
	return nil
}

func when(b hs.At, off int) time.Time {
	secs := b.U32(off)
	if secs == 0 {
		return time.Time{}
	}
	return time.Unix(int64(secs), int64(b.U32(off+4))*1000).UTC()
}

func parseEntry(rep *hs.Frame) (Entry, bool) {
	b := hs.At(rep.Body)
	tmpl := int(rep.TemplateLen)
	params, _ := b.Params(hs.HeaderLen + tmpl)
	if len(params) == 0 {
		return Entry{}, false
	}
	e := Entry{
		Created:  when(b, 22),
		Modified: when(b, 30),
		Size:     uint64(b.U32(46)),
		Type:     b.U16(54),
	}
	attrs := b.U32(50)
	e.ReadOnly = attrs&0x01 != 0
	e.Hidden = attrs&0x02 != 0
	e.Dir = attrs&0x10 != 0 || e.Type == 2
	if tmpl >= 81+8-hs.HeaderLen {
		if large := b.U64(81); large > 0 {
			e.Size = large
		}
	}
	if tmpl >= 92-hs.HeaderLen {
		e.Symlink = b.U8(91) != 0 || e.Type == 3
	}
	e.Name = decodeName(params[0].Data, b.U16(73))
	return e, true
}

// list sends one list-attributes request for name (a path, or a pattern like "/home/*").
func (cl *Client) list(name, op, display string) ([]Entry, error) {
	body := (&hs.Builder{}).U16(0).U32(0).U16(nameCCSID).U32(1).U16(0).U16(0xFFFF).U16(0x0001).U16(0).
		Param(cpName, utf16Name(name)).Bytes()
	if err := cl.c.Send(&hs.Frame{TemplateLen: 20, ReqRepID: reqList, Body: body}); err != nil {
		return nil, err
	}
	var out []Entry
	for {
		rep, err := cl.c.Read()
		if err != nil {
			return nil, err
		}
		switch rep.ReqRepID {
		case repList:
			if e, ok := parseEntry(rep); ok && e.Name != "." && e.Name != ".." {
				out = append(out, e)
			}
		case repReturn:
			code := hs.At(rep.Body).U16(22)
			if code != 0 && code != rcNoMoreFile {
				return nil, &Error{Code: code, Op: op, Path: display}
			}
			return out, nil
		default:
			return nil, fmt.Errorf("%s %s: unexpected reply %04X", op, display, rep.ReqRepID)
		}
		if hs.At(rep.Body).U16(20)&1 == 0 {
			return out, nil
		}
	}
}

// List returns the entries of a directory.
func (cl *Client) List(dir string) ([]Entry, error) {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	dir = Clean(dir)
	pattern := dir + "/*"
	if dir == "/" {
		pattern = "/*"
	}
	return cl.list(pattern, "list", dir)
}

// Stat returns the entry for one path.
func (cl *Client) Stat(p string) (Entry, error) {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	p = Clean(p)
	es, err := cl.list(p, "stat", p)
	if err != nil {
		return Entry{}, err
	}
	if len(es) == 0 {
		return Entry{}, &Error{Code: 0x02, Op: "stat", Path: p}
	}
	return es[0], nil
}

func (cl *Client) simple(id, cp uint16, tmpl uint16, head *hs.Builder, name, op string) error {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	rep, err := cl.c.Request(&hs.Frame{TemplateLen: tmpl, ReqRepID: id, Body: head.Param(cp, utf16Name(name)).Bytes()})
	if err != nil {
		return err
	}
	return cl.returnCode(rep, op, name)
}

// Mkdir creates a directory.
func (cl *Client) Mkdir(p string) error {
	p = Clean(p)
	return cl.simple(reqMkdir, cpDirName, 8, (&hs.Builder{}).U16(0).U16(nameCCSID).U32(1), p, "create folder")
}

// Remove deletes a file, or an empty directory when dir is true.
func (cl *Client) Remove(p string, dir bool) error {
	p = Clean(p)
	if dir {
		return cl.simple(reqRmdir, cpDirName, 8, (&hs.Builder{}).U16(0).U16(nameCCSID).U32(1), p, "delete folder")
	}
	return cl.simple(reqDelete, cpName, 8, (&hs.Builder{}).U16(0).U16(nameCCSID).U32(1), p, "delete")
}

// Rename renames or moves a file or directory.
func (cl *Client) Rename(from, to string, replace bool) error {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	from, to = Clean(from), Clean(to)
	flags := uint16(0)
	if replace {
		flags = 1
	}
	body := (&hs.Builder{}).U16(0).U16(nameCCSID).U16(nameCCSID).U32(1).U32(1).U16(flags).
		Param(cpOldName, utf16Name(from)).Param(cpNewName, utf16Name(to)).Bytes()
	rep, err := cl.c.Request(&hs.Frame{TemplateLen: 16, ReqRepID: reqRename, Body: body})
	if err != nil {
		return err
	}
	return cl.returnCode(rep, "rename", from)
}

// Open modes.
const (
	openRead    = iota // access read, open existing
	openReplace        // access write, create or replace
)

func (cl *Client) open(p string, mode int) (uint32, error) {
	access, options := uint16(0x01), uint16(0x08)
	if mode == openReplace {
		access, options = 0x02, 0x02
	}
	b := (&hs.Builder{}).U16(0).U16(nameCCSID).U32(1).U16(nameCCSID).U16(access).U16(0).U16(0).U16(options).
		U32(0).U32(0).U16(1).U32(0).U32(0)
	tmpl := uint16(36)
	if cl.level >= 16 {
		b.U64(0)
		tmpl = 44
	}
	rep, err := cl.c.Request(&hs.Frame{TemplateLen: tmpl, ReqRepID: reqOpen, Body: b.Param(cpName, utf16Name(p)).Bytes()})
	if err != nil {
		return 0, err
	}
	op := "open"
	if mode == openReplace {
		op = "write"
	}
	if err := cl.returnCode(rep, op, p); err != nil {
		return 0, err
	}
	if rep.ReqRepID != repOpen {
		return 0, fmt.Errorf("%s %s: unexpected reply %04X", op, p, rep.ReqRepID)
	}
	return hs.At(rep.Body).U32(22), nil
}

func (cl *Client) closeHandle(h uint32) error {
	body := (&hs.Builder{}).U16(0).U32(h).U16(2).U16(0xFFFF).U16(0).U8(0).U64(0).Bytes()
	rep, err := cl.c.Request(&hs.Frame{TemplateLen: 21, ReqRepID: reqClose, Body: body})
	if err != nil {
		return err
	}
	if rep.ReqRepID == repClose || rep.ReqRepID == repReturn {
		if code := hs.At(rep.Body).U16(22); code != 0 {
			return &Error{Code: code, Op: "close"}
		}
	}
	return nil
}

// Download copies a file to w. progress (optional) gets the bytes done so far.
func (cl *Client) Download(p string, w io.Writer, progress func(done int64)) error {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	p = Clean(p)
	h, err := cl.open(p, openRead)
	if err != nil {
		return err
	}
	var done int64
	readErr := func() error {
		for {
			rb := (&hs.Builder{}).U16(0).U32(h).U32(0).U32(uint32(done)).U32(chunk).U32(0)
			tmpl := uint16(18)
			if cl.level >= 16 {
				rb.U64(0).U64(uint64(done)) // 64-bit offset for files over 4 GB
				tmpl = 38
			}
			if err := cl.c.Send(&hs.Frame{TemplateLen: tmpl, ReqRepID: reqRead, Body: rb.Bytes()}); err != nil {
				return err
			}
			got := 0
			for {
				rep, err := cl.c.Read()
				if err != nil {
					return err
				}
				b := hs.At(rep.Body)
				switch rep.ReqRepID {
				case repRead:
					n := int(b.U32(24)) - 6
					data := b.Slice(30, n)
					if n > 0 && data != nil {
						if _, err := w.Write(data); err != nil {
							return err
						}
						got += n
						done += int64(n)
						if progress != nil {
							progress(done)
						}
					}
				case repReturn:
					code := b.U16(22)
					if code == rcNoMoreData {
						return nil
					}
					if code != 0 {
						return &Error{Code: code, Op: "download", Path: p}
					}
				default:
					return fmt.Errorf("download %s: unexpected reply %04X", p, rep.ReqRepID)
				}
				if b.U16(20)&1 == 0 {
					break
				}
			}
			if got == 0 {
				return nil
			}
		}
	}()
	closeErr := cl.closeHandle(h)
	if readErr != nil {
		return readErr
	}
	return closeErr
}

// Upload writes r to the file at p, replacing it when it exists. progress (optional) gets bytes done.
func (cl *Client) Upload(p string, r io.Reader, progress func(done int64)) error {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	p = Clean(p)
	h, err := cl.open(p, openReplace)
	if err != nil {
		return err
	}
	var done int64
	buf := make([]byte, chunk)
	writeErr := func() error {
		for {
			n, rerr := io.ReadFull(r, buf)
			if n > 0 {
				b := (&hs.Builder{}).U16(0).U32(h).U32(0).U32(uint32(done)).U16(2).U16(0xFFFF)
				tmpl := uint16(18)
				if cl.level >= 16 {
					b.U64(0).U64(uint64(done))
					tmpl = 34
				}
				rep, err := cl.c.Request(&hs.Frame{TemplateLen: tmpl, ReqRepID: reqWrite, Body: b.Param(cpData, buf[:n]).Bytes()})
				if err != nil {
					return err
				}
				rb := hs.At(rep.Body)
				switch rep.ReqRepID {
				case repWrite:
					if code := rb.U16(22); code != 0 {
						return &Error{Code: code, Op: "upload", Path: p}
					}
					if left := rb.U32(28); left != 0 {
						return fmt.Errorf("upload %s: the host wrote %d of %d bytes (disk full or quota?)", p, n-int(left), n)
					}
				case repReturn:
					if code := rb.U16(22); code != 0 {
						return &Error{Code: code, Op: "upload", Path: p}
					}
				default:
					return fmt.Errorf("upload %s: unexpected reply %04X", p, rep.ReqRepID)
				}
				done += int64(n)
				if progress != nil {
					progress(done)
				}
			}
			if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
				return nil
			}
			if rerr != nil {
				return rerr
			}
		}
	}()
	closeErr := cl.closeHandle(h)
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}
