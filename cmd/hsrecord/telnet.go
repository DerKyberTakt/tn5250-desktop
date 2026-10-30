package main

import (
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"os"
	"strconv"
	"time"
)

// Telnet recording mode: localhost:<local> forwards to a host's TN5250 port and
// writes every byte chunk in both directions to a trace file in the same JSON shape
// as the emulator's "Save Session Trace" (events of {t, dir, hex}; "in" = host to
// client), so the engine's trace tooling can replay what another emulator saw. Plain
// telnet only; a TLS session cannot be read in the middle. The file holds screen
// contents: keep it private.

type telnetTrace struct {
	Description string        `json:"description"`
	Port        int           `json:"port"`
	Term        string        `json:"term"`
	Negotiated  []string      `json:"negotiated"`
	Records     int           `json:"records"`
	Events      []telnetEvent `json:"events"`
}

type telnetEvent struct {
	T   int64  `json:"t"`
	Dir string `json:"dir"`
	Hex string `json:"hex"`
}

func runTelnetProxy(local int, remote, outFile string) {
	l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(local)))
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("telnet proxy: localhost:%d -> %s; one session per file, writing %s", local, remote, outFile)
	for {
		c, err := l.Accept()
		if err != nil {
			log.Print(err)
			continue
		}
		recordTelnet(c, remote, outFile)
	}
}

func recordTelnet(client net.Conn, remote, outFile string) {
	defer client.Close()
	server, err := net.DialTimeout("tcp", remote, 15*time.Second)
	if err != nil {
		log.Printf("telnet: %v", err)
		return
	}
	defer server.Close()
	start := time.Now()
	tr := telnetTrace{Description: "telnet proxy recording - " + remote, Port: remotePort(remote), Term: "unknown", Negotiated: []string{}}
	add := make(chan telnetEvent, 64)
	done := make(chan struct{}, 2)
	pump := func(dir string, from, to net.Conn) {
		defer func() { done <- struct{}{} }()
		buf := make([]byte, 32*1024)
		for {
			n, err := from.Read(buf)
			if n > 0 {
				add <- telnetEvent{T: time.Since(start).Milliseconds(), Dir: dir, Hex: hex.EncodeToString(buf[:n])}
				if _, werr := to.Write(buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	go pump("in", server, client)
	go pump("out", client, server)
	finished := 0
	for finished < 2 {
		select {
		case e := <-add:
			tr.Events = append(tr.Events, e)
		case <-done:
			finished++
			// One side hung up: drop the other so its pump ends too (the host keeps a
			// telnet session open for a while after the client leaves).
			client.Close()
			server.Close()
		}
	}
	for len(add) > 0 {
		tr.Events = append(tr.Events, <-add)
	}
	tr.Records = len(tr.Events)
	b, _ := json.MarshalIndent(tr, "", " ")
	if err := os.WriteFile(outFile, append(b, '\n'), 0o600); err != nil {
		log.Printf("telnet: write %s: %v", outFile, err)
		return
	}
	log.Printf("telnet: session closed, %d chunks written to %s", len(tr.Events), outFile)
}

func remotePort(remote string) int {
	_, p, err := net.SplitHostPort(remote)
	if err != nil {
		return 23
	}
	n, _ := strconv.Atoi(p)
	return n
}
