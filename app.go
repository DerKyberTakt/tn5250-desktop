package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/zalando/go-keyring"
)

const (
	appDirName     = "tn5250-terminal"
	keyringService = "tn5250-terminal"
	maxImageBytes  = 4 * 1024 * 1024
)

// App is the service bound to the pages: every exported method is callable from the shell
// as Call.ByName("main.App.X", ...) (bridge.ts). Events go out with app.Event.Emit as one
// JSON payload each.
type App struct {
	wails   *application.App
	sockets *Sockets
	ifsOnce sync.Once
	ifsSt   *ifsState
	// The drag ghost window (app_ghost.go).
	ghostOnce sync.Once
	ghostSt   *ghostState
	sqlOnce sync.Once
	sqlSt   *sqlState
}

func NewApp() *App {
	a := &App{}
	a.sockets = NewSockets(a.emit)
	return a
}

// attach gives the service the running application (events, dialogs, windows).
func (a *App) attach(w *application.App) {
	a.wails = w
}

func (a *App) emit(event string, data any) {
	if a.wails == nil {
		return
	}
	// Socket bytes belong to the broker window alone; the rest is for whoever listens.
	if strings.HasPrefix(event, "net:") {
		a.emitTo(brokerWindow, event, data)
		return
	}
	a.wails.Event.Emit(event, data)
}

func (a *App) shutdown() {
	a.sockets.CloseAll()
	st := a.ifs()
	st.mu.Lock()
	sessions := st.sessions
	st.sessions = map[string]*ifsSession{}
	st.mu.Unlock()
	for _, s := range sessions {
		_ = s.client.Close()
	}
}

// secondInstance: another launch of the exe brings the main window up and hands it the
// command line (`tn5250-terminal host[:port]` opens that session there).
func (a *App) secondInstance(data application.SecondInstanceData) {
	if a.wails == nil {
		return
	}
	win, ok := a.wails.Window.Get(mainWindow)
	if !ok {
		return
	}
	win.Restore()
	win.Show()
	win.Focus()
	if len(data.Args) > 0 {
		dispatch(win, "launch:args", data.Args)
	}
}

// --- sockets ---

func (a *App) NetConnect(id string, o ConnectOptions) error { return a.sockets.Connect(id, o) }
func (a *App) NetSend(id string, data string) error         { return a.sockets.Send(id, data) }
func (a *App) NetClose(id string)                           { a.sockets.Close(id) }

// --- system ---

// LaunchArgs returns the command line after the program name: `tn5250-terminal host[:port]` opens a session.
func (a *App) LaunchArgs() []string {
	return os.Args[1:]
}

type SystemInfo struct {
	ComputerName string `json:"computerName"`
	UserName     string `json:"userName"`
	Platform     string `json:"platform"`
}

func (a *App) SystemInfo() SystemInfo {
	host, _ := os.Hostname()
	name := ""
	if u, err := user.Current(); err == nil {
		name = u.Username
		// Windows reports DOMAIN\user.
		if i := strings.LastIndexAny(name, `\/`); i >= 0 {
			name = name[i+1:]
		}
	}
	return SystemInfo{ComputerName: host, UserName: name, Platform: runtime.GOOS}
}

// --- settings (one JSON file in the user config directory) ---

func configDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, appDirName)
	return dir, os.MkdirAll(dir, 0o700)
}

func settingsPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.json"), nil
}

// SettingsLoad returns the settings file text; a user without one yet gets the
// preloaded settings an administrator may have put in place (see preloadedSettingsPaths),
// or "" when there is nothing at all.
func (a *App) SettingsLoad() (string, error) {
	p, err := settingsPath()
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return preloadedSettings(), nil
	}
	return string(b), err
}

// preloadedSettingsPaths lists the files a user who has no settings of their own yet
// starts from: settings.default.json next to the executable (a portable copy, or a seed
// an installer drops beside the exe). The file is only read until the user saves settings
// of their own; nothing is written there. Settings every user must keep getting belong in
// the managed file instead (managedSettingsPath).
var preloadedSettingsPaths = func() []string {
	var paths []string
	if exe, err := os.Executable(); err == nil {
		paths = append(paths, filepath.Join(filepath.Dir(exe), "settings.default.json"))
	}
	return paths
}

