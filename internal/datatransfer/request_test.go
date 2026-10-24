package datatransfer

import (
	"strings"
	"testing"
)

// The shape ACS writes for an upload request (values made up; PUB400 host).
const uploadDTTX = "[DataTransferTo]\r\nDataTransferVersion=1.0\r\n[HostInfo]\r\nHostName=pub400.com\r\nHostFile=MYLIB/ITEMS\r\nFRFFile=\r\nCrtOpt=2\r\nHostFileType=1\r\nObjAuth=0\r\nRecLen=92\r\nFileText=\r\nMbrText=\r\nDatabase=*SYSBAS\r\n[ClientInfo]\r\nClientFile=C:\\Users\\me\\Desktop\\items.csv\r\nUseFDF=1\r\nClientFileType=12\r\nInputDevice=2\r\nFileEncoding=windows-1252\r\nFDFFile=C:\\Users\\me\\Desktop\\items.fdfx\r\n[Properties]\r\nConvert65535=1\r\nConvertTabs=0\r\nShowWarnings=1\r\nUseSSL=2\r\n[Options]\r\nDateFmt=MDY\r\nDateSep=[/]\r\nTimeFmt=HMS\r\nTimeSep=[:]\r\nDecimalSep=.\r\n"

const fieldsFDFX = "[Data Transfer File Description]\r\nFieldCount=3\r\nFileType=12\r\nClientFileEncoding=windows-1252\r\nDataTransferVersion=1.0\r\n[Options]\r\nDateFormat=1\r\nDateSep=1\r\nDcmlSep=1\r\nTimeFormat=1\r\nTimeSep=1\r\n[F0001]\r\nLength=7\r\nName=F1\r\nType=1\r\n[F0002]\r\nLength=10\r\nName=ITEM\r\nType=1\r\n[F0003]\r\nLength=15\r\nName=F3\r\nType=1\r\n"

func TestParseUploadRequest(t *testing.T) {
	r, err := ParseRequest(uploadDTTX)
	if err != nil {
		t.Fatal(err)
	}
	if r.Direction != Upload || r.HostName != "pub400.com" || r.HostFile != "MYLIB/ITEMS" {
		t.Fatalf("header: %+v", r)
	}
	if r.Library() != "MYLIB" || r.File() != "ITEMS" || r.Member() != "" {
		t.Fatalf("split: %q %q %q", r.Library(), r.File(), r.Member())
	}
	if r.CrtOpt != CrtOptReplace || r.HostFileType != HostFileDatabase || r.RecLen != 92 {
		t.Fatalf("host info: %+v", r)
	}
	if r.ClientFileType != FileTypeCSV || !r.UseFDF || r.FileEncoding != "windows-1252" || !strings.HasSuffix(r.FDFFile, "items.fdfx") {
		t.Fatalf("client info: %+v", r)
	}
	if r.Options.DateFmt != "MDY" || r.Options.DateSep != "/" || r.Options.TimeSep != ":" || r.Options.DecimalSep != "." {
		t.Fatalf("options: %+v", r.Options)
	}
	if r.Properties["showwarnings"] != "1" {
		t.Fatalf("properties: %v", r.Properties)
	}
}

func TestMemberAndDownload(t *testing.T) {
	r, err := ParseRequest("[DataTransferFrom]\nDataTransferVersion=1.0\n[HostInfo]\nHostName=pub400.com\nHostFile=MYLIB/ITEMS(JAN)\nHostFileType=1\n[SQL]\nSelect=*\nWhere=QTY > 0\nOrderBy=ITEM\n[ClientInfo]\nClientFile=items.csv\nClientFileType=12\n")
	if err != nil {
		t.Fatal(err)
	}
	if r.Direction != Download || r.Member() != "JAN" || r.File() != "ITEMS" {
		t.Fatalf("%+v", r)
	}
	if r.SQL["where"] != "QTY > 0" || r.SQL["orderby"] != "ITEM" {
		t.Fatalf("sql: %v", r.SQL)
	}
}

func TestParseRequestErrors(t *testing.T) {
	if _, err := ParseRequest("[Something]\nHostFile=A/B\n"); err == nil {
		t.Fatal("wrong first section accepted")
	}
	if _, err := ParseRequest(""); err == nil {
		t.Fatal("empty accepted")
	}
	if _, err := ParseRequest("[DataTransferTo]\n[HostInfo]\nHostName=x\n"); err == nil {
		t.Fatal("missing HostFile accepted")
	}
}

func TestRequestRoundTrip(t *testing.T) {
	r, err := ParseRequest(uploadDTTX)
	if err != nil {
		t.Fatal(err)
	}
	again, err := ParseRequest(r.Write())
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range [][2]string{
		{r.HostFile, again.HostFile}, {r.ClientFile, again.ClientFile}, {r.FDFFile, again.FDFFile},
		{r.FileEncoding, again.FileEncoding}, {r.Options.DateSep, again.Options.DateSep},
	} {
		if c[0] != c[1] {
			t.Fatalf("round trip changed %q -> %q", c[0], c[1])
		}
	}
	if again.CrtOpt != r.CrtOpt || again.ClientFileType != r.ClientFileType || again.UseFDF != r.UseFDF {
		t.Fatalf("round trip changed numbers: %+v vs %+v", r, again)
	}
	if !strings.HasPrefix(r.Write(), "[DataTransferTo]\r\nDataTransferVersion=1.0\r\n[HostInfo]\r\n") {
		t.Fatalf("layout: %q", r.Write()[:60])
	}
}

func TestFDF(t *testing.T) {
	f, err := ParseFDF(fieldsFDFX)
	if err != nil {
		t.Fatal(err)
	}
	if f.FileType != FileTypeCSV || f.Encoding != "windows-1252" || len(f.Fields) != 3 {
		t.Fatalf("%+v", f)
	}
	if f.Fields[1].Name != "ITEM" || f.Fields[1].Length != 10 || f.Fields[1].Type != 1 {
		t.Fatalf("field 2: %+v", f.Fields[1])
	}
	again, err := ParseFDF(f.Write())
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Fields) != 3 || again.Fields[2].Length != 15 || again.Options["dcmlsep"] != "1" {
		t.Fatalf("round trip: %+v", again)
	}
	if _, err := ParseFDF("[Data Transfer File Description]\nFieldCount=2\n[F0001]\nName=A\nLength=1\nType=1\n"); err == nil {
		t.Fatal("missing field section accepted")
	}
	if _, err := ParseFDF(uploadDTTX); err == nil {
		t.Fatal("a request accepted as an FDF")
	}
}

func TestINIQuirks(t *testing.T) {
	// A byte-order mark, blank lines, comments and mixed-case keys.
	r, err := ParseRequest("\ufeff[DataTransferTo]\r\n\r\n; saved by hand\r\n[hostinfo]\r\nhostfile = MYLIB/F\r\nHOSTNAME=pub400.com\r\n[ClientInfo]\r\nClientFile=a=b.csv\r\n")
	if err != nil {
		t.Fatal(err)
	}
	if r.HostFile != "MYLIB/F" || r.HostName != "pub400.com" || r.ClientFile != "a=b.csv" {
		t.Fatalf("%+v", r)
	}
}
