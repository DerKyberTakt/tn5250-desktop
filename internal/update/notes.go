package update

import (
	"bufio"
	"context"
	"fmt"
	"net/url"
	"strings"
)

// RawBase is where a tagged file of the repository is read from (CHANGELOG.md of a release).
const RawBase = "https://raw.githubusercontent.com"

const (
	changelogFile = "CHANGELOG.md"
	maxNotesBytes = 512 << 10
	maxNoteLines  = 400
)

// Release is one section of CHANGELOG.md: "## <version> - <date>" and its bullet lines.
type Release struct {
	Version string   `json:"version"`
	Date    string   `json:"date,omitempty"`
	Items   []string `json:"items"`
}

// Changelog reads CHANGELOG.md as it is at tag.
func (c *Client) Changelog(ctx context.Context, tag string) (string, error) {
	base := c.Raw
	if base == "" {
		base = RawBase
	}
	u := fmt.Sprintf("%s/%s/%s/%s", base, c.Repo, url.PathEscape(tag), changelogFile)
	data, err := c.fetch(ctx, u, maxNotesBytes)
	if err != nil {
		return "", fmt.Errorf("%s: %w", changelogFile, err)
	}
	return string(data), nil
}

// ParseChangelog splits a Keep-a-Changelog style file into its releases, newest first,
// as the file lists them. A heading is "## <version> - <date>" or "## <version>"; the
// lines under it that start with "- " are its items (a line that does not, such as a
// paragraph or a continued item, is appended to the previous item).
func ParseChangelog(text string) []Release {
	var out []Release
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), " \t\r")
		switch {
		case strings.HasPrefix(line, "## "):
			head := strings.TrimSpace(line[3:])
			ver, date, _ := strings.Cut(head, " - ")
			out = append(out, Release{Version: strings.TrimSpace(ver), Date: strings.TrimSpace(date)})
		case len(out) == 0:
			// Text before the first heading (the file title).
		case strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* "):
			r := &out[len(out)-1]
			r.Items = append(r.Items, strings.TrimSpace(line[2:]))
		case strings.TrimSpace(line) == "" || strings.HasPrefix(line, "#"):
			// Blank lines and deeper headings carry nothing.
		default:
			r := &out[len(out)-1]
			if n := len(r.Items); n > 0 {
				r.Items[n-1] += " " + strings.TrimSpace(line)
			} else {
				r.Items = append(r.Items, strings.TrimSpace(line))
			}
		}
	}
	return out
}

// NotesSince returns the releases newer than current up to and including latest, newest
// first: what a user of current gets by updating to latest. When the file names none of
// them (the headings do not parse as versions), it returns the latest release alone, and
// when that is missing too, nothing. The number of lines is capped so a dialog can hold it.
func NotesSince(changelog, current, latest string) []Release {
	var out []Release
	lines := 0
	for _, r := range ParseChangelog(changelog) {
		if !isVersion(r.Version) || Compare(r.Version, current) <= 0 || Compare(r.Version, latest) > 0 {
			continue
		}
		if lines+len(r.Items) > maxNoteLines {
			r.Items = append(r.Items[:max(0, maxNoteLines-lines)], "… more on the release page.")
			out = append(out, r)
			break
		}
		lines += len(r.Items)
		out = append(out, r)
	}
	if len(out) == 0 {
		for _, r := range ParseChangelog(changelog) {
			if isVersion(r.Version) && Compare(r.Version, latest) == 0 {
				return []Release{r}
			}
		}
	}
	return out
}

// isVersion tells "0.3.2" and "v0.3.1.1" from "Unreleased".
func isVersion(v string) bool {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" || v[0] < '0' || v[0] > '9' {
		return false
	}
	return true
}
