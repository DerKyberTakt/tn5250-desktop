// Package sqlviacl runs SQL on an IBM i with nothing but the remote command server
// and the file server, the two host servers every client can reach:
//
//   - a query (SELECT, VALUES, WITH) is materialised with RUNSQL into a QTEMP table
//     capped at a number of rows, copied to a UTF-8 CSV stream file with CPYTOIMPF
//     (column names in the first row), read back over the IFS and deleted again;
//     the column types come from QSYS2.SYSCOLUMNS of the QTEMP table, the same way;
//   - anything else (INSERT, UPDATE, DDL, CALL, SET ...) runs with RUNSQL.
//
// This package only builds the commands and parses what comes back; it talks to no
// host, so every rule is unit-tested. Limits: a statement is at most 5000 characters
// (RUNSQL), update counts are not reported (RUNSQL gives none), NULL comes back as an
// empty field (CPYTOIMPF *DLM), and a running statement cannot be interrupted.
package sqlviacl

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// Kind of statement.
type Kind int

const (
	// Statement is anything RUNSQL can run without a result set.
	Statement Kind = iota
	// Query produces a result set.
	Query
)

// MaxStatement is RUNSQL's limit for the SQL text.
const MaxStatement = 5000

// HardCap is the most rows one query materialises; the page pages through them.
const HardCap = 10000

var leadingComments = regexp.MustCompile(`^(\s|--[^\n]*\n|/\*[\s\S]*?\*/)+`)
var fetchFirst = regexp.MustCompile(`(?i)\bFETCH\s+(FIRST|NEXT)\s+\d*\s*ROWS?\s+ONLY\s*$`)

// Classify tells whether a statement returns rows. Leading comments are skipped.
func Classify(stmt string) Kind {
	s := strings.ToUpper(strings.TrimSpace(leadingComments.ReplaceAllString(stmt, "")))
	s = strings.TrimLeft(s, "(")
	for _, kw := range []string{"SELECT", "VALUES", "WITH"} {
		if strings.HasPrefix(s, kw) && (len(s) == len(kw) || !isWord(s[len(kw)])) {
			return Query
		}
	}
	return Statement
}

func isWord(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z'
}

// Quote wraps text in CL apostrophes, doubling the ones inside.
func Quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// Options are the connection's naming and default schema.
type Options struct {
	// Naming "sys" (library/file) or "sql" (schema.table); anything else = sql.
	Naming string
	// DefaultSchema, when set, becomes RUNSQL's DFTRDBCOL.
	DefaultSchema string
}

func (o Options) sys() bool { return strings.EqualFold(o.Naming, "sys") }

func (o Options) runsqlTail() string {
	naming := "*SQL"
	if o.sys() {
		naming = "*SYS"
	}
	tail := " COMMIT(*NONE) NAMING(" + naming + ")"
	if s := strings.TrimSpace(o.DefaultSchema); s != "" {
		tail += " DFTRDBCOL(" + strings.ToUpper(s) + ")"
	}
	return tail
}

// qualified names a QTEMP table for the naming mode.
func (o Options) qualified(table string) string {
	if o.sys() {
		return "QTEMP/" + table
	}
	return "QTEMP." + table
}

// RunSQL is the command that runs a statement without a result set.
func RunSQL(stmt string, o Options) (string, error) {
	stmt = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(stmt), ";"))
	if stmt == "" {
		return "", errors.New("empty statement")
	}
	if len(stmt) > MaxStatement {
		return "", fmt.Errorf("the statement is %d characters; RUNSQL takes at most %d", len(stmt), MaxStatement)
	}
	return "RUNSQL SQL(" + Quote(stmt) + ")" + o.runsqlTail(), nil
}

// Materialise is the RUNSQL that copies at most maxRows+1 rows of a query into the
// QTEMP table (one more than asked, so "more rows" can be told). A query that already
// ends with FETCH FIRST keeps its own limit; a CTE (WITH) cannot be wrapped and gets
// the FETCH FIRST appended instead.
func Materialise(stmt, table string, maxRows int, o Options) (string, error) {
	stmt = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(stmt), ";"))
	if stmt == "" {
		return "", errors.New("empty statement")
	}
	limit := fmt.Sprintf(" FETCH FIRST %d ROWS ONLY", maxRows+1)
	var inner string
	switch {
	case fetchFirst.MatchString(stmt):
		inner = stmt
	case strings.HasPrefix(strings.ToUpper(strings.TrimSpace(leadingComments.ReplaceAllString(stmt, ""))), "WITH"):
		inner = stmt + limit
	default:
		inner = "SELECT * FROM (" + stmt + ") AS TN5250Q" + limit
	}
	sql := "CREATE TABLE " + o.qualified(table) + " AS (" + inner + ") WITH DATA"
	if len(sql) > MaxStatement {
		return "", fmt.Errorf("the query is %d characters; RUNSQL takes at most %d", len(stmt), MaxStatement-(len(sql)-len(stmt)))
	}
	return "RUNSQL SQL(" + Quote(sql) + ")" + o.runsqlTail(), nil
}

