package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/ifs"
	"github.com/DerKyberTakt/tn5250-desktop/internal/hostserver/rmtcmd"
	"github.com/DerKyberTakt/tn5250-desktop/internal/sqlviacl"
)

// Run SQL Scripts and the Console, on two host servers every IBM i offers: the remote
// command server runs CL (and SQL through RUNSQL), the file server brings query
// results back as CSV stream files (internal/sqlviacl explains the mechanics and the
// limits). The database host server client, which would give typed rows and update
// counts directly, is still to be recorded; the page-facing model below stays the same
// when it replaces this.

// SqlConnectRequest opens a connection for one Run SQL Scripts or Console tab.
type SqlConnectRequest struct {
	Host                string `json:"host"`
	TLS                 bool   `json:"tls"`
	TrustAnyCertificate bool   `json:"trustAnyCertificate"`
	User                string `json:"user"`
	Password            string `json:"password"`
	TimeoutMs           int    `json:"timeoutMs"`
	// Naming is "sql" (schema.table) or "sys" (library/file); DefaultSchema may be empty.
	Naming        string `json:"naming"`
	DefaultSchema string `json:"defaultSchema"`
}

// SqlColumn describes one result column as the host reports it.
type SqlColumn struct {
	Name     string `json:"name"`
	Label    string `json:"label,omitempty"`
	Type     string `json:"type"` // CHAR, VARCHAR, DECIMAL, INTEGER, DATE, ...
	Length   int    `json:"length"`
	Scale    int    `json:"scale"`
	Nullable bool   `json:"nullable"`
	CCSID    int    `json:"ccsid,omitempty"`
}

// SqlMessage is one SQLCA / CL message.
type SqlMessage struct {
	ID       string `json:"id"`       // SQLSTATE, or a CPF/CPD message id
	Code     int    `json:"code"`     // SQLCODE (0 when not SQL)
	Severity int    `json:"severity"` // CL message severity
	Text     string `json:"text"`
}

// SqlResult is the outcome of one statement or command.
type SqlResult struct {
	// "rows" (a result set), "count" (an update count), "none" (ran, nothing to show),
	// "error".
	Kind        string       `json:"kind"`
	Columns     []SqlColumn  `json:"columns,omitempty"`
	Rows        [][]*string  `json:"rows,omitempty"` // nil = SQL NULL
	More        bool         `json:"more"`           // more rows can be fetched with SqlFetch
	Cursor      string       `json:"cursor,omitempty"`
	UpdateCount int          `json:"updateCount"`
	Messages    []SqlMessage `json:"messages"`
	ElapsedMs   int          `json:"elapsedMs"`
}

const defaultPageRows = 500

var errSQLCancelled = errors.New("cancelled")

// sqlCache keeps a materialised result so the page can fetch it page by page.
type sqlCache struct {
	columns   []SqlColumn
	rows      [][]*string
	truncated bool // the query had more rows than sqlviacl.HardCap
}

type sqlSession struct {
	mu      sync.Mutex
	cmd     *rmtcmd.Client
	files   *ifs.Client // opened on first use, with the same sign-on
	options hs.DialOptions
	naming  sqlviacl.Options
	user    string
	seq     int
	results map[string]*sqlCache
	order   []string // cursors, oldest first (a few are kept)
	cancel  atomic.Bool
	// header is false once this host refused CPYTOIMPF ADDCOLNAM (releases before 7.2).
	header bool
}

type sqlState struct {
	mu       sync.Mutex
	sessions map[string]*sqlSession
	next     int
}

func (a *App) sql() *sqlState {
	a.sqlOnce.Do(func() { a.sqlSt = &sqlState{sessions: map[string]*sqlSession{}} })
	return a.sqlSt
}

func (a *App) sqlSession(id string) (*sqlSession, error) {
	st := a.sql()
	st.mu.Lock()
	defer st.mu.Unlock()
	s := st.sessions[id]
	if s == nil {
		return nil, errors.New("the connection is closed; connect again")
	}
	return s, nil
}

