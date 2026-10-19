// Command hsrecord is a development tool: a fake IBM i host server on localhost
// that answers just enough of the sign-on and file server handshake for a real
// client (for example IBM's Java toolbox) to talk to it, and logs every request.
// The logs give exact protocol bytes and password-substitute test vectors without
// touching a real system. Use made-up user profiles and passwords only.
package main

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"sync"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
	"golang.org/x/text/encoding/charmap"
)

var (
	level      = flag.Int("level", 1, "password level to announce (0-3)")
	signonPort = flag.Int("signon", 18476, "sign-on server port")
	filePort   = flag.Int("file", 18473, "file server port")
	outPath    = flag.String("out", "hsrecord.jsonl", "log file (JSON lines)")
	serverSeed = []byte{0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF}
	fileData   = []byte("Hello from the fake IFS")
	mu         sync.Mutex
	out        *os.File
)

type record struct {
	Port     int    `json:"port"`
	ReqRepID string `json:"reqRepId"`
	HeaderID string `json:"headerId"`
	Template int    `json:"templateLen"`
	Hex      string `json:"hex"`
}

func logFrame(port int, f *hs.Frame) {
	mu.Lock()
	defer mu.Unlock()
	b, _ := json.Marshal(record{Port: port, ReqRepID: fmt.Sprintf("%04X", f.ReqRepID), HeaderID: fmt.Sprintf("%04X", f.HeaderID), Template: int(f.TemplateLen), Hex: hex.EncodeToString(f.Bytes())})
	_, _ = out.Write(append(b, '\n'))
	log.Printf("port %d  req %04X  hdr %04X  tmpl %d  len %d", port, f.ReqRepID, f.HeaderID, f.TemplateLen, len(f.Body)+hs.HeaderLen)
}

func ebcdic(s string, n int) []byte {
	b, _ := charmap.CodePage037.NewEncoder().Bytes([]byte(s))
	for len(b) < n {
		b = append(b, 0x40)
	}
	return b[:n]
}

func reply(req *hs.Frame, id uint16, tmpl uint16, body []byte) *hs.Frame {
	return &hs.Frame{HeaderID: req.HeaderID, ServerID: req.ServerID, CSInstance: req.CSInstance, Correlation: req.Correlation, TemplateLen: tmpl, ReqRepID: id, Body: body}
}

