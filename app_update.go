package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/DerKyberTakt/tn5250-desktop/internal/update"
)

// Release asset names, fixed by .github/workflows/release.yml.
const (
	assetSetup    = "tn5250-terminal-setup-x64.exe"
	assetPortable = "tn5250-terminal-portable-x64.zip"
	assetAppImage = "tn5250-terminal-x86_64.AppImage"
	exeName       = "tn5250-terminal.exe"
	// updatedFromFlag is passed to the new exe after a portable swap so it waits for
	// the old process to exit (the single-instance lock would otherwise hand off to it).
	updatedFromFlag = "--updated-from="
)

// UpdateInfo is what Check for Updates shows.
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`    // tag, e.g. "v0.1.3"; empty when no release exists
	Available bool   `json:"available"` // Latest is newer than Current
	Page      string `json:"page"`      // release notes page
	// Mode is how this copy updates: "installer" (per-user setup, silent), "portable"
	// (exe swapped in place), "appimage", or "manual" (download from the page).
	Mode   string `json:"mode"`
	Reason string `json:"reason,omitempty"` // why Mode is "manual"
}

// UpdateCheck asks GitHub for the latest release.
func (a *App) UpdateCheck() (UpdateInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := update.New()
	info := UpdateInfo{Current: appVersion}
	info.Mode, info.Reason = updateMode()
	tag, err := c.Latest(ctx)
	if errors.Is(err, update.ErrNoRelease) {
		return info, nil
	}
	if err != nil {
		return info, friendlyUpdateError(err)
	}
	info.Latest = tag
	info.Page = c.ReleasePage(tag)
	info.Available = update.Compare(tag, appVersion) > 0
	return info, nil
}

// UpdateInstall downloads the release tagged tag, verifies it against SHA256SUMS,
// starts the new version and quits this one. Progress goes out as
// "update:progress" events (done, total bytes).
func (a *App) UpdateInstall(tag string) error {
	mode, reason := updateMode()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	c := update.New()
	progress := func(done, total int64) {
		if a.ctx != nil {
			wruntime.EventsEmit(a.ctx, "update:progress", done, total)
		}
	}
	exe, err := currentExe()
	if err != nil {
		return err
	}
	switch mode {
	case "installer":
		dir := filepath.Join(os.TempDir(), "tn5250-terminal-update")
		setup, err := c.Download(ctx, tag, assetSetup, dir, progress)
		if err != nil {
			return friendlyUpdateError(err)
		}
		// The installer waits for this process to let go of the exe, then restarts it.
		if err := exec.Command(setup, "/S", "/relaunch").Start(); err != nil {
			return fmt.Errorf("could not start the installer: %w", err)
		}
	case "portable", "appimage":
		dir := filepath.Dir(exe)
		next := exe + ".new"
		if mode == "portable" {
			zipPath, err := c.Download(ctx, tag, assetPortable, filepath.Join(os.TempDir(), "tn5250-terminal-update"), progress)
			if err != nil {
				return friendlyUpdateError(err)
			}
			if err := update.ExtractFile(zipPath, exeName, next); err != nil {
				return err
			}
			_ = os.Remove(zipPath)
		} else {
			got, err := c.Download(ctx, tag, assetAppImage, dir, progress)
			if err != nil {
				return friendlyUpdateError(err)
			}
			if err := os.Rename(got, next); err != nil {
				return err
			}
		}
		if err := update.Replace(exe, next); err != nil {
			_ = os.Remove(next)
			return fmt.Errorf("could not replace %s: %w", filepath.Base(exe), err)
		}
		cmd := exec.Command(exe, updatedFromFlag+strconv.Itoa(os.Getpid()))
		cmd.Dir = dir
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("updated, but could not restart: %w", err)
		}
	default:
		return errors.New(reason)
	}
	// Let the page receive the result, then exit so the new version can start.
	go func() {
		time.Sleep(300 * time.Millisecond)
		if a.ctx != nil {
			wruntime.Quit(a.ctx)
		}
	}()
	return nil
}

func currentExe() (string, error) {
	if p := os.Getenv("APPIMAGE"); p != "" && runtime.GOOS == "linux" {
		return p, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return exe, nil
}

// updateMode tells how this copy can update itself.
func updateMode() (mode, reason string) {
	exe, err := currentExe()
	if err != nil {
		return "manual", err.Error()
	}
	dir := filepath.Dir(exe)
	switch runtime.GOOS {
	case "windows":
		// The per-user installer puts uninstall.exe next to the app.
		if _, err := os.Stat(filepath.Join(dir, "uninstall.exe")); err == nil {
			return "installer", ""
		}
		if !strings.EqualFold(filepath.Base(exe), exeName) {
			return "manual", "This copy is not named " + exeName + "; download the update from the release page."
		}
		if !update.Writable(dir) {
			return "manual", "The folder " + dir + " is read-only; download the update from the release page."
		}
		return "portable", ""
	case "linux":
		if os.Getenv("APPIMAGE") != "" && update.Writable(dir) {
			return "appimage", ""
		}
		return "manual", "Install updates with your package manager or from the release page."
	default:
		return "manual", "Download the update from the release page."
	}
}

// afterUpdate runs before the window opens: a swapped-in exe waits for the old one
// to exit, and the exe left over from the swap is removed.
func afterUpdate(args []string) {
	for _, a := range args {
		if pid, ok := strings.CutPrefix(a, updatedFromFlag); ok {
			if n, err := strconv.Atoi(pid); err == nil {
				waitForExit(n, 15*time.Second)
			}
		}
	}
	exe, err := currentExe()
	if err != nil {
		return
	}
	go func() {
		for i := 0; i < 6 && !update.RemoveOld(exe); i++ {
			time.Sleep(5 * time.Second)
		}
	}()
}

func friendlyUpdateError(err error) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "x509"), strings.Contains(msg, "certificate"):
		return fmt.Errorf("could not verify github.com's certificate (a proxy may be intercepting HTTPS): %w", err)
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "dial tcp"), strings.Contains(msg, "timeout"),
		strings.Contains(msg, "Client.Timeout"), strings.Contains(msg, "connection refused"):
		return fmt.Errorf("could not reach github.com (offline, or a proxy is required: set HTTPS_PROXY): %w", err)
	}
	return err
}
