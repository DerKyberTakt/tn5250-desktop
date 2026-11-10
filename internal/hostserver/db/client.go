// Package db is a client for the IBM i database host server (QZDASOINIT, "as-database",
// port 8471): the server IBM's own JDBC driver talks to. It prepares and runs SQL
// statements in a server job signed on as the user and returns typed columns and
// rows, one round trip per request, so Run SQL Scripts no longer needs the RUNSQL +
// CPYTOIMPF detour of internal/sqlviacl (which stays as the fallback for hosts that
// do not run this server).
//
// The wire format follows IBM's JTOpen sources (DBBaseRequestDS, DBBaseReplyDS,
// DBSQLAttributesDS, DBSQLRequestDS, DBSQLRPBDS, DBReplyServerAttributes, DBReplySQLCA,
// DBSuperExtendedDataFormat, DBExtendedData, JDServerRow, AS400JDBCConnectionImpl,
// AS400JDBCStatement, JDServerRowCache). After the common 20-byte host-server header
// (internal/hostserver/ds.go) every request carries a 20-byte template:
//
//	20 u32 operation-result bitmap (which parts of the reply are wanted; bit 31 =
//	       "send a reply at all"), 24 u32 reserved, 28/30 u16 return/fill ORS handle,
//	32 u16 based-on ORS handle (0), 34 u16 RPB handle, 36 u16 parameter-marker
//	descriptor handle (0), 38 u16 parameter count; LL/CP parameters from 40.
//
// and every reply the same 20 bytes with 34 u16 error class and 36 i32 return code.
// ORS handle = RPB handle = statement id; this client runs one statement at a time in
// request parameter block 1. The sequence for a query is CREATE_RPB (once),
// PREPARE_DESCRIBE (gives the column format), OPEN_DESCRIBE_FETCH (opens the cursor
// and returns the first block), FETCH (next blocks), CLOSE; for anything else it is
// EXECUTE_IMMEDIATE and the update count comes from the SQLCA.
package db

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	hs "github.com/DerKyberTakt/tn5250-desktop/internal/hostserver"
)

// Function ids (request id in the header) and the reply id.
const (
	fnSetAttributes     uint16 = 0x1F80
	fnCreateRPB         uint16 = 0x1D00
	fnPrepareDescribe   uint16 = 0x1803
	fnOpenDescribeFetch uint16 = 0x180E
	fnFetch             uint16 = 0x180B
	fnClose             uint16 = 0x180A
	fnExecuteImmediate  uint16 = 0x1806
	fnCancel            uint16 = 0x1818
	ReplyID             uint16 = 0x2800
)

// Operation-result bitmap bits.
const (
	orsReturnData  uint32 = 0x80000000
	orsMessageID   uint32 = 0x40000000
	orsFirstLevel  uint32 = 0x20000000
	orsDataFormat  uint32 = 0x08000000
	orsResultData  uint32 = 0x04000000
	orsSQLCA       uint32 = 0x02000000
	orsServerAttrs uint32 = 0x01000000
	// orsDiagnostics asks for the message id, first-level text and SQLCA with every
	// statement reply, so an error explains itself without a second request.
	orsDiagnostics = orsMessageID | orsFirstLevel | orsSQLCA
)

// Request code points of the attribute exchange (function 0x1F80).
const (
	attrClientCCSID     uint16 = 0x3801
	attrLanguageFeature uint16 = 0x3802
	attrFunctionalLevel uint16 = 0x3803
	attrTranslate       uint16 = 0x3805
	attrPackageSize     uint16 = 0x3806
	attrDateFormat      uint16 = 0x3807
	attrDateSeparator   uint16 = 0x3808
	attrTimeFormat      uint16 = 0x3809
	attrTimeSeparator   uint16 = 0x380A
	attrDecimalSep      uint16 = 0x380B
	attrNaming          uint16 = 0x380C
	attrCommitLevel     uint16 = 0x380E
	attrDefaultLibrary  uint16 = 0x380F
	attrAmbiguousSelect uint16 = 0x3811
	attrPackageAdd      uint16 = 0x3812
	attrExtendedFormats uint16 = 0x3821
	attrLOBThreshold    uint16 = 0x3822
	attrCompression     uint16 = 0x3823
	attrAutoCommit      uint16 = 0x3824
	attrClientSupport   uint16 = 0x3825
	attrDecimalPrec     uint16 = 0x3827
	attrHexParser       uint16 = 0x3828
	attrLocatorPersist  uint16 = 0x3830
	attrCloseOnEOF      uint16 = 0x383F
)

