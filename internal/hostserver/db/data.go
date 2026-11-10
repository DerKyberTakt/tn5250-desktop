package db

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/encoding/charmap"
)

// decodeRows reads extended result data (CP 0x380E, JTOpen DBExtendedData): row count
// u32 at 4, column count u16 at 8, indicator size u16 at 10, row size u32 at 16;
// the null indicators (i16 per row and column, row-major, -1 = NULL, -2 = mapping
// error) at 20; then the rows, each a fixed slot per field in format order.
func (f *dataFormat) decodeRows(d []byte, jobCCSID uint16) ([][]*string, error) {
	if len(d) < 20 {
		return nil, nil
	}
	rowCount := int(binary.BigEndian.Uint32(d[4:]))
	colCount := int(binary.BigEndian.Uint16(d[8:]))
	indSize := int(binary.BigEndian.Uint16(d[10:]))
	rowSize := int(binary.BigEndian.Uint32(d[16:]))
	if rowCount == 0 {
		return nil, nil
	}
	if colCount != len(f.fields) {
		return nil, fmt.Errorf("result data has %d columns, the format %d", colCount, len(f.fields))
	}
	indicators := 20
	data := indicators + rowCount*colCount*indSize
	if data+rowCount*rowSize > len(d) || rowSize < 0 {
		return nil, fmt.Errorf("result data of %d bytes is short for %d rows of %d bytes", len(d), rowCount, rowSize)
	}
	out := make([][]*string, 0, rowCount)
	for r := 0; r < rowCount; r++ {
		row := make([]*string, colCount)
		base := data + r*rowSize
		off := base
		for c, fld := range f.fields {
			null := false
			if indSize == 2 {
				ind := int16(binary.BigEndian.Uint16(d[indicators+(r*colCount+c)*2:]))
				null = ind < 0
			}
			end := off + int(fld.length)
			if end > base+rowSize || end > len(d) {
				return nil, fmt.Errorf("field %d runs past its row", c+1)
			}
			if !null {
				s := decodeField(fld, d[off:end], jobCCSID)
				row[c] = &s
			}
			off = end
		}
		out = append(out, row)
	}
	return out, nil
}

// decodeField turns one field's slot into text (JTOpen's SQLData classes).
func decodeField(f field, b []byte, job uint16) string {
	switch f.code &^ 1 {
	case typeChar:
		if f.ccsid == 65535 {
			return hexText(b)
		}
		return strings.TrimRight(decodeText(b, f.ccsid, job), " ")
	case typeVarchar, typeLongVarchar, typeDatalink:
		v := varSlice(b, 1)
		if f.ccsid == 65535 {
			return hexText(v)
		}
		return decodeText(v, f.ccsid, job)
	case typeGraphic:
		return strings.TrimRight(decodeGraphic(b, f.ccsid), " ")
	case typeVargraphic, typeLongVargraphc:
		return decodeGraphic(varSlice(b, 2), f.ccsid)
	case typeDate, typeTime, typeTimestamp:
		return strings.TrimRight(decodeText(b, ebcdicCCSID, job), " ")
	case typeDecimal:
		return packedDecimal(b, int(f.precision), int(f.scale))
	case typeNumeric:
		return zonedDecimal(b, int(f.scale))
	case typeSmallint:
		if len(b) >= 2 {
			return scaled(int64(int16(binary.BigEndian.Uint16(b))), int(f.scale))
		}
	case typeInteger:
		if len(b) >= 4 {
			return scaled(int64(int32(binary.BigEndian.Uint32(b))), int(f.scale))
		}
	case typeBigint:
		if len(b) >= 8 {
			return strconv.FormatInt(int64(binary.BigEndian.Uint64(b)), 10)
		}
	case typeFloat:
		switch len(b) {
		case 4:
			return strconv.FormatFloat(float64(math.Float32frombits(binary.BigEndian.Uint32(b))), 'g', -1, 32)
		case 8:
			return strconv.FormatFloat(math.Float64frombits(binary.BigEndian.Uint64(b)), 'g', -1, 64)
		}
	case typeBoolean:
		if len(b) >= 1 && b[0] == 0xF0 {
			return "false"
		}
		return "true"
	case typeBinary, typeRowID:
		return hexText(b)
	case typeVarbinary:
		return hexText(varSlice(b, 1))
	case typeBlob:
		return hexText(lobSlice(b))
	case typeClob:
		return decodeText(lobSlice(b), f.ccsid, job)
	case typeDBClob:
		return decodeGraphic(lobSlice(b), f.ccsid)
	case typeBlobLocator, typeClobLocator, typeDBClobLocator, typeXML, typeXMLLocator:
		return "<large object>"
	case typeDecfloat:
		return "0x" + hexText(b)
	}
	return hexText(b)
}

