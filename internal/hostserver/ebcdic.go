package hostserver

import "strings"

// EBCDIC encodes s in CCSID 37 (the code page the host servers accept for command
// text and names on an English system); characters outside it fail.
func EBCDIC(s string) ([]byte, error) {
	return cp037.NewEncoder().Bytes([]byte(s))
}

// FromEBCDIC decodes CCSID 37 bytes, trimming trailing blanks and NULs.
func FromEBCDIC(b []byte) string {
	out, err := cp037.NewDecoder().Bytes(b)
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(out), " \x00")
}
