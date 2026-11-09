package main

import (
	"encoding/json"
	"os"
	"runtime"
)

// The window frame. On Windows (and Linux, as an experiment) the app draws its own title
// bar (src/desktop/titlebar.ts) in a frameless window, like VS Code or Teams; the system
// frame is the escape hatch: View > Use System Title Bar writes systemTitleBar: true to
// settings.json and the next start honours it. macOS keeps the system frame.

// FrameInfo tells the page whether to draw the title bar and for which platform.
type FrameInfo struct {
	Custom   bool   `json:"custom"`
	Platform string `json:"platform"`
}

// wantsCustomFrame decides before the first window exists (the option cannot change later).
func wantsCustomFrame() bool {
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" {
		return false
	}
	p, err := settingsPath()
	if err != nil {
		return true
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return true
	}
	var f struct {
		SystemTitleBar bool `json:"systemTitleBar"`
	}
	if json.Unmarshal(b, &f) != nil {
		return true
	}
	return !f.SystemTitleBar
}

// FrameInfo is what the shell page asks when it loads.
func (a *App) FrameInfo() FrameInfo {
	return FrameInfo{Custom: a.customFrame, Platform: runtime.GOOS}
}
