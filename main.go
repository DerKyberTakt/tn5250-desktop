// TN5250 Terminal: a native desktop shell around the TypeScript TN5250 engine and canvas UI.
package main

import (
	"embed"
	"io/fs"
	"log"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:dist/desktop
var dist embed.FS

//go:embed build/appicon.png
var icon []byte

// mainWindow is the name of the first window; a second launch of the exe is forwarded to it.
const mainWindow = "main"

func main() {
	afterUpdate(os.Args[1:])
	assets, err := fs.Sub(dist, "dist/desktop")
	if err != nil {
		log.Fatal(err)
	}
	app := NewApp()
	wails := application.New(application.Options{
		Name:        "TN5250 Terminal",
		Description: "5250 terminal emulator for IBM i",
		Icon:        icon,
		Services:    []application.Service{application.NewService(app)},
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID:               "io.github.derkybertakt.tn5250-desktop",
			OnSecondInstanceLaunch: app.secondInstance,
		},
		OnShutdown: app.shutdown,
		Mac:        application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		Linux:      application.LinuxOptions{ProgramName: "tn5250-terminal"},
	})
	app.attach(wails)
	win := wails.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             mainWindow,
		Title:            "TN5250 Terminal",
		Width:            1180,
		Height:           800,
		MinWidth:         640,
		MinHeight:        420,
		BackgroundColour: application.NewRGB(0, 0, 0),
		URL:              "/",
		// Files dropped on the window are uploaded by the IFS browser; the page decides what a drop means.
		EnableFileDrop: true,
		Windows:        application.WindowsWindow{Theme: application.SystemDefault},
		Linux:          application.LinuxWindow{Icon: icon, WebviewGpuPolicy: application.WebviewGpuPolicyOnDemand},
	})
	win.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		win.EmitEvent("files:dropped", e.Context().DroppedFiles())
	})
	if err := wails.Run(); err != nil {
		log.Fatal(err)
	}
}
