package main

import "errors"

// Run SQL Scripts and the Console: the page-facing model. The database and remote
// command server clients (internal/hostserver/db, internal/hostserver/rmtcmd) are
// recorded and built next; until then every call reports that plainly.

// SqlConnectRequest opens a database connection for one Run SQL Scripts tab.
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

var errSQLNotReady = errors.New("Run SQL Scripts is not finished in this build: the database server client is still being recorded against IBM's client")

// SqlConnect signs on to the database host server; it returns a connection id.
func (a *App) SqlConnect(_ SqlConnectRequest) (string, error) { return "", errSQLNotReady }

// SqlClose ends a connection.
func (a *App) SqlClose(_ string) {}

// SqlRun runs one SQL statement; at most maxRows rows come back in the first block.
func (a *App) SqlRun(_ string, _ string, _ int) (SqlResult, error) {
	return SqlResult{}, errSQLNotReady
}

// SqlFetch continues an open result set.
func (a *App) SqlFetch(_ string, _ string, _ int) (SqlResult, error) {
	return SqlResult{}, errSQLNotReady
}

// SqlCancel interrupts the running statement of a connection.
func (a *App) SqlCancel(_ string) {}

// CmdRun runs a CL command through the remote command server of the same sign-on.
func (a *App) CmdRun(_ string, _ string) (SqlResult, error) {
	return SqlResult{}, errSQLNotReady
}

// QshRun runs a Qshell command (QSH CMD(...) with its output sent to a stream file
// and read back); the output lines come back as rows of one column.
func (a *App) QshRun(_ string, _ string) (SqlResult, error) {
	return SqlResult{}, errSQLNotReady
}
