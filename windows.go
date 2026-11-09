package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Windows of the app. The hidden "broker" window owns every 5250 session (its page runs the
// session controllers); the visible windows render them. Messages between them travel as
// the "relay" event, delivered to one window by Relay. See src/desktop/relay.ts.

const brokerWindow = "broker"

// WindowBounds is a window's position and size on the virtual screen, in device-independent
// pixels (the same units as a page's screenX/screenY).
type WindowBounds struct {
	Name   string `json:"name"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

func (a *App) window(name string) (application.Window, error) {
	if a.wails == nil {
		return nil, errors.New("application not running")
	}
	win, ok := a.wails.Window.Get(name)
	if !ok {
		return nil, fmt.Errorf("no window %q", name)
	}
	return win, nil
}

// Relay delivers an event to one window (the broker or a visible window).
func (a *App) Relay(to string, name string, data any) error {
	win, err := a.window(to)
	if err != nil {
		return err
	}
	dispatch(win, name, data)
	return nil
}

// dispatch delivers an event to one window only. (win.EmitEvent is an app-wide broadcast
// that merely records the window as sender: every window would receive every message.)
func dispatch(win application.Window, name string, data any) {
	win.DispatchWailsEvent(&application.CustomEvent{Name: name, Data: data})
}

// WindowOpen opens a visible window loading the shell page for that window name. x and y
// place its top-left corner (negative = let the system decide); width and height 0 = default.
func (a *App) WindowOpen(name, title string, x, y, width, height int) error {
	if a.wails == nil {
		return errors.New("application not running")
	}
	name = strings.TrimSpace(name)
	if name == "" || name == brokerWindow || strings.ContainsAny(name, "?&/ ") {
		return fmt.Errorf("invalid window name %q", name)
	}
	if _, ok := a.wails.Window.Get(name); ok {
		return fmt.Errorf("window %q is already open", name)
	}
	if width <= 0 || height <= 0 {
		width, height = 1180, 800
	}
	win := a.newWindow(name, title, width, height)
	if x >= 0 && y >= 0 {
		win.SetPosition(x, y)
	}
	return nil
}

// WindowFocus brings a window to the front.
func (a *App) WindowFocus(name string) error {
	win, err := a.window(name)
	if err != nil {
		return err
	}
	win.Restore()
	win.Show()
	win.Focus()
	return nil
}

// WindowClose closes a visible window (its sessions are the broker's business).
func (a *App) WindowClose(name string) error {
	if name == brokerWindow {
		return errors.New("the broker window cannot be closed")
	}
	win, err := a.window(name)
	if err != nil {
		return err
	}
	win.Close()
	return nil
}

// WindowList names the visible windows.
func (a *App) WindowList() []WindowBounds {
	if a.wails == nil {
		return nil
	}
	var out []WindowBounds
	for _, w := range a.wails.Window.GetAll() {
		if w.Name() == brokerWindow || w.Name() == ghostWindow {
			continue
		}
		out = append(out, boundsOf(w))
	}
	return out
}

// WindowBounds reports where a window is, for drag-and-drop between windows.
func (a *App) WindowBounds(name string) (WindowBounds, error) {
	win, err := a.window(name)
	if err != nil {
		return WindowBounds{}, err
	}
	return boundsOf(win), nil
}

func boundsOf(w application.Window) WindowBounds {
	x, y := w.Position()
	width, height := w.Size()
	return WindowBounds{Name: w.Name(), X: x, Y: y, Width: width, Height: height}
}

// newWindow creates a visible shell window and wires its events: dropped files go to its
// page, closing it tells the broker (which closes or re-homes its sessions), and closing
// the last visible window quits the app (the hidden broker must not keep it alive).
func (a *App) newWindow(name, title string, width, height int) *application.WebviewWindow {
	url := "/"
	if name != mainWindow {
		url = "/?window=" + name
	}
	// The colour shown until the page paints: the shell's chrome colour of the system scheme.
	background := application.NewRGB(236, 236, 236)
	if a.wails.Env.IsDarkMode() {
		background = application.NewRGB(43, 43, 43)
	}
	win := a.wails.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             name,
		Title:            title,
		Width:            width,
		Height:           height,
		MinWidth:         640,
		MinHeight:        420,
		BackgroundColour: background,
		URL:              url,
		EnableFileDrop:   true,
		// Frameless with the page's title bar (app_frame.go). On Windows the page marks its
		// caption and buttons as non-client regions, so dragging, double-click, Snap Layouts
		// and the button clicks stay the system's; the DWM shadow and rounded corners stay too.
		Frameless: a.customFrame,
		Windows:   application.WindowsWindow{Theme: application.SystemDefault, NonClientRegionSupport: a.customFrame},
		Linux:     application.LinuxWindow{Icon: icon, WebviewGpuPolicy: application.WebviewGpuPolicyOnDemand},
	})
	win.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		dispatch(win, "files:dropped", e.Context().DroppedFiles())
	})
	win.OnWindowEvent(events.Common.WindowClosing, func(_ *application.WindowEvent) {
		a.emitTo(brokerWindow, "relay", map[string]any{"type": "window:closed", "window": name})
		if a.visibleWindows(name) == 0 {
			a.wails.Quit()
		}
	})
	return win
}

// newBrokerWindow creates the hidden window that owns the sessions.
func (a *App) newBrokerWindow() {
	a.wails.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:   brokerWindow,
		Title:  "TN5250 sessions",
		Width:  400,
		Height: 300,
		Hidden: true,
		URL:    "/broker.html",
	})
}

// visibleWindows counts the shell windows other than the one named.
func (a *App) visibleWindows(except string) int {
	n := 0
	for _, w := range a.wails.Window.GetAll() {
		if w.Name() != brokerWindow && w.Name() != ghostWindow && w.Name() != except {
			n++
		}
	}
	return n
}

// emitTo sends an event to one window, silently when it is not there.
func (a *App) emitTo(name, event string, data any) {
	if a.wails == nil {
		return
	}
	if win, ok := a.wails.Window.Get(name); ok {
		dispatch(win, event, data)
	}
}
