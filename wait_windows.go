package main

import (
	"os"
	"time"
)

// waitForExit waits up to timeout for process pid to end. On Windows FindProcess
// opens a handle that can be waited on even for a process that is not our child.
func waitForExit(pid int, timeout time.Duration) {
	p, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		_, _ = p.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
	_ = p.Release()
}
