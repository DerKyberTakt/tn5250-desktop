package sqlviacl

import (
	"strings"
	"testing"
)

func TestClassify(t *testing.T) {
	cases := map[string]Kind{
		"select * from qsys2.systables":                       Query,
		"  SELECT 1 FROM SYSIBM.SYSDUMMY1":                    Query,
		"-- comment\nselect 1 from sysibm.sysdummy1":          Query,
		"/* c */ WITH t AS (SELECT 1 FROM x) SELECT * FROM t": Query,
		"VALUES (1, 2)": Query,
		"(select 1 from x) union (select 2 from y)": Query,
		"insert into t values (1)":                  Statement,
		"UPDATE t SET a = 1":                        Statement,
		"CREATE TABLE qtemp.x (a int)":              Statement,
		"CALL QSYS2.QCMDEXC('DSPLIBL')":             Statement,
		"SELECTED":                                  Statement,
		"withdraw":                                  Statement,
	}
	for stmt, want := range cases {
		if got := Classify(stmt); got != want {
			t.Errorf("%q: got %v, want %v", stmt, got, want)
		}
	}
}

func TestRunSQLQuotesAndNaming(t *testing.T) {
	cmd, err := RunSQL("UPDATE t SET name = 'O''Brien' WHERE id = 1;", Options{Naming: "sys", DefaultSchema: "mylib"})
	if err != nil {
		t.Fatal(err)
	}
	want := "RUNSQL SQL('UPDATE t SET name = ''O''''Brien'' WHERE id = 1') COMMIT(*NONE) NAMING(*SYS) DFTRDBCOL(MYLIB)"
	if cmd != want {
		t.Fatalf("got  %s\nwant %s", cmd, want)
	}
	cmd, _ = RunSQL("delete from t", Options{})
	if !strings.HasSuffix(cmd, "COMMIT(*NONE) NAMING(*SQL)") {
		t.Fatalf("sql naming by default: %s", cmd)
	}
	if _, err := RunSQL("   ", Options{}); err == nil {
		t.Fatal("empty statement must fail")
	}
	if _, err := RunSQL("select "+strings.Repeat("x", MaxStatement), Options{}); err == nil || !strings.Contains(err.Error(), "5000") {
		t.Fatalf("long statement: %v", err)
	}
}

func TestMaterialise(t *testing.T) {
	cmd, err := Materialise("select * from qsys2.systables order by table_name", "TN5250Q1", 10000, Options{})
	if err != nil {
		t.Fatal(err)
	}
	want := "RUNSQL SQL('CREATE TABLE QTEMP.TN5250Q1 AS (SELECT * FROM (select * from qsys2.systables order by table_name) AS TN5250Q FETCH FIRST 10001 ROWS ONLY) WITH DATA') COMMIT(*NONE) NAMING(*SQL)"
	if cmd != want {
		t.Fatalf("got  %s\nwant %s", cmd, want)
	}
	// System naming: QTEMP/T.
	cmd, _ = Materialise("select * from mylib/myfile", "TN5250Q2", 500, Options{Naming: "sys"})
	if !strings.Contains(cmd, "CREATE TABLE QTEMP/TN5250Q2 AS") || !strings.HasSuffix(cmd, "NAMING(*SYS)") {
		t.Fatalf("sys naming: %s", cmd)
	}
	// The query's own FETCH FIRST wins.
	cmd, _ = Materialise("select * from t fetch first 5 rows only;", "Q", 500, Options{})
	if strings.Contains(cmd, "501") || !strings.Contains(cmd, "AS (select * from t fetch first 5 rows only) WITH DATA") {
		t.Fatalf("own limit: %s", cmd)
	}
	// A CTE is not wrapped; the limit is appended.
	cmd, _ = Materialise("with t as (select 1 as a from sysibm.sysdummy1) select a from t", "Q", 500, Options{})
	if !strings.Contains(cmd, "AS (with t as (select 1 as a from sysibm.sysdummy1) select a from t FETCH FIRST 501 ROWS ONLY) WITH DATA") {
		t.Fatalf("cte: %s", cmd)
	}
}

