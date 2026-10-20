//go:build !windows

package main

import (
	"syscall"
	"time"
)

// waitForExit waits up to timeout for process pid to end (polls with signal 0).
func waitForExit(pid int, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) && syscall.Kill(pid, 0) == nil {
		time.Sleep(200 * time.Millisecond)
	}
}
