package ifs

import (
	"bytes"
	"crypto/rand"
	"strings"
	"testing"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/ifs/ifstest"
)

func newFakeServer(t *testing.T, level byte) *ifstest.Server {
	t.Helper()
	f, err := ifstest.New("127.0.0.1:0", "TESTUSER", "SECRET1", level)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return f
}

func options(f *ifstest.Server, password string) hs.DialOptions {
	return hs.DialOptions{Host: "127.0.0.1", Port: f.Port(), User: "testuser", Password: password}
}

func open(t *testing.T, f *ifstest.Server) *Client {
	t.Helper()
	c, err := Open(options(f, "SECRET1"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestSignonBothPasswordLevels(t *testing.T) {
	for _, level := range []byte{1, 2} {
		f := newFakeServer(t, level)
		c := open(t, f)
		if c.Level() != 16 {
			t.Fatalf("level %d: datastream level %d", level, c.Level())
		}
	}
}

func TestWrongPassword(t *testing.T) {
	f := newFakeServer(t, 1)
	_, err := Open(options(f, "WRONG"))
	if err == nil || !strings.Contains(err.Error(), "password is not correct") {
		t.Fatalf("want a wrong-password message, got %v", err)
	}
}

func TestListStatMkdirRenameRemove(t *testing.T) {
	f := newFakeServer(t, 1)
	f.Files["/home/TESTUSER/a.txt"] = []byte("hello")
	c := open(t, f)

	if err := c.Mkdir("/home/TESTUSER/sub"); err != nil {
		t.Fatal(err)
	}
	es, err := c.List("/home/TESTUSER/")
	if err != nil {
		t.Fatal(err)
	}
	if len(es) != 2 || es[0].Name != "a.txt" || es[0].Dir || es[0].Size != 5 || es[1].Name != "sub" || !es[1].Dir {
		t.Fatalf("unexpected listing %+v", es)
	}
	if es[0].Modified.Unix() != 1760000060 {
		t.Fatalf("modified %v", es[0].Modified)
	}
	st, err := c.Stat("/home/TESTUSER/a.txt")
	if err != nil || st.Size != 5 {
		t.Fatalf("stat %+v %v", st, err)
	}
	if _, err := c.Stat("/home/TESTUSER/missing"); !IsNotFound(err) {
		t.Fatalf("want not found, got %v", err)
	}
	if err := c.Mkdir("/home/TESTUSER/sub"); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("duplicate mkdir: %v", err)
	}
	if err := c.Rename("/home/TESTUSER/a.txt", "/home/TESTUSER/b.txt", false); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.Files["/home/TESTUSER/b.txt"]; !ok {
		t.Fatal("rename did not reach the server")
	}
	if err := c.Remove("/home/TESTUSER/b.txt", false); err != nil {
		t.Fatal(err)
	}
	if err := c.Remove("/home/TESTUSER/sub", true); err != nil {
		t.Fatal(err)
	}
	es, _ = c.List("/home/TESTUSER")
	if len(es) != 0 {
		t.Fatalf("expected an empty folder, got %+v", es)
	}
	if _, err := c.List("/nope"); !IsNotFound(err) {
		t.Fatalf("listing a missing folder: %v", err)
	}
}

func TestListEmptyDirectory(t *testing.T) {
	f := newFakeServer(t, 1)
	f.EmptyDirNotFound = true
	f.Dirs["/home/TESTUSER/empty"] = true
	c := open(t, f)
	es, err := c.List("/home/TESTUSER/empty")
	if err != nil {
		t.Fatalf("an empty folder must list as empty, got %v", err)
	}
	if len(es) != 0 {
		t.Fatalf("expected no entries, got %+v", es)
	}
	if _, err := c.List("/home/TESTUSER/missing"); err == nil {
		t.Fatal("a missing folder must still fail")
	}
}

func TestUploadDownloadLargeFile(t *testing.T) {
	f := newFakeServer(t, 2)
	c := open(t, f)
	data := make([]byte, 3*chunk+1234) // several blocks, last one partial
	_, _ = rand.Read(data)
	var last int64
	if err := c.Upload("/home/TESTUSER/big.bin", bytes.NewReader(data), func(n int64) { last = n }); err != nil {
		t.Fatal(err)
	}
	if last != int64(len(data)) || f.Writes != 4 {
		t.Fatalf("progress %d, writes %d", last, f.Writes)
	}
	if !bytes.Equal(f.Files["/home/TESTUSER/big.bin"], data) {
		t.Fatal("uploaded content differs")
	}
	var out bytes.Buffer
	if err := c.Download("/home/TESTUSER/big.bin", &out, nil); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out.Bytes(), data) {
		t.Fatalf("downloaded %d bytes, want %d", out.Len(), len(data))
	}
	if len(f.Handles) != 0 {
		t.Fatal("file handles left open")
	}
	if err := c.Download("/home/TESTUSER/none.bin", &out, nil); !IsNotFound(err) {
		t.Fatalf("download of a missing file: %v", err)
	}
}

func TestEmptyFile(t *testing.T) {
	f := newFakeServer(t, 1)
	f.Files["/home/TESTUSER/empty"] = []byte{}
	c := open(t, f)
	var out bytes.Buffer
	if err := c.Download("/home/TESTUSER/empty", &out, nil); err != nil || out.Len() != 0 {
		t.Fatalf("empty download: %d bytes, %v", out.Len(), err)
	}
}

func TestClean(t *testing.T) {
	for in, want := range map[string]string{"home/x/": "/home/x", `\QSYS.LIB\MYLIB.LIB`: "/QSYS.LIB/MYLIB.LIB", "/": "/", " /tmp/./a/../b ": "/tmp/b"} {
		if got := Clean(in); got != want {
			t.Fatalf("Clean(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReadAllReportsCCSIDAndTruncates(t *testing.T) {
	f := newFakeServer(t, 1)
	f.Files["/home/TESTUSER/ebcdic.txt"] = []byte{0xC8, 0xC5, 0xD3, 0xD3, 0xD6} // "HELLO" in CCSID 37
	f.CCSIDs["/home/TESTUSER/ebcdic.txt"] = 37
	f.Files["/home/TESTUSER/big.bin"] = bytes.Repeat([]byte{7}, 1000)
	c := open(t, f)

	data, ccsid, truncated, err := c.ReadAll("/home/TESTUSER/ebcdic.txt", 1<<20)
	if err != nil || truncated {
		t.Fatalf("ReadAll: %v truncated=%v", err, truncated)
	}
	if ccsid != 37 || !bytes.Equal(data, f.Files["/home/TESTUSER/ebcdic.txt"]) {
		t.Fatalf("ccsid %d data %x", ccsid, data)
	}
	data, ccsid, truncated, err = c.ReadAll("/home/TESTUSER/big.bin", 300)
	if err != nil || !truncated || len(data) != 300 || ccsid != 1208 {
		t.Fatalf("truncated read: err=%v truncated=%v len=%d ccsid=%d", err, truncated, len(data), ccsid)
	}
	if _, _, _, err := c.ReadAll("/home/TESTUSER/missing", 10); err == nil {
		t.Fatal("missing file: want an error")
	}
}

func TestWriteAllTagsNewFilesAndReplaces(t *testing.T) {
	f := newFakeServer(t, 1)
	c := open(t, f)
	if err := c.WriteAll("/home/TESTUSER/new.txt", []byte("abc"), 37); err != nil {
		t.Fatal(err)
	}
	if got := f.Files["/home/TESTUSER/new.txt"]; string(got) != "abc" {
		t.Fatalf("content %q", got)
	}
	if f.CCSIDs["/home/TESTUSER/new.txt"] != 37 {
		t.Fatalf("ccsid %d", f.CCSIDs["/home/TESTUSER/new.txt"])
	}
	// Replacing keeps the file's CCSID: the request's value only tags a created file.
	if err := c.WriteAll("/home/TESTUSER/new.txt", []byte("longer text"), 1208); err != nil {
		t.Fatal(err)
	}
	if string(f.Files["/home/TESTUSER/new.txt"]) != "longer text" || f.CCSIDs["/home/TESTUSER/new.txt"] != 37 {
		t.Fatalf("after replace: %q ccsid %d", f.Files["/home/TESTUSER/new.txt"], f.CCSIDs["/home/TESTUSER/new.txt"])
	}
	// An upload tags a created file UTF-8.
	if err := c.Upload("/home/TESTUSER/up.txt", strings.NewReader("x"), nil); err != nil {
		t.Fatal(err)
	}
	if f.CCSIDs["/home/TESTUSER/up.txt"] != 1208 {
		t.Fatalf("upload ccsid %d", f.CCSIDs["/home/TESTUSER/up.txt"])
	}
}
