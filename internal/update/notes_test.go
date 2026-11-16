package update

import (
	"context"
	"strings"
	"testing"
)

const sampleChangelog = `# Changelog

## Unreleased
- Not out yet.

## 0.3.2 - 2026-11-16
- Find on screen: Ctrl+F opens a find bar.
- The host code page now reaches the host.
  It continues here.

## 0.3.1.1 - 2026-11-13
- macOS updates itself like the other platforms.

## 0.3.1 - 2026-11-13
- Cmd+C copies.

## 0.3.0 - 2026-11-12
- Import Connections.
`

func TestParseChangelog(t *testing.T) {
	rs := ParseChangelog(sampleChangelog)
	if len(rs) != 5 {
		t.Fatalf("releases: got %d, want 5", len(rs))
	}
	if rs[0].Version != "Unreleased" || rs[0].Date != "" {
		t.Errorf("first heading: %+v", rs[0])
	}
	if rs[1].Version != "0.3.2" || rs[1].Date != "2026-11-16" {
		t.Errorf("0.3.2 heading: %+v", rs[1])
	}
	if len(rs[1].Items) != 2 || rs[1].Items[1] != "The host code page now reaches the host. It continues here." {
		t.Errorf("0.3.2 items: %q", rs[1].Items)
	}
}

func TestNotesSince(t *testing.T) {
	got := NotesSince(sampleChangelog, "0.3.1", "v0.3.2")
	if len(got) != 2 || got[0].Version != "0.3.2" || got[1].Version != "0.3.1.1" {
		t.Fatalf("0.3.1 -> 0.3.2: got %+v", got)
	}
	// The file names no version between: the latest section alone.
	got = NotesSince(sampleChangelog, "0.3.2", "v0.3.3")
	if len(got) != 0 {
		t.Fatalf("0.3.2 -> 0.3.3 with no 0.3.3 section: got %+v", got)
	}
	// Headings that are not versions (a file in another style): the latest release's section.
	other := "## Latest\n- a\n\n## 0.3.2\n- b\n"
	got = NotesSince(other, "0.0.0", "v0.3.2")
	if len(got) != 1 || got[0].Version != "0.3.2" || got[0].Items[0] != "b" {
		t.Fatalf("fallback: got %+v", got)
	}
	// Many lines are capped, with a pointer to the page.
	var b strings.Builder
	b.WriteString("## 9.0.0\n")
	for i := 0; i < maxNoteLines+50; i++ {
		b.WriteString("- line\n")
	}
	got = NotesSince(b.String(), "0.0.0", "9.0.0")
	if len(got) != 1 || len(got[0].Items) != maxNoteLines+1 || !strings.HasPrefix(got[0].Items[maxNoteLines], "…") {
		t.Fatalf("cap: got %d items", len(got[0].Items))
	}
}

func TestChangelog(t *testing.T) {
	c, files := fakeGitHub(t, "/o/r/releases/tag/v0.2.0", map[string][]byte{"o/r/v0.2.0/CHANGELOG.md": []byte(sampleChangelog)}, "")
	c.Raw = files.URL
	text, err := c.Changelog(context.Background(), "v0.2.0")
	if err != nil || text != sampleChangelog {
		t.Fatalf("Changelog: %v (%d bytes)", err, len(text))
	}
	if _, err := c.Changelog(context.Background(), "v0.1.0"); err == nil {
		t.Fatal("missing file: want an error")
	}
	c.Raw = "https://example.invalid"
	if _, err := c.Changelog(context.Background(), "v0.2.0"); err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("other host: want refusal, got %v", err)
	}
}
