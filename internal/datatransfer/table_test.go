package datatransfer

import (
	"bytes"
	"strings"
	"testing"
)

func sample() *Table {
	return &Table{
		Columns: []string{"ITEM", "DESC", "QTY", "PRICE"},
		Rows: [][]string{
			{"000123", "Café \"Dark\", 1 lb", "12", "4.50"},
			{"4567", "Plain", "0", "-1.25"},
			{"89", "", "", ""},
		},
	}
}

func TestCSVRoundTrip(t *testing.T) {
	for _, enc := range []string{"UTF-8", "windows-1252", "UTF-16"} {
		var buf bytes.Buffer
		if err := WriteCSV(&buf, sample(), enc, true); err != nil {
			t.Fatal(enc, err)
		}
		if enc == "UTF-8" {
			s := buf.String()
			if !strings.HasPrefix(s, "ITEM,DESC,QTY,PRICE\r\n000123,\"Café \"\"Dark\"\", 1 lb\",12,4.50\r\n") {
				t.Fatalf("csv layout: %q", s[:60])
			}
		}
		got, err := ReadCSV(bytes.NewReader(buf.Bytes()), enc, true)
		if err != nil {
			t.Fatal(enc, err)
		}
		want := sample()
		if strings.Join(got.Columns, "|") != strings.Join(want.Columns, "|") || len(got.Rows) != 3 || got.Rows[0][1] != want.Rows[0][1] || got.Rows[1][3] != "-1.25" {
			t.Fatalf("%s round trip: %+v", enc, got)
		}
	}
}

func TestCSVReadsExcelOutput(t *testing.T) {
	// Excel writes a BOM and CRLF, and leaves short rows short.
	in := "\xEF\xBB\xBFA,B,C\r\n1,2,3\r\n4,5\r\n"
	got, err := ReadCSV(strings.NewReader(in), "UTF-8", true)
	if err != nil {
		t.Fatal(err)
	}
	if got.Columns[0] != "A" || len(got.Rows) != 2 || len(got.Rows[1]) != 2 {
		t.Fatalf("%+v", got)
	}
}

func TestTextRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteText(&buf, sample(), "windows-1252", true); err != nil {
		t.Fatal(err)
	}
	got, err := ReadText(bytes.NewReader(buf.Bytes()), "windows-1252", true)
	if err != nil {
		t.Fatal(err)
	}
	if got.Columns[1] != "DESC" || got.Rows[0][1] != "Café \"Dark\", 1 lb" || got.Rows[2][3] != "" {
		t.Fatalf("%+v", got)
	}
}

func TestUnsupportedEncoding(t *testing.T) {
	if err := WriteCSV(&bytes.Buffer{}, sample(), "EBCDIC-37", true); err == nil {
		t.Fatal("unknown encoding accepted")
	}
}

func TestXLSXRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteXLSX(&buf, sample(), "ITEMS", true, nil); err != nil {
		t.Fatal(err)
	}
	got, err := ReadXLSX(bytes.NewReader(buf.Bytes()), int64(buf.Len()), true)
	if err != nil {
		t.Fatal(err)
	}
	want := sample()
	if strings.Join(got.Columns, "|") != strings.Join(want.Columns, "|") {
		t.Fatalf("columns: %v", got.Columns)
	}
	if len(got.Rows) != 3 {
		t.Fatalf("rows: %d", len(got.Rows))
	}
	// Leading-zero item stays text, quantities come back as the numbers written, blanks stay blank.
	if got.Rows[0][0] != "000123" || got.Rows[0][1] != want.Rows[0][1] || got.Rows[0][2] != "12" || got.Rows[1][3] != "-1.25" || got.Rows[2][1] != "" || len(got.Rows[2]) != 4 {
		t.Fatalf("%+v", got.Rows)
	}
}

func TestXLSXSharedStrings(t *testing.T) {
	// A workbook as Excel saves it: shared strings and a sheet reached through the rels.
	var buf bytes.Buffer
	zw := newTestZip(&buf, map[string]string{
		"[Content_Types].xml":        xlsxContentTypes,
		"_rels/.rels":                xlsxRootRels,
		"xl/workbook.xml":            `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId3"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="x" Target="worksheets/sheet7.xml"/></Relationships>`,
		"xl/sharedStrings.xml":       `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>ITEM</t></si><si><r><t>Rich </t></r><r><t>text</t></r></si></sst>`,
		"xl/worksheets/sheet7.xml":   `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>QTY</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>7</v></c></row></sheetData></worksheet>`,
	})
	_ = zw
	got, err := ReadXLSX(bytes.NewReader(buf.Bytes()), int64(buf.Len()), true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got.Columns, "|") != "ITEM|QTY|" || got.Rows[0][0] != "Rich text" || got.Rows[0][1] != "" || got.Rows[0][2] != "7" {
		t.Fatalf("%+v", got)
	}
}

func TestCellRef(t *testing.T) {
	for i, want := range map[int]string{0: "A1", 25: "Z1", 26: "AA1", 27: "AB1", 701: "ZZ1", 702: "AAA1"} {
		if got := cellRef(i, 1); got != want {
			t.Errorf("cellRef(%d) = %s, want %s", i, got, want)
		}
		if colIndex(want) != i {
			t.Errorf("colIndex(%s) = %d, want %d", want, colIndex(want), i)
		}
	}
	if !looksNumeric("12.5") || !looksNumeric("-3") || looksNumeric("007") || looksNumeric("1e5") || looksNumeric("") || looksNumeric("Inf") {
		t.Fatal("looksNumeric")
	}
}
