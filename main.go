// TN5250 Terminal: a native desktop shell around the TypeScript TN5250 engine and canvas UI.
package main

import (
	"embed"
	"io/fs"
	"log"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"
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
		// The hidden broker window runs the sessions: it must not quit the app on its own, and
		// its timers must not be throttled as a background page.
		Mac:   application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: false},
		Linux: application.LinuxOptions{ProgramName: "tn5250-terminal", DisableQuitOnLastWindowClosed: true},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
			AdditionalBrowserArgs:         []string{"--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"},
		},
	})
	app.attach(wails)
	app.newBrokerWindow()
	app.newWindow(mainWindow, "TN5250 Terminal", 1180, 800)
	if err := wails.Run(); err != nil {
		log.Fatal(err)
	}
}
