package db

import (
	"errors"
	"strings"
	"testing"
	"time"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/db/dbtest"
)

// customers is the table every query in these tests returns: one column per type
// family, two rows, the second with NULLs.
var customers = dbtest.Table{
	Cols: []dbtest.Col{
		{Name: "CUSNUM", Type: 484, Length: 4, Scale: 0, Precision: 7, CCSID: 65535}, // DECIMAL(7,0) packed
		{Name: "LSTNAM", Type: 453, Length: 8, CCSID: 37},                            // CHAR(8) nullable
		{Name: "CITY", Type: 449, Length: 22, CCSID: 37},                             // VARCHAR(20) nullable
		{Name: "BALDUE", Type: 485, Length: 4, Scale: 2, Precision: 6, CCSID: 65535}, // DECIMAL(6,2) nullable
		{Name: "CDTLMT", Type: 488, Length: 5, Scale: 0, Precision: 5, CCSID: 65535}, // NUMERIC(5,0) zoned
		{Name: "QTY", Type: 497, Length: 4, CCSID: 65535},                            // INTEGER nullable
		{Name: "FLAGS", Type: 500, Length: 2, CCSID: 65535},                          // SMALLINT
		{Name: "BIGONE", Type: 492, Length: 8, CCSID: 65535},                         // BIGINT
		{Name: "RATIO", Type: 480, Length: 8, CCSID: 65535},                          // DOUBLE
		{Name: "SINCE", Type: 384, Length: 10, CCSID: 37},                            // DATE
		{Name: "AT", Type: 388, Length: 8, CCSID: 37},                                // TIME
		{Name: "STAMP", Type: 392, Length: 26, CCSID: 37},                            // TIMESTAMP
		{Name: "NOTE", Type: 465, Length: 42, CCSID: 13488},                          // VARGRAPHIC(20) nullable
		{Name: "KEY", Type: 912, Length: 4, CCSID: 65535},                            // BINARY(4)
		{Name: "MEMO", Type: 409, Length: 4 + 64, CCSID: 37},                         // CLOB inline, nullable
	},
	Rows: [][]any{
		{"938472", "Henning", "Dallas", "-37.00", "5000", int64(12), int64(3), int64(9007199254740993), 0.5, "2026-11-09", "23:15:59", "2026-11-09-23.15.59.123456", "Größe ✓", []byte{0xDE, 0xAD, 0xBE, 0xEF}, "a longer text"},
		{"839283", nil, nil, nil, "0", nil, int64(-1), int64(-2), -1.25, "0001-01-01", "00:00:00", "0001-01-01-00.00.00.000000", nil, []byte{0, 0, 0, 1}, nil},
	},
}

func handler(sql string) any {
	s := strings.ToUpper(strings.TrimSpace(sql))
	switch {
	case strings.HasPrefix(s, "SELECT * FROM QIWS.QCUSTCDT"):
		return customers
	case strings.HasPrefix(s, "SELECT N FROM"):
		t := dbtest.Table{Cols: []dbtest.Col{{Name: "N", Type: 496, Length: 4, CCSID: 65535}}}
		for i := int64(1); i <= 7; i++ {
			t.Rows = append(t.Rows, []any{i})
		}
		return t
	case strings.HasPrefix(s, "SELECT * FROM NOWHERE"):
		return dbtest.Fail{Class: 7, Code: -204, ID: "SQL0204", Text: "NOWHERE in QGPL type *FILE not found.", SQLCode: -204, SQLState: "42704"}
	case strings.HasPrefix(s, "INSERT"):
		return dbtest.Exec{Count: 3}
	case strings.HasPrefix(s, "DELETE FROM EMPTY"):
		return dbtest.Exec{Count: 0}
	case strings.HasPrefix(s, "CREATE"):
		return dbtest.Exec{}
	case strings.HasPrefix(s, "UPDATE WARN"):
		return dbtest.Fail{Class: 7, Code: 1, ID: "SQL0100", Text: "Row not found for UPDATE.", SQLCode: 100, SQLState: "02000"}
	case strings.HasPrefix(s, "UPDATE LOUD"):
		return dbtest.Fail{Class: 7, Code: 464, ID: "SQL0464", Text: "Procedure returned result sets.", SQLCode: 464, SQLState: "0100E"}
	}
	return dbtest.Fail{Class: 7, Code: -104, ID: "SQL0104", Text: "Token not valid.", SQLCode: -104, SQLState: "42601"}
}

