// Package rmtcmd is a client for the IBM i remote command host server (QZRCSRVS,
// "as-rmtcmd", port 8475): it runs CL commands in a server job signed on as the user
// and returns the job's messages. The CL / QSH Console and Run SQL Scripts tools are
// built on it (SQL goes through RUNSQL and CPYTOIMPF, see internal/sqlviacl).
//
// Wire format, after the common host-server header (internal/hostserver/ds.go). The
// layouts follow IBM's own client (JTOpen: RCExchangeAttributesRequestDataStream,
// RCRunCommandRequestDataStream, RemoteCommandImplRemote.parseMessages):
//
//	exchange attributes  request 0x1001, template 14: client CCSID u32 at 20, NLV at 24
//	                     (4 EBCDIC digits, "2924" = English), client version u32 at 28,
//	                     two reserved bytes. Reply 0x8001: return code u16 at 20, server
//	                     job CCSID u32 at 22, NLV at 26, version at 30, datastream level
//	                     u16 at 34.
//	run command          request 0x1002, template 1: the message option byte at 20 (its
//	                     values depend on the datastream level, see messageOption), then
//	                     the command as one parameter: at level 10 and up CP 0x1104 =
//	                     u32 CCSID 1200 + the text in UTF-16; below that CP 0x1101 = the
//	                     text in the job's EBCDIC. Reply 0x8002: return code u16 at 20
//	                     (0 = ran, 0x0400 = failed and the messages say why, 0x0401 =
//	                     the command's CCSID was refused), message count u16 at 22, then
//	                     the messages as parameters from 24 (CP 0x1107 at level 11, 0x1106
//	                     at level 10, the fixed layout before that; see ParseMessages).
package rmtcmd

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"sync"
	"unicode/utf16"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
)

// Request and reply ids, code points, return codes.
const (
	ReqExchange     uint16 = 0x1001
	ReqRun          uint16 = 0x1002
	RepExchange     uint16 = 0x8001
	RepRun          uint16 = 0x8002
	CPCommandEBCDIC uint16 = 0x1101 // command text in the job CCSID (datastream level below 10)
	CPCommand       uint16 = 0x1104 // u32 CCSID 1200 + command text in UTF-16 (level 10 and up)
	CPMessage       uint16 = 0x1102 // message, fixed layout (older levels)
	CPMessageCCSID  uint16 = 0x1106 // message with text/substitution CCSIDs (level 10)
	CPMessageFull   uint16 = 0x1107 // message in the QMHRCVPM layout (level 11 and up)
	clientCCSID     uint32 = 37
	clientVersion   uint32 = 1
	unicodeCCSID    uint32 = 1200
	RCFailed        uint16 = 0x0400 // the command ran and failed; the messages say why
	RCBadCCSID      uint16 = 0x0401 // the server refused the CCSID of the command text
	RCLimitedUser   uint16 = 0x0100 // the profile is limited (LMTCPB); commands cannot run from a client
	nlvEnglish             = "2924"
	maxCommandText         = 32 * 1024
)

// Message is one job message the command produced.
type Message struct {
	ID       string `json:"id"`       // CPF2105, SQL0204 ...
	Type     uint16 `json:"type"`     // 1 completion, 2 diagnostic, 4 informational, 15 escape ...
	Severity uint16 `json:"severity"` // 0-99
	File     string `json:"file"`     // message file, e.g. QCPFMSG
	Library  string `json:"library"`
	Text     string `json:"text"`
	Help     string `json:"help,omitempty"`
}

// Result is the outcome of one command.
type Result struct {
	// Code is the server's return code: 0 = the command ran, RCFailed = it failed.
	Code     uint16
	Messages []Message
}

// Failed reports whether the command ended in error.
func (r *Result) Failed() bool { return r.Code != 0 }

// Err returns the last escape message as an error, or a generic one; nil when the command ran.
func (r *Result) Err() error {
	if !r.Failed() {
		return nil
	}
	for i := len(r.Messages) - 1; i >= 0; i-- {
		if m := r.Messages[i]; m.Text != "" {
			return fmt.Errorf("%s: %s", m.ID, m.Text)
		}
	}
	switch r.Code {
	case RCLimitedUser:
		return errors.New("the user profile is limited (LMTCPB); it may not run commands from a client")
	case RCBadCCSID:
		return errors.New("the remote command server refused the command's CCSID (return code 0401)")
	}
	return fmt.Errorf("the command failed (remote command server return code %04X)", r.Code)
}

// Client is one signed-on remote command server connection; calls are serialised.
type Client struct {
	mu    sync.Mutex
	c     *hs.Conn
	ccsid uint32
	level uint16
}

