// Package update finds the latest GitHub Release of the app and downloads a
// release asset verified against the release's SHA256SUMS file.
//
// It talks only to github.com and GitHub's download hosts (*.githubusercontent.com),
// over HTTPS, without the rate-limited REST API: the latest tag comes from the
// redirect of github.com/<repo>/releases/latest. Nothing is sent but the requests
// themselves (no telemetry, no token). Proxies come from HTTPS_PROXY / NO_PROXY.
package update

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Repo is the GitHub repository releases come from.
const Repo = "DerKyberTakt/tn5250-desktop"

const (
	// SumsFile is the checksum asset every release carries (sha256sum format).
	SumsFile      = "SHA256SUMS"
	maxSumsBytes  = 64 << 10
	maxAssetBytes = 256 << 20
	maxRedirects  = 10
	userAgent     = "tn5250-terminal"
)

// ErrNoRelease means the repository has no published (non-prerelease) release yet.
var ErrNoRelease = errors.New("no release published yet")

// Client fetches release information and assets.
type Client struct {
	Base    string // "https://github.com"
	Repo    string
	HTTP    *http.Client
	Allowed func(u *url.URL) bool // every request and redirect target must pass
}

// New returns a client for the app's own repository on github.com.
func New() *Client {
	t := http.DefaultTransport.(*http.Transport).Clone() // keeps ProxyFromEnvironment
	t.TLSHandshakeTimeout = 15 * time.Second
	t.ResponseHeaderTimeout = 30 * time.Second
	return &Client{
		Base:    "https://github.com",
		Repo:    Repo,
		HTTP:    &http.Client{Transport: t, Timeout: 10 * time.Minute},
		Allowed: GitHubOnly,
	}
}

// GitHubOnly allows HTTPS to github.com and GitHub's release download hosts.
func GitHubOnly(u *url.URL) bool {
	if u.Scheme != "https" {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return h == "github.com" || strings.HasSuffix(h, ".githubusercontent.com")
}

// ReleasePage is the web page of a release, for "release notes" links.
func (c *Client) ReleasePage(tag string) string {
	return fmt.Sprintf("%s/%s/releases/tag/%s", c.Base, c.Repo, url.PathEscape(tag))
}

// Latest returns the tag of the latest published release (prereleases excluded).
func (c *Client) Latest(ctx context.Context) (string, error) {
	u := fmt.Sprintf("%s/%s/releases/latest", c.Base, c.Repo)
	hc := *c.HTTP
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := c.do(ctx, &hc, u)
	if err != nil {
		return "", err
	}
	_ = resp.Body.Close()
	if resp.StatusCode < 300 || resp.StatusCode > 399 {
		if resp.StatusCode == http.StatusNotFound {
			return "", ErrNoRelease
		}
		return "", fmt.Errorf("releases/latest: unexpected HTTP %d", resp.StatusCode)
	}
	loc, err := resp.Location()
	if err != nil {
		return "", fmt.Errorf("releases/latest: %w", err)
	}
	// .../releases/tag/v0.1.3 ; without any release GitHub redirects to .../releases.
	dir, tag := path.Split(loc.Path)
	if !strings.HasSuffix(dir, "/releases/tag/") || tag == "" {
		return "", ErrNoRelease
	}
	return url.PathUnescape(tag)
}

// Download fetches asset from the release tagged tag into dir, checks it against
// the release's SHA256SUMS and returns the path of the verified file. A file that
// fails the check is deleted.
func (c *Client) Download(ctx context.Context, tag, asset, dir string, progress func(done, total int64)) (string, error) {
	sums, err := c.fetch(ctx, c.assetURL(tag, SumsFile), maxSumsBytes)
	if err != nil {
		return "", fmt.Errorf("%s: %w", SumsFile, err)
	}
	want, ok := ParseSums(sums)[asset]
	if !ok {
		return "", fmt.Errorf("%s is not part of release %s", asset, tag)
	}

	resp, err := c.do(ctx, c.client(), c.assetURL(tag, asset))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: HTTP %d", asset, resp.StatusCode)
	}
	if resp.ContentLength > maxAssetBytes {
		return "", fmt.Errorf("%s: too large (%d bytes)", asset, resp.ContentLength)
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, asset+".*.part")
	if err != nil {
		return "", err
	}
	keep := false
	defer func() {
		_ = tmp.Close()
		if !keep {
			_ = os.Remove(tmp.Name())
		}
	}()

	h := sha256.New()
	pr := &progressReader{r: io.LimitReader(resp.Body, maxAssetBytes+1), total: resp.ContentLength, fn: progress}
	n, err := io.Copy(io.MultiWriter(tmp, h), pr)
	if err != nil {
		return "", fmt.Errorf("%s: %w", asset, err)
	}
	if n > maxAssetBytes {
		return "", fmt.Errorf("%s: too large", asset)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return "", fmt.Errorf("%s: checksum mismatch (got %s, release says %s)", asset, got, want)
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	final := filepath.Join(dir, asset)
	_ = os.Remove(final)
	if err := os.Rename(tmp.Name(), final); err != nil {
		return "", err
	}
	keep = true
	return final, nil
}

func (c *Client) assetURL(tag, name string) string {
	return fmt.Sprintf("%s/%s/releases/download/%s/%s", c.Base, c.Repo, url.PathEscape(tag), url.PathEscape(name))
}

// client follows redirects only to allowed hosts.
func (c *Client) client() *http.Client {
	hc := *c.HTTP
	hc.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= maxRedirects {
			return errors.New("too many redirects")
		}
		if !c.Allowed(req.URL) {
			return fmt.Errorf("refusing redirect to %s", req.URL.Host)
		}
		return nil
	}
	return &hc
}

