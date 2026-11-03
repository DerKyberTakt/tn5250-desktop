// Package rmtcmd is a client for the IBM i remote command host server (QZRCSRVS,
// "as-rmtcmd", port 8475): it runs CL commands in a server job signed on as the user
// and returns the job's messages. The CL / QSH Console and Run SQL Scripts tools are
// built on it (SQL goes through RUNSQL and CPYTOIMPF, see internal/sqlviacl).
//
// Wire format, after the common host-server header (internal/hostserver/ds.go):
//
//	exchange attributes  request 0x1001, template 14: client CCSID u32, NLV (4 EBCDIC
//	                     characters, "2924" = English), client version u32, datastream
//	                     level u16. Reply 0x8001: return code u16 at offset 20, server
//	                     CCSID u32 at 22, NLV at 26, version at 30, datastream level u16
//	                     at 34.
//	run command          request 0x1002, template 1: message option (2 = all messages),
//	                     then one parameter CP 0x1104 = u32 CCSID of the text + the
//	                     command text. Reply 0x8002: return code u16 at 20 (0 = ran,
//	                     0x0400 = the command failed and the messages say why), then the
//	                     job's messages as parameters CP 0x1102 / 0x1106.
//
// The layouts come from the documented behaviour of IBM's own clients and are checked
// against the fake server in rmtcmdtest; they have not yet been verified byte for byte
// against a live host. A message parameter is known in two layouts (with and without a
// help-text length); the parser takes the one whose lengths add up to the parameter.
package rmtcmd

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"sync"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
)

// Request and reply ids, code points.
const (
	ReqExchange    uint16 = 0x1001
	ReqRun         uint16 = 0x1002
	RepExchange    uint16 = 0x8001
	RepRun         uint16 = 0x8002
	CPCommand      uint16 = 0x1104 // command text preceded by its CCSID
	CPMessage      uint16 = 0x1102 // message without help text
	CPMessageHelp  uint16 = 0x1106 // message with help text
	commandCCSID   uint32 = 37
	clientVersion  uint32 = 1
	datastreamLvl  uint16 = 10
	messagesAll    uint8  = 2
	RCFailed       uint16 = 0x0400 // the command ran and failed; the messages say why
	RCLimitedUser  uint16 = 0x0100 // the profile is limited (LMTCPB); commands cannot run from a client
	nlvEnglish            = "2924"
	maxCommandText        = 32 * 1024
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
	if r.Code == RCLimitedUser {
		return errors.New("the user profile is limited (LMTCPB); it may not run commands from a client")
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
	body := (&hs.Builder{}).U32(commandCCSID).Raw(nlv).U32(clientVersion).U16(datastreamLvl).Bytes()
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

// JobName is the server job that runs the commands (QZRCSRVS ...), when the sign-on told it.
func (cl *Client) JobName() string { return cl.c.JobName }

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
	text, err := hs.EBCDIC(command)
	if err != nil {
		return nil, fmt.Errorf("the command has characters the host cannot take: %w", err)
	}
	param := make([]byte, 4, 4+len(text))
	binary.BigEndian.PutUint32(param, commandCCSID)
	param = append(param, text...)
	body := (&hs.Builder{}).U8(messagesAll).Param(CPCommand, param).Bytes()

	cl.mu.Lock()
	defer cl.mu.Unlock()
	rep, err := cl.c.Request(&hs.Frame{TemplateLen: 1, ReqRepID: ReqRun, Body: body})
	if err != nil {
		return nil, err
	}
	if rep.ReqRepID != RepRun {
		return nil, fmt.Errorf("unexpected reply %04X from the remote command server", rep.ReqRepID)
	}
	b := hs.At(rep.Body)
	res := &Result{Code: b.U16(20)}
	params, _ := b.Params(22)
	for _, p := range params {
		if p.CP != CPMessage && p.CP != CPMessageHelp {
			continue
		}
		if m, ok := ParseMessage(p.Data, p.CP == CPMessageHelp); ok {
			res.Messages = append(res.Messages, m)
		}
	}
	return res, nil
}

// ParseMessage decodes one message parameter (the bytes after LL/CP):
//
//	0   message id        7 EBCDIC
//	7   type              u16
//	9   severity          u16
//	11  message file     10 EBCDIC
//	21  library          10 EBCDIC
//	31  substitution length  u16
//	33  text length          u16
//	35  [help length         u16]   only in the layout with help text
//	    substitution data, text, [help]
//
// When the lengths of neither layout add up to the parameter, the fixed part is kept
// and the text is whatever follows it, so a message is never lost entirely.
func ParseMessage(d []byte, withHelp bool) (Message, bool) {
	if len(d) < 35 {
		return Message{}, false
	}
	m := Message{
		ID:       hs.FromEBCDIC(d[0:7]),
		Type:     binary.BigEndian.Uint16(d[7:9]),
		Severity: binary.BigEndian.Uint16(d[9:11]),
		File:     hs.FromEBCDIC(d[11:21]),
		Library:  hs.FromEBCDIC(d[21:31]),
	}
	subLen := int(binary.BigEndian.Uint16(d[31:33]))
	textLen := int(binary.BigEndian.Uint16(d[33:35]))
	// Layout with a help length (CP 0x1106), then the one without (0x1102).
	if len(d) >= 37 {
		helpLen := int(binary.BigEndian.Uint16(d[35:37]))
		if 37+subLen+textLen+helpLen == len(d) && (withHelp || helpLen > 0) {
			m.Text = hs.FromEBCDIC(d[37+subLen : 37+subLen+textLen])
			m.Help = hs.FromEBCDIC(d[37+subLen+textLen:])
			return m, true
		}
	}
	if 35+subLen+textLen == len(d) {
		m.Text = hs.FromEBCDIC(d[35+subLen:])
		return m, true
	}
	// Unknown layout: take the text after the fixed part, skipping what looks like substitution data.
	start := 35 + subLen
	if start > len(d) {
		start = 35
	}
	m.Text = hs.FromEBCDIC(d[start:])
	return m, true
}