// SqlConnect signs on to the remote command server; it returns a connection id.
func (a *App) SqlConnect(r SqlConnectRequest) (string, error) {
	o := hs.DialOptions{Host: r.Host, TLS: r.TLS, TrustAnyCertificate: r.TrustAnyCertificate, Timeout: time.Duration(r.TimeoutMs) * time.Millisecond, User: r.User, Password: r.Password}
	c, err := rmtcmd.Open(o)
	if err != nil {
		return "", err
	}
	s := &sqlSession{
		cmd:     c,
		options: o,
		naming:  sqlviacl.Options{Naming: r.Naming, DefaultSchema: r.DefaultSchema},
		user:    strings.ToUpper(strings.TrimSpace(r.User)),
		results: map[string]*sqlCache{},
		header:  true,
	}
	st := a.sql()
	st.mu.Lock()
	defer st.mu.Unlock()
	st.next++
	id := fmt.Sprintf("sql%d", st.next)
	st.sessions[id] = s
	return id, nil
}

// SqlClose ends a connection.
func (a *App) SqlClose(id string) {
	st := a.sql()
	st.mu.Lock()
	s := st.sessions[id]
	delete(st.sessions, id)
	st.mu.Unlock()
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.cmd.Close()
	if s.files != nil {
		_ = s.files.Close()
	}
}

// SqlCancel asks the running statement to stop between its steps. The host command
// that is running at that moment finishes on the host; its result is discarded.
func (a *App) SqlCancel(id string) {
	if s, err := a.sqlSession(id); err == nil {
		s.cancel.Store(true)
	}
}

