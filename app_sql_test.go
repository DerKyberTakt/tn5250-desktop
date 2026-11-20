package main

import (
	"fmt"
	"testing"
	"time"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/db"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/db/dbtest"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/rmtcmd"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/rmtcmd/rmtcmdtest"
	"github.com/DerKyberTakt/tn5250-desktop/internal/sqlviacl"
)

// testSQL starts fake command and database servers on 127.0.0.1 and registers a session
// connected to them. The database handler is dbHandler; the returned servers record
// what reached them.
func testSQL(t *testing.T, dbHandler dbtest.Handler) (a *App, id string, cmds *rmtcmdtest.Server, dbs *dbtest.Server) {
	t.Helper()
	cmds, err := rmtcmdtest.New("127.0.0.1:0", "TESTUSER", "SECRET1", 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmds.Close() })
	dbs, err = dbtest.New("127.0.0.1:0", "TESTUSER", "SECRET1", 2, dbHandler)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbs.Close() })
	o := hs.DialOptions{Host: "127.0.0.1", Port: cmds.Port(), User: "testuser", Password: "SECRET1", IdleTimeout: -1}
	c, err := rmtcmd.Open(o)
	if err != nil {
		t.Fatal(err)
	}
	s := &sqlSession{cmd: c, options: o, naming: sqlviacl.Options{Naming: "sql"}, user: "TESTUSER", results: map[string]*sqlCache{}, header: true}
	s.track(c)
	od := o
	od.Port = dbs.Port()
	d, err := db.Open(db.Options{DialOptions: od, Naming: "sql"})
	if err != nil {
		t.Fatal(err)
	}
	s.db = d
	s.track(d)
	a = &App{}
	st := a.sql()
	id = fmt.Sprintf("sql%d", len(st.sessions)+1)
	st.sessions[id] = s
	return a, id, cmds, dbs
}

// SqlClose must not wait behind a statement that waits for a silent host (audit d3-2).
func TestSqlCloseWhileStatementHangs(t *testing.T) {
	release := make(chan struct{})
	a, id, _, _ := testSQL(t, func(string) any { <-release; return dbtest.Exec{} })
	t.Cleanup(func() { close(release) })
	ran := make(chan error, 1)
	go func() { _, err := a.SqlRun(id, "UPDATE T SET A = 1", 10); ran <- err }()
	time.Sleep(300 * time.Millisecond)
	closed := make(chan struct{})
	go func() { a.SqlClose(id); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("SqlClose blocked behind the running statement")
	}
	select {
	case err := <-ran:
		if err == nil {
			t.Error("the interrupted statement reported success")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("SqlRun did not return after SqlClose")
	}
}
