package main

import (
	"errors"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The ghost window: a small transparent, click-through, always-on-top window that shows the
// droplet of a tab being dragged while the pointer is outside the window the drag started
// in (a page can only draw inside its own window). The shell asks for it at the start of a
// drag (GhostPrepare, the WebView takes a moment to come up), shows and moves it while the
// pointer is outside (GhostShow / GhostMove) and hides it again (GhostHide).

const ghostWindow = "ghost"

// Windows extended styles for a window that never takes focus, never gets the mouse and is
// not on the task bar. Set as a whole (ExStyle replaces what Wails would compute).
const (
	wsExTransparent = 0x00000020
	wsExToolWindow  = 0x00000080
	wsExTopmost     = 0x00000008
	wsExLayered     = 0x00080000
	wsExNoActivate  = 0x08000000
)

type ghostState struct {
	mu    sync.Mutex
	win   *application.WebviewWindow
	label string
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
		Name:              ghostWindow,
		Title:             "TN5250 drag",
		Width:             260,
		Height:            60,
		Hidden:            true,
		Frameless:         true,
		DisableResize:     true,
		AlwaysOnTop:       true,
		IgnoreMouseEvents: true,
		BackgroundType:    application.BackgroundTypeTransparent,
		BackgroundColour:  application.NewRGBA(0, 0, 0, 0),
		URL:               "/ghost.html",
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
			ExStyle:                           wsExTransparent | wsExToolWindow | wsExTopmost | wsExLayered | wsExNoActivate,
		},
	})
	return g.win, nil
}

// GhostPrepare creates the ghost window (hidden) so it is ready when the pointer leaves.
func (a *App) GhostPrepare() error {
	_, err := a.ghostWin()
	return err
}

// GhostShow puts the droplet with the label at a screen point (DIPs, the page's screenX/Y).
func (a *App) GhostShow(label string, x, y int) error {
	win, err := a.ghostWin()
	if err != nil {
		return err
	}
	g := a.ghost()
	g.mu.Lock()
	g.label = label
	g.mu.Unlock()
	dispatch(win, "ghost:label", label)
	win.SetPosition(x-18, y-14)
	win.Show()
	return nil
}

// GhostMove follows the pointer.
func (a *App) GhostMove(x, y int) error {
	win, err := a.ghostWin()
	if err != nil {
		return err
	}
	win.SetPosition(x-18, y-14)
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
func (a *App) GhostLabel() string {
	g := a.ghost()
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.label
}