// Export is the CPYTOIMPF that writes a QTEMP table as UTF-8 CSV with a header row.
// Without the header (hosts before 7.2 do not know ADDCOLNAM), the names come from
// the metadata query.
func Export(table, stmf string, header bool) string {
	cmd := "CPYTOIMPF FROMFILE(QTEMP/" + table + ") TOSTMF(" + Quote(stmf) + ") MBROPT(*REPLACE) STMFCODPAG(*UTF8) RCDDLM(*LF) DTAFMT(*DLM) STRDLM('\"') FLDDLM(',') DECPNT(*PERIOD) RMVBLANK(*TRAILING)"
	if header {
		cmd += " ADDCOLNAM(*SQL)"
	}
	return cmd
}

// Drop removes a QTEMP table.
func Drop(table string) string { return "DLTF FILE(QTEMP/" + table + ")" }

// Column is what the page shows above a result column.
type Column struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Length   int    `json:"length"`
	Scale    int    `json:"scale"`
	Nullable bool   `json:"nullable"`
	CCSID    int    `json:"ccsid,omitempty"`
	Position int    `json:"-"`
}

// MetadataQuery is the RUNSQL that copies the column catalogue of a QTEMP table into
// another QTEMP table (exported and read like a result). Always SQL naming: the
// catalogue is addressed by schema.
func MetadataQuery(table, into string) string {
	sql := "CREATE TABLE QTEMP." + into + " AS (SELECT ORDINAL_POSITION, COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE, IS_NULLABLE, CCSID FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = 'QTEMP' AND TABLE_NAME = '" + table + "') WITH DATA"
	return "RUNSQL SQL(" + Quote(sql) + ") COMMIT(*NONE) NAMING(*SQL)"
}

// ParseColumns turns the exported catalogue rows (with or without the header row) into
// columns in ordinal order.
func ParseColumns(header []string, rows [][]*string) []Column {
	idx := map[string]int{"ORDINAL_POSITION": 0, "COLUMN_NAME": 1, "DATA_TYPE": 2, "LENGTH": 3, "NUMERIC_SCALE": 4, "IS_NULLABLE": 5, "CCSID": 6}
	if len(header) >= 7 {
		for i, h := range header {
			idx[strings.ToUpper(strings.TrimSpace(h))] = i
		}
	}
	get := func(row []*string, key string) string {
		i, ok := idx[key]
		if !ok || i >= len(row) || row[i] == nil {
			return ""
		}
		return strings.TrimSpace(*row[i])
	}
	out := make([]Column, 0, len(rows))
	for _, row := range rows {
		pos, _ := strconv.Atoi(get(row, "ORDINAL_POSITION"))
		length, _ := strconv.Atoi(get(row, "LENGTH"))
		scale, _ := strconv.Atoi(get(row, "NUMERIC_SCALE"))
		ccsid, _ := strconv.Atoi(get(row, "CCSID"))
		out = append(out, Column{
			Name:     get(row, "COLUMN_NAME"),
			Type:     strings.ToUpper(get(row, "DATA_TYPE")),
			Length:   length,
			Scale:    scale,
			Nullable: strings.EqualFold(get(row, "IS_NULLABLE"), "Y"),
			CCSID:    ccsid,
			Position: pos,
		})
	}
	// Insertion sort by position: the catalogue copy is small and arrives nearly in order.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Position < out[j-1].Position; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// ParseCSV reads what CPYTOIMPF wrote: comma-separated, strings in double quotes,
// LF records, UTF-8 (a BOM is tolerated). With header, the first record names the
// columns. An empty unquoted field is returned as an empty string (CPYTOIMPF writes
// NULL that way too, so NULL is not distinguishable).
func ParseCSV(data []byte, header bool) (names []string, rows [][]*string, err error) {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	r.TrimLeadingSpace = false
	first := true
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return names, rows, fmt.Errorf("reading the result file: %w", err)
		}
		if first && header {
			first = false
			names = make([]string, len(rec))
			for i, n := range rec {
				names[i] = strings.TrimSpace(n)
			}
			continue
		}
		first = false
		row := make([]*string, len(rec))
		for i := range rec {
			v := rec[i]
			row[i] = &v
		}
		rows = append(rows, row)
	}
	return names, rows, nil
}

// QshCommand wraps a Qshell command line so that its output lands in a stream file:
// QSH CMD('<line> > /tmp/x 2>&1'). The line's apostrophes are doubled for CL.
func QshCommand(line, stmf string) string {
	return "QSH CMD(" + Quote(strings.TrimSpace(line)+" > "+stmf+" 2>&1") + ")"
}

// Lines splits a stream file's text into rows of one column.
func Lines(data []byte) [][]*string {
	text := strings.TrimRight(string(bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})), "\n")
	if text == "" {
		return nil
	}
	parts := strings.Split(text, "\n")
	out := make([][]*string, len(parts))
	for i, p := range parts {
		v := strings.TrimRight(p, "\r")
		out[i] = []*string{&v}
	}
	return out
}

// IsCommandError reports whether a CL message id means the command itself was wrong
// for this host (a keyword this release does not know), so a simpler form can be tried.
func IsCommandError(id string) bool {
	switch id {
	case "CPD0043", "CPD0044", "CPD0084", "CPF0001", "CPF0006":
		return true
	}
	return false
}
