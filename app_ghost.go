package main

import (
	"errors"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The ghost window: a small transparent, always-on-top window that shows the droplet of a
// tab being dragged while the pointer is outside the window the drag started in (a page can
// only draw inside its own window). The shell asks for it at the start of a drag
// (GhostPrepare, the WebView takes a moment to come up), shows and moves it while the
// pointer is outside (GhostShow / GhostMove) and hides it again (GhostHide).
//
// It is NOT click-through (IgnoreMouseEvents): in Wails 3.1 on Windows that option turns the
// window into a layered window, and a layered window cannot be transparent in windowed
// hosting; the droplet then sat in an opaque white box. The window never takes the mouse
// anyway: the page that started the drag holds the pointer capture, and the drop target is
// found from the window list (which leaves this window out), not by hit testing.

const ghostWindow = "ghost"

// Windows extended styles for a window that never takes focus and is not on the task bar.
// Set as a whole (ExStyle replaces what Wails would compute). WS_EX_NOREDIRECTIONBITMAP is
// what Wails itself uses for a transparent window: the WebView composes straight onto the
// screen, nothing is painted behind it.
const (
	wsExToolWindow          = 0x00000080
	wsExTopmost             = 0x00000008
	wsExNoActivate          = 0x08000000
	wsExNoRedirectionBitmap = 0x00200000
)

// Where the droplet sits inside the ghost window (ghost.css: .ghost-page .tab-ghost), so the
// window is placed with the droplet's corner at the pointer, like the in-page droplet.
const (
	ghostDX     = 12
	ghostDY     = 14
	ghostWidth  = 280
	ghostHeight = 84
)

// GhostInfo is what the ghost page shows: the tab's name and the app's appearance
// ("system", "light" or "dark"), so the droplet matches the window it came out of.
type GhostInfo struct {
	Label string `json:"label"`
	Theme string `json:"theme"`
}

type ghostState struct {
	mu   sync.Mutex
	win  *application.WebviewWindow
	info GhostInfo
}

func (a *App) ghost() *ghostState {
	a.ghostOnce.Do(func() { a.ghostSt = &ghostState{} })
	return a.ghostSt
}

// ghostWin returns the ghost window, creating it hidden on first use.
func (a *App) ghostWin() (*application.WebviewWindow, error) {
	if a.wails == nil {
		return nil, errors.New("application not running")
	}
	g := a.ghost()
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.win != nil {
		return g.win, nil
	}
	g.win = a.wails.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             ghostWindow,
		Title:            "TN5250 drag",
		Width:            ghostWidth,
		Height:           ghostHeight,
		Hidden:           true,
		Frameless:        true,
		DisableResize:    true,
		AlwaysOnTop:      true,
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.NewRGBA(0, 0, 0, 0),
		URL:              "/ghost.html",
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
			ExStyle:                           wsExNoRedirectionBitmap | wsExToolWindow | wsExTopmost | wsExNoActivate,
		},
	})
	return g.win, nil
}

// GhostPrepare creates the ghost window (hidden) so it is ready when the pointer leaves.
func (a *App) GhostPrepare() error {
	_, err := a.ghostWin()
	return err
}

// GhostShow puts the droplet with the label at a screen point (DIPs, the page's screenX/Y),
// drawn for the app's appearance ("system", "light", "dark").
func (a *App) GhostShow(label, theme string, x, y int) error {
	win, err := a.ghostWin()
	if err != nil {
		return err
	}
	info := GhostInfo{Label: label, Theme: theme}
	g := a.ghost()
	g.mu.Lock()
	g.info = info
	g.mu.Unlock()
	dispatch(win, "ghost:label", info)
	win.SetPosition(x-ghostDX, y-ghostDY)
	win.Show()
	return nil
}

// GhostMove follows the pointer.
func (a *App) GhostMove(x, y int) error {
	win, err := a.ghostWin()
	if err != nil {
		return err
	}
	win.SetPosition(x-ghostDX, y-ghostDY)
	return nil
}

// GhostHide takes the droplet away (the pointer is back inside a window, or the drag ended).
func (a *App) GhostHide() {
	g := a.ghost()
	g.mu.Lock()
	win := g.win
	g.mu.Unlock()
	if win != nil {
		win.Hide()
	}
}

// GhostLabel is what the ghost page asks for when it has loaded (the event may have been earlier).
func (a *App) GhostLabel() GhostInfo {
	g := a.ghost()
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.info
}
