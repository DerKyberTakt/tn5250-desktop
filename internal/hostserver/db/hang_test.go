package db

import (
	"strings"
	"testing"
	"time"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/db/dbtest"
)

// hangServer answers every statement only when release is closed (audit d3-2).
func hangServer(t *testing.T) *dbtest.Server {
	t.Helper()
	release := make(chan struct{})
	s, err := dbtest.New("127.0.0.1:0", "TESTUSER", "SECRET1", 2, func(string) any {
		<-release
		return dbtest.Exec{}
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	t.Cleanup(func() { close(release) }) // runs first
	return s
}

func TestSilentHostTimesOutAfterSignOn(t *testing.T) {
	s := hangServer(t)
	c, err := Open(Options{DialOptions: hs.DialOptions{Host: "127.0.0.1", Port: s.Port(), User: "testuser", Password: "SECRET1", IdleTimeout: 300 * time.Millisecond}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	done := make(chan error, 1)
	go func() { _, err := c.Exec("UPDATE T SET A = 1"); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected a timeout")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Exec still blocked 5 s after the host went silent")
	}
}

func TestCloseInterruptsARunningRequest(t *testing.T) {
	s := hangServer(t)
	c, err := Open(Options{DialOptions: hs.DialOptions{Host: "127.0.0.1", Port: s.Port(), User: "testuser", Password: "SECRET1", IdleTimeout: -1}})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := c.Exec("UPDATE T SET A = 1"); done <- err }()
	time.Sleep(200 * time.Millisecond)
	closed := make(chan struct{})
	go func() { _ = c.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("Close blocked behind the running request")
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "database server") {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the request did not fail after Close")
	}
}