// varSlice is the payload of a variable-length slot: a 2-byte count (bytes, or
// characters times unit), then the data.
func varSlice(b []byte, unit int) []byte {
	if len(b) < 2 {
		return nil
	}
	n := int(binary.BigEndian.Uint16(b)) * unit
	if n > len(b)-2 {
		n = len(b) - 2
	}
	return b[2 : 2+n]
}

// lobSlice is an inline LOB: a 4-byte length, then the data.
func lobSlice(b []byte) []byte {
	if len(b) < 4 {
		return nil
	}
	n := int(binary.BigEndian.Uint32(b))
	if n > len(b)-4 {
		n = len(b) - 4
	}
	return b[4 : 4+n]
}

func hexText(b []byte) string { return strings.ToUpper(hex.EncodeToString(b)) }

// packedDecimal decodes IBM packed decimal: two digits per byte, the sign in the low
// nibble of the last byte (0xB and 0xD negative; 0xA, 0xC, 0xE, 0xF positive).
func packedDecimal(b []byte, precision, scale int) string {
	if len(b) == 0 {
		return ""
	}
	var digits strings.Builder
	for i, by := range b {
		digits.WriteByte('0' + (by >> 4))
		if i < len(b)-1 {
			digits.WriteByte('0' + (by & 0x0F))
		}
	}
	sign := b[len(b)-1] & 0x0F
	s := digits.String()
	if precision > 0 && len(s) > precision {
		s = s[len(s)-precision:]
	}
	return withScale(s, sign == 0x0B || sign == 0x0D, scale)
}

// zonedDecimal decodes zoned decimal: one digit per byte in the low nibble, the sign
// in the high nibble of the last byte (0xB and 0xD negative).
func zonedDecimal(b []byte, scale int) string {
	if len(b) == 0 {
		return ""
	}
	var digits strings.Builder
	for _, by := range b {
		digits.WriteByte('0' + (by & 0x0F))
	}
	sign := b[len(b)-1] >> 4
	return withScale(digits.String(), sign == 0x0B || sign == 0x0D, scale)
}

// scaled formats an integer that carries an implied scale (SMALLINT/INTEGER with
// scale > 0, which the host uses for some zoned columns).
func scaled(v int64, scale int) string {
	if scale <= 0 {
		return strconv.FormatInt(v, 10)
	}
	neg := v < 0
	if neg {
		v = -v
	}
	return withScale(strconv.FormatInt(v, 10), neg, scale)
}

// withScale places the decimal point in a digit string and trims leading zeros.
func withScale(digits string, neg bool, scale int) string {
	for len(digits) <= scale {
		digits = "0" + digits
	}
	intPart, frac := digits[:len(digits)-scale], digits[len(digits)-scale:]
	intPart = strings.TrimLeft(intPart, "0")
	if intPart == "" {
		intPart = "0"
	}
	s := intPart
	if scale > 0 {
		s += "." + frac
	}
	if neg && strings.Trim(digits, "0") != "" {
		s = "-" + s
	}
	return s
}

// decodeGraphic decodes double-byte text: UCS-2 / UTF-16 for 13488, 1200 and 17584;
// other DBCS code pages are shown as hex (no tables for them here).
func decodeGraphic(b []byte, ccsid uint16) string {
	switch ccsid {
	case 1200, 13488, 17584, 1208:
		return decodeText(b, ccsid, ccsid)
	}
	return hexText(b)
}

// decodeText converts host text to a Go string by CCSID. 0, 1 and 65535 mean "the
// job's CCSID" (65535 data is passed through CCSID 37 the way a 5250 shows it).
// Single-byte EBCDIC pages use the 037 table unless Go has the exact one (1047,
// 1140); the other Latin pages differ from 037 only in a few symbols.
func decodeText(b []byte, ccsid, job uint16) string {
	if ccsid == 0 || ccsid == 1 || ccsid == 65535 {
		ccsid = job
	}
	switch ccsid {
	case 1200, 13488, 17584:
		u := make([]uint16, 0, len(b)/2)
		for i := 0; i+1 < len(b); i += 2 {
			u = append(u, binary.BigEndian.Uint16(b[i:]))
		}
		return string(utf16.Decode(u))
	case 1208:
		return string(b)
	case 819:
		out, _ := charmap.ISO8859_1.NewDecoder().Bytes(b)
		return string(out)
	case 1252:
		out, _ := charmap.Windows1252.NewDecoder().Bytes(b)
		return string(out)
	case 1047:
		out, _ := charmap.CodePage1047.NewDecoder().Bytes(b)
		return string(out)
	case 1140:
		out, _ := charmap.CodePage1140.NewDecoder().Bytes(b)
		return string(out)
	}
	out, err := charmap.CodePage037.NewDecoder().Bytes(b)
	if err != nil {
		return hexText(b)
	}
	return string(out)
}
