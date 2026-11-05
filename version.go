package main

import (
	_ "embed"
	"regexp"
)

// build/config.yml is the single source of the app version: Wails writes it into the exe's
// version resource, the installer and the packages, and the release workflow refuses a tag
// that does not match it.
//
//go:embed build/config.yml
var buildConfig []byte

var appVersion = readVersion(buildConfig)

var versionLine = regexp.MustCompile(`(?m)^\s*version:\s*"?([0-9][0-9A-Za-z.\-]*)"?\s*(#.*)?$`)

func readVersion(data []byte) string {
	// The first `version:` line is the config schema ('3'); the app version is the one
	// under info:, which is the first that looks like a release number.
	for _, m := range versionLine.FindAllSubmatch(data, -1) {
		v := string(m[1])
		if v != "3" {
			return v
		}
	}
	return "0.0.0"
}

// Version returns the app version, e.g. "0.1.2" or "0.1.2.1".
func (a *App) Version() string {
	return appVersion
}
