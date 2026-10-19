package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/ifs"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// IfsConnectRequest is what the shell sends to open an IFS browser.
type IfsConnectRequest struct {
	Host                string `json:"host"`
	TLS                 bool   `json:"tls"`
	TrustAnyCertificate bool   `json:"trustAnyCertificate"`
	User                string `json:"user"`
	Password            string `json:"password"`
	TimeoutMs           int    `json:"timeoutMs"`
}

type ifsSession struct {
	client  *ifs.Client
	options hs.DialOptions // kept in memory for transfer connections; never written anywhere
}

// ifsState holds the open IFS sessions and running transfers.
type ifsState struct {
	mu        sync.Mutex
	sessions  map[string]*ifsSession
	cancelled map[string]bool
	next      int
}

func (a *App) ifs() *ifsState {
	a.ifsOnce.Do(func() {
		a.ifsSt = &ifsState{sessions: map[string]*ifsSession{}, cancelled: map[string]bool{}}
	})
	return a.ifsSt
}

func (a *App) ifsSession(id string) (*ifsSession, error) {
	st := a.ifs()
	st.mu.Lock()
	defer st.mu.Unlock()
	s := st.sessions[id]
	if s == nil {
		return nil, errors.New("the IFS session is closed; reopen the browser")
	}
	return s, nil
}

// IfsConnect signs on to the file server and returns a session id.
func (a *App) IfsConnect(r IfsConnectRequest) (string, error) {
	timeout := time.Duration(r.TimeoutMs) * time.Millisecond
	o := hs.DialOptions{Host: r.Host, TLS: r.TLS, TrustAnyCertificate: r.TrustAnyCertificate, Timeout: timeout, User: r.User, Password: r.Password}
	c, err := ifs.Open(o)
	if err != nil {
		return "", err
	}
	st := a.ifs()
	st.mu.Lock()
	defer st.mu.Unlock()
	st.next++
	id := fmt.Sprintf("ifs%d", st.next)
	st.sessions[id] = &ifsSession{client: c, options: o}
	return id, nil
}

// IfsClose ends a session.
func (a *App) IfsClose(id string) {
	st := a.ifs()
	st.mu.Lock()
	s := st.sessions[id]
	delete(st.sessions, id)
	st.mu.Unlock()
	if s != nil {
		_ = s.client.Close()
	}
}

func (a *App) IfsList(id, dir string) ([]ifs.Entry, error) {
	s, err := a.ifsSession(id)
	if err != nil {
		return nil, err
	}
	es, err := s.client.List(dir)
	if es == nil && err == nil {
		es = []ifs.Entry{}
	}
	return es, err
}

func (a *App) IfsMkdir(id, p string) error {
	s, err := a.ifsSession(id)
	if err != nil {
		return err
	}
	return s.client.Mkdir(p)
}

func (a *App) IfsRename(id, from, to string) error {
	s, err := a.ifsSession(id)
	if err != nil {
		return err
	}
	return s.client.Rename(from, to, false)
}

// IfsDelete removes a file, or a folder with everything in it when recursive is set.
func (a *App) IfsDelete(id, p string, dir, recursive bool) error {
	s, err := a.ifsSession(id)
	if err != nil {
		return err
	}
	if !dir {
		return s.client.Remove(p, false)
	}
	if recursive {
		return deleteTree(s.client, ifs.Clean(p), 0)
	}
	return s.client.Remove(p, true)
}

func deleteTree(c *ifs.Client, p string, depth int) error {
	if depth > 64 {
		return fmt.Errorf("delete %s: folders nested too deeply", p)
	}
	es, err := c.List(p)
	if err != nil {
		return err
	}
	for _, e := range es {
		child := path.Join(p, e.Name)
		if e.Dir && !e.Symlink {
			if err := deleteTree(c, child, depth+1); err != nil {
				return err
			}
			continue
		}
		if err := c.Remove(child, false); err != nil {
			return err
		}
	}
	return c.Remove(p, true)
}

// IfsProgress is sent as the "ifs:progress" event.
type IfsProgress struct {
	Transfer string `json:"transfer"`
	File     string `json:"file"`
	Done     int64  `json:"done"`
	Total    int64  `json:"total"`
	Files    int    `json:"files"`
	FilesNow int    `json:"filesNow"`
}

var errCancelled = errors.New("cancelled")

func (a *App) isCancelled(transfer string) bool {
	st := a.ifs()
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.cancelled[transfer]
}

