package main

import (
	"encoding/base64"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"
)

type recorder struct {
	mu     sync.Mutex
	events []string
	got    chan struct{}
}

func newRecorder() *recorder { return &recorder{got: make(chan struct{}, 64)} }

func (r *recorder) emit(event string, args ...interface{}) {
	r.mu.Lock()
	line := event
	for _, a := range args {
		line += " " + a.(string)
	}
	r.events = append(r.events, line)
	r.mu.Unlock()
	r.got <- struct{}{}
}

func (r *recorder) wait(t *testing.T, n int) []string {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		r.mu.Lock()
		if len(r.events) >= n {
			out := append([]string(nil), r.events...)
			r.mu.Unlock()
			return out
		}
		r.mu.Unlock()
		select {
		case <-r.got:
		case <-deadline:
			t.Fatalf("timed out waiting for %d events, have %v", n, r.events)
		}
	}
}

func listen(t *testing.T) (net.Listener, int) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l, l.Addr().(*net.TCPAddr).Port
}

func TestEchoAndHostClose(t *testing.T) {
	l, port := listen(t)
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		buf := make([]byte, 16)
		n, _ := c.Read(buf)
		_, _ = c.Write(buf[:n])
		_ = c.Close()
	}()
	rec := newRecorder()
	s := NewSockets(rec.emit)
	if err := s.Connect("a", ConnectOptions{Host: "127.0.0.1", Port: port, TimeoutMs: 2000}); err != nil {
		t.Fatal(err)
	}
	if err := s.Send("a", base64.StdEncoding.EncodeToString([]byte{0xff, 0xfb, 0x18})); err != nil {
		t.Fatal(err)
	}
	ev := rec.wait(t, 2)
	if ev[0] != "net:data a //sY" || ev[1] != "net:closed a " {
		t.Fatalf("unexpected events %v", ev)
	}
	if err := s.Send("a", "AA=="); err == nil {
		t.Fatal("send after close should fail")
	}
}

func TestLocalCloseIsSilent(t *testing.T) {
	l, port := listen(t)
	accepted := make(chan net.Conn, 1)
	go func() {
		c, _ := l.Accept()
		accepted <- c
	}()
	rec := newRecorder()
	s := NewSockets(rec.emit)
	if err := s.Connect("b", ConnectOptions{Host: "127.0.0.1", Port: port}); err != nil {
		t.Fatal(err)
	}
	<-accepted
	s.Close("b")
	time.Sleep(100 * time.Millisecond)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.events) != 0 {
		t.Fatalf("expected no events after a local close, got %v", rec.events)
	}
}

func TestDuplicateIdRejected(t *testing.T) {
	l, port := listen(t)
	go func() {
		for {
			if _, err := l.Accept(); err != nil {
				return
			}
		}
	}()
	s := NewSockets(newRecorder().emit)
	defer s.CloseAll()
	opts := ConnectOptions{Host: "127.0.0.1", Port: port}
	if err := s.Connect("c", opts); err != nil {
		t.Fatal(err)
	}
	if err := s.Connect("c", opts); err == nil {
		t.Fatal("second connect with the same id should fail")
	}
}

func TestValidation(t *testing.T) {
	s := NewSockets(newRecorder().emit)
	cases := []ConnectOptions{
		{Host: "", Port: 23},
		{Host: "bad host", Port: 23},
		{Host: "h", Port: 0},
		{Host: "h", Port: 70000},
	}
	for _, c := range cases {
		if err := s.Connect("x", c); err == nil {
			t.Fatalf("expected an error for %+v", c)
		}
	}
	if err := s.Connect("", ConnectOptions{Host: "h", Port: 23}); err == nil {
		t.Fatal("empty id must be rejected")
	}
}

func TestRefusedReportsAddress(t *testing.T) {
	l, port := listen(t)
	_ = l.Close()
	s := NewSockets(newRecorder().emit)
	err := s.Connect("d", ConnectOptions{Host: "127.0.0.1", Port: port, TimeoutMs: 1000})
	if err == nil {
		t.Fatal("expected connection refused")
	}
	want := "127.0.0.1:" + strconv.Itoa(port) + ": "
	if len(err.Error()) <= len(want) || err.Error()[:len(want)] != want {
		t.Fatalf("error should start with the address: %q", err.Error())
	}
}