// Request code points of statement and RPB requests.
const (
	stmtName          uint16 = 0x3806
	stmtPrepareOption uint16 = 0x3808
	stmtOpenAttrs     uint16 = 0x3809
	stmtCursorName    uint16 = 0x380B
	stmtBlockingFactr uint16 = 0x380C
	stmtScrollable    uint16 = 0x380D
	stmtScrollOption  uint16 = 0x380E
	stmtReuse         uint16 = 0x3810
	stmtType          uint16 = 0x3812
	stmtJobID         uint16 = 0x3826
	stmtExtendedText  uint16 = 0x3831
)

// Reply code points.
const (
	repMessageID     uint16 = 0x3801
	repFirstLevel    uint16 = 0x3802
	repServerAttrs   uint16 = 0x3804
	repSQLCA         uint16 = 0x3807
	repExtFormat     uint16 = 0x380C
	repExtData       uint16 = 0x380E
	repSuperExtFormt uint16 = 0x3812
)

const (
	unicodeCCSID    uint16 = 13488 // UCS-2, the CCSID JTOpen tags statement text with
	ebcdicCCSID     uint16 = 37
	rpbID           uint16 = 1
	maxBlockRows           = 32767
	defaultBlock           = 500
	functionalLevel        = "V7R2M01   " // what JTOpen 21 announces
	nlvEnglish             = "2924"
	maxStatementLen        = 2 * 1024 * 1024
)

// ServerAttributes is what the host reports in the attribute exchange.
type ServerAttributes struct {
	CCSID   uint16 // the server job's CCSID; names and messages come in it
	Release string // "V7R5M0"
	VRM     int    // 0x070500
	// JobID is "name      user      number" (26 characters), the handle Cancel needs.
	JobID         string
	DefaultSchema string
	// FunctionalLevel is the server's functional level number (JTOpen: cancel needs 5+).
	FunctionalLevel int
}

// Message is one SQL message from a reply: a warning, or the error behind an Error.
type Message struct {
	ID       string `json:"id"`      // SQL0204, CPF... (may be empty)
	SQLCode  int32  `json:"sqlCode"` // from the SQLCA, 0 when there was none
	SQLState string `json:"sqlState"`
	Text     string `json:"text"`
}

// Error is a statement the host refused: error class and return code from the reply
// template plus whatever diagnostics came with it.
type Error struct {
	Class uint16
	Code  int32
	Message
}

func (e *Error) Error() string {
	switch {
	case e.ID != "" && e.Text != "":
		return e.ID + ": " + e.Text
	case e.Text != "":
		return e.Text
	case e.SQLCode != 0:
		return fmt.Sprintf("SQLCODE %d (SQLSTATE %s)", e.SQLCode, e.SQLState)
	}
	return fmt.Sprintf("the database server refused the request (error class %d, return code %d)", e.Class, e.Code)
}

// Options describe the connection.
type Options struct {
	hs.DialOptions
	// Naming is "sql" (schema.table, the default) or "sys" (library/file).
	Naming string
	// DefaultSchema, when set, is the default collection for unqualified names.
	DefaultSchema string
}

// Client is one connection to the database server: one server job, one statement at
// a time.
type Client struct {
	mu    sync.Mutex
	c     *hs.Conn
	opts  Options
	attrs ServerAttributes
	// Warnings the attribute exchange produced (class 7, codes 301/303/304).
	Warnings   []Message
	cursorOpen bool
	closed     bool
}