// IfsCancel stops a running transfer after the current block.
func (a *App) IfsCancel(transfer string) {
	st := a.ifs()
	st.mu.Lock()
	st.cancelled[transfer] = true
	st.mu.Unlock()
}

func (a *App) emitProgress(p IfsProgress) {
	if a.ctx != nil {
		wruntime.EventsEmit(a.ctx, "ifs:progress", p)
	}
}

// cancelWriter stops a download when the transfer is cancelled.
type cancelWriter struct {
	w      io.Writer
	cancel func() bool
}

func (c cancelWriter) Write(p []byte) (int, error) {
	if c.cancel() {
		return 0, errCancelled
	}
	return c.w.Write(p)
}

type cancelReader struct {
	r      io.Reader
	cancel func() bool
}

func (c cancelReader) Read(p []byte) (int, error) {
	if c.cancel() {
		return 0, errCancelled
	}
	return c.r.Read(p)
}

// transferClient opens a second connection so browsing stays responsive during a transfer.
func transferClient(s *ifsSession) (*ifs.Client, error) { return ifs.Open(s.options) }

type plannedFile struct {
	remote string
	local  string
	size   int64
}

func planDownload(c *ifs.Client, remote, local string, depth int, out *[]plannedFile, dirs *[]string) error {
	st, err := c.Stat(remote)
	if err != nil {
		return err
	}
	if !st.Dir {
		*out = append(*out, plannedFile{remote: remote, local: local, size: int64(st.Size)})
		return nil
	}
	if depth > 64 {
		return fmt.Errorf("%s: folders nested too deeply", remote)
	}
	*dirs = append(*dirs, local)
	es, err := c.List(remote)
	if err != nil {
		return err
	}
	for _, e := range es {
		if e.Symlink {
			continue
		}
		name := safeLocalName(e.Name)
		if e.Dir {
			if err := planDownload(c, path.Join(remote, e.Name), filepath.Join(local, name), depth+1, out, dirs); err != nil {
				return err
			}
		} else {
			*out = append(*out, plannedFile{remote: path.Join(remote, e.Name), local: filepath.Join(local, name), size: int64(e.Size)})
		}
	}
	return nil
}

// safeLocalName keeps a remote name usable as a Windows/Linux file name.
func safeLocalName(n string) string {
	r := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "|", "_")
	n = strings.TrimRight(r.Replace(n), ". ")
	if n == "" {
		n = "_"
	}
	return n
}

// IfsDownload asks for a local folder (several items or a folder) or file name (one file) and copies
// the remote paths there. Returns the number of files copied (0 when cancelled at the dialog).
func (a *App) IfsDownload(id string, remotes []string, transfer string) (int, error) {
	s, err := a.ifsSession(id)
	if err != nil {
		return 0, err
	}
	if len(remotes) == 0 {
		return 0, nil
	}
	c, err := transferClient(s)
	if err != nil {
		return 0, err
	}
	defer c.Close()

	var files []plannedFile
	var dirs []string
	single := len(remotes) == 1
	if single {
		st, err := c.Stat(remotes[0])
		if err != nil {
			return 0, err
		}
		single = !st.Dir
	}
	if single {
		local, err := wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{Title: "Download " + path.Base(remotes[0]), DefaultFilename: safeLocalName(path.Base(remotes[0]))})
		if err != nil || local == "" {
			return 0, err
		}
		if err := planDownload(c, ifs.Clean(remotes[0]), local, 0, &files, &dirs); err != nil {
			return 0, err
		}
	} else {
		dest, err := wruntime.OpenDirectoryDialog(a.ctx, wruntime.OpenDialogOptions{Title: "Download to folder"})
		if err != nil || dest == "" {
			return 0, err
		}
		for _, r := range remotes {
			r = ifs.Clean(r)
			if err := planDownload(c, r, filepath.Join(dest, safeLocalName(path.Base(r))), 0, &files, &dirs); err != nil {
				return 0, err
			}
		}
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return 0, err
		}
	}
	var total, base int64
	for _, f := range files {
		total += f.size
	}
	cancel := func() bool { return a.isCancelled(transfer) }
	for i, f := range files {
		if cancel() {
			return i, errCancelled
		}
		if err := downloadOne(c, f, func(n int64) {
			a.emitProgress(IfsProgress{Transfer: transfer, File: f.remote, Done: base + n, Total: total, Files: len(files), FilesNow: i + 1})
		}, cancel); err != nil {
			return i, err
		}
		base += f.size
	}
	a.emitProgress(IfsProgress{Transfer: transfer, Done: total, Total: total, Files: len(files), FilesNow: len(files)})
	return len(files), nil
}

