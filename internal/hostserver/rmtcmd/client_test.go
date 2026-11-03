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

func newServer(t *testing.T, level byte) *rmtcmdtest.Server {
	t.Helper()
	s, err := rmtcmdtest.New("127.0.0.1:0", "TESTUSER", "SECRET1", level, handler)
	if err != nil {
		t.Fatal(err)
	}
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
		c := open(t, newServer(t, level))
		if c.ServerCCSID() != 37 || c.level != 10 {
			t.Fatalf("level %d: ccsid %d, datastream level %d", level, c.ServerCCSID(), c.level)
		}
	}
}

func TestWrongPassword(t *testing.T) {
	s := newServer(t, 1)
	_, err := Open(hs.DialOptions{Host: "127.0.0.1", Port: s.Port(), User: "testuser", Password: "WRONG"})
	if err == nil || !strings.Contains(err.Error(), "password is not correct") {
		t.Fatalf("want a wrong-password message, got %v", err)
	}
}

func TestRunSuccessAndFailure(t *testing.T) {
	s := newServer(t, 1)
	c := open(t, s)
	r, err := c.Run("DSPLIBL OUTPUT(*PRINT)")
	if err != nil || r.Failed() || len(r.Messages) != 0 {
		t.Fatalf("DSPLIBL: err %v, result %+v", err, r)
	}
	r, err = c.Run("CHKOBJ OBJ(QGPL/NOPE) OBJTYPE(*FILE)")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Failed() || r.Code != RCFailed || len(r.Messages) != 2 {
		t.Fatalf("CHKOBJ: %+v", r)
	}
	m := r.Messages[0]
	if m.ID != "CPF9801" || m.Type != 2 || m.Severity != 40 || m.File != "QCPFMSG" || m.Library != "QSYS" || !strings.HasSuffix(m.Text, "not found.") || !strings.HasPrefix(m.Help, "Cause") {
		t.Fatalf("message: %+v", m)
	}
	if r.Messages[1].Help != "" {
		t.Fatalf("second message should have no help text: %+v", r.Messages[1])
	}
	if err := r.Err(); err == nil || !strings.Contains(err.Error(), "CPF9801: Object NOPE") {
		t.Fatalf("error text: %v", err)
	}
	if got := s.Ran(); len(got) != 2 || got[1] != "CHKOBJ OBJ(QGPL/NOPE) OBJTYPE(*FILE)" {
		t.Fatalf("commands seen by the server: %q", got)
	}
}

func TestMessagesWithoutHelpLayout(t *testing.T) {
	s := newServer(t, 2)
	s.WithHelp = false
	c := open(t, s)
	r, err := c.Run("SNDPGMMSG MSG('hello')")
	if err != nil || r.Failed() || len(r.Messages) != 1 || r.Messages[0].Text != "hello from the host" || r.Messages[0].Help != "" {
		t.Fatalf("err %v, result %+v", err, r)
	}
}

func TestUnknownMessageLayoutKeepsTheText(t *testing.T) {
	s := newServer(t, 1)
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

func TestParseMessageRejectsShortData(t *testing.T) {
	if _, ok := ParseMessage(make([]byte, 10), false); ok {
		t.Fatal("10 bytes is not a message")
	}
}