// managedSettingsPath is the machine-wide settings file an administrator maintains:
// the TN5250_MANAGED_SETTINGS environment variable when set (a local path or a network
// share), otherwise %ProgramData%\tn5250-terminal\settings.json on Windows,
// /Library/Application Support/tn5250-terminal/settings.json on macOS and
// /etc/tn5250-terminal/settings.json elsewhere. It is read at every start and layered
// under the user's own file (defaults, read-only company sessions, company macros, the
// update check); the app never writes to it.
var managedSettingsPath = func() string {
	if p := os.Getenv("TN5250_MANAGED_SETTINGS"); p != "" {
		return expandHome(p)
	}
	switch runtime.GOOS {
	case "windows":
		if pd := os.Getenv("ProgramData"); pd != "" {
			return filepath.Join(pd, appDirName, "settings.json")
		}
		return ""
	case "darwin":
		return filepath.Join("/Library/Application Support", appDirName, "settings.json")
	default:
		return filepath.Join("/etc", appDirName, "settings.json")
	}
}

// ManagedSettingsLoad returns the managed settings file text, or "" when there is none.
// A file that exists but cannot be read is an error the shell reports and goes on without.
func (a *App) ManagedSettingsLoad() (string, error) {
	p := managedSettingsPath()
	if p == "" {
		return "", nil
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return string(b), err
}

// SettingsPaths tells the user (Help > Settings File Location) where everything lives.
type SettingsPaths struct {
	// The user's own file.
	User string `json:"user"`
	// The managed file, "" when the platform has no place for one.
	Managed       string `json:"managed"`
	ManagedExists bool   `json:"managedExists"`
	// The first-start seed next to the executable, "" when unknown.
	Preload string `json:"preload"`
}

func (a *App) SettingsPaths() SettingsPaths {
	out := SettingsPaths{Managed: managedSettingsPath()}
	out.User, _ = settingsPath()
	if out.Managed != "" {
		if st, err := os.Stat(out.Managed); err == nil && !st.IsDir() {
			out.ManagedExists = true
		}
	}
	if paths := preloadedSettingsPaths(); len(paths) > 0 {
		out.Preload = paths[0]
	}
	return out
}

// preloadedSettings returns the first preloaded settings file that exists and is not empty.
func preloadedSettings() string {
	for _, p := range preloadedSettingsPaths() {
		b, err := os.ReadFile(p)
		if err == nil && len(strings.TrimSpace(string(b))) > 0 {
			return string(b)
		}
	}
	return ""
}

// SettingsSave replaces the settings file atomically.
func (a *App) SettingsSave(text string) error {
	p, err := settingsPath()
	if err != nil {
		return err
	}
	return writeFileAtomic(p, []byte(text))
}

func (a *App) SettingsFilePath() string {
	p, _ := settingsPath()
	return p
}

func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".settings-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(name, path)
	}
	if err != nil {
		_ = os.Remove(name)
	}
	return err
}

// --- secrets (Windows Credential Manager / Linux Secret Service) ---

func (a *App) SecretGet(key string) (string, error) {
	v, err := keyring.Get(keyringService, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return v, err
}

func (a *App) SecretSet(key, value string) error {
	if value == "" {
		return a.SecretDelete(key)
	}
	return keyring.Set(keyringService, key, value)
}

func (a *App) SecretDelete(key string) error {
	err := keyring.Delete(keyringService, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

// --- files and dialogs ---

type FileFilter struct {
	Name     string `json:"name"`
	Patterns string `json:"patterns"`
}

func toWailsFilters(filters []FileFilter) []application.FileFilter {
	out := make([]application.FileFilter, 0, len(filters))
	for _, f := range filters {
		out = append(out, application.FileFilter{DisplayName: f.Name, Pattern: f.Patterns})
	}
	return out
}

// PickFile shows an open dialog and returns the chosen path ("" when cancelled).
func (a *App) PickFile(title string, filters []FileFilter) (string, error) {
	return a.PickFileIn(title, filters, "")
}

// expandHome turns "~/..." into the path under the home directory.
func expandHome(dir string) string {
	if strings.HasPrefix(dir, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(dir, "~"))
		}
	}
	return dir
}

// existingDir is dir when it is a folder, else "" (the dialog then opens where the OS likes).
func existingDir(dir string) string {
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return ""
	}
	return dir
}

