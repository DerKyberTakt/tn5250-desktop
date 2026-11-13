package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/db"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/ifs"
	"github.com/wailsapp/wails/v3/pkg/application"
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
	// db is the database-server connection a subtree search opens on first use.
	db *db.Client
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
		if s.db != nil {
			_ = s.db.Close()
		}
	}
}

// IfsHit is one match of IfsSearch: the name is the path relative to the folder searched.
type IfsHit struct {
	Name     string    `json:"name"`
	Dir      bool      `json:"dir"`
	Size     uint64    `json:"size"`
	Modified time.Time `json:"modified"`
}

// IfsSearch finds the entries of dir whose names contain text (* and ? are wildcards).
// In the folder itself the pattern goes to the file server, so a folder of tens of
// thousands of files is filtered on the host. With subtree the whole tree below dir is
// searched through QSYS2.IFS_OBJECT_STATISTICS on the database server (opened on first
// use; it needs the *DATABASE host server and IBM i 7.3 or later); at most 2000 hits.
func (a *App) IfsSearch(id, dir, text string, subtree bool) ([]IfsHit, error) {
	s, err := a.ifsSession(id)
	if err != nil {
		return nil, err
	}
	dir = ifs.Clean(dir)
	if !subtree {
		es, err := s.client.ListPattern(dir, text)
		if err != nil {
			return nil, err
		}
		out := make([]IfsHit, 0, len(es))
		for _, e := range es {
			out = append(out, IfsHit{Name: e.Name, Dir: e.Dir, Size: e.Size, Modified: e.Modified})
		}
		return out, nil
	}
	if s.db == nil {
		c, err := db.Open(db.Options{DialOptions: s.options, Naming: "sql"})
		if err != nil {
			return nil, fmt.Errorf("the subtree search needs the database host server: %w", err)
		}
		s.db = c
	}
	// The name part of the path (after the last slash) must contain the text; * and ?
	// become the SQL wildcards, LIKE's own wildcards in the text are escaped.
	like := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`, `*`, `%`, `?`, `_`).Replace(strings.ToUpper(strings.TrimSpace(text)))
	if !strings.ContainsAny(text, "*?") {
		like = "%" + like + "%"
	}
	q := func(v string) string { return strings.ReplaceAll(v, "'", "''") }
	sql := "SELECT PATH_NAME, OBJECT_TYPE, DATA_SIZE, LAST_WRITE_TIMESTAMP FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(START_PATH_NAME => '" + q(dir) + "', SUBTREE_DIRECTORIES => 'YES', OBJECT_TYPE_LIST => '*ALLSTMF *DIR')) " +
		"WHERE PATH_NAME <> '" + q(dir) + "' AND UPPER(SUBSTR(PATH_NAME, LENGTH(PATH_NAME) - LOCATE('/', REVERSE(PATH_NAME)) + 2)) LIKE '" + q(like) + "' ESCAPE '\\' " +
		"ORDER BY PATH_NAME FETCH FIRST 2000 ROWS ONLY"
	rows, data, err := s.db.Query(sql, 1000)
	if err != nil {
		var e *db.Error
		if !errors.As(err, &e) {
			_ = s.db.Close()
			s.db = nil
		}
		return nil, err
	}
	all := data
	for !rows.Done {
		d, err := rows.Next()
		if err != nil {
			return nil, err
		}
		all = append(all, d...)
	}
	_ = rows.Close()
	prefix := dir + "/"
	if dir == "/" {
		prefix = "/"
	}
	out := make([]IfsHit, 0, len(all))
	for _, r := range all {
		if len(r) < 4 || r[0] == nil {
			continue
		}
		h := IfsHit{Name: strings.TrimPrefix(*r[0], prefix)}
		if r[1] != nil {
			h.Dir = strings.TrimSpace(*r[1]) == "*DIR"
		}
		if r[2] != nil {
			fmt.Sscan(strings.TrimSpace(*r[2]), &h.Size)
		}
		if r[3] != nil {
			if t, err := time.ParseInLocation("2006-01-02 15:04:05", strings.TrimSpace(*r[3])[:19], time.Local); err == nil {
				h.Modified = t
			}
		}
		out = append(out, h)
	}
	return out, nil
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
	a.emit("ifs:progress", p)
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
		local, err := a.wails.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{Title: "Download " + path.Base(remotes[0]), Filename: safeLocalName(path.Base(remotes[0]))}).PromptForSingleSelection()
		if err != nil || local == "" {
			return 0, err
		}
		if err := planDownload(c, ifs.Clean(remotes[0]), local, 0, &files, &dirs); err != nil {
			return 0, err
		}
	} else {
		dest, err := a.wails.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{Title: "Download to folder", CanChooseDirectories: true, CanChooseFiles: false}).PromptForSingleSelection()
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
		paths, err = a.wails.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{Title: "Upload to " + remoteDir, CanChooseFiles: true, AllowsMultipleSelection: true}).PromptForMultipleSelection()
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

// IfsBytes is a file's content for the viewer: base64 data, the data CCSID the server reports
// (0 = unknown), the full size and whether the data stops short of it.
type IfsBytes struct {
	Data      string `json:"data"`
	Ccsid     uint16 `json:"ccsid"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
}

const maxReadBytes = 16 * 1024 * 1024

// IfsReadBytes returns up to maxBytes of a file (capped at 16 MB) with its CCSID.
func (a *App) IfsReadBytes(id, p string, maxBytes int) (IfsBytes, error) {
	s, err := a.ifsSession(id)
	if err != nil {
		return IfsBytes{}, err
	}
	st, err := s.client.Stat(p)
	if err != nil {
		return IfsBytes{}, err
	}
	if st.Dir {
		return IfsBytes{}, errors.New("that is a folder")
	}
	if st.Type == 4 {
		return IfsBytes{}, errors.New("that is a QSYS.LIB object, not a stream file; use a 5250 session or SQL to look at it")
	}
	if maxBytes <= 0 || maxBytes > maxReadBytes {
		maxBytes = maxReadBytes
	}
	data, ccsid, truncated, err := s.client.ReadAll(p, maxBytes)
	if err != nil {
		return IfsBytes{}, err
	}
	return IfsBytes{Data: base64.StdEncoding.EncodeToString(data), Ccsid: ccsid, Size: int64(st.Size), Truncated: truncated}, nil
}

// IfsWriteBytes writes base64 data to a file. An existing file is replaced only when replace is
// set (otherwise EXISTS: name); a created file is tagged with ccsid (0 = the server's choice).
func (a *App) IfsWriteBytes(id, p, dataB64 string, ccsid uint16, replace bool) error {
	s, err := a.ifsSession(id)
	if err != nil {
		return err
	}
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return fmt.Errorf("bad data: %w", err)
	}
	if !replace {
		if _, err := s.client.Stat(p); err == nil {
			return &ExistsError{Names: []string{path.Base(p)}}
		} else if !ifs.IsNotFound(err) {
			return err
		}
	}
	return s.client.WriteAll(p, data, ccsid)
}
