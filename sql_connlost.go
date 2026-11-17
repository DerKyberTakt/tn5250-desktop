package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"syscall"
)

// connLost tells a host-server connection that is gone (the server job ended, the
// network dropped, a firewall closed an idle socket) from an ordinary failure, so the
// page can offer to reconnect instead of leaving a dead tab.
func connLost(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNABORTED) {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return true
	}
	m := strings.ToLower(err.Error())
	for _, s := range []string{"connection is closed", "forcibly closed", "connection reset", "broken pipe", "use of closed", "connection abort", "wsarecv", "wsasend"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// sqlFail returns err as it is, unless the connection is lost: then the session is
// taken out of the table and closed, and the error says "connection lost" so the page
// knows a reconnect is the answer. The caller holds s.mu.
func (a *App) sqlFail(id string, s *sqlSession, err error) error {
	if !connLost(err) {
		return err
	}
	st := a.sql()
	st.mu.Lock()
	if st.sessions[id] == s {
		delete(st.sessions, id)
	}
	st.mu.Unlock()
	s.closeLocked()
	return fmt.Errorf("connection lost: %w", err)
}
