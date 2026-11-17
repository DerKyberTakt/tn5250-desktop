package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"syscall"
	"testing"
	"time"
)

type fakeNetErr struct{}

func (fakeNetErr) Error() string   { return "read tcp 10.0.0.1:50000->10.0.0.2:8476: i/o timeout" }
func (fakeNetErr) Timeout() bool   { return true }
func (fakeNetErr) Temporary() bool { return false }

func TestConnLost(t *testing.T) {
	lost := []error{
		io.EOF,
		io.ErrUnexpectedEOF,
		net.ErrClosed,
		fmt.Errorf("database server: %w", syscall.ECONNRESET),
		fmt.Errorf("remote command server: %w", syscall.EPIPE),
		fakeNetErr{},
		errors.New("write tcp 10.0.0.1:50000->10.0.0.2:8475: wsasend: An existing connection was forcibly closed by the remote host."),
		errors.New("the connection is closed; connect again"),
	}
	for _, e := range lost {
		if !connLost(e) {
			t.Errorf("%v: want lost", e)
		}
	}
	kept := []error{
		nil,
		errors.New("sign-on refused: the password is not correct"),
		errors.New("SQL0204: TABLE in SCHEMA type *FILE not found"),
		errors.New("CPF9801: Object not found"),
		fmt.Errorf("could not reach github.com: %w", errors.New("no such host")),
	}
	for _, e := range kept {
		if connLost(e) {
			t.Errorf("%v: want kept", e)
		}
	}
	_ = time.Second
}
