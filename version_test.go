package main

import "testing"

func TestReadVersion(t *testing.T) {
	if got := readVersion([]byte(`{"info":{"productVersion":"0.1.2.1"}}`)); got != "0.1.2.1" {
		t.Fatalf("got %q", got)
	}
	if got := readVersion([]byte(`{}`)); got != "0.0.0" {
		t.Fatalf("missing version: got %q", got)
	}
	if appVersion == "0.0.0" {
		t.Fatal("embedded wails.json has no productVersion")
	}
}
