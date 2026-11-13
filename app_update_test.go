package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAppBundle(t *testing.T) {
	app := filepath.Join("/Applications", "TN5250 Terminal.app")
	exe := filepath.Join(app, "Contents", "MacOS", "tn5250-terminal")
	got, ok := appBundle(exe)
	if !ok || got != app {
		t.Fatalf("appBundle(%q) = %q, %v", exe, got, ok)
	}
	for _, p := range []string{
		filepath.Join("/usr", "local", "bin", "tn5250-terminal"),
		filepath.Join(app, "Contents", "tn5250-terminal"),
		filepath.Join("/Applications", "Other", "Contents", "MacOS", "x"),
	} {
		if _, ok := appBundle(p); ok {
			t.Errorf("appBundle(%q) found a bundle", p)
		}
	}
}

func TestFindBundle(t *testing.T) {
	dir := t.TempDir()
	if _, err := findBundle(dir); err == nil {
		t.Fatal("empty folder: expected an error")
	}
	mk(t, filepath.Join(dir, "__MACOSX"))
	app := filepath.Join(dir, "TN5250 Terminal.app")
	mk(t, filepath.Join(app, "Contents", "MacOS"))
	got, err := findBundle(dir)
	if err != nil || got != app {
		t.Fatalf("findBundle = %q, %v", got, err)
	}
}

func mk(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}
