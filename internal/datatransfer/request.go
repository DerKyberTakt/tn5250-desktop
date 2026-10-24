// Package datatransfer reads and writes the request files of IBM i Access Client
// Solutions Data Transfer, so requests saved by ACS run unchanged here and requests
// saved here open in ACS:
//
//   - .dttx  upload   ([DataTransferTo]:   PC file -> database file)
//   - .dtfx  download ([DataTransferFrom]: database file -> PC file)
//   - .fdfx  field description ([Data Transfer File Description]) of the PC file
//
// All three are INI-style text files. Key names below are the ones ACS writes.
package datatransfer

import (
	"bufio"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Direction of a transfer.
type Direction int

const (
	Upload   Direction = iota // [DataTransferTo]
	Download                  // [DataTransferFrom]
)

// Client file types as ACS numbers them (ClientFileType / FileType).
const (
	FileTypeText = 1  // ASCII text, fixed columns or delimited by the FDF
	FileTypeCSV  = 12 // comma separated values
)

// HostFileType: 1 = physical file (database), as in ACS.
const HostFileDatabase = 1

// Host file creation choices (CrtOpt) for uploads, as ACS numbers them.
const (
	CrtOptNone    = 0 // append to an existing file
	CrtOptCreate  = 1 // create the file if it does not exist
	CrtOptReplace = 2 // replace the member's data
)

// Options holds the date, time and decimal formats of the PC file.
type Options struct {
	DateFmt    string // MDY, DMY, YMD, JUL, ISO, USA, EUR, JIS
	DateSep    string // the character between the brackets of DateSep=[/]
	TimeFmt    string // HMS, ISO, USA, EUR, JIS
	TimeSep    string
	DecimalSep string
}

// Request is one Data Transfer request file.
type Request struct {
	Direction Direction
	Version   string
	// [HostInfo]
	HostName     string
	HostFile     string // LIB/FILE or LIB/FILE(MEMBER)
	HostFileType int
	RecLen       int
	CrtOpt       int
	FileText     string
	MbrText      string
	Database     string // *SYSBAS or an IASP name
	// [ClientInfo]
	ClientFile     string
	ClientFileType int
	FileEncoding   string // e.g. windows-1252, UTF-8
	UseFDF         bool
	FDFFile        string
	// [SQL] of a download (ACS keys Select / Where / OrderBy ...), empty for uploads.
	SQL map[string]string
	// [Properties]
	Properties map[string]string
	Options    Options
	// Every section as read, for keys this package does not model.
	Sections map[string]map[string]string
}

// Library, File and Member split HostFile; Member is empty when the file has none.
func (r *Request) Library() string { lib, _, _ := splitHostFile(r.HostFile); return lib }
func (r *Request) File() string    { _, f, _ := splitHostFile(r.HostFile); return f }
func (r *Request) Member() string  { _, _, m := splitHostFile(r.HostFile); return m }

func splitHostFile(s string) (lib, file, member string) {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '('); i >= 0 && strings.HasSuffix(s, ")") {
		member = s[i+1 : len(s)-1]
		s = s[:i]
	}
	lib, file, ok := strings.Cut(s, "/")
	if !ok {
		return "", s, member
	}
	return lib, file, member
}

