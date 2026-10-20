package update

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// OldSuffix marks the previous exe after a swap; the new version deletes it on start.
const OldSuffix = ".old"

// ExtractFile copies the zip entry named name (any folder) to dest.
func ExtractFile(zipPath, name, dest string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if !strings.EqualFold(filepath.Base(filepath.FromSlash(f.Name)), name) || f.FileInfo().IsDir() {
			continue
		}
		if f.UncompressedSize64 > maxAssetBytes {
			return fmt.Errorf("%s: too large", name)
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		defer rc.Close()
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, io.LimitReader(rc, maxAssetBytes)); err != nil {
			_ = out.Close()
			_ = os.Remove(dest)
			return err
		}
		return out.Close()
	}
	return fmt.Errorf("%s not found in %s", name, filepath.Base(zipPath))
}

// Replace puts newFile in place of exe. A running exe cannot be overwritten on
// Windows but it can be renamed, so exe becomes exe.old first; on failure the
// original is put back.
func Replace(exe, newFile string) error {
	old := exe + OldSuffix
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(newFile, exe); err != nil {
		if back := os.Rename(old, exe); back != nil {
			return errors.Join(err, back)
		}
		return err
	}
	_ = os.Chmod(exe, 0o755)
	return nil
}

// RemoveOld deletes the exe left behind by Replace; false while it is still in use.
func RemoveOld(exe string) bool {
	err := os.Remove(exe + OldSuffix)
	return err == nil || errors.Is(err, os.ErrNotExist)
}

// Writable reports whether files can be created in dir (a portable exe in
// Program Files or on a read-only share cannot update itself).
func Writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".update-check-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}
