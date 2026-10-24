package datatransfer

import (
	"bufio"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// Table is the PC side of a transfer: column names and rows of text cells. Values
// are kept as text exactly as they appear in the file; the database layer converts.
type Table struct {
	Columns []string
	Rows    [][]string
}

// WriteCSV writes the table as comma separated values (RFC 4180, CRLF, a header row
// when the table has column names) in the given file encoding ("UTF-8",
// "windows-1252", ... as ACS names them).
func WriteCSV(w io.Writer, t *Table, encoding string, header bool) error {
	enc, err := encoder(w, encoding)
	if err != nil {
		return err
	}
	cw := csv.NewWriter(enc)
	cw.UseCRLF = true
	if header && len(t.Columns) > 0 {
		if err := cw.Write(t.Columns); err != nil {
			return err
		}
	}
	for _, r := range t.Rows {
		if err := cw.Write(r); err != nil {
			return err
		}
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		return err
	}
	return enc.Close()
}

// ReadCSV reads comma separated values; with header, the first row names the columns.
// Rows may have fewer cells than the header (missing cells are empty).
func ReadCSV(r io.Reader, encoding string, header bool) (*Table, error) {
	dec, err := decoder(r, encoding)
	if err != nil {
		return nil, err
	}
	cr := csv.NewReader(dec)
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true
	all, err := cr.ReadAll()
	if err != nil {
		return nil, err
	}
	t := &Table{}
	if header && len(all) > 0 {
		t.Columns = all[0]
		all = all[1:]
	}
	t.Rows = all
	return t, nil
}

// WriteText writes a tab-separated text file (ACS "ASCII text" with tab delimiters).
func WriteText(w io.Writer, t *Table, encoding string, header bool) error {
	enc, err := encoder(w, encoding)
	if err != nil {
		return err
	}
	bw := bufio.NewWriter(enc)
	write := func(cells []string) {
		for i, c := range cells {
			if i > 0 {
				bw.WriteByte('\t')
			}
			bw.WriteString(strings.NewReplacer("\t", " ", "\r", " ", "\n", " ").Replace(c))
		}
		bw.WriteString("\r\n")
	}
	if header && len(t.Columns) > 0 {
		write(t.Columns)
	}
	for _, r := range t.Rows {
		write(r)
	}
	if err := bw.Flush(); err != nil {
		return err
	}
	return enc.Close()
}

// ReadText reads a tab-separated text file.
func ReadText(r io.Reader, encoding string, header bool) (*Table, error) {
	dec, err := decoder(r, encoding)
	if err != nil {
		return nil, err
	}
	t := &Table{}
	sc := bufio.NewScanner(dec)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	first := true
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if first {
			line = strings.TrimPrefix(line, "ï»¿")
		}
		cells := strings.Split(line, "\t")
		if first && header {
			t.Columns = cells
		} else {
			t.Rows = append(t.Rows, cells)
		}
		first = false
	}
	return t, sc.Err()
}

// closer is what encoder returns: a writer that must be closed to flush the transform.
type closer interface {
	io.Writer
	Close() error
}

type nopCloser struct{ io.Writer }

func (nopCloser) Close() error { return nil }

func encoder(w io.Writer, encoding string) (closer, error) {
	switch normEncoding(encoding) {
	case "utf-8":
		return nopCloser{w}, nil
	case "utf-8-bom":
		if _, err := w.Write([]byte{0xEF, 0xBB, 0xBF}); err != nil {
			return nil, err
		}
		return nopCloser{w}, nil
	case "utf-16", "utf-16le":
		return transform.NewWriter(w, unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder()), nil
	}
	cm, err := codePage(encoding)
	if err != nil {
		return nil, err
	}
	return transform.NewWriter(w, cm.NewEncoder()), nil
}

func decoder(r io.Reader, encoding string) (io.Reader, error) {
	switch normEncoding(encoding) {
	case "utf-8", "utf-8-bom":
		// A BOM written by Excel or Notepad is skipped either way.
		br := bufio.NewReader(r)
		if b, _ := br.Peek(3); len(b) == 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
			_, _ = br.Discard(3)
		}
		return br, nil
	case "utf-16", "utf-16le":
		return transform.NewReader(r, unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder()), nil
	}
	cm, err := codePage(encoding)
	if err != nil {
		return nil, err
	}
	return transform.NewReader(r, cm.NewDecoder()), nil
}

func normEncoding(e string) string {
	e = strings.ToLower(strings.TrimSpace(e))
	switch e {
	case "", "utf8", "utf-8":
		return "utf-8"
	case "utf-8 with bom", "utf8bom", "utf-8-bom":
		return "utf-8-bom"
	case "utf16", "utf-16", "utf-16le", "unicode":
		return "utf-16le"
	}
	return e
}

func codePage(encoding string) (*charmap.Charmap, error) {
	switch normEncoding(encoding) {
	case "windows-1252", "cp1252", "1252":
		return charmap.Windows1252, nil
	case "iso-8859-1", "latin1", "iso8859-1":
		return charmap.ISO8859_1, nil
	case "ibm437", "cp437", "437":
		return charmap.CodePage437, nil
	case "ibm850", "cp850", "850":
		return charmap.CodePage850, nil
	case "windows-1250":
		return charmap.Windows1250, nil
	case "windows-1251":
		return charmap.Windows1251, nil
	}
	return nil, fmt.Errorf("file encoding %q is not supported (use UTF-8, windows-1252, ISO-8859-1, IBM437, IBM850)", encoding)
}

// FitLength reports whether every cell of column i fits in n characters (for a
// field description check before an upload).
func (t *Table) FitLength(i, n int) error {
	for row, r := range t.Rows {
		if i < len(r) && utf8.RuneCountInString(r[i]) > n {
			return fmt.Errorf("row %d: %q is longer than %d characters", row+1, r[i], n)
		}
	}
	return nil
}

// ErrNoRows is returned by readers that found nothing to transfer.
var ErrNoRows = errors.New("the file has no data rows")
