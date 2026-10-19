// Command fakeifs is a development tool: an in-memory IBM i file server on localhost
// with a few sample files, for trying the IFS browser without a real system.
//
//	go run ./cmd/fakeifs -addr 127.0.0.1:8473 -user TESTUSER -password SECRET1
package main

import (
	"flag"
	"log"
	"strings"

	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/ifs/ifstest"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8473", "listen address")
	user := flag.String("user", "TESTUSER", "user profile")
	password := flag.String("password", "SECRET1", "password")
	level := flag.Int("level", 1, "password level (0-3)")
	flag.Parse()
	s, err := ifstest.New(*addr, *user, *password, byte(*level))
	if err != nil {
		log.Fatal(err)
	}
	home := "/home/" + strings.ToUpper(*user)
	s.Mu.Lock()
	for _, d := range []string{home + "/projects", home + "/projects/reports", "/tmp", "/QSYS.LIB", "/QSYS.LIB/MYLIB.LIB"} {
		s.Dirs[d] = true
	}
	s.Files[home+"/readme.txt"] = []byte("Sample file on the fake IFS.\nLine two.\n")
	s.Files[home+"/projects/plan.md"] = []byte("# Plan\n\n- list\n- upload\n- download\n")
	s.Files[home+"/projects/reports/sales-2026-10.csv"] = []byte(strings.Repeat("item,qty,amount\nA100,5,12.50\n", 2000))
	s.Files["/tmp/scratch.log"] = make([]byte, 3*1024*1024)
	s.Mu.Unlock()
	log.Printf("fake IFS on %s (user %s)", *addr, strings.ToUpper(*user))
	select {}
}