// PickFileIn is PickFile opening in dir when that folder exists ("~/..." = under the home directory).
func (a *App) PickFileIn(title string, filters []FileFilter, dir string) (string, error) {
	return a.wails.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		Title: title, Directory: existingDir(expandHome(dir)), Filters: toWailsFilters(filters), CanChooseFiles: true,
	}).PromptForSingleSelection()
}

// PickFilesIn is PickFileIn for several files; an empty list when cancelled.
func (a *App) PickFilesIn(title string, filters []FileFilter, dir string) ([]string, error) {
	paths, err := a.wails.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		Title: title, Directory: existingDir(expandHome(dir)), Filters: toWailsFilters(filters), CanChooseFiles: true, AllowsMultipleSelection: true,
	}).PromptForMultipleSelection()
	if paths == nil {
		paths = []string{}
	}
	sort.Strings(paths)
	return paths, err
}

// ListFiles lists the files in dir (not its subfolders) whose name ends with ext, ignoring
// case, sorted; "~/..." is under the home directory. A folder that does not exist gives none.
func (a *App) ListFiles(dir, ext string) ([]string, error) {
	dir = expandHome(dir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []string{}, nil
		}
		return nil, err
	}
	out := []string{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), strings.ToLower(ext)) {
			continue
		}
		out = append(out, filepath.Join(dir, e.Name()))
	}
	sort.Strings(out)
	return out, nil
}

// SaveTextFile asks where to save and writes the text; false when cancelled.
func (a *App) SaveTextFile(title, defaultName, text string, filters []FileFilter) (bool, error) {
	p, err := a.wails.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{Title: title, Filename: defaultName, Filters: toWailsFilters(filters)}).PromptForSingleSelection()
	if err != nil || p == "" {
		return false, err
	}
	return true, os.WriteFile(p, []byte(text), 0o600)
}

// ReadTextFile reads a small text file the user picked (colour schemes, keyboard maps).
func (a *App) ReadTextFile(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if st.Size() > 2*1024*1024 {
		return "", errors.New("file too large")
	}
	b, err := os.ReadFile(path)
	return string(b), err
}

var imageTypes = map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}

// ImageDataURL loads a watermark image as a data URL.
func (a *App) ImageDataURL(path string) (string, error) {
	mime, ok := imageTypes[strings.ToLower(filepath.Ext(path))]
	if !ok {
		return "", errors.New("not an image file")
	}
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if st.Size() > maxImageBytes {
		return "", fmt.Errorf("image larger than %d MB", maxImageBytes/1024/1024)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(b), nil
}

func (a *App) ClipboardSet(text string) error {
	if !a.wails.Clipboard.SetText(text) {
		return errors.New("clipboard not available")
	}
	return nil
}

func (a *App) ClipboardGet() (string, error) {
	// An empty clipboard, or one holding no text, pastes nothing; it is not an error.
	text, ok := a.wails.Clipboard.Text()
	if !ok {
		return "", nil
	}
	return text, nil
}

// OpenURL opens http(s) links in the default browser; nothing else.
func (a *App) OpenURL(url string) {
	lower := strings.ToLower(url)
	if strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "http://") {
		_ = a.wails.Browser.OpenURL(url)
	}
}

// RunPcCommand runs a PC Organizer command (STRPCCMD on the host) through the user's
// shell, as PC Organizer and tn5250j do. The policy that allowed it (open links only, ask,
// run everything) lives in the front end; wait=true (PAUSE(*YES)) returns when the command
// has exited, otherwise as soon as it started.
func (a *App) RunPcCommand(command string, wait bool) error {
	command = strings.TrimSpace(command)
	if command == "" {
		return errors.New("empty PC command")
	}
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd.exe", "/d", "/s", "/c", command)
	} else {
		cmd = exec.Command("/bin/sh", "-c", command)
	}
	if wait {
		return cmd.Run()
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
