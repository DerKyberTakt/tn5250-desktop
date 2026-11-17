package update

import (
	"context"
	"os"
	"testing"
)

// TestLiveNotes reads the real CHANGELOG.md at the latest tag and shows what a user of
// TN5250_LIVE_FROM (default 0.3.2) would be offered. Set TN5250_LIVE_UPDATE=1 to run it.
func TestLiveNotes(t *testing.T) {
	if os.Getenv("TN5250_LIVE_UPDATE") == "" {
		t.Skip("set TN5250_LIVE_UPDATE=1 to read the real change log")
	}
	from := os.Getenv("TN5250_LIVE_FROM")
	if from == "" {
		from = "0.3.2"
	}
	c := New()
	tag, err := c.Latest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	text, err := c.Changelog(context.Background(), tag)
	if err != nil {
		t.Fatal(err)
	}
	notes := NotesSince(text, from, tag)
	if len(notes) == 0 {
		t.Fatalf("no notes between %s and %s", from, tag)
	}
	for _, r := range notes {
		t.Logf("%s (%s): %d items; first: %.100s", r.Version, r.Date, len(r.Items), r.Items[0])
	}
}
