package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/db"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/db/dbtest"
)

// A file announced as 10 bytes must not stream for ever to the local disk (audit d4-4).
func TestBoundedWriterStopsAnEndlessStream(t *testing.T) {
	var buf bytes.Buffer
	w := newBoundedWriter(&buf, 10)
	chunk := make([]byte, 1<<20)
	var err error
	n := 0
	for ; n < 1000 && err == nil; n++ {
		_, err = w.Write(chunk)
	}
	if !errors.Is(err, errHostSentTooMuch) {
		t.Fatalf("err = %v after %d chunks", err, n)
	}
	if buf.Len() > 10+minSlackBytes {
		t.Fatalf("%d bytes written for a 10 byte announcement", buf.Len())
	}
}

func TestBoundedWriterAllowsTheAnnouncedSize(t *testing.T) {
	var buf bytes.Buffer
	w := newBoundedWriter(&buf, 100<<20)
	if _, err := w.Write(make([]byte, 100<<20)); err != nil {
		t.Fatal(err)
	}
}

func TestDrainRowsStopsAtTheCap(t *testing.T) {
	s, err := dbtest.New("127.0.0.1:0", "TESTUSER", "SECRET1", 2, func(string) any {
		t := dbtest.Table{Cols: []dbtest.Col{{Name: "N", Type: 496, Length: 4, CCSID: 65535}}}
		for i := int64(0); i < 300; i++ {
			t.Rows = append(t.Rows, []any{i})
		}
		return t
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, err := db.Open(db.Options{DialOptions: hs.DialOptions{Host: "127.0.0.1", Port: s.Port(), User: "testuser", Password: "SECRET1", IdleTimeout: -1}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	rows, data, err := c.Query("SELECT N FROM T", 100)
	if err != nil {
		t.Fatal(err)
	}
	all, err := drainRows(rows, data, 150)
	if err == nil || !strings.Contains(err.Error(), "more than 150 rows") {
		t.Fatalf("rows = %d, err = %v", len(all), err)
	}
	rows, data, _ = c.Query("SELECT N FROM T", 100)
	if all, err = drainRows(rows, data, 1000); err != nil || len(all) != 300 {
		t.Fatalf("rows = %d, err = %v", len(all), err)
	}
}
