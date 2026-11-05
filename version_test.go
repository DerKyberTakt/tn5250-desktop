package main

import "testing"

func TestReadVersion(t *testing.T) {
	cfg := []byte("version: '3'\n\ninfo:\n  productName: \"X\"\n  version: \"0.1.2.1\" # The application version\n")
	if got := readVersion(cfg); got != "0.1.2.1" {
		t.Fatalf("got %q", got)
	}
	if got := readVersion([]byte("version: '3'\n")); got != "0.0.0" {
		t.Fatalf("missing version: got %q", got)
	}
	if appVersion == "0.0.0" {
		t.Fatal("embedded build/config.yml has no info.version")
	}
}
