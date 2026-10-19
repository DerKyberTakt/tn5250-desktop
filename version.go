package main

import (
	_ "embed"
	"encoding/json"
)

// wails.json is the single source of the app version: Wails writes it into the
// exe's version resource and the installer, and the release workflow refuses a
// tag that does not match it.
//
//go:embed wails.json
var wailsJSON []byte

var appVersion = readVersion(wailsJSON)

func readVersion(data []byte) string {
	var cfg struct {
		Info struct {
			ProductVersion string `json:"productVersion"`
		} `json:"info"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil || cfg.Info.ProductVersion == "" {
		return "0.0.0"
	}
	return cfg.Info.ProductVersion
}

// Version returns the app version, e.g. "0.1.2" or "0.1.2.1".
func (a *App) Version() string {
	return appVersion
}