// Open connects, signs on, exchanges attributes and creates the request parameter
// block the statements run in.
func Open(o Options) (*Client, error) {
	conn, err := hs.Dial(hs.ServerDatabase, "as-database", o.DialOptions)
	if err != nil {
		return nil, err
	}
	c := &Client{c: conn, opts: o}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	conn.SetDeadline(time.Now().Add(timeout))
	if err := c.exchangeAttributes(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := c.createRPB(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	conn.SetDeadline(time.Time{})
	return c, nil
}

// Attributes returns what the host reported at connect time.
func (c *Client) Attributes() ServerAttributes { return c.attrs }

// Close ends the connection; an open cursor is closed on the host first.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	if c.cursorOpen {
		c.cursorOpen = false
		_ = c.c.Send(c.closeCursor())
	}
	return c.c.Close()
}

// ---- requests ---------------------------------------------------------------------

type request struct {
	fn     uint16
	ors    uint32
	rpb    uint16
	params hs.Builder
	count  uint16
}

func newRequest(fn uint16, ors uint32, rpb uint16) *request {
	return &request{fn: fn, ors: ors, rpb: rpb}
}

func (r *request) raw(cp uint16, data []byte) *request {
	r.params.Param(cp, data)
	r.count++
	return r
}
func (r *request) u8(cp uint16, v uint8) *request { return r.raw(cp, []byte{v}) }
func (r *request) u16(cp uint16, v uint16) *request {
	return r.raw(cp, binary.BigEndian.AppendUint16(nil, v))
}
func (r *request) u32(cp uint16, v uint32) *request {
	return r.raw(cp, binary.BigEndian.AppendUint32(nil, v))
}

// str is a variable-length string parameter: CCSID, 2-byte length, EBCDIC bytes.
func (r *request) str(cp uint16, ccsid uint16, s string) *request {
	e, _ := hs.EBCDIC(s)
	b := (&hs.Builder{}).U16(ccsid).U16(uint16(len(e))).Raw(e)
	return r.raw(cp, b.Bytes())
}

// frame builds the datastream: 20-byte template, then the parameters.
func (r *request) frame() *hs.Frame {
	body := (&hs.Builder{}).U32(r.ors).U32(0).U16(r.rpb).U16(r.rpb).U16(0).U16(r.rpb).U16(0).U16(r.count).Raw(r.params.Bytes())
	return &hs.Frame{TemplateLen: 20, ReqRepID: r.fn, Body: body.Bytes()}
}

type reply struct {
	class  uint16
	code   int32
	fn     uint16 // function whose data is returned (template offset 30)
	params []hs.Param
	body   hs.At
}

// request sends one request and reads its reply; the caller holds c.mu.
func (c *Client) request(r *request) (*reply, error) {
	rep, err := c.c.Request(r.frame())
	if err != nil {
		return nil, fmt.Errorf("database server: %w", err)
	}
	if rep.ReqRepID != ReplyID {
		return nil, fmt.Errorf("database server: unexpected reply id %04X", rep.ReqRepID)
	}
	b := hs.At(rep.Body)
	out := &reply{class: b.U16(34), code: int32(b.U32(36)), fn: b.U16(30), body: b}
	if len(rep.Body) > 20 {
		out.params, _ = b.Params(40)
	}
	return out, nil
}

// failed says whether a reply is an error (not a warning or an end-of-data signal).
func (rep *reply) failed() bool { return rep.class != 0 && rep.code < 0 }

// endOfData recognises the last block: (1,100) and (2,701) leave the cursor open on
// the host, (2,700) means the host already closed it (attribute 0x383F).
func (rep *reply) endOfData() (last, hostClosed bool) {
	switch {
	case rep.class == 1 && rep.code == 100, rep.class == 2 && rep.code == 701:
		return true, false
	case rep.class == 2 && rep.code == 700:
		return true, true
	}
	return false, false
}

