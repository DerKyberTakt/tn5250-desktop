package db

import (
	"encoding/binary"
	"testing"
)

// header builds the 20-byte start of an extended data reply.
func rowsHeader(rows uint32, cols, ind uint16, rowSize uint32) []byte {
	d := make([]byte, 20)
	binary.BigEndian.PutUint32(d[4:], rows)
	binary.BigEndian.PutUint16(d[8:], cols)
	binary.BigEndian.PutUint16(d[10:], ind)
	binary.BigEndian.PutUint32(d[16:], rowSize)
	return d
}

// A host-supplied row count must not size an allocation (audit d3-1): these used to
// allocate gigabytes or loop for ever on a reply of a few dozen bytes.
func TestDecodeRowsRejectsHostileCounts(t *testing.T) {
	two := &dataFormat{fields: []field{{code: typeChar, length: 0}, {code: typeChar, length: 0}}}
	cases := map[string]struct {
		f *dataFormat
		d []byte
	}{
		"no columns, huge count":       {&dataFormat{}, rowsHeader(4294967295, 0, 0, 0)},
		"huge count, row size 0":       {two, rowsHeader(4294967295, 2, 2, 0)},
		"huge count, tiny data":        {two, rowsHeader(4294967295, 2, 2, 8)},
		"count over the limit":         {two, append(rowsHeader(1<<21, 2, 0, 1), make([]byte, 1<<22)...)},
		"overflowing indicator size":   {two, rowsHeader(4294967295, 2, 65535, 1)},
		"zero-length columns, no data": {two, rowsHeader(1<<20, 2, 0, 1)},
		"fields larger than the row":   {&dataFormat{fields: []field{{code: typeChar, length: 10}}}, append(rowsHeader(1, 1, 0, 4), make([]byte, 4)...)},
	}
	for name, c := range cases {
		rows, err := c.f.decodeRows(c.d, 37)
		if err == nil {
			t.Errorf("%s: expected an error, got %d rows", name, len(rows))
		}
	}
}

func TestDecodeRowsStillDecodes(t *testing.T) {
	f := &dataFormat{fields: []field{{code: typeChar, length: 2, ccsid: 37}}}
	d := append(rowsHeader(2, 1, 2, 2), 0, 0, 0, 0)
	d = append(d, 0xC1, 0xC2, 0xC3, 0xC4) // "AB", "CD" in EBCDIC 37
	rows, err := f.decodeRows(d, 37)
	if err != nil || len(rows) != 2 || *rows[0][0] != "AB" || *rows[1][0] != "CD" {
		t.Fatalf("rows = %v, err = %v", rows, err)
	}
}