// ParseRequest reads a .dttx or .dtfx file.
func ParseRequest(text string) (*Request, error) {
	sections, order := parseINI(text)
	if len(order) == 0 {
		return nil, errors.New("not a Data Transfer request: no sections")
	}
	r := &Request{Sections: sections, SQL: map[string]string{}, Properties: map[string]string{}}
	switch strings.ToLower(order[0]) {
	case "datatransferto":
		r.Direction = Upload
	case "datatransferfrom":
		r.Direction = Download
	default:
		return nil, fmt.Errorf("not a Data Transfer request: first section is [%s]", order[0])
	}
	r.Version = get(sections, order[0], "DataTransferVersion")
	h := "HostInfo"
	r.HostName = get(sections, h, "HostName")
	r.HostFile = get(sections, h, "HostFile")
	r.HostFileType = atoi(get(sections, h, "HostFileType"))
	r.RecLen = atoi(get(sections, h, "RecLen"))
	r.CrtOpt = atoi(get(sections, h, "CrtOpt"))
	r.FileText = get(sections, h, "FileText")
	r.MbrText = get(sections, h, "MbrText")
	r.Database = get(sections, h, "Database")
	c := "ClientInfo"
	r.ClientFile = get(sections, c, "ClientFile")
	r.ClientFileType = atoi(get(sections, c, "ClientFileType"))
	r.FileEncoding = get(sections, c, "FileEncoding")
	r.UseFDF = get(sections, c, "UseFDF") == "1"
	r.FDFFile = get(sections, c, "FDFFile")
	for k, v := range sections["sql"] {
		r.SQL[k] = v
	}
	for k, v := range sections["properties"] {
		r.Properties[k] = v
	}
	o := "Options"
	r.Options = Options{
		DateFmt:    get(sections, o, "DateFmt"),
		DateSep:    unbracket(get(sections, o, "DateSep")),
		TimeFmt:    get(sections, o, "TimeFmt"),
		TimeSep:    unbracket(get(sections, o, "TimeSep")),
		DecimalSep: unbracket(get(sections, o, "DecimalSep")),
	}
	if r.HostFile == "" {
		return nil, errors.New("the request has no HostFile")
	}
	return r, nil
}

// Write renders the request in ACS's layout (CRLF, the sections ACS writes).
func (r *Request) Write() string {
	var b strings.Builder
	line := func(s string) { b.WriteString(s); b.WriteString("\r\n") }
	kv := func(k, v string) { line(k + "=" + v) }
	if r.Direction == Upload {
		line("[DataTransferTo]")
	} else {
		line("[DataTransferFrom]")
	}
	kv("DataTransferVersion", orDefault(r.Version, "1.0"))
	line("[HostInfo]")
	kv("HostName", r.HostName)
	kv("HostFile", r.HostFile)
	if r.Direction == Upload {
		kv("FRFFile", "")
		kv("CrtOpt", strconv.Itoa(r.CrtOpt))
	}
	kv("HostFileType", strconv.Itoa(orInt(r.HostFileType, HostFileDatabase)))
	if r.Direction == Upload {
		kv("ObjAuth", "0")
		kv("RecLen", strconv.Itoa(r.RecLen))
		kv("FileText", r.FileText)
		kv("MbrText", r.MbrText)
	}
	kv("Database", orDefault(r.Database, "*SYSBAS"))
	if r.Direction == Download && len(r.SQL) > 0 {
		line("[SQL]")
		for _, k := range sortedKeys(r.SQL) {
			kv(k, r.SQL[k])
		}
	}
	line("[ClientInfo]")
	kv("ClientFile", r.ClientFile)
	if r.Direction == Upload {
		kv("UseFDF", boolStr(r.UseFDF))
	}
	kv("ClientFileType", strconv.Itoa(orInt(r.ClientFileType, FileTypeCSV)))
	if r.Direction == Upload {
		kv("InputDevice", "2")
	}
	kv("FileEncoding", orDefault(r.FileEncoding, "UTF-8"))
	kv("FDFFile", r.FDFFile)
	line("[Properties]")
	props := r.Properties
	if len(props) == 0 {
		props = map[string]string{"Convert65535": "1", "ShowWarnings": "1", "UseSSL": "2", "UseCompression": "1", "AutoRun": "0", "AutoClose": "0"}
	}
	for _, k := range sortedKeys(props) {
		kv(k, props[k])
	}
	line("[Options]")
	kv("DateFmt", orDefault(r.Options.DateFmt, "ISO"))
	kv("DateSep", "["+orDefault(r.Options.DateSep, "-")+"]")
	kv("TimeFmt", orDefault(r.Options.TimeFmt, "ISO"))
	kv("TimeSep", "["+orDefault(r.Options.TimeSep, ":")+"]")
	kv("DecimalSep", orDefault(r.Options.DecimalSep, "."))
	return b.String()
}