func newServer(t *testing.T) *dbtest.Server {
	t.Helper()
	s, err := dbtest.New("127.0.0.1:0", "TESTUSER", "SECRET1", 2, handler)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func open(t *testing.T, s *dbtest.Server) *Client {
	t.Helper()
	c, err := Open(Options{DialOptions: hs.DialOptions{Host: "127.0.0.1", Port: s.Port(), User: "testuser", Password: "SECRET1"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestOpenExchangesAttributes(t *testing.T) {
	s := newServer(t)
	c := open(t, s)
	a := c.Attributes()
	if a.CCSID != 37 || a.Release != "V7R5M0" || a.VRM != 0x070500 || a.FunctionalLevel != 14 || a.JobID != "QZDASOINITQUSER     123456" || a.DefaultSchema != "QGPL" {
		t.Fatalf("attributes: %+v", a)
	}
	if got := s.Attributes[0x3801]; len(got) != 2 || got[0] != 0x34 || got[1] != 0xB0 {
		t.Fatalf("client CCSID parameter: % X", got)
	}
	if got := s.Attributes[0x3821]; len(got) != 1 || got[0] != 0xF2 {
		t.Fatalf("extended formats parameter: % X", got)
	}
	if got := s.Attributes[0x3807]; len(got) != 2 || got[1] != 5 {
		t.Fatalf("date format parameter: % X", got)
	}
	if got := s.Attributes[0x3803]; len(got) != 14 {
		t.Fatalf("functional level parameter should be CCSID + 10 chars + 2 pad bytes, got %d bytes", len(got))
	}
	// Sign-on, attributes, create RPB; nothing else.
	if got := seen(t, s, 4); len(got) != 4 || got[2] != fnSetAttributes || got[3] != fnCreateRPB {
		t.Fatalf("requests at connect: %04X", got)
	}
}

func TestWrongPassword(t *testing.T) {
	s := newServer(t)
	_, err := Open(Options{DialOptions: hs.DialOptions{Host: "127.0.0.1", Port: s.Port(), User: "testuser", Password: "WRONG"}})
	if err == nil || !strings.Contains(err.Error(), "password is not correct") {
		t.Fatalf("want a wrong-password message, got %v", err)
	}
}

// seen waits until the server has received n requests (CREATE_RPB and CLOSE get no
// reply, so the client may be ahead of the server) and returns them.
func seen(t *testing.T, s *dbtest.Server, n int) []uint16 {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got := s.Seen()
		if len(got) >= n || time.Now().After(deadline) {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func str(p *string) string {
	if p == nil {
		return "<null>"
	}
	return *p
}

func TestQueryDecodesEveryType(t *testing.T) {
	s := newServer(t)
	c := open(t, s)
	rows, data, err := c.Query("select * from qiws.qcustcdt", 100)
	if err != nil {
		t.Fatal(err)
	}
	if s.Statements[0] != "select * from qiws.qcustcdt" {
		t.Fatalf("statement seen by the server: %q", s.Statements)
	}
	wantCols := []struct {
		name, typ string
		length    int
		nullable  bool
	}{
		{"CUSNUM", "DECIMAL", 7, false}, {"LSTNAM", "CHAR", 8, true}, {"CITY", "VARCHAR", 20, true}, {"BALDUE", "DECIMAL", 6, true},
		{"CDTLMT", "NUMERIC", 5, false}, {"QTY", "INTEGER", 10, true}, {"FLAGS", "SMALLINT", 5, false}, {"BIGONE", "BIGINT", 19, false},
		{"RATIO", "DOUBLE", 15, false}, {"SINCE", "DATE", 10, false}, {"AT", "TIME", 8, false}, {"STAMP", "TIMESTAMP", 26, false},
		{"NOTE", "VARGRAPHIC", 20, true}, {"KEY", "BINARY", 4, false}, {"MEMO", "CLOB", 68, true},
	}
	if len(rows.Columns) != len(wantCols) {
		t.Fatalf("%d columns: %+v", len(rows.Columns), rows.Columns)
	}
	for i, w := range wantCols {
		col := rows.Columns[i]
		if col.Name != w.name || col.Type != w.typ || col.Length != w.length || col.Nullable != w.nullable {
			t.Errorf("column %d: %+v, want %+v", i, col, w)
		}
	}
	if rows.Columns[3].Scale != 2 {
		t.Errorf("BALDUE scale: %+v", rows.Columns[3])
	}
	if len(data) != 2 || !rows.Done {
		t.Fatalf("%d rows, done %v", len(data), rows.Done)
	}
	want := [][]string{
		{"938472", "Henning", "Dallas", "-37.00", "5000", "12", "3", "9007199254740993", "0.5", "2026-11-09", "23:15:59", "2026-11-09-23.15.59.123456", "Größe ✓", "DEADBEEF", "a longer text"},
		{"839283", "<null>", "<null>", "<null>", "0", "<null>", "-1", "-2", "-1.25", "0001-01-01", "00:00:00", "0001-01-01-00.00.00.000000", "<null>", "00000001", "<null>"},
	}
	for r, row := range want {
		for i, w := range row {
			if got := str(data[r][i]); got != w {
				t.Errorf("row %d column %s: %q, want %q", r, rows.Columns[i].Name, got, w)
			}
		}
	}
	// prepare+describe, open+fetch; the last block arrived with the open, no FETCH.
	got := seen(t, s, 6)[4:]
	if len(got) != 2 || got[0] != fnPrepareDescribe || got[1] != fnOpenDescribeFetch {
		t.Fatalf("statement requests: %04X", got)
	}
}

func TestBlocksAndClose(t *testing.T) {
	s := newServer(t)
	c := open(t, s)
	rows, data, err := c.Query("SELECT N FROM T", 3)
	if err != nil {
		t.Fatal(err)
	}
	var all []string
	collect := func(d [][]*string) {
		for _, r := range d {
			all = append(all, str(r[0]))
		}
	}
	collect(data)
	for !rows.Done {
		d, err := rows.Next()
		if err != nil {
			t.Fatal(err)
		}
		collect(d)
	}
	if strings.Join(all, ",") != "1,2,3,4,5,6,7" {
		t.Fatalf("rows: %v", all)
	}
	if len(s.Blocks) != 3 || s.Blocks[0] != 3 || s.Blocks[2] != 3 {
		t.Fatalf("blocking factors: %v", s.Blocks)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	want := []uint16{fnPrepareDescribe, fnOpenDescribeFetch, fnFetch, fnFetch, fnClose}
	got := seen(t, s, 4+len(want))[4:]
	if len(got) != len(want) {
		t.Fatalf("requests: %04X", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("requests: %04X, want %04X", got, want)
		}
	}
}

func TestHostClosesAtEOF(t *testing.T) {
	s := newServer(t)
	s.CloseAtEOF = true
	c := open(t, s)
	rows, data, err := c.Query("SELECT N FROM T", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) != 7 || !rows.Done {
		t.Fatalf("%d rows, done %v", len(data), rows.Done)
	}
	_ = rows.Close()
	// Then another query: no CLOSE may be sent for a cursor the host already closed.
	if _, _, err := c.Query("SELECT N FROM T", 10); err != nil {
		t.Fatal(err)
	}
	for _, fn := range seen(t, s, 8) {
		if fn == fnClose {
			t.Fatalf("a CLOSE was sent although the host closed the cursor: %04X", s.Seen())
		}
	}
}

func TestNewQueryClosesTheOpenCursor(t *testing.T) {
	s := newServer(t)
	c := open(t, s)
	if _, _, err := c.Query("SELECT N FROM T", 2); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Query("SELECT N FROM T", 2); err != nil {
		t.Fatal(err)
	}
	want := []uint16{fnPrepareDescribe, fnOpenDescribeFetch, fnClose, fnPrepareDescribe, fnOpenDescribeFetch}
	got := seen(t, s, 4+len(want))[4:]
	for i := range want {
		if i >= len(got) || got[i] != want[i] {
			t.Fatalf("requests: %04X, want %04X", got, want)
		}
	}
}

func TestExecUpdateCounts(t *testing.T) {
	s := newServer(t)
	c := open(t, s)
	r, err := c.Exec("insert into t values (1), (2), (3)")
	if err != nil || r.UpdateCount != 3 || r.SQLCode != 0 {
		t.Fatalf("insert: %+v, %v", r, err)
	}
	r, err = c.Exec("delete from empty")
	if err != nil || r.UpdateCount != 0 || r.SQLCode != 100 {
		t.Fatalf("delete: %+v, %v", r, err)
	}
	r, err = c.Exec("create table t (n int)")
	if err != nil || r.UpdateCount != 0 {
		t.Fatalf("create: %+v, %v", r, err)
	}
	if got := s.Seen(); got[len(got)-1] != fnExecuteImmediate {
		t.Fatalf("requests: %04X", got)
	}
}

func TestSQLErrorExplainsItself(t *testing.T) {
	s := newServer(t)
	c := open(t, s)
	_, _, err := c.Query("select * from nowhere", 10)
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("want *Error, got %v", err)
	}
	if e.ID != "SQL0204" || e.SQLCode != -204 || e.SQLState != "42704" || !strings.Contains(e.Text, "not found") || e.Class != 7 || e.Code != -204 {
		t.Fatalf("error: %+v", e)
	}
	if !strings.HasPrefix(err.Error(), "SQL0204: NOWHERE") {
		t.Fatalf("error text: %v", err)
	}
	// The connection is still usable.
	if r, err := c.Exec("insert into t values (1)"); err != nil || r.UpdateCount != 3 {
		t.Fatalf("after the error: %+v %v", r, err)
	}
}

func TestWarnings(t *testing.T) {
	s := newServer(t)
	c := open(t, s)
	// SQLSTATE class 02 (no row) is not reported as a warning.
	r, err := c.Exec("update warn set x = 1")
	if err != nil || len(r.Messages) != 0 {
		t.Fatalf("02000 should be silent: %+v %v", r, err)
	}
	r, err = c.Exec("update loud set x = 1")
	if err != nil || len(r.Messages) != 1 || r.Messages[0].ID != "SQL0464" || r.Messages[0].SQLCode != 464 {
		t.Fatalf("want one warning: %+v %v", r, err)
	}
}

func TestCancelNamesTheJob(t *testing.T) {
	s := newServer(t)
	c := open(t, s)
	if err := c.Cancel(); err != nil {
		t.Fatal(err)
	}
	if len(s.Cancelled) != 1 || s.Cancelled[0] != "QZDASOINITQUSER     123456" {
		t.Fatalf("cancelled: %q", s.Cancelled)
	}
}

func TestDecimalHelpers(t *testing.T) {
	cases := []struct {
		digits string
		neg    bool
		scale  int
		want   string
	}{
		{"0012345", false, 2, "123.45"}, {"0000000", true, 2, "0.00"}, {"0000005", true, 2, "-0.05"}, {"123", false, 0, "123"}, {"000", false, 0, "0"}, {"5", false, 3, "0.005"},
	}
	for _, tc := range cases {
		if got := withScale(tc.digits, tc.neg, tc.scale); got != tc.want {
			t.Errorf("withScale(%q, %v, %d) = %q, want %q", tc.digits, tc.neg, tc.scale, got, tc.want)
		}
	}
	if got := packedDecimal([]byte{0x12, 0x34, 0x5D}, 5, 2); got != "-123.45" {
		t.Errorf("packed: %q", got)
	}
	if got := zonedDecimal([]byte{0xF1, 0xF2, 0xD3}, 1); got != "-12.3" {
		t.Errorf("zoned: %q", got)
	}
	if got := decodeText([]byte{0xC8, 0x89}, 65535, 37); got != "Hi" {
		t.Errorf("65535 text through the job CCSID: %q", got)
	}
}