func downloadOne(c *ifs.Client, f plannedFile, progress func(int64), cancel func() bool) error {
	tmp := f.local + ".part"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	err = c.Download(f.remote, cancelWriter{w: out, cancel: cancel}, progress)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Remove(f.local)
	return os.Rename(tmp, f.local)
}

// IfsUpload copies local files (a dialog when paths is empty) into the remote folder.
// Existing remote files are replaced only when replace is set; otherwise the conflict is reported.
func (a *App) IfsUpload(id, remoteDir string, paths []string, replace bool, transfer string) (int, error) {
	s, err := a.ifsSession(id)
	if err != nil {
		return 0, err
	}
	if len(paths) == 0 {
		paths, err = wruntime.OpenMultipleFilesDialog(a.ctx, wruntime.OpenDialogOptions{Title: "Upload to " + remoteDir})
		if err != nil || len(paths) == 0 {
			return 0, err
		}
	}
	c, err := transferClient(s)
	if err != nil {
		return 0, err
	}
	defer c.Close()

	type item struct {
		local, remote string
		size          int64
	}
	var items []item
	var mkdirs []string
	var walk func(local, remote string, depth int) error
	walk = func(local, remote string, depth int) error {
		info, err := os.Stat(local)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			items = append(items, item{local, remote, info.Size()})
			return nil
		}
		if depth > 64 {
			return fmt.Errorf("%s: folders nested too deeply", local)
		}
		mkdirs = append(mkdirs, remote)
		entries, err := os.ReadDir(local)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := walk(filepath.Join(local, e.Name()), path.Join(remote, e.Name()), depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	base := ifs.Clean(remoteDir)
	for _, p := range paths {
		if err := walk(p, path.Join(base, filepath.Base(p)), 0); err != nil {
			return 0, err
		}
	}
	if !replace {
		var exists []string
		for _, it := range items {
			if _, err := c.Stat(it.remote); err == nil {
				exists = append(exists, path.Base(it.remote))
			} else if !ifs.IsNotFound(err) {
				return 0, err
			}
		}
		if len(exists) > 0 {
			return 0, &ExistsError{Names: exists}
		}
	}
	for _, d := range mkdirs {
		if err := c.Mkdir(d); err != nil {
			var fe *ifs.Error
			if !(errors.As(err, &fe) && fe.Code == 0x04) { // already exists is fine
				return 0, err
			}
		}
	}
	var total, done int64
	for _, it := range items {
		total += it.size
	}
	cancel := func() bool { return a.isCancelled(transfer) }
	for i, it := range items {
		if cancel() {
			return i, errCancelled
		}
		f, err := os.Open(it.local)
		if err != nil {
			return i, err
		}
		err = c.Upload(it.remote, cancelReader{r: f, cancel: cancel}, func(n int64) {
			a.emitProgress(IfsProgress{Transfer: transfer, File: it.remote, Done: done + n, Total: total, Files: len(items), FilesNow: i + 1})
		})
		_ = f.Close()
		if err != nil {
			return i, err
		}
		done += it.size
	}
	a.emitProgress(IfsProgress{Transfer: transfer, Done: total, Total: total, Files: len(items), FilesNow: len(items)})
	return len(items), nil
}

// ExistsError lists remote files an upload would replace.
type ExistsError struct{ Names []string }

func (e *ExistsError) Error() string {
	const max = 5
	shown := e.Names
	more := ""
	if len(shown) > max {
		more = fmt.Sprintf(" and %d more", len(shown)-max)
		shown = shown[:max]
	}
	return "EXISTS: " + strings.Join(shown, ", ") + more
}

const maxViewBytes = 2 * 1024 * 1024

// IfsReadText returns a small file as text for the viewer (UTF-8; other bytes shown as Latin-1).
func (a *App) IfsReadText(id, p string) (string, error) {
	s, err := a.ifsSession(id)
	if err != nil {
		return "", err
	}
	st, err := s.client.Stat(p)
	if err != nil {
		return "", err
	}
	if st.Dir {
		return "", errors.New("that is a folder")
	}
	if st.Size > maxViewBytes {
		return "", fmt.Errorf("the file is %d MB; download it to open it", st.Size/1024/1024)
	}
	var buf bytes.Buffer
	if err := s.client.Download(p, &buf, nil); err != nil {
		return "", err
	}
	b := buf.Bytes()
	if utf8.Valid(b) {
		return string(b), nil
	}
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r), nil
}