// Open signs on to the remote command server and exchanges attributes.
func Open(o hs.DialOptions) (*Client, error) {
	c, err := hs.Dial(hs.ServerCommand, "as-rmtcmd", o)
	if err != nil {
		return nil, err
	}
	nlv, err := hs.EBCDIC(nlvEnglish)
	if err != nil {
		_ = c.Close()
		return nil, err
	}
	// 14-byte template: CCSID, NLV, client version, two bytes IBM's client leaves zero.
	body := (&hs.Builder{}).U32(clientCCSID).Raw(nlv).U32(clientVersion).U16(0).Bytes()
	rep, err := c.Request(&hs.Frame{TemplateLen: 14, ReqRepID: ReqExchange, Body: body})
	if err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("remote command server: %w", err)
	}
	b := hs.At(rep.Body)
	if rep.ReqRepID != RepExchange || b.U16(20) != 0 {
		_ = c.Close()
		return nil, fmt.Errorf("the remote command server refused the session (reply %04X, code %04X)", rep.ReqRepID, b.U16(20))
	}
	return &Client{c: c, ccsid: b.U32(22), level: b.U16(34)}, nil
}

// Close ends the session (and the server job).
func (cl *Client) Close() error { return cl.c.Close() }

// ServerCCSID is the CCSID the server job announced.
func (cl *Client) ServerCCSID() uint32 { return cl.ccsid }

// Level is the datastream level the server announced.
func (cl *Client) Level() uint16 { return cl.level }

// JobName is the server job that runs the commands (QZRCSRVS ...), when the sign-on told it.
func (cl *Client) JobName() string { return cl.c.JobName }

// messageOption is the byte at offset 20 of the run request: how many messages to return
// and, from level 10 on, in which layout. The values moved with the datastream level
// (JTOpen RCRunCommandRequestDataStream): below level 7 the server knows 0 = up to ten
// messages and 1 = none; levels 7-9 add 2 = all; level 10 renumbers them 3 = up to ten /
// 4 = all and answers in the CP 0x1106 layout; level 11 uses 5 / 6 and CP 0x1107.
func messageOption(level uint16) uint8 {
	switch {
	case level >= 11:
		return 6
	case level >= 10:
		return 4
	case level >= 7:
		return 2
	default:
		return 0
	}
}

// Run runs one CL command and returns its messages. A failed command is not an error:
// check Result.Failed (network and protocol problems are errors).
func (cl *Client) Run(command string) (*Result, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil, errors.New("no command")
	}
	if len(command) > maxCommandText {
		return nil, fmt.Errorf("the command is longer than %d characters", maxCommandText)
	}
	body := (&hs.Builder{}).U8(messageOption(cl.level))
	if cl.level >= 10 {
		// CP 0x1104: the text in UTF-16 tagged 1200. The server refuses other CCSIDs here (0x0401).
		param := make([]byte, 4, 4+2*len(command))
		binary.BigEndian.PutUint32(param, unicodeCCSID)
		for _, u := range utf16.Encode([]rune(command)) {
			param = binary.BigEndian.AppendUint16(param, u)
		}
		body.Param(CPCommand, param)
	} else {
		text, err := hs.EBCDIC(command)
		if err != nil {
			return nil, fmt.Errorf("the command has characters the host cannot take: %w", err)
		}
		body.Param(CPCommandEBCDIC, text)
	}

	cl.mu.Lock()
	defer cl.mu.Unlock()
	rep, err := cl.c.Request(&hs.Frame{TemplateLen: 1, ReqRepID: ReqRun, Body: body.Bytes()})
	if err != nil {
		return nil, err
	}
	if rep.ReqRepID != RepRun {
		return nil, fmt.Errorf("unexpected reply %04X from the remote command server", rep.ReqRepID)
	}
	b := hs.At(rep.Body)
	return &Result{Code: b.U16(20), Messages: ParseMessages(rep.Body)}, nil
}

// ParseMessages reads the messages of a run command reply (the frame body: offsets count
// from the frame start, as in hs.At): the count at 22, then one LL/CP parameter per
// message from 24. Three layouts exist, told apart by the code point, exactly as IBM's
// client does (RemoteCommandImplRemote.parseMessages):
//
//	0x1107  QMHRCVPM fields, each a u32 length followed by the value (level 11 and up)
//	0x1106  text CCSID u32, substitution CCSID u32, severity u16, then length-prefixed
//	        type, id, file, library, text, substitution data, help (level 10)
//	other   fixed: id 7 EBCDIC, type 2 EBCDIC digits, severity u16, file 10, library 10,
//	        substitution length u16, text length u16, substitution data, text
//
// A message whose layout does not add up keeps what could be read, so nothing is lost
// entirely.
func ParseMessages(body []byte) []Message {
	b := hs.At(body)
	count := int(b.U16(22))
	var out []Message
	off := 24
	for i := 0; i < count; i++ {
		ll := int(b.U32(off))
		if ll < 6 {
			break
		}
		data := b.Slice(off+6, ll-6)
		if data == nil {
			break
		}
		switch b.U16(off + 4) {
		case CPMessageFull:
			out = append(out, parseFull(data))
		case CPMessageCCSID:
			out = append(out, parseWithCCSID(data))
		default:
			if m, ok := parseFixed(data); ok {
				out = append(out, m)
			}
		}
		off += ll
	}
	return out
}

// cursor walks a message parameter; reads past the end yield what is left and set short.
type cursor struct {
	b     []byte
	i     int
	short bool
}