func (c *Client) do(ctx context.Context, hc *http.Client, rawURL string) (*http.Response, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	if !c.Allowed(u) {
		return nil, fmt.Errorf("refusing to contact %s", u.Host)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	return hc.Do(req)
}

func (c *Client) fetch(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	resp, err := c.do(ctx, c.client(), rawURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("response too large")
	}
	return data, nil
}

// ParseSums reads sha256sum output ("<hex>  <name>" or "<hex> *<name>") into name -> lowercase hex.
func ParseSums(data []byte) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		hash, name, ok := strings.Cut(line, " ")
		if !ok || len(hash) != 64 {
			continue
		}
		if _, err := hex.DecodeString(hash); err != nil {
			continue
		}
		name = strings.TrimPrefix(strings.TrimLeft(name, " "), "*")
		if name != "" {
			out[name] = strings.ToLower(hash)
		}
	}
	return out
}

// Compare orders versions such as "0.1.2", "v0.1.2.1" and "0.2.0-rc1": numeric parts
// (missing ones count as 0), then a release sorts after its own prereleases.
// It returns -1, 0 or 1.
func Compare(a, b string) int {
	an, apre := splitVersion(a)
	bn, bpre := splitVersion(b)
	for i := 0; i < len(an) || i < len(bn); i++ {
		var x, y int
		if i < len(an) {
			x = an[i]
		}
		if i < len(bn) {
			y = bn[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	switch {
	case apre == bpre:
		return 0
	case apre == "":
		return 1
	case bpre == "":
		return -1
	case apre < bpre:
		return -1
	default:
		return 1
	}
}

func splitVersion(v string) ([]int, string) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	v, pre, _ := strings.Cut(v, "-")
	var nums []int
	for _, p := range strings.Split(v, ".") {
		n, err := strconv.Atoi(p)
		if err != nil {
			n = 0
		}
		nums = append(nums, n)
	}
	return nums, pre
}

type progressReader struct {
	r     io.Reader
	done  int64
	total int64
	last  time.Time
	fn    func(done, total int64)
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.done += int64(n)
	if p.fn != nil && (err != nil || time.Since(p.last) > 200*time.Millisecond) {
		p.last = time.Now()
		p.fn(p.done, p.total)
	}
	return n, err
}
