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

// The installed AppImage keeps the release file name; the update must replace it
// atomically and never delete it (audit d5-1 / g6-8).
func TestInstallAppImageSameName(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, assetAppImage)
	if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(dir, ".tn5250-update-x")
	mk(t, work)
	got := filepath.Join(work, assetAppImage)
	if err := os.WriteFile(got, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := installAppImage(exe, got); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(exe)
	if err != nil || string(b) != "new" {
		t.Fatalf("installed = %q, %v", b, err)
	}
	if fi, _ := os.Stat(exe); fi.Mode().Perm()&0o111 == 0 {
		t.Errorf("not executable: %v", fi.Mode())
	}
}

func TestInstallAppImageKeepsOldOnFailure(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, assetAppImage)
	if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := installAppImage(exe, filepath.Join(dir, "missing")); err == nil {
		t.Fatal("expected an error")
	}
	if err := installAppImage(exe, exe); err == nil {
		t.Fatal("same path: expected an error")
	}
	if b, err := os.ReadFile(exe); err != nil || string(b) != "old" {
		t.Fatalf("installed file lost: %q, %v", b, err)
	}
}