func (c *cursor) take(n int) []byte {
	if n < 0 || c.i+n > len(c.b) {
		c.short = true
		rest := c.b[min(c.i, len(c.b)):]
		c.i = len(c.b)
		return rest
	}
	v := c.b[c.i : c.i+n]
	c.i += n
	return v
}

func (c *cursor) u16() uint16 {
	v := c.take(2)
	if len(v) < 2 {
		return 0
	}
	return binary.BigEndian.Uint16(v)
}

func (c *cursor) u32() uint32 {
	v := c.take(4)
	if len(v) < 4 {
		return 0
	}
	return binary.BigEndian.Uint32(v)
}

// lbytes reads a u32 length and that many bytes.
func (c *cursor) lbytes() []byte { return c.take(int(c.u32())) }

// lstr reads a length-prefixed EBCDIC string, trimmed.
func (c *cursor) lstr() string { return strings.TrimSpace(hs.FromEBCDIC(c.lbytes())) }

// lu32 reads a u32 length and a u32 value stored in that many bytes (QMHRCVPM BIN(4) fields).
func (c *cursor) lu32() uint32 {
	v := c.lbytes()
	if len(v) < 4 {
		return 0
	}
	return binary.BigEndian.Uint32(v)
}

// typeDigits turns the two EBCDIC digits of a message type ("15") into its number.
func typeDigits(b []byte) uint16 {
	if len(b) < 2 {
		return 0
	}
	return uint16(b[0]&0x0F)*10 + uint16(b[1]&0x0F)
}

// decodeText turns message text in the given CCSID into a string: UTF-16 for the Unicode
// CCSIDs, otherwise the job's EBCDIC (IBM's client converts with the job CCSID too).
func decodeText(b []byte, ccsid uint32) string {
	if ccsid == 1200 || ccsid == 13488 || ccsid == 17584 {
		u := make([]uint16, 0, len(b)/2)
		for i := 0; i+1 < len(b); i += 2 {
			u = append(u, binary.BigEndian.Uint16(b[i:]))
		}
		return string(utf16.Decode(u))
	}
	return hs.FromEBCDIC(b)
}

// parseWithCCSID is the CP 0x1106 layout (AS400ImplRemote.parseMessage).
func parseWithCCSID(d []byte) Message {
	c := &cursor{b: d}
	textCCSID := c.u32()
	_ = c.u32() // substitution data CCSID
	m := Message{Severity: c.u16()}
	m.Type = typeDigits(c.lbytes())
	m.ID = c.lstr()
	m.File = c.lstr()
	m.Library = c.lstr()
	m.Text = strings.TrimRight(decodeText(c.lbytes(), textCCSID), " ")
	_ = c.lbytes() // substitution data
	m.Help = strings.TrimSpace(decodeText(c.lbytes(), textCCSID))
	return m
}

// parseFull is the CP 0x1107 layout: the QMHRCVPM fields, each preceded by its length, in
// the order IBM's client reads them.
func parseFull(d []byte) Message {
	c := &cursor{b: d}
	m := Message{Severity: uint16(c.lu32())}
	m.ID = c.lstr()
	m.Type = typeDigits(c.lbytes())
	_ = c.lbytes() // message key
	m.File = c.lstr()
	_ = c.lstr()         // message file library specified
	m.Library = c.lstr() // message file library used
	for i := 0; i < 11; i++ {
		// sending job, user, number, program, instruction, date, time, receiving program,
		// instruction, sending type, receiving type
		_ = c.lbytes()
	}
	_ = c.lu32()          // text CCSID conversion status
	_ = c.lu32()          // data CCSID conversion status
	_ = c.lbytes()        // alert option
	textCCSID := c.lu32() // CCSID of the message and help text
	_ = c.lu32()          // CCSID of the replacement data
	_ = c.lbytes()        // replacement data
	m.Text = strings.TrimRight(decodeText(c.lbytes(), textCCSID), " ")
	m.Help = strings.TrimSpace(decodeText(c.lbytes(), textCCSID))
	return m
}

// parseFixed is the layout of the older levels (and CP 0x1102).
func parseFixed(d []byte) (Message, bool) {
	if len(d) < 35 {
		return Message{}, false
	}
	m := Message{
		ID:       strings.TrimSpace(hs.FromEBCDIC(d[0:7])),
		Type:     typeDigits(d[7:9]),
		Severity: binary.BigEndian.Uint16(d[9:11]),
		File:     strings.TrimSpace(hs.FromEBCDIC(d[11:21])),
		Library:  strings.TrimSpace(hs.FromEBCDIC(d[21:31])),
	}
	subLen := int(binary.BigEndian.Uint16(d[31:33]))
	textLen := int(binary.BigEndian.Uint16(d[33:35]))
	start := 35 + subLen
	if start > len(d) {
		start = 35
	}
	end := start + textLen
	if end > len(d) || textLen == 0 {
		end = len(d)
	}
	m.Text = strings.TrimRight(hs.FromEBCDIC(d[start:end]), " ")
	return m, true
}
