package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"sync"
	"time"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
)

// Proxy mode: local port 18470+n forwards to <host>:8470+n (central, database, data
// queue, file, print, remote command, sign-on) and logs every frame in both
// directions. Point a real client (IBM's Java toolbox) at localhost with those
// service ports to record real requests AND real replies. Use PUB400.COM or a test
// system only; the log holds whatever the host returns.

type proxyRecord struct {
	Port     int    `json:"port"`
	Conn     int    `json:"conn"`
	Dir      string `json:"dir"` // "c2s" client to server, "s2c" server to client
	ReqRepID string `json:"reqRepId"`
	ServerID string `json:"serverId"`
	Template int    `json:"templateLen"`
	Hex      string `json:"hex"`
}

var connSeq struct {
	sync.Mutex
	n int
}

func runProxy(remote string) {
	for i := 0; i <= 6; i++ {
		go proxyPort(18470+i, net.JoinHostPort(remote, fmt.Sprint(8470+i)))
	}
	log.Printf("proxy: localhost:18470-18476 -> %s:8470-8476, logging to %s", remote, *outPath)
	select {}
}

func proxyPort(local int, remote string) {
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", local))
	if err != nil {
		log.Fatal(err)
	}
	for {
		c, err := l.Accept()
		if err != nil {
			log.Print(err)
			continue
		}
		connSeq.Lock()
		connSeq.n++
		id := connSeq.n
		connSeq.Unlock()
		go proxyConn(local, id, c, remote)
	}
}

func proxyConn(port, id int, client net.Conn, remote string) {
	defer client.Close()
	server, err := net.DialTimeout("tcp", remote, 15*time.Second)
	if err != nil {
		log.Printf("conn %d: %v", id, err)
		return
	}
	defer server.Close()
	log.Printf("conn %d: port %d -> %s", id, port, remote)
	done := make(chan struct{}, 2)
	pump := func(dir string, from, to net.Conn) {
		defer func() { done <- struct{}{} }()
		for {
			f, err := hs.ReadFrame(from)
			if err != nil {
				return
			}
			logProxy(port, id, dir, f)
			if _, err := to.Write(f.Bytes()); err != nil {
				return
			}
		}
	}
	go pump("c2s", client, server)
	go pump("s2c", server, client)
	<-done
	log.Printf("conn %d: closed", id)
}

func logProxy(port, id int, dir string, f *hs.Frame) {
	mu.Lock()
	defer mu.Unlock()
	b, _ := json.Marshal(proxyRecord{
		Port: port, Conn: id, Dir: dir,
		ReqRepID: fmt.Sprintf("%04X", f.ReqRepID), ServerID: fmt.Sprintf("%04X", f.ServerID),
		Template: int(f.TemplateLen), Hex: hex.EncodeToString(f.Bytes()),
	})
	_, _ = out.Write(append(b, '\n'))
	log.Printf("conn %d %s  server %04X  req %04X  len %d", id, dir, f.ServerID, f.ReqRepID, len(f.Body)+hs.HeaderLen)
}
