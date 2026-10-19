package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/options"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/zalando/go-keyring"
)

const (
	appDirName     = "tn5250-terminal"
	keyringService = "tn5250-terminal"
	maxImageBytes  = 4 * 1024 * 1024
)

// App is bound to the page: every exported method is callable from the shell as window.go.main.App.X.
type App struct {
	ctx     context.Context
	sockets *Sockets
}

func NewApp() *App {
	a := &App{}
	a.sockets = NewSockets(func(event string, args ...interface{}) {
		if a.ctx != nil {
			wruntime.EventsEmit(a.ctx, event, args...)
		}
	})
	return a
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) shutdown(_ context.Context) {
	a.sockets.CloseAll()
}

func (a *App) secondInstance(_ options.SecondInstanceData) {
	if a.ctx == nil {
		return
	}
	wruntime.WindowUnminimise(a.ctx)
	wruntime.WindowShow(a.ctx)
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

// SettingsLoad returns the settings file text, or "" when there is none yet.
func (a *App) SettingsLoad() (string, error) {
	p, err := settingsPath()
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return string(b), err
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

func toWailsFilters(filters []FileFilter) []wruntime.FileFilter {
	out := make([]wruntime.FileFilter, 0, len(filters))
	for _, f := range filters {
		out = append(out, wruntime.FileFilter{DisplayName: f.Name, Pattern: f.Patterns})
	}
	return out
}

// PickFile shows an open dialog and returns the chosen path ("" when cancelled).
func (a *App) PickFile(title string, filters []FileFilter) (string, error) {
	return wruntime.OpenFileDialog(a.ctx, wruntime.OpenDialogOptions{Title: title, Filters: toWailsFilters(filters)})
}

// SaveTextFile asks where to save and writes the text; false when cancelled.
func (a *App) SaveTextFile(title, defaultName, text string, filters []FileFilter) (bool, error) {
	p, err := wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{Title: title, DefaultFilename: defaultName, Filters: toWailsFilters(filters)})
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
	return wruntime.ClipboardSetText(a.ctx, text)
}

func (a *App) ClipboardGet() (string, error) {
	return wruntime.ClipboardGetText(a.ctx)
}

// OpenURL opens http(s) links in the default browser; nothing else.
func (a *App) OpenURL(url string) {
	lower := strings.ToLower(url)
	if strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "http://") {
		wruntime.BrowserOpenURL(a.ctx, url)
	}
}