func answer(req *hs.Frame) []*hs.Frame {
	jobName := append([]byte{0, 0, 0, 37}, ebcdic("123456/QUSER/QPWFSERVSO", 23)...)
	switch req.ReqRepID {
	case 0x7001: // exchange random seeds
		r := reply(req, 0xF001, 12, (&hs.Builder{}).U32(0).Raw(serverSeed).Bytes())
		r.HeaderID = uint16(req.HeaderID&0xFF00) | uint16(*level)
		return []*hs.Frame{r}
	case 0x7002: // start server
		body := (&hs.Builder{}).U32(0).Param(0x1104, ebcdic("TESTUSER", 10)).Param(0x111F, jobName).Bytes()
		return []*hs.Frame{reply(req, 0xF002, 4, body)}
	case 0x7003: // sign-on exchange attributes
		body := (&hs.Builder{}).U32(0).
			Param(0x1101, []byte{0x00, 0x07, 0x05, 0x00}).
			Param(0x1102, []byte{0x00, 0x0A}).
			Param(0x1103, serverSeed).
			Param(0x1119, []byte{byte(*level)}).
			Param(0x111F, jobName).Bytes()
		return []*hs.Frame{reply(req, 0xF003, 4, body)}
	case 0x7004: // sign-on info
		date := []byte{0x07, 0xEA, 10, 19, 12, 0, 0, 0, 0, 0, 0}
		body := (&hs.Builder{}).U32(0).
			Param(0x1106, date).Param(0x1107, date).Param(0x1108, date).
			Param(0x1114, []byte{0, 0, 0, 37}).
			Param(0x1104, ebcdic("TESTUSER", 10)).Bytes()
		return []*hs.Frame{reply(req, 0xF004, 4, body)}
	case 0x0016: // file server exchange attributes
		body := (&hs.Builder{}).U16(0).U16(16).U16(0).U32(65535).U32(6 + 2).U16(0x000A).U16(1200).Bytes()
		return []*hs.Frame{reply(req, 0x8009, 16, body)}
	case 0x000A: // list attributes: two entries, then "no more files"
		return append(listEntries(req), reply(req, 0x8001, 4, (&hs.Builder{}).U16(0).U16(0x12).Bytes()))
	case 0x0002: // open: handle 0x1234, file size at offset 89 (DS level 16)
		b := (&hs.Builder{}).U16(0).U32(0x1234)
		for b.Len() < 89-hs.HeaderLen {
			b.U8(0)
		}
		b.U64(uint64(len(fileData)))
		return []*hs.Frame{reply(req, 0x8002, uint16(b.Len()), b.Bytes())}
	case 0x0003: // read: everything at offset 0, then end of data
		off := int(hs.At(req.Body).U64(50))
		if off < len(fileData) {
			return []*hs.Frame{reply(req, 0x8003, 4, (&hs.Builder{}).U16(0).U16(0xFFFF).Param(0x0020, fileData[off:]).Bytes())}
		}
		return []*hs.Frame{reply(req, 0x8001, 4, (&hs.Builder{}).U16(0).U16(0x16).Bytes())}
	case 0x0004: // write: all written
		return []*hs.Frame{reply(req, 0x800B, 12, (&hs.Builder{}).U16(0).U16(0).U32(0).U32(0).Bytes())}
	case 0x0009: // close
		return []*hs.Frame{reply(req, 0x8004, 4, (&hs.Builder{}).U16(0).U16(0).Bytes())}
	default: // mkdir, delete, rename, ...: success
		return []*hs.Frame{reply(req, 0x8001, 4, (&hs.Builder{}).U16(0).U16(0).Bytes())}
	}
}

// listEntries answers a list request with a directory and a file (template layout of DS level 16).
func listEntries(req *hs.Frame) []*hs.Frame {
	entry := func(name string, dir bool, size uint64, secs uint32) *hs.Frame {
		b := &hs.Builder{}
		b.U16(1)                 // chain indicator: more replies follow
		b.U32(secs).U32(250000)  // create: seconds, microseconds
		b.U32(secs + 60).U32(0)  // modify
		b.U32(secs + 120).U32(0) // access
		b.U32(uint32(size))      // size (32-bit)
		attrs, typ := uint32(0), uint16(1)
		if dir {
			attrs, typ = 0x10, 2
		}
		b.U32(attrs).U16(typ).U16(0).U32(0).U32(0).U32(7).U16(0).U8(0)
		b.U16(1200).U16(0).U32(0) // name CCSID, checkout CCSID, restart id (ends at offset 81)
		b.U64(size).U16(1).U8(0)  // large size, file system type, symlink
		tmpl := uint16(b.Len())
		units := []byte{}
		for _, r := range name {
			units = append(units, byte(r>>8), byte(r))
		}
		b.Param(0x0002, units)
		return reply(req, 0x8005, tmpl, b.Bytes())
	}
	return []*hs.Frame{entry("projects", true, 0, 1760000000), entry("notes.txt", false, 5000000000, 1760003600)}
}

func serve(port int) {
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("listening on %d", port)
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		go func(c net.Conn) {
			defer c.Close()
			for {
				f, err := hs.ReadFrame(c)
				if err != nil {
					return
				}
				logFrame(port, f)
				for _, r := range answer(f) {
					if _, err := c.Write(r.Bytes()); err != nil {
						return
					}
				}
			}
		}(c)
	}
}

func main() {
	flag.Parse()
	var err error
	out, err = os.Create(*outPath)
	if err != nil {
		log.Fatal(err)
	}
	go serve(*signonPort)
	serve(*filePort)
}