// diagnostics reads the message id, first-level text and SQLCA of a reply.
func (c *Client) diagnostics(rep *reply) Message {
	var m Message
	if d, ok := hs.Find(rep.params, repMessageID); ok && len(d) > 2 {
		m.ID = strings.TrimSpace(decodeText(d[2:], binary.BigEndian.Uint16(d), c.attrs.CCSID))
	}
	if d, ok := hs.Find(rep.params, repFirstLevel); ok && len(d) > 4 {
		n := int(binary.BigEndian.Uint16(d[2:]))
		if n > len(d)-4 {
			n = len(d) - 4
		}
		m.Text = strings.TrimSpace(decodeText(d[4:4+n], binary.BigEndian.Uint16(d), c.attrs.CCSID))
	}
	if ca, ok := parseSQLCA(find(rep.params, repSQLCA)); ok {
		m.SQLCode, m.SQLState = ca.code, ca.state
	}
	return m
}

func (c *Client) errorOf(rep *reply) *Error {
	return &Error{Class: rep.class, Code: rep.code, Message: c.diagnostics(rep)}
}

// warningOf returns the reply's message when the host added one to a successful
// request (class != 0 with a non-negative code that is not an end-of-data signal).
func (c *Client) warningOf(rep *reply) (Message, bool) {
	if rep.class == 0 {
		return Message{}, false
	}
	if last, _ := rep.endOfData(); last {
		return Message{}, false
	}
	m := c.diagnostics(rep)
	if strings.HasPrefix(m.SQLState, "00") || strings.HasPrefix(m.SQLState, "02") {
		return Message{}, false
	}
	if m.Text == "" && m.ID == "" {
		m.Text = fmt.Sprintf("warning from the database server (class %d, code %d)", rep.class, rep.code)
	}
	return m, true
}

func find(params []hs.Param, cp uint16) []byte {
	d, _ := hs.Find(params, cp)
	return d
}

// ---- SQLCA ----------------------------------------------------------------------------

type sqlca struct {
	code  int32
	state string
	errd  [6]int32
}

// parseSQLCA reads the 136-byte SQL communication area (JTOpen DBReplySQLCA):
// SQLCODE i32 at 12, SQLERRD1..6 at 96..116, SQLSTATE 5 EBCDIC bytes at 131.
func parseSQLCA(d []byte) (sqlca, bool) {
	if len(d) < 136 {
		return sqlca{}, false
	}
	var ca sqlca
	ca.code = int32(binary.BigEndian.Uint32(d[12:]))
	for i := range ca.errd {
		ca.errd[i] = int32(binary.BigEndian.Uint32(d[96+4*i:]))
	}
	ca.state = hs.FromEBCDIC(d[131:136])
	return ca, true
}

// ---- connect -----------------------------------------------------------------------------