// SqlRun runs one SQL statement; at most maxRows rows come back in the first block.
func (a *App) SqlRun(id string, statement string, maxRows int) (SqlResult, error) {
	s, err := a.sqlSession(id)
	if err != nil {
		return SqlResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancel.Store(false)
	if maxRows <= 0 {
		maxRows = defaultPageRows
	}
	start := time.Now()
	stmt := strings.TrimSpace(statement)
	if sqlviacl.Classify(stmt) == sqlviacl.Query {
		return s.query(stmt, maxRows, start)
	}
	cmd, err := sqlviacl.RunSQL(stmt, s.naming)
	if err != nil {
		return failed(err, start), nil
	}
	res, err := s.cmd.Run(cmd)
	if err != nil {
		return SqlResult{}, err
	}
	out := SqlResult{Kind: "none", Messages: messagesOf(res), ElapsedMs: elapsed(start)}
	if res.Failed() {
		out.Kind = "error"
		if len(out.Messages) == 0 {
			out.Messages = []SqlMessage{{Text: res.Err().Error()}}
		}
	}
	return out, nil
}

// SqlFetch continues a materialised result: the cursor is "<table>:<offset>".
func (a *App) SqlFetch(id string, cursor string, maxRows int) (SqlResult, error) {
	s, err := a.sqlSession(id)
	if err != nil {
		return SqlResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if maxRows <= 0 {
		maxRows = defaultPageRows
	}
	table, offsetText, ok := strings.Cut(cursor, ":")
	offset, _ := strconv.Atoi(offsetText)
	c := s.results[table]
	if !ok || c == nil {
		return SqlResult{}, errors.New("that result is no longer available; run the query again")
	}
	return c.page(table, offset, maxRows, time.Now(), nil), nil
}

// CmdRun runs a CL command through the remote command server of the same sign-on.
func (a *App) CmdRun(id string, command string) (SqlResult, error) {
	s, err := a.sqlSession(id)
	if err != nil {
		return SqlResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	start := time.Now()
	res, err := s.cmd.Run(command)
	if err != nil {
		return SqlResult{}, err
	}
	out := SqlResult{Kind: "none", Messages: messagesOf(res), ElapsedMs: elapsed(start)}
	if res.Failed() {
		out.Kind = "error"
		if len(out.Messages) == 0 {
			out.Messages = []SqlMessage{{Text: res.Err().Error()}}
		}
	}
	return out, nil
}

// QshRun runs a Qshell command line with its output sent to a stream file and read
// back; the output lines come back as rows of one column.
func (a *App) QshRun(id string, command string) (SqlResult, error) {
	s, err := a.sqlSession(id)
	if err != nil {
		return SqlResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	start := time.Now()
	stmf := s.tempFile("txt")
	res, err := s.cmd.Run(sqlviacl.QshCommand(command, stmf))
	if err != nil {
		return SqlResult{}, err
	}
	out := SqlResult{Kind: "none", Messages: messagesOf(res), ElapsedMs: elapsed(start)}
	if data, readErr := s.readAndRemove(stmf); readErr == nil {
		out.Rows = sqlviacl.Lines(data)
		if len(out.Rows) > 0 {
			out.Kind = "rows"
			out.Columns = []SqlColumn{{Name: "output", Type: "VARCHAR"}}
		}
	} else if !ifs.IsNotFound(readErr) {
		out.Messages = append(out.Messages, SqlMessage{Text: "the command's output could not be read: " + readErr.Error()})
	}
	if res.Failed() {
		out.Kind = "error"
		if len(out.Messages) == 0 {
			out.Messages = []SqlMessage{{Text: res.Err().Error()}}
		}
	}
	out.ElapsedMs = elapsed(start)
	return out, nil
}

// --- the query path ---------------------------------------------------------------

// query materialises a SELECT into QTEMP, exports it as CSV, reads the file over the
// IFS and keeps the rows for paging. The QTEMP tables and the file are removed again
// whatever happens.
func (s *sqlSession) query(stmt string, maxRows int, start time.Time) (SqlResult, error) {
	s.seq++
	table := fmt.Sprintf("TN5250Q%d", s.seq)
	meta := table + "M"
	stmf := s.tempFile("csv")
	defer func() {
		_, _ = s.cmd.Run(sqlviacl.Drop(table))
		_, _ = s.cmd.Run(sqlviacl.Drop(meta))
	}()

	cmd, err := sqlviacl.Materialise(stmt, table, sqlviacl.HardCap, s.naming)
	if err != nil {
		return failed(err, start), nil
	}
	res, err := s.cmd.Run(cmd)
	if err != nil {
		return SqlResult{}, err
	}
	if res.Failed() {
		return failedResult(res, start), nil
	}
	if s.cancel.Load() {
		return SqlResult{}, errSQLCancelled
	}

	// Export with a header row; a host that does not know ADDCOLNAM gets the plain form
	// and the names come from the catalogue.
	data, exportMsgs, err := s.export(table, stmf)
	if err != nil {
		return SqlResult{}, err
	}
	if data == nil {
		return SqlResult{Kind: "error", Messages: exportMsgs, ElapsedMs: elapsed(start)}, nil
	}
	names, rows, err := sqlviacl.ParseCSV(data, s.header)
	if err != nil {
		return failed(err, start), nil
	}
	if s.cancel.Load() {
		return SqlResult{}, errSQLCancelled
	}

	// Column types from the catalogue of the QTEMP table (best effort: a failure here
	// only costs the type labels).
	var columns []SqlColumn
	var notes []SqlMessage
	if cols, err := s.metadata(table, meta); err == nil && len(cols) > 0 {
		for _, c := range cols {
			columns = append(columns, SqlColumn{Name: c.Name, Type: c.Type, Length: c.Length, Scale: c.Scale, Nullable: c.Nullable, CCSID: c.CCSID})
		}
	} else if err != nil {
		notes = append(notes, SqlMessage{Text: "column types not available: " + err.Error()})
	}
	width := 0
	for _, r := range rows {
		if len(r) > width {
			width = len(r)
		}
	}
	if len(names) > width {
		width = len(names)
	}
	if len(columns) > width {
		width = len(columns)
	}
	for len(columns) < width {
		columns = append(columns, SqlColumn{Type: "CHAR"})
	}
	for i := range columns {
		if i < len(names) && names[i] != "" {
			columns[i].Name = names[i]
		}
		if columns[i].Name == "" {
			columns[i].Name = fmt.Sprintf("COL%d", i+1)
		}
	}
	for i, r := range rows {
		for len(r) < width {
			r = append(r, nil)
		}
		rows[i] = r
	}
	c := &sqlCache{columns: columns, rows: rows}
	if len(c.rows) > sqlviacl.HardCap {
		c.rows = c.rows[:sqlviacl.HardCap]
		c.truncated = true
	}
	s.keep(table, c)
	return c.page(table, 0, maxRows, start, notes), nil
}

// export runs CPYTOIMPF and reads the file. A nil data with messages means the export
// failed on the host.
func (s *sqlSession) export(table, stmf string) ([]byte, []SqlMessage, error) {
	for {
		res, err := s.cmd.Run(sqlviacl.Export(table, stmf, s.header))
		if err != nil {
			return nil, nil, err
		}
		if res.Failed() {
			if s.header && commandRejected(res) {
				s.header = false
				continue
			}
			return nil, messagesOf(res), nil
		}
		data, err := s.readAndRemove(stmf)
		if err != nil {
			return nil, nil, fmt.Errorf("reading the result file %s: %w", stmf, err)
		}
		return data, nil, nil
	}
}

func (s *sqlSession) metadata(table, meta string) ([]sqlviacl.Column, error) {
	res, err := s.cmd.Run(sqlviacl.MetadataQuery(table, meta))
	if err != nil {
		return nil, err
	}
	if res.Failed() {
		return nil, res.Err()
	}
	stmf := s.tempFile("csv")
	data, msgs, err := s.export(meta, stmf)
	if err != nil {
		return nil, err
	}
	if data == nil {
		if len(msgs) > 0 {
			return nil, errors.New(msgs[len(msgs)-1].Text)
		}
		return nil, errors.New("the catalogue copy failed")
	}
	names, rows, err := sqlviacl.ParseCSV(data, s.header)
	if err != nil {
		return nil, err
	}
	return sqlviacl.ParseColumns(names, rows), nil
}

// commandRejected tells whether the host did not understand the command itself (an
// unknown keyword on an older release), as opposed to the command failing.
func commandRejected(res *rmtcmd.Result) bool {
	for _, m := range res.Messages {
		if sqlviacl.IsCommandError(m.ID) {
			return true
		}
	}
	return false
}

func (s *sqlSession) tempFile(ext string) string {
	s.seq++
	return fmt.Sprintf("/tmp/tn5250-%s-%d-%d.%s", strings.ToLower(s.user), os.Getpid(), s.seq, ext)
}

// readAndRemove downloads a stream file over the file server and deletes it.
func (s *sqlSession) readAndRemove(p string) ([]byte, error) {
	if s.files == nil {
		c, err := ifs.Open(s.options)
		if err != nil {
			return nil, fmt.Errorf("file server: %w", err)
		}
		s.files = c
	}
	var buf bytes.Buffer
	err := s.files.Download(p, &buf, nil)
	_ = s.files.Remove(p, false)
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// keep remembers a result for paging, forgetting the oldest beyond a few.
func (s *sqlSession) keep(table string, c *sqlCache) {
	s.results[table] = c
	s.order = append(s.order, table)
	for len(s.order) > 4 {
		delete(s.results, s.order[0])
		s.order = s.order[1:]
	}
}

func (c *sqlCache) page(table string, offset, maxRows int, start time.Time, notes []SqlMessage) SqlResult {
	if offset < 0 {
		offset = 0
	}
	if offset > len(c.rows) {
		offset = len(c.rows)
	}
	end := offset + maxRows
	if end > len(c.rows) {
		end = len(c.rows)
	}
	out := SqlResult{Kind: "rows", Columns: c.columns, Rows: c.rows[offset:end], Messages: append([]SqlMessage{}, notes...), ElapsedMs: elapsed(start)}
	if out.Rows == nil {
		out.Rows = [][]*string{}
	}
	if end < len(c.rows) {
		out.More = true
		out.Cursor = table + ":" + strconv.Itoa(end)
	} else if c.truncated {
		out.Messages = append(out.Messages, SqlMessage{Text: fmt.Sprintf("Only the first %d rows were fetched; add a WHERE or FETCH FIRST clause for the rest.", sqlviacl.HardCap)})
	}
	return out
}

// --- helpers ------------------------------------------------------------------------

func elapsed(start time.Time) int { return int(time.Since(start) / time.Millisecond) }

func failed(err error, start time.Time) SqlResult {
	return SqlResult{Kind: "error", Messages: []SqlMessage{{Text: err.Error()}}, ElapsedMs: elapsed(start)}
}

func failedResult(res *rmtcmd.Result, start time.Time) SqlResult {
	out := SqlResult{Kind: "error", Messages: messagesOf(res), ElapsedMs: elapsed(start)}
	if len(out.Messages) == 0 {
		out.Messages = []SqlMessage{{Text: res.Err().Error()}}
	}
	return out
}

// messagesOf maps the job's messages to the page's shape; an SQLnnnn message id
// carries its SQLCODE as a negative number, the way the SQLCA reports it.
func messagesOf(res *rmtcmd.Result) []SqlMessage {
	out := make([]SqlMessage, 0, len(res.Messages))
	for _, m := range res.Messages {
		code := 0
		if strings.HasPrefix(m.ID, "SQL") && len(m.ID) == 7 {
			if n, err := strconv.Atoi(m.ID[3:]); err == nil {
				code = -n
			}
		}
		out = append(out, SqlMessage{ID: m.ID, Code: code, Severity: int(m.Severity), Text: m.Text})
	}
	return out
}
