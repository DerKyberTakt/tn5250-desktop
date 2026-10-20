package update

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeGitHub serves releases/latest and releases/download like github.com: asset
// downloads redirect to a second server standing in for the download host.
func fakeGitHub(t *testing.T, latest string, assets map[string][]byte, sums string) (*Client, *httptest.Server) {
	t.Helper()
	files := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, ok := assets[strings.TrimPrefix(r.URL.Path, "/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(files.Close)
	gh := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/o/r/releases/latest":
			if latest == "" {
				http.NotFound(w, r)
				return
			}
			http.Redirect(w, r, latest, http.StatusFound)
		case r.URL.Path == "/o/r/releases/download/v0.2.0/"+SumsFile:
			_, _ = w.Write([]byte(sums))
		case strings.HasPrefix(r.URL.Path, "/o/r/releases/download/v0.2.0/"):
			http.Redirect(w, r, files.URL+"/"+filepath.Base(r.URL.Path), http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(gh.Close)
	allowed := map[string]bool{hostOf(gh.URL): true, hostOf(files.URL): true}
	c := &Client{Base: gh.URL, Repo: "o/r", HTTP: gh.Client(), Allowed: func(u *url.URL) bool { return u.Scheme == "https" && allowed[u.Host] }}
	return c, files
}

func hostOf(raw string) string {
	u, _ := url.Parse(raw)
	return u.Host
}

func sha(data []byte) string {
	s := sha256.Sum256(data)
	return hex.EncodeToString(s[:])
}

func TestLatest(t *testing.T) {
	c, _ := fakeGitHub(t, "/o/r/releases/tag/v0.2.0", nil, "")
	tag, err := c.Latest(context.Background())
	if err != nil || tag != "v0.2.0" {
		t.Fatalf("Latest = %q, %v", tag, err)
	}

	c, _ = fakeGitHub(t, "", nil, "")
	if _, err := c.Latest(context.Background()); !errors.Is(err, ErrNoRelease) {
		t.Fatalf("404: want ErrNoRelease, got %v", err)
	}

	c, _ = fakeGitHub(t, "/o/r/releases", nil, "")
	if _, err := c.Latest(context.Background()); !errors.Is(err, ErrNoRelease) {
		t.Fatalf("redirect to the list: want ErrNoRelease, got %v", err)
	}
}

func TestDownloadVerifies(t *testing.T) {
	good := []byte("installer bytes")
	sums := fmt.Sprintf("%s  setup.exe\n%s  other.zip\n", sha(good), sha([]byte("x")))
	c, _ := fakeGitHub(t, "", map[string][]byte{"setup.exe": good, "other.zip": []byte("tampered")}, sums)
	dir := t.TempDir()

	var seen int64
	p, err := c.Download(context.Background(), "v0.2.0", "setup.exe", dir, func(done, _ int64) { seen = done })
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(p); string(got) != string(good) || seen != int64(len(good)) {
		t.Fatalf("downloaded %q, progress %d", got, seen)
	}

	if _, err := c.Download(context.Background(), "v0.2.0", "other.zip", dir, nil); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("tampered asset: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "other.zip")); !os.IsNotExist(err) {
		t.Fatal("a file that failed the check was kept")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("leftover files: %v", entries)
	}

	if _, err := c.Download(context.Background(), "v0.2.0", "missing.exe", dir, nil); err == nil || !strings.Contains(err.Error(), "not part of release") {
		t.Fatalf("asset not in SHA256SUMS: %v", err)
	}
}

func TestDownloadRefusesOtherHosts(t *testing.T) {
	good := []byte("data")
	c, files := fakeGitHub(t, "", map[string][]byte{"setup.exe": good}, sha(good)+"  setup.exe\n")
	blocked := hostOf(files.URL)
	inner := c.Allowed
	c.Allowed = func(u *url.URL) bool { return u.Host != blocked && inner(u) }
	_, err := c.Download(context.Background(), "v0.2.0", "setup.exe", t.TempDir(), nil)
	if err == nil || !strings.Contains(err.Error(), "refusing redirect") {
		t.Fatalf("redirect to a host outside the list: %v", err)
	}
}

func TestGitHubOnly(t *testing.T) {
	for raw, want := range map[string]bool{
		"https://github.com/o/r":                         true,
		"https://objects.githubusercontent.com/x":        true,
		"https://release-assets.githubusercontent.com/x": true,
		"http://github.com/o/r":                          false,
		"https://github.com.evil.example/x":              false,
		"https://example.com/x":                          false,
		"https://githubusercontent.com.evil.example/x":   false,
	} {
		u, _ := url.Parse(raw)
		if GitHubOnly(u) != want {
			t.Errorf("GitHubOnly(%s) != %v", raw, want)
		}
	}
}

func TestParseSums(t *testing.T) {
	h := strings.Repeat("ab", 32)
	got := ParseSums([]byte(h + "  a.exe\r\n" + strings.ToUpper(h) + " *b.zip\nnot a line\n\n"))
	if got["a.exe"] != h || got["b.zip"] != h || len(got) != 2 {
		t.Fatalf("ParseSums = %v", got)
	}
}

func TestCompare(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"0.1.2", "0.1.2", 0},
		{"v0.1.2", "0.1.2.0", 0},
		{"0.1.2", "0.1.3", -1},
		{"0.1.2.1", "0.1.2", 1},
		{"0.1.10", "0.1.9", 1},
		{"0.2.0-rc1", "0.2.0", -1},
		{"0.2.0-rc2", "0.2.0-rc1", 1},
		{"1.0.0", "0.9.9.9", 1},
	} {
		if got := Compare(c.a, c.b); got != c.want {
			t.Errorf("Compare(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestExtractReplaceRemoveOld(t *testing.T) {
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "p.zip")
	f, _ := os.Create(zipPath)
	zw := zip.NewWriter(f)
	w, _ := zw.Create("tn5250-terminal.exe")
	_, _ = w.Write([]byte("new"))
	_ = zw.Close()
	_ = f.Close()

	exe := filepath.Join(dir, "tn5250-terminal.exe")
	_ = os.WriteFile(exe, []byte("old"), 0o755)
	next := exe + ".new"
	if err := ExtractFile(zipPath, "tn5250-terminal.exe", next); err != nil {
		t.Fatal(err)
	}
	if err := ExtractFile(zipPath, "missing.exe", next+"2"); err == nil {
		t.Fatal("missing entry: no error")
	}
	if err := Replace(exe, next); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "new" {
		t.Fatalf("exe = %q", got)
	}
	if got, _ := os.ReadFile(exe + OldSuffix); string(got) != "old" {
		t.Fatalf("old = %q", got)
	}
	if !RemoveOld(exe) || !RemoveOld(exe) {
		t.Fatal("RemoveOld failed")
	}
	if !Writable(dir) {
		t.Fatal("temp dir not writable")
	}

	// A failed swap puts the original back.
	if err := Replace(exe, filepath.Join(dir, "does-not-exist")); err == nil {
		t.Fatal("missing new file: no error")
	}
	if got, _ := os.ReadFile(exe); string(got) != "new" {
		t.Fatalf("exe after failed swap = %q", got)
	}
}

// TestLiveGitHub checks the real release on github.com (network): TN5250_LIVE_UPDATE=1 go test ./internal/update -run Live
func TestLiveGitHub(t *testing.T) {
	if os.Getenv("TN5250_LIVE_UPDATE") == "" {
		t.Skip("set TN5250_LIVE_UPDATE=1 to check the real release")
	}
	c := New()
	tag, err := c.Latest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	p, err := c.Download(context.Background(), tag, "tn5250-terminal-portable-x64.zip", t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("latest %s, verified %s", tag, filepath.Base(p))
}