func TestExportDropMetadata(t *testing.T) {
	cmd := Export("TN5250Q1", "/tmp/tn5250-jsmith-1.csv", true)
	for _, part := range []string{"CPYTOIMPF FROMFILE(QTEMP/TN5250Q1)", "TOSTMF('/tmp/tn5250-jsmith-1.csv')", "STMFCCSID(1208)", "RCDDLM(*LF)", "DTAFMT(*DLM)", `STRDLM('"')`, "FLDDLM(',')", "DECPNT(*PERIOD)", "ADDCOLNAM(*SQL)"} {
		if !strings.Contains(cmd, part) {
			t.Errorf("export lacks %s: %s", part, cmd)
		}
	}
	if strings.Contains(Export("T", "/tmp/x", false), "ADDCOLNAM") {
		t.Error("no header must not ask for column names")
	}
	if Drop("T") != "DLTF FILE(QTEMP/T)" {
		t.Error(Drop("T"))
	}
	meta := MetadataQuery("TN5250Q1", "TN5250Q1M")
	if !strings.Contains(meta, "CREATE TABLE QTEMP.TN5250Q1M AS (SELECT ORDINAL_POSITION, COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE, IS_NULLABLE, CCSID FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = ''QTEMP'' AND TABLE_NAME = ''TN5250Q1'') WITH DATA") {
		t.Fatal(meta)
	}
}

func TestParseCSVAndColumns(t *testing.T) {
	data := []byte("\xEF\xBB\xBF\"TABLE_NAME\",\"ROW_COUNT\",\"LAST_USED\"\n\"CUSTOMER\",1234,\"2026-11-03\"\n\"O\"\"BRIEN\",,\n")
	names, rows, err := ParseCSV(data, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(names, "|") != "TABLE_NAME|ROW_COUNT|LAST_USED" {
		t.Fatalf("names %q", names)
	}
	if len(rows) != 2 || *rows[0][1] != "1234" || *rows[1][0] != `O"BRIEN` || *rows[1][1] != "" {
		t.Fatalf("rows %v", rows)
	}
	_, rows, _ = ParseCSV([]byte("1,2\n3,4\n"), false)
	if len(rows) != 2 || *rows[1][1] != "4" {
		t.Fatalf("no header: %v", rows)
	}

	s := func(v string) *string { return &v }
	cols := ParseColumns([]string{"ORDINAL_POSITION", "COLUMN_NAME", "DATA_TYPE", "LENGTH", "NUMERIC_SCALE", "IS_NULLABLE", "CCSID"}, [][]*string{
		{s("2"), s("ROW_COUNT"), s("BIGINT"), s("8"), s("0"), s("Y"), s("")},
		{s("1"), s("TABLE_NAME"), s("VARCHAR"), s("128"), s(""), s("N"), s("1208")},
	})
	if len(cols) != 2 || cols[0].Name != "TABLE_NAME" || cols[0].Type != "VARCHAR" || cols[0].Length != 128 || cols[0].CCSID != 1208 || cols[0].Nullable {
		t.Fatalf("columns %+v", cols)
	}
	if cols[1].Name != "ROW_COUNT" || !cols[1].Nullable || cols[1].Type != "BIGINT" {
		t.Fatalf("columns %+v", cols)
	}
}

func TestQshAndLines(t *testing.T) {
	cmd := QshCommand("ls -la /home/jsmith | grep 'x'", "/tmp/tn5250-q.txt")
	if cmd != "QSH CMD('ls -la /home/jsmith | grep ''x'' > /tmp/tn5250-q.txt 2>&1')" {
		t.Fatal(cmd)
	}
	rows := Lines([]byte("\xEF\xBB\xBFtotal 3\r\na.txt\nb.txt\n"))
	if len(rows) != 3 || *rows[0][0] != "total 3" || *rows[2][0] != "b.txt" {
		t.Fatalf("%v", rows)
	}
	if Lines([]byte("")) != nil {
		t.Fatal("empty output is no rows")
	}
	if !IsCommandError("CPD0043") || IsCommandError("CPF9801") {
		t.Fatal("command error ids")
	}
}
