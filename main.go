// TN5250 Terminal: a native desktop shell around the TypeScript TN5250 engine and canvas UI.
package main

import (
	"embed"
	"io/fs"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:dist/desktop
var dist embed.FS

//go:embed build/appicon.png
var icon []byte

func main() {
	assets, err := fs.Sub(dist, "dist/desktop")
	if err != nil {
		log.Fatal(err)
	}
	app := NewApp()
	err = wails.Run(&options.App{
		Title:            "TN5250 Terminal",
		Width:            1180,
		Height:           800,
		MinWidth:         640,
		MinHeight:        420,
		BackgroundColour: &options.RGBA{R: 0, G: 0, B: 0, A: 255},
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		Bind:       []interface{}{app},
		// Files dropped on the IFS browser are uploaded; the page decides what a drop means.
		DragAndDrop: &options.DragAndDrop{EnableFileDrop: true},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "io.github.derkybertakt.tn5250-desktop",
			OnSecondInstanceLaunch: app.secondInstance,
		},
		Windows: &windows.Options{
			Theme: windows.SystemDefault,
		},
		Linux: &linux.Options{
			Icon:             icon,
			ProgramName:      "tn5250-terminal",
			WebviewGpuPolicy: linux.WebviewGpuPolicyOnDemand,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
