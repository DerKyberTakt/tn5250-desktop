package rmtcmd

import (
	"strings"
	"testing"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/rmtcmd/rmtcmdtest"
)

func handler(command string) (uint16, []rmtcmdtest.Message) {
	switch {
	case strings.HasPrefix(command, "DSPLIBL"):
		return 0, nil
	case strings.HasPrefix(command, "CHKOBJ"):
		return RCFailed, []rmtcmdtest.Message{
			{ID: "CPF9801", Type: 2, Severity: 40, File: "QCPFMSG", Library: "QSYS", Text: "Object NOPE in library QGPL not found.", Help: "Cause . . . . . :   The object was not found."},
			{ID: "CPF9801", Type: 15, Severity: 40, File: "QCPFMSG", Library: "QSYS", Text: "Object NOPE in library QGPL not found."},
		}
	case strings.HasPrefix(command, "SNDPGMMSG"):
		return 0, []rmtcmdtest.Message{{ID: "", Type: 1, Severity: 0, Text: "hello from the host"}}
	}
	return RCFailed, []rmtcmdtest.Message{{ID: "CPF0006", Type: 15, Severity: 30, File: "QCPFMSG", Library: "QSYS", Text: "Errors occurred in command."}}
}

func newServer(t *testing.T, level byte, dsl uint16) *rmtcmdtest.Server {
	t.Helper()
	s, err := rmtcmdtest.New("127.0.0.1:0", "TESTUSER", "SECRET1", level, handler)
	if err != nil {
		t.Fatal(err)
	}
	s.DSL = dsl
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func open(t *testing.T, s *rmtcmdtest.Server) *Client {
	t.Helper()
	c, err := Open(hs.DialOptions{Host: "127.0.0.1", Port: s.Port(), User: "testuser", Password: "SECRET1"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestOpenExchangesAttributes(t *testing.T) {
	for _, level := range []byte{1, 2} {
		c := open(t, newServer(t, level, 11))
		if c.ServerCCSID() != 37 || c.Level() != 11 {
			t.Fatalf("level %d: ccsid %d, datastream level %d", level, c.ServerCCSID(), c.Level())
		}
	}
}

func TestWrongPassword(t *testing.T) {
	s := newServer(t, 1, 11)
	_, err := Open(hs.DialOptions{Host: "127.0.0.1", Port: s.Port(), User: "testuser", Password: "WRONG"})
	if err == nil || !strings.Contains(err.Error(), "password is not correct") {
		t.Fatalf("want a wrong-password message, got %v", err)
	}
}

// checkCHKOBJ is what every layout must deliver for the CHKOBJ messages of the handler.
func checkCHKOBJ(t *testing.T, r *Result) {
	t.Helper()
	if !r.Failed() || r.Code != RCFailed || len(r.Messages) != 2 {
		t.Fatalf("CHKOBJ: %+v", r)
	}
	m := r.Messages[0]
	if m.ID != "CPF9801" || m.Type != 2 || m.Severity != 40 || m.File != "QCPFMSG" || m.Library != "QSYS" || !strings.HasSuffix(m.Text, "not found.") {
		t.Fatalf("message: %+v", m)
	}
	if r.Messages[1].Type != 15 || r.Messages[1].Help != "" {
		t.Fatalf("second message: %+v", r.Messages[1])
	}
	if err := r.Err(); err == nil || !strings.Contains(err.Error(), "CPF9801: Object NOPE") {
		t.Fatalf("error text: %v", err)
	}
}

// A current host (level 11): the command goes as UTF-16 tagged 1200 with message option 6,
// and the messages come back in the QMHRCVPM layout (CP 0x1107) with their help text.
func TestLevel11UnicodeCommandAndFullMessages(t *testing.T) {
	s := newServer(t, 1, 11)
	c := open(t, s)
	r, err := c.Run("DSPLIBL OUTPUT(*PRINT)")
	if err != nil || r.Failed() || len(r.Messages) != 0 {
		t.Fatalf("DSPLIBL: err %v, result %+v", err, r)
	}
	r, err = c.Run("CHKOBJ OBJ(QGPL/NOPE) OBJTYPE(*FILE)")
	if err != nil {
		t.Fatal(err)
	}
	checkCHKOBJ(t, r)
	if !strings.HasPrefix(r.Messages[0].Help, "Cause") {
		t.Fatalf("help text: %+v", r.Messages[0])
	}
	if got := s.Ran(); len(got) != 2 || got[1] != "CHKOBJ OBJ(QGPL/NOPE) OBJTYPE(*FILE)" {
		t.Fatalf("commands seen by the server: %q", got)
	}
	if len(s.Options) != 2 || s.Options[0] != 6 {
		t.Fatalf("message option bytes: %v", s.Options)
	}
}

// Level 10: message option 4 and the CP 0x1106 layout.
func TestLevel10Layout(t *testing.T) {
	s := newServer(t, 2, 10)
	c := open(t, s)
	r, err := c.Run("CHKOBJ OBJ(QGPL/NOPE) OBJTYPE(*FILE)")
	if err != nil {
		t.Fatal(err)
	}
	checkCHKOBJ(t, r)
	if !strings.HasPrefix(r.Messages[0].Help, "Cause") || s.Options[0] != 4 {
		t.Fatalf("level 10: help %q option %d", r.Messages[0].Help, s.Options[0])
	}
}

// Before level 10 the command is EBCDIC in CP 0x1101 and the messages use the fixed layout.
func TestLegacyLevelEBCDICCommandAndFixedMessages(t *testing.T) {
	s := newServer(t, 1, 7)
	c := open(t, s)
	r, err := c.Run("CHKOBJ OBJ(QGPL/NOPE) OBJTYPE(*FILE)")
	if err != nil {
		t.Fatal(err)
	}
	checkCHKOBJ(t, r)
	if s.Options[0] != 2 || s.Ran()[0] != "CHKOBJ OBJ(QGPL/NOPE) OBJTYPE(*FILE)" {
		t.Fatalf("legacy level: option %d commands %q", s.Options[0], s.Ran())
	}
	r, err = c.Run("SNDPGMMSG MSG('hello')")
	if err != nil || r.Failed() || len(r.Messages) != 1 || r.Messages[0].Text != "hello from the host" || r.Messages[0].Type != 1 {
		t.Fatalf("err %v, result %+v", err, r)
	}
}

func TestGarbledFixedLayoutKeepsTheText(t *testing.T) {
	s := newServer(t, 1, 7)
	s.Garble = true
	c := open(t, s)
	r, err := c.Run("CHKOBJ OBJ(QGPL/NOPE) OBJTYPE(*FILE)")
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Messages) != 2 || r.Messages[1].ID != "CPF9801" || !strings.Contains(r.Messages[1].Text, "not found") {
		t.Fatalf("garbled layout: %+v", r.Messages)
	}
}

// The fake host refuses a command whose CCSID is not 1200 with 0x0401, the way the real one
// did when the client sent EBCDIC tagged 37; a result with that code explains itself.
func TestBadCCSIDResultExplainsItself(t *testing.T) {
	r := &Result{Code: RCBadCCSID}
	if err := r.Err(); err == nil || !strings.Contains(err.Error(), "0401") {
		t.Fatalf("want the CCSID explanation, got %v", err)
	}
}

func TestParseMessagesIgnoresShortData(t *testing.T) {
	// Count 1 but a parameter shorter than the fixed layout: nothing, no panic.
	body := (&hs.Builder{}).U16(0).U16(1).Param(CPMessage, make([]byte, 10)).Bytes()
	if got := ParseMessages(body); len(got) != 0 {
		t.Fatalf("10 bytes is not a message: %+v", got)
	}
	if got := ParseMessages(nil); got != nil {
		t.Fatalf("empty body: %+v", got)
	}
}
