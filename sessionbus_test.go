package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestSessionBusError(t *testing.T) {
	if sessionBusError(nil) != nil {
		t.Fatal("nil in, nil out")
	}
	msg := startupFailure(sessionBusError(errors.New("dial unix /nonexistent: no such file")))
	if strings.Contains(msg, "\n") || !strings.Contains(msg, "D-Bus session bus") || !strings.HasPrefix(msg, "tn5250-terminal: ") {
		t.Fatalf("message = %q", msg)
	}
}

func TestErrorLoggerWritesErrorsOnly(t *testing.T) {
	var b bytes.Buffer
	l := errorLogger(&b)
	l.Info("chatty")
	l.Error("failed to initialize single instance manager")
	if !strings.Contains(b.String(), "single instance") || strings.Contains(b.String(), "chatty") {
		t.Fatalf("log = %q", b.String())
	}
}
