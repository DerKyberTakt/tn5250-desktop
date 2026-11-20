package main

import (
	"strings"
	"testing"
)

func TestCheckSessionBusMissing(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent/bus")
	err := checkSessionBus()
	if err == nil || !strings.Contains(err.Error(), "D-Bus session bus") {
		t.Fatalf("err = %v", err)
	}
}
