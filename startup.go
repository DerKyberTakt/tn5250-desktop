package main

import (
	"fmt"
	"io"
	"log/slog"
	"os"
)

// startupFailure is the one-line message printed to stderr when the app cannot start.
func startupFailure(err error) string {
	return "tn5250-terminal: " + err.Error()
}

// failStartup prints a one-line error to stderr and exits with status 1. Wails' own
// production logger discards everything, which used to make start-up failures silent.
func failStartup(err error) {
	fmt.Fprintln(os.Stderr, startupFailure(err))
	os.Exit(1)
}

// errorLogger is the Wails system logger: errors (including the fatal start-up ones)
// go to w, nothing else.
func errorLogger(w io.Writer) *slog.Logger {
	return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelError}))
}
