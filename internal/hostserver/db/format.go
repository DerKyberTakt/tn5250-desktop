package db

import (
	"encoding/binary"
	"fmt"
	"strings"
)

// SQL type codes of the data format (JTOpen SQLDataFactory / SQLNativeType), with the
// low bit (nullable) masked off.
const (
	typeDate          = 384
	typeTime          = 388
	typeTimestamp     = 392
	typeDatalink      = 396
	typeBlob          = 404
	typeClob          = 408
	typeDBClob        = 412
	typeVarchar       = 448
	typeChar          = 452
	typeLongVarchar   = 456
	typeVargraphic    = 464
	typeGraphic       = 468
	typeLongVargraphc = 472
	typeFloat         = 480
	typeDecimal       = 484 // packed
	typeNumeric       = 488 // zoned
	typeBigint        = 492
	typeInteger       = 496
	typeSmallint      = 500
	typeRowID         = 904
	typeVarbinary     = 908
	typeBinary        = 912
	typeBlobLocator   = 960
	typeClobLocator   = 964
	typeDBClobLocator = 968
	typeXML           = 988
	typeDecfloat      = 996
	typeBoolean       = 2436
	typeXMLLocator    = 2452
)

// Column describes one result column the way the host reported it.
type Column struct {
	Name     string
	Type     string // CHAR, VARCHAR, DECIMAL, INTEGER, DATE ...
	Code     uint16 // the SQL type code, nullable bit off
	Length   int    // characters for text, digits (precision) for numbers
	Scale    int
	CCSID    uint16
	Nullable bool
}

// field is one entry of the data format: how its bytes sit in a row.
type field struct {
	code      uint16 // type with the nullable bit
	length    uint32 // slot size in bytes
	scale     uint16
	precision uint16
	ccsid     uint16
	name      string
}

type dataFormat struct {
	fields     []field
	recordSize uint32
}

// parseFormat reads a super-extended (CP 0x3812) or extended (CP 0x380C) data format
// (JTOpen DBSuperExtendedDataFormat / DBExtendedDataFormat). Both start with a
// 16-byte header: consistency token, field count u32 at 4, record size u32 at 12.
// Super-extended descriptors are 48 bytes (type u16 at +2, length u32 at +4, scale
// u16 at +8, precision u16 at +10, CCSID u16 at +12, offset/length of the variable
// part at +32/+36; the name is item CP 0x3840 of that part: CCSID u16 + text).
// Extended descriptors are 64 bytes with the name inline (length u16 at +30, CCSID
// u16 at +32, text at +34).
func parseFormat(cp uint16, d []byte, jobCCSID uint16) (*dataFormat, error) {
	if len(d) < 16 {
		return nil, fmt.Errorf("data format of %d bytes", len(d))
	}
	count := int(binary.BigEndian.Uint32(d[4:]))
	f := &dataFormat{recordSize: binary.BigEndian.Uint32(d[12:])}
	stride := 48
	if cp == repExtFormat {
		stride = 64
	}
	if count < 0 || count > 8000 || 16+count*stride > len(d) {
		return nil, fmt.Errorf("data format: %d fields in %d bytes", count, len(d))
	}
	for i := 0; i < count; i++ {
		base := 16 + i*stride
		desc := d[base:]
		fld := field{
			code:      binary.BigEndian.Uint16(desc[2:]),
			length:    binary.BigEndian.Uint32(desc[4:]),
			scale:     binary.BigEndian.Uint16(desc[8:]),
			precision: binary.BigEndian.Uint16(desc[10:]),
			ccsid:     binary.BigEndian.Uint16(desc[12:]),
		}
		switch cp {
		case repExtFormat:
			n := int(binary.BigEndian.Uint16(desc[30:]))
			nameCCSID := binary.BigEndian.Uint16(desc[32:])
			if n > 30 {
				n = 30
			}
			if 34+n <= len(desc) {
				fld.name = strings.TrimRight(decodeText(desc[34:34+n], nameCCSID, jobCCSID), " \x00")
			}
		default:
			off := int(binary.BigEndian.Uint32(desc[32:]))
			n := int(binary.BigEndian.Uint32(desc[36:]))
			if off > 0 && n > 0 && base+off+n <= len(d) {
				fld.name = formatName(d[base+off:base+off+n], jobCCSID)
			}
		}
		if fld.name == "" {
			fld.name = fmt.Sprintf("COL%d", i+1)
		}
		f.fields = append(f.fields, fld)
	}
	return f, nil
}

// formatName walks the variable part of a super-extended descriptor: LL/CP items,
// 0x3840 = column name (CCSID u16, then the text).
func formatName(v []byte, jobCCSID uint16) string {
	for len(v) >= 6 {
		ll := int(binary.BigEndian.Uint32(v))
		cp := binary.BigEndian.Uint16(v[4:])
		if ll < 6 || ll > len(v) {
			break
		}
		if cp == 0x3840 && ll >= 8 {
			return strings.TrimRight(decodeText(v[8:ll], binary.BigEndian.Uint16(v[6:]), jobCCSID), " \x00")
		}
		v = v[ll:]
	}
	return ""
}

// columns is the page-facing description of the fields.
func (f *dataFormat) columns() []Column {
	out := make([]Column, 0, len(f.fields))
	for _, fld := range f.fields {
		code := fld.code &^ 1
		c := Column{Name: fld.name, Code: code, Nullable: fld.code&1 == 1, CCSID: fld.ccsid, Scale: int(fld.scale)}
		c.Type, c.Length = typeName(code, fld)
		out = append(out, c)
	}
	return out
}

// typeName gives the SQL type and its display length for a field.
func typeName(code uint16, f field) (string, int) {
	l := int(f.length)
	switch code {
	case typeDate:
		return "DATE", l
	case typeTime:
		return "TIME", l
	case typeTimestamp:
		return "TIMESTAMP", l
	case typeChar:
		if f.ccsid == 65535 {
			return "CHAR FOR BIT DATA", l
		}
		return "CHAR", l
	case typeVarchar, typeLongVarchar:
		if f.ccsid == 65535 {
			return "VARCHAR FOR BIT DATA", l - 2
		}
		return "VARCHAR", l - 2
	case typeGraphic:
		return "GRAPHIC", l / 2
	case typeVargraphic, typeLongVargraphc:
		return "VARGRAPHIC", (l - 2) / 2
	case typeDecimal:
		return "DECIMAL", int(f.precision)
	case typeNumeric:
		return "NUMERIC", int(f.precision)
	case typeInteger:
		return "INTEGER", 10
	case typeSmallint:
		return "SMALLINT", 5
	case typeBigint:
		return "BIGINT", 19
	case typeFloat:
		if l == 4 {
			return "REAL", 7
		}
		return "DOUBLE", 15
	case typeDecfloat:
		if l == 8 {
			return "DECFLOAT", 16
		}
		return "DECFLOAT", 34
	case typeBinary:
		return "BINARY", l
	case typeVarbinary:
		return "VARBINARY", l - 2
	case typeRowID:
		return "ROWID", l
	case typeBlob, typeBlobLocator:
		return "BLOB", l
	case typeClob, typeClobLocator:
		return "CLOB", l
	case typeDBClob, typeDBClobLocator:
		return "DBCLOB", l
	case typeXML, typeXMLLocator:
		return "XML", l
	case typeDatalink:
		return "DATALINK", l - 2
	case typeBoolean:
		return "BOOLEAN", 1
	}
	return fmt.Sprintf("TYPE %d", code), l
}