// exchangeAttributes is the first request: it tells the server how the client wants
// to talk (Unicode statement text, super-extended formats, ISO dates, no translation)
// and reads back the job's CCSID, release and identity.
func (c *Client) exchangeAttributes() error {
	r := newRequest(fnSetAttributes, orsReturnData|orsServerAttrs, 0)
	r.u16(attrClientCCSID, unicodeCCSID)
	nlv, _ := hs.EBCDIC(nlvEnglish)
	r.raw(attrLanguageFeature, (&hs.Builder{}).U16(ebcdicCCSID).Raw(nlv).Bytes())
	// Client functional level: JTOpen's parameter counts two trailing bytes it never
	// writes (DBBaseRequestDS, the fixed-string overload); send them as zeros.
	lvl, _ := hs.EBCDIC(functionalLevel)
	r.raw(attrFunctionalLevel, (&hs.Builder{}).U16(ebcdicCCSID).Raw(lvl).U16(0).Bytes())
	r.u8(attrTranslate, 0xF0) // data comes back in the job's CCSIDs; we convert
	r.u16(attrPackageSize, 1)
	r.u8(attrAutoCommit, 0xE8)  // autocommit on
	r.u16(attrCommitLevel, 0)   // *NONE
	r.u16(attrDateFormat, 5)    // ISO yyyy-mm-dd
	r.u16(attrDateSeparator, 1) // '-'
	r.u16(attrTimeFormat, 4)    // JIS hh:mm:ss
	r.u16(attrTimeSeparator, 0) // ':'
	r.u16(attrDecimalSep, 0)    // '.'
	naming := uint16(0)
	if strings.EqualFold(c.opts.Naming, "sys") || strings.EqualFold(c.opts.Naming, "system") {
		naming = 1
	}
	r.u16(attrNaming, naming)
	r.u16(attrCompression, 0)
	if lib := strings.ToUpper(strings.TrimSpace(c.opts.DefaultSchema)); lib != "" {
		r.str(attrDefaultLibrary, ebcdicCCSID, lib)
	}
	r.u16(attrPackageAdd, 1)
	r.u8(attrExtendedFormats, 0xF2) // super-extended data formats (V5R4+)
	r.u32(attrLOBThreshold, 32768)  // LOBs up to 32 KB come inline
	r.u16(attrAmbiguousSelect, 1)   // ambiguous SELECT = read only
	r.u32(attrClientSupport, 0xF2000000)
	r.raw(attrDecimalPrec, (&hs.Builder{}).U16(31).U16(31).U16(0).Bytes())
	r.u8(attrHexParser, 0)
	r.u16(attrLocatorPersist, 1)
	r.u8(attrCloseOnEOF, 0xE8) // the host may close the cursor at end of data (class 2 / 700)

	rep, err := c.request(r)
	if err != nil {
		return err
	}
	if rep.class != 0 {
		if rep.class == 7 && (rep.code == 301 || rep.code == 303 || rep.code == 304) {
			if m, ok := c.warningOf(rep); ok {
				c.Warnings = append(c.Warnings, m)
			}
		} else {
			e := c.errorOf(rep)
			return fmt.Errorf("database server attribute exchange: %w", e)
		}
	}
	d := find(rep.params, repServerAttrs)
	if len(d) < 2+114 {
		return errors.New("database server: the attribute reply carries no server attributes")
	}
	c.attrs = parseServerAttributes(d[2:])
	return nil
}

// parseServerAttributes reads the structure after the CCSID of parameter 0x3804
// (JTOpen DBReplyServerAttributes): job CCSID u16 at 19, functional level 10 EBCDIC
// chars at 50 with the VRM digits in bytes 51/53/55, job identifier 26 chars at 88,
// default schema length u16 at 114 and text at 116.
func parseServerAttributes(d []byte) ServerAttributes {
	var a ServerAttributes
	a.CCSID = binary.BigEndian.Uint16(d[19:])
	level := hs.FromEBCDIC(d[50:60])
	if len(level) >= 6 {
		a.Release = level[:6]
	}
	a.VRM = int(d[51]&0x0F)<<16 | int(d[53]&0x0F)<<8 | int(d[55]&0x0F)
	if len(level) > 6 {
		fmt.Sscanf(strings.TrimSpace(level[6:]), "%d", &a.FunctionalLevel)
	}
	a.JobID = strings.TrimRight(decodeText(d[88:114], a.CCSID, a.CCSID), " ")
	if len(d) >= 116 {
		n := int(binary.BigEndian.Uint16(d[114:]))
		if n > 0 && 116+n <= len(d) {
			a.DefaultSchema = strings.TrimSpace(decodeText(d[116:116+n], a.CCSID, a.CCSID))
		}
	}
	return a
}

// createRPB makes request parameter block 1 with the statement and cursor names; the
// server sends no reply (bitmap 0), as in JTOpen.
func (c *Client) createRPB() error {
	r := newRequest(fnCreateRPB, 0, rpbID)
	r.str(stmtName, c.attrs.CCSID, fmt.Sprintf("STMT%04d", rpbID))
	r.str(stmtCursorName, c.attrs.CCSID, fmt.Sprintf("CRSR%04d", rpbID))
	if err := c.c.Send(r.frame()); err != nil {
		return fmt.Errorf("database server: %w", err)
	}
	return nil
}

