package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListFiles(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"Prod.hod", "dev.HOD", "notes.txt", "Printer.hod"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "folder.hod"), 0o700); err != nil {
		t.Fatal(err)
	}
	var a App
	got, err := a.ListFiles(dir, ".hod")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(dir, "Printer.hod"), filepath.Join(dir, "Prod.hod"), filepath.Join(dir, "dev.HOD")}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}

	// A folder that does not exist gives an empty list, not an error.
	none, err := a.ListFiles(filepath.Join(dir, "missing"), ".hod")
	if err != nil || len(none) != 0 {
		t.Fatalf("missing folder: %v, %v", none, err)
	}
}

func TestExpandHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip(err)
	}
	if got := expandHome("~/Documents"); got != filepath.Join(home, "Documents") {
		t.Fatalf("got %q", got)
	}
	if got := expandHome("/plain/path"); got != "/plain/path" {
		t.Fatalf("got %q", got)
	}
}

func TestPreloadedSettings(t *testing.T) {
	dir := t.TempDir()
	saved := preloadedSettingsPaths
	defer func() { preloadedSettingsPaths = saved }()
	first := filepath.Join(dir, "settings.default.json")
	second := filepath.Join(dir, "machine", "settings.json")
	preloadedSettingsPaths = func() []string { return []string{first, second} }

	if got := preloadedSettings(); got != "" {
		t.Fatalf("nothing preloaded, got %q", got)
	}
	if err := os.MkdirAll(filepath.Dir(second), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte(`{"version":1,"defaults":{},"sessions":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := preloadedSettings(); got != `{"version":1,"defaults":{},"sessions":[]}` {
		t.Fatalf("machine-wide file: got %q", got)
	}
	// An empty file next to the exe does not shadow the machine-wide one; a real one wins.
	if err := os.WriteFile(first, []byte("  \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := preloadedSettings(); got != `{"version":1,"defaults":{},"sessions":[]}` {
		t.Fatalf("empty file shadowed: got %q", got)
	}
	if err := os.WriteFile(first, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := preloadedSettings(); got != `{"version":1}` {
		t.Fatalf("exe-side file: got %q", got)
	}
}
