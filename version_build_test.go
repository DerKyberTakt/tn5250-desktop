package main

import (
	"os"
	"strings"
	"testing"
)

// The app version is written into more files than build/config.yml: the Windows version
// resource and installer, the macOS bundle, the Linux package and the manifest. A release
// whose files disagree builds, but the installer's uninstall entry shows the old version
// and the release workflow's smoke test fails late, on the Windows runner. Catch it here.
func TestBuildFilesAgreeOnVersion(t *testing.T) {
	v := appVersion
	if v == "0.0.0" {
		t.Skip("no version in build/config.yml")
	}
	files := map[string]string{
		"build/windows/info.json":            `"` + v + `"`,
		"build/windows/nsis/wails_tools.nsh": `INFO_PRODUCTVERSION "` + v + `"`,
		"build/windows/wails.exe.manifest":   `version="` + v + `"`,
		"build/linux/nfpm/nfpm.yaml":         `version: "` + v + `"`,
		"build/darwin/Info.plist":            "<string>" + v + "</string>",
		"build/darwin/Info.dev.plist":        "<string>" + v + "</string>",
	}
	for path, want := range files {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("%s: %v", path, err)
			continue
		}
		if !strings.Contains(string(data), want) {
			t.Errorf("%s does not carry version %s (looked for %q)", path, v, want)
		}
	}
	// package.json keeps the three-part version: a desktop-only fourth part (0.3.1.1) stays out of it.
	parts := strings.Split(v, ".")
	if len(parts) > 3 {
		parts = parts[:3]
	}
	pkg, err := os.ReadFile("package.json")
	if err != nil {
		t.Fatal(err)
	}
	if want := `"version": "` + strings.Join(parts, ".") + `"`; !strings.Contains(string(pkg), want) {
		t.Errorf("package.json does not carry %s", want)
	}
}