// statementText is the extended statement text parameter: CCSID 13488, 4-byte length,
// the text in UCS-2.
func statementText(sql string) ([]byte, error) {
	if len(sql) > maxStatementLen {
		return nil, fmt.Errorf("the statement is %d bytes; the database server takes at most %d", len(sql), maxStatementLen)
	}
	u := utf16.Encode([]rune(sql))
	b := (&hs.Builder{}).U16(unicodeCCSID).U32(uint32(2 * len(u)))
	for _, w := range u {
		b.U16(w)
	}
	return b.Bytes(), nil
}

// ---- statements ---------------------------------------------------------------------------

// Rows is an open query: its columns and the fetched blocks.
type Rows struct {
	c       *Client
	Columns []Column
	format  *dataFormat
	block   uint32
	// Done is true once the last block has been read.
	Done bool
	// Messages are warnings the host attached to the open or the fetches.
	Messages []Message
}

// Query prepares and opens a SELECT (or VALUES / WITH) and returns the first block of
// at most block rows. Rows.Next brings the following blocks; Rows.Close ends it. A
// cursor still open from an earlier Query is closed first.
func (c *Client) Query(sql string, block int) (*Rows, [][]*string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, nil, errors.New("the connection is closed")
	}
	if c.cursorOpen {
		c.cursorOpen = false
		if err := c.c.Send(c.closeCursor()); err != nil {
			return nil, nil, fmt.Errorf("database server: %w", err)
		}
	}
	text, err := statementText(sql)
	if err != nil {
		return nil, nil, err
	}
	// 1. prepare + describe: the column format.
	r := newRequest(fnPrepareDescribe, orsReturnData|orsDataFormat|orsDiagnostics, rpbID)
	r.raw(stmtExtendedText, text).u16(stmtType, 2).u8(stmtPrepareOption, 0)
	rep, err := c.request(r)
	if err != nil {
		return nil, nil, err
	}
	if rep.failed() {
		return nil, nil, c.errorOf(rep)
	}
	rows := &Rows{c: c}
	if m, ok := c.warningOf(rep); ok {
		rows.Messages = append(rows.Messages, m)
	}
	var fd []byte
	cp := repSuperExtFormt
	if d, ok := hs.Find(rep.params, repSuperExtFormt); ok {
		fd = d
	} else if d, ok := hs.Find(rep.params, repExtFormat); ok {
		fd, cp = d, repExtFormat
	}
	if fd == nil {
		return nil, nil, errors.New("the statement returns no result set")
	}
	f, err := parseFormat(cp, fd, c.attrs.CCSID)
	if err != nil {
		return nil, nil, err
	}
	rows.format = f
	rows.Columns = f.columns()
	if block <= 0 {
		block = defaultBlock
	}
	if block > maxBlockRows {
		block = maxBlockRows
	}
	rows.block = uint32(block)

	// 2. open + fetch the first block.
	r = newRequest(fnOpenDescribeFetch, orsReturnData|orsResultData|orsDiagnostics, rpbID)
	r.u8(stmtOpenAttrs, 0x80).u32(stmtBlockingFactr, rows.block).u16(stmtScrollable, 0)
	rep, err = c.request(r)
	if err != nil {
		return nil, nil, err
	}
	if rep.failed() {
		return nil, nil, c.errorOf(rep)
	}
	c.cursorOpen = true
	data, err := rows.take(rep)
	if err != nil {
		return nil, nil, err
	}
	return rows, data, nil
}

// take decodes the rows of a reply and notes whether it was the last block.
func (rows *Rows) take(rep *reply) ([][]*string, error) {
	if m, ok := rows.c.warningOf(rep); ok {
		rows.Messages = append(rows.Messages, m)
	}
	var data [][]*string
	if d, ok := hs.Find(rep.params, repExtData); ok {
		if rep.body.U16(20)&1 != 0 {
			return nil, errors.New("the database server compressed the rows, which this client did not ask for")
		}
		var err error
		data, err = rows.format.decodeRows(d, rows.c.attrs.CCSID)
		if err != nil {
			return nil, err
		}
	}
	last, hostClosed := rep.endOfData()
	if last || len(data) == 0 || uint32(len(data)) < rows.block {
		rows.Done = true
	}
	if hostClosed {
		rows.c.cursorOpen = false
	}
	return data, nil
}

