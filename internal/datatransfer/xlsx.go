package datatransfer

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// A minimal .xlsx writer and reader (Office Open XML SpreadsheetML): one sheet, text
// and numbers, inline strings on output, shared strings understood on input. Enough
// for Data Transfer; no styles, formulas or dates beyond their text.

const (
	xlsxContentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
	xlsxRootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
	xlsxWorkbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="%s" sheetId="1" r:id="rId1"/></sheets></workbook>`
	xlsxWorkbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
)

// WriteXLSX writes the table as a workbook with one sheet. Cells that look like plain
// numbers are written as numbers (so Excel sums them); everything else as text.
// numeric says which columns are numeric on the host; nil means "guess per cell".
func WriteXLSX(w io.Writer, t *Table, sheet string, header bool, numeric []bool) error {
	if sheet == "" {
		sheet = "Sheet1"
	}
	zw := zip.NewWriter(w)
	add := func(name, body string) error {
		f, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = io.WriteString(f, body)
		return err
	}
	if err := add("[Content_Types].xml", xlsxContentTypes); err != nil {
		return err
	}
	if err := add("_rels/.rels", xlsxRootRels); err != nil {
		return err
	}
	if err := add("xl/workbook.xml", fmt.Sprintf(xlsxWorkbook, xmlEscape(sheet))); err != nil {
		return err
	}
	if err := add("xl/_rels/workbook.xml.rels", xlsxWorkbookRels); err != nil {
		return err
	}
	f, err := zw.Create("xl/worksheets/sheet1.xml")
	if err != nil {
		return err
	}
	var b bytes.Buffer
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n")
	b.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	row := 1
	writeRow := func(cells []string, textOnly bool) {
		fmt.Fprintf(&b, `<row r="%d">`, row)
		for i, c := range cells {
			ref := cellRef(i, row)
			isNum := !textOnly && ((numeric == nil && looksNumeric(c)) || (numeric != nil && i < len(numeric) && numeric[i] && looksNumeric(c)))
			if isNum {
				fmt.Fprintf(&b, `<c r="%s"><v>%s</v></c>`, ref, strings.TrimSpace(c))
			} else if c != "" {
				fmt.Fprintf(&b, `<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`, ref, xmlEscape(c))
			}
		}
		b.WriteString(`</row>`)
		row++
	}
	if header && len(t.Columns) > 0 {
		writeRow(t.Columns, true)
	}
	for _, r := range t.Rows {
		writeRow(r, false)
	}
	b.WriteString(`</sheetData></worksheet>`)
	if _, err := f.Write(b.Bytes()); err != nil {
		return err
	}
	return zw.Close()
}

// ReadXLSX reads the first sheet of a workbook. With header, row 1 names the columns.
// Empty cells inside a row become ""; trailing empty cells are kept up to the widest row.
func ReadXLSX(r io.ReaderAt, size int64, header bool) (*Table, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, fmt.Errorf("not an .xlsx file: %w", err)
	}
	read := func(name string) ([]byte, error) {
		for _, f := range zr.File {
			if f.Name == name {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(io.LimitReader(rc, 512<<20))
			}
		}
		return nil, nil
	}
	shared, err := readSharedStrings(read)
	if err != nil {
		return nil, err
	}
	sheetName, err := firstSheetPath(read)
	if err != nil {
		return nil, err
	}
	data, err := read(sheetName)
	if err != nil {
		return nil, err
	}
	if data == nil {
		return nil, errors.New("the workbook has no worksheet")
	}
	rows, err := parseSheet(data, shared)
	if err != nil {
		return nil, err
	}
	t := &Table{}
	if header && len(rows) > 0 {
		t.Columns = rows[0]
		rows = rows[1:]
	}
	t.Rows = rows
	return t, nil
}

func firstSheetPath(read func(string) ([]byte, error)) (string, error) {
	wb, err := read("xl/workbook.xml")
	if err != nil || wb == nil {
		return "", errors.New("the workbook has no xl/workbook.xml")
	}
	var workbook struct {
		Sheets []struct {
			ID string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
		} `xml:"sheets>sheet"`
	}
	if err := xml.Unmarshal(wb, &workbook); err != nil || len(workbook.Sheets) == 0 {
		return "xl/worksheets/sheet1.xml", nil
	}
	rels, err := read("xl/_rels/workbook.xml.rels")
	if err != nil || rels == nil {
		return "xl/worksheets/sheet1.xml", nil
	}
	var relationships struct {
		Rels []struct {
			ID     string `xml:"Id,attr"`
			Target string `xml:"Target,attr"`
		} `xml:"Relationship"`
	}
	if err := xml.Unmarshal(rels, &relationships); err != nil {
		return "xl/worksheets/sheet1.xml", nil
	}
	for _, rel := range relationships.Rels {
		if rel.ID == workbook.Sheets[0].ID {
			target := strings.TrimPrefix(rel.Target, "/")
			if !strings.HasPrefix(target, "xl/") {
				target = "xl/" + target
			}
			return target, nil
		}
	}
	return "xl/worksheets/sheet1.xml", nil
}

func readSharedStrings(read func(string) ([]byte, error)) ([]string, error) {
	data, err := read("xl/sharedStrings.xml")
	if err != nil || data == nil {
		return nil, err
	}
	var sst struct {
		Items []struct {
			T string   `xml:"t"`
			R []string `xml:"r>t"`
		} `xml:"si"`
	}
	if err := xml.Unmarshal(data, &sst); err != nil {
		return nil, fmt.Errorf("sharedStrings.xml: %w", err)
	}
	out := make([]string, len(sst.Items))
	for i, it := range sst.Items {
		if it.T != "" {
			out[i] = it.T
		} else {
			out[i] = strings.Join(it.R, "")
		}
	}
	return out, nil
}

func parseSheet(data []byte, shared []string) ([][]string, error) {
	var sheet struct {
		Rows []struct {
			Cells []struct {
				Ref  string `xml:"r,attr"`
				Type string `xml:"t,attr"`
				V    string `xml:"v"`
				Is   struct {
					T string   `xml:"t"`
					R []string `xml:"r>t"`
				} `xml:"is"`
			} `xml:"c"`
		} `xml:"sheetData>row"`
	}
	if err := xml.Unmarshal(data, &sheet); err != nil {
		return nil, fmt.Errorf("worksheet: %w", err)
	}
	var rows [][]string
	width := 0
	for _, r := range sheet.Rows {
		var cells []string
		for _, c := range r.Cells {
			col := colIndex(c.Ref)
			for len(cells) < col {
				cells = append(cells, "")
			}
			var v string
			switch c.Type {
			case "s":
				if n, err := strconv.Atoi(c.V); err == nil && n >= 0 && n < len(shared) {
					v = shared[n]
				}
			case "inlineStr":
				v = c.Is.T
				if v == "" {
					v = strings.Join(c.Is.R, "")
				}
			case "b":
				if c.V == "1" {
					v = "TRUE"
				} else {
					v = "FALSE"
				}
			default:
				v = c.V
			}
			cells = append(cells, v)
		}
		if len(cells) > width {
			width = len(cells)
		}
		rows = append(rows, cells)
	}
	for i := range rows {
		for len(rows[i]) < width {
			rows[i] = append(rows[i], "")
		}
	}
	return rows, nil
}

// cellRef turns a zero-based column and one-based row into "A1" style.
func cellRef(col, row int) string {
	s := ""
	for c := col; ; c = c/26 - 1 {
		s = string(rune('A'+c%26)) + s
		if c < 26 {
			break
		}
	}
	return s + strconv.Itoa(row)
}

// colIndex reads the column of an "A1" reference (zero-based); -1 keeps order when missing.
func colIndex(ref string) int {
	n := 0
	ok := false
	for _, ch := range ref {
		if ch >= 'A' && ch <= 'Z' {
			n = n*26 + int(ch-'A') + 1
			ok = true
		} else {
			break
		}
	}
	if !ok {
		return 0
	}
	return n - 1
}

func looksNumeric(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 20 {
		return false
	}
	// Leading zeros (item numbers, zip codes) stay text so Excel does not drop them.
	if len(s) > 1 && s[0] == '0' && s[1] != '.' {
		return false
	}
	_, err := strconv.ParseFloat(s, 64)
	return err == nil && !strings.ContainsAny(s, "eEiInN")
}

func xmlEscape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
