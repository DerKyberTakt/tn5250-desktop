package datatransfer

import (
	"archive/zip"
	"bytes"
)

// newTestZip writes the given files into buf as a zip archive.
func newTestZip(buf *bytes.Buffer, files map[string]string) *zip.Writer {
	zw := zip.NewWriter(buf)
	for name, body := range files {
		f, err := zw.Create(name)
		if err != nil {
			panic(err)
		}
		if _, err := f.Write([]byte(body)); err != nil {
			panic(err)
		}
	}
	if err := zw.Close(); err != nil {
		panic(err)
	}
	return zw
}