// Next fetches the next block; nil rows with Done set means the end.
func (rows *Rows) Next() ([][]*string, error) {
	c := rows.c
	c.mu.Lock()
	defer c.mu.Unlock()
	if rows.Done || !c.cursorOpen {
		rows.Done = true
		return nil, nil
	}
	r := newRequest(fnFetch, orsReturnData|orsResultData|orsDiagnostics, rpbID)
	r.u16(stmtScrollOption, 0).u32(stmtBlockingFactr, rows.block)
	rep, err := c.request(r)
	if err != nil {
		return nil, err
	}
	if rep.failed() {
		return nil, c.errorOf(rep)
	}
	return rows.take(rep)
}

// Close closes the cursor on the host (no reply is requested, as in JTOpen).
func (rows *Rows) Close() error {
	c := rows.c
	c.mu.Lock()
	defer c.mu.Unlock()
	rows.Done = true
	if !c.cursorOpen || c.closed {
		return nil
	}
	c.cursorOpen = false
	if err := c.c.Send(c.closeCursor()); err != nil {
		return fmt.Errorf("database server: %w", err)
	}
	return nil
}

func (c *Client) closeCursor() *hs.Frame {
	return newRequest(fnClose, 0, rpbID).u8(stmtReuse, 0xF1).frame()
}

// ExecResult is the outcome of a statement without a result set.
type ExecResult struct {
	// UpdateCount is SQLERRD(3): rows inserted, updated or deleted (0 for DDL).
	UpdateCount int
	SQLCode     int32
	SQLState    string
	Messages    []Message
}

// Exec runs a statement that returns no rows (INSERT, UPDATE, DELETE, MERGE, DDL,
// SET, CALL without result sets ...) with EXECUTE_IMMEDIATE.
func (c *Client) Exec(sql string) (ExecResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return ExecResult{}, errors.New("the connection is closed")
	}
	if c.cursorOpen {
		c.cursorOpen = false
		if err := c.c.Send(c.closeCursor()); err != nil {
			return ExecResult{}, fmt.Errorf("database server: %w", err)
		}
	}
	text, err := statementText(sql)
	if err != nil {
		return ExecResult{}, err
	}
	r := newRequest(fnExecuteImmediate, orsReturnData|orsDiagnostics, rpbID)
	r.raw(stmtExtendedText, text).u16(stmtType, 1).u8(stmtOpenAttrs, 0xF0).u8(stmtPrepareOption, 0)
	rep, err := c.request(r)
	if err != nil {
		return ExecResult{}, err
	}
	if rep.failed() {
		return ExecResult{}, c.errorOf(rep)
	}
	var out ExecResult
	if ca, ok := parseSQLCA(find(rep.params, repSQLCA)); ok {
		out.UpdateCount = int(ca.errd[2])
		out.SQLCode, out.SQLState = ca.code, ca.state
	}
	if m, ok := c.warningOf(rep); ok {
		out.Messages = append(out.Messages, m)
	}
	return out, nil
}

// Cancel interrupts the statement running on this connection the way JDBC does: a
// second connection to the same server, signed on as the same user, sends CANCEL
// with this connection's job identifier. The interrupted request then fails on the
// main connection with an SQL error.
func (c *Client) Cancel() error {
	if c.attrs.JobID == "" {
		return errors.New("the database server did not report its job identifier; cancel is not available")
	}
	o := c.opts
	if o.Timeout <= 0 {
		o.Timeout = 15 * time.Second
	}
	conn, err := hs.Dial(hs.ServerDatabase, "as-database", o.DialOptions)
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(o.Timeout))
	side := &Client{c: conn, opts: o}
	if err := side.exchangeAttributes(); err != nil {
		return err
	}
	r := newRequest(fnCancel, orsReturnData, 0)
	r.str(stmtJobID, side.attrs.CCSID, c.attrs.JobID)
	rep, err := side.request(r)
	if err != nil {
		return err
	}
	if rep.failed() {
		return side.errorOf(rep)
	}
	return nil
}
