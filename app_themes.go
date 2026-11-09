package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Theme files (src/desktop/themes.ts): one .json per theme in the user's themes folder
// (next to settings.json), plus a read-only themes folder next to the managed settings
// file for themes an administrator ships. The app only ever writes the user's folder.

// ThemeFile is one theme file as the page gets it: the name is the file's, the JSON is read as is.
type ThemeFile struct {
	Name    string `json:"name"`
	JSON    string `json:"json"`
	Managed bool   `json:"managed"`
}

func themesDir() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	dir = filepath.Join(dir, "themes")
	return dir, os.MkdirAll(dir, 0o700)
}

func managedThemesDir() string {
	p := managedSettingsPath()
	if p == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(p), "themes")
}

func listThemeFiles(dir string, managed bool) []ThemeFile {
	var out []ThemeFile
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		out = append(out, ThemeFile{Name: strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())), JSON: string(b), Managed: managed})
	}
	return out
}

// ThemesList returns the administrator's themes, then the user's, by file name.
func (a *App) ThemesList() ([]ThemeFile, error) {
	var out []ThemeFile
	if d := managedThemesDir(); d != "" {
		out = append(out, listThemeFiles(d, true)...)
	}
	dir, err := themesDir()
	if err != nil {
		return out, err
	}
	out = append(out, listThemeFiles(dir, false)...)
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	if out == nil {
		out = []ThemeFile{}
	}
	return out, nil
}

// themeFileName is the file a theme name maps to; characters a file name cannot hold become "_".
func themeFileName(name string) (string, error) {
	n := strings.TrimSpace(name)
	if n == "" {
		return "", errors.New("the theme needs a name")
	}
	safe := safeLocalName(n)
	if safe == "" || safe == "_" {
		return "", fmt.Errorf("%q cannot be a file name", name)
	}
	return safe + ".json", nil
}

// ThemeSave writes (or replaces) a theme in the user's folder.
func (a *App) ThemeSave(name, json string) error {
	file, err := themeFileName(name)
	if err != nil {
		return err
	}
	dir, err := themesDir()
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(dir, file), []byte(json))
}

// ThemeDelete removes a theme from the user's folder (managed themes stay).
func (a *App) ThemeDelete(name string) error {
	file, err := themeFileName(name)
	if err != nil {
		return err
	}
	dir, err := themesDir()
	if err != nil {
		return err
	}
	err = os.Remove(filepath.Join(dir, file))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// ThemesFolder is where the user's theme files live, for Help and the themes dialog.
func (a *App) ThemesFolder() string {
	dir, _ := themesDir()
	return dir
}