// FDFField is one column of the PC file.
type FDFField struct {
	Name   string
	Type   int // ACS field type number (1 = character; numbers as ACS writes them)
	Length int
	Scale  int
}

// FDF is a .fdfx field description.
type FDF struct {
	FileType int
	Encoding string
	Version  string
	Options  map[string]string
	Fields   []FDFField
}

// ParseFDF reads a .fdfx file.
func ParseFDF(text string) (*FDF, error) {
	sections, order := parseINI(text)
	if len(order) == 0 || strings.ToLower(order[0]) != "data transfer file description" {
		return nil, errors.New("not a Data Transfer field description")
	}
	head := order[0]
	f := &FDF{
		FileType: atoi(get(sections, head, "FileType")),
		Encoding: get(sections, head, "ClientFileEncoding"),
		Version:  get(sections, head, "DataTransferVersion"),
		Options:  map[string]string{},
	}
	for k, v := range sections["options"] {
		f.Options[k] = v
	}
	count := atoi(get(sections, head, "FieldCount"))
	for i := 1; i <= count; i++ {
		sec := fmt.Sprintf("F%04d", i)
		if _, ok := sections[strings.ToLower(sec)]; !ok {
			return nil, fmt.Errorf("field description %d of %d is missing", i, count)
		}
		f.Fields = append(f.Fields, FDFField{
			Name:   get(sections, sec, "Name"),
			Type:   atoi(get(sections, sec, "Type")),
			Length: atoi(get(sections, sec, "Length")),
			Scale:  atoi(get(sections, sec, "Scale")),
		})
	}
	return f, nil
}

// Write renders the field description in ACS's layout.
func (f *FDF) Write() string {
	var b strings.Builder
	line := func(s string) { b.WriteString(s); b.WriteString("\r\n") }
	line("[Data Transfer File Description]")
	line("FieldCount=" + strconv.Itoa(len(f.Fields)))
	line("FileType=" + strconv.Itoa(orInt(f.FileType, FileTypeCSV)))
	line("ClientFileEncoding=" + orDefault(f.Encoding, "UTF-8"))
	line("DataTransferVersion=" + orDefault(f.Version, "1.0"))
	line("[Options]")
	opts := f.Options
	if len(opts) == 0 {
		opts = map[string]string{"DateFormat": "1", "DateSep": "1", "DcmlSep": "1", "TimeFormat": "1", "TimeSep": "1"}
	}
	for _, k := range sortedKeys(opts) {
		line(k + "=" + opts[k])
	}
	for i, fld := range f.Fields {
		line(fmt.Sprintf("[F%04d]", i+1))
		line("Length=" + strconv.Itoa(fld.Length))
		line("Name=" + fld.Name)
		line("Type=" + strconv.Itoa(fld.Type))
		if fld.Scale != 0 {
			line("Scale=" + strconv.Itoa(fld.Scale))
		}
	}
	return b.String()
}

// parseINI returns sections (lower-cased names) and the section order as written.
// Values keep their case and inner spaces; keys are matched case-insensitively by get().
func parseINI(text string) (map[string]map[string]string, []string) {
	sections := map[string]map[string]string{}
	var order []string
	current := ""
	sc := bufio.NewScanner(strings.NewReader(strings.TrimPrefix(text, "\xEF\xBB\xBF")))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			name := line[1 : len(line)-1]
			current = strings.ToLower(name)
			if _, ok := sections[current]; !ok {
				sections[current] = map[string]string{}
				order = append(order, name)
			}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || current == "" {
			continue
		}
		sections[current][strings.ToLower(strings.TrimSpace(k))] = strings.TrimSpace(v)
	}
	return sections, order
}

func get(sections map[string]map[string]string, section, key string) string {
	return sections[strings.ToLower(section)][strings.ToLower(key)]
}

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

func unbracket(s string) string {
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") && len(s) >= 2 {
		return s[1 : len(s)-1]
	}
	return s
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func orInt(n, d int) int {
	if n == 0 {
		return d
	}
	return n
}

func boolStr(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
