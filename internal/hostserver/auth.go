package hostserver

import (
	"crypto/des"
	"crypto/sha1"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/encoding/charmap"
)

// Request/reply ids of the authentication datastreams.
const (
	reqExchangeSeed uint16 = 0x7001
	reqStartServer  uint16 = 0x7002
)

// Code points of the start-server request/reply.
const (
	cpUserID       uint16 = 0x1104
	cpPassword     uint16 = 0x1105
	cpJobName      uint16 = 0x111F
	authSchemeDES         = 0x01
	authSchemeSHA1        = 0x03
)

var cp037 = charmap.CodePage037

// ebcdic37 encodes s in CCSID 37, padded with EBCDIC blanks (0x40) to n bytes.
func ebcdic37(s string, n int) ([]byte, error) {
	enc, err := cp037.NewEncoder().Bytes([]byte(s))
	if err != nil {
		return nil, fmt.Errorf("characters not valid in a user profile or password: %q", s)
	}
	if len(enc) > n {
		return nil, fmt.Errorf("%q is longer than %d characters", s, n)
	}
	out := make([]byte, n)
	for i := range out {
		out[i] = 0x40
	}
	copy(out, enc)
	return out, nil
}

// UserIDBytes is the user profile as sent on the wire: upper case, CCSID 37, blank padded to 10.
func UserIDBytes(user string) ([]byte, error) {
	u := strings.ToUpper(strings.TrimSpace(user))
	if u == "" {
		return nil, errors.New("no user profile given")
	}
	return ebcdic37(u, 10)
}

func utf16be(s []rune) []byte {
	units := utf16.Encode(s)
	out := make([]byte, 2*len(units))
	for i, u := range units {
		out[2*i] = byte(u >> 8)
		out[2*i+1] = byte(u)
	}
	return out
}

func desEncrypt(key, block []byte) []byte {
	c, err := des.NewCipher(key)
	if err != nil {
		panic(err) // the key is always 8 bytes
	}
	out := make([]byte, 8)
	c.Encrypt(out, block)
	return out
}

func xor8(a, b []byte) []byte {
	out := make([]byte, 8)
	for i := 0; i < 8; i++ {
		out[i] = a[i] ^ b[i]
	}
	return out
}

func add8(a, b []byte) []byte {
	out := make([]byte, 8)
	carry := 0
	for i := 7; i >= 0; i-- {
		t := int(a[i]) + int(b[i]) + carry
		carry = t >> 8
		out[i] = byte(t)
	}
	return out
}

func ebcdicLen(b []byte) int {
	n := 0
	for n < len(b) && b[n] != 0x40 && b[n] != 0 {
		n++
	}
	return n
}

// shiftKey XORs the 8-byte block with 0x55 and shifts the whole 64-bit value left by one bit.
func shiftKey(b []byte) []byte {
	k := make([]byte, 8)
	for i := 0; i < 8; i++ {
		k[i] = b[i] ^ 0x55
	}
	out := make([]byte, 8)
	for i := 0; i < 7; i++ {
		out[i] = k[i]<<1 | k[i+1]>>7
	}
	out[7] = k[7] << 1
	return out
}

var sequenceOne = []byte{0, 0, 0, 0, 0, 0, 0, 1}

// desToken derives the password token (QPWDLVL 0/1) from the EBCDIC user ID and password (10 bytes each).
func desToken(userID, password []byte) []byte {
	id := append([]byte(nil), userID[:10]...)
	if ebcdicLen(userID) > 8 {
		// Fold the 9th and 10th characters into the first eight.
		id[0] ^= id[8] & 0xC0
		id[1] ^= (id[8] & 0x30) << 2
		id[2] ^= (id[8] & 0x0C) << 4
		id[3] ^= (id[8] & 0x03) << 6
		id[4] ^= id[9] & 0xC0
		id[5] ^= (id[9] & 0x30) << 2
		id[6] ^= (id[9] & 0x0C) << 4
		id[7] ^= (id[9] & 0x03) << 6
	}
	pw := ebcdicLen(password)
	blank := func() []byte { return []byte{0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40} }
	if pw > 8 {
		first, second := blank(), blank()
		copy(first, password[:8])
		copy(second, password[8:pw])
		return xor8(desEncrypt(shiftKey(first), id[:8]), desEncrypt(shiftKey(second), id[:8]))
	}
	first := blank()
	copy(first, password[:pw])
	return desEncrypt(shiftKey(first), id[:8])
}

// desSubstitute is the 8-byte password substitute for QPWDLVL 0/1.
func desSubstitute(userID, token, clientSeed, serverSeed []byte) []byte {
	rdrSeq := add8(sequenceOne, serverSeed)
	verifier := desEncrypt(token, xor8(desEncrypt(token, rdrSeq), clientSeed))
	e3 := desEncrypt(token, xor8(xor8(userID[:8], rdrSeq), verifier))
	tail := []byte{userID[8], userID[9], 0x40, 0x40, 0x40, 0x40, 0x40, 0x40}
	e4 := desEncrypt(token, xor8(xor8(rdrSeq, tail), e3))
	return desEncrypt(token, xor8(sequenceOne, e4))
}

// DESPassword prepares a QPWDLVL 0/1 password: a leading digit gets a "Q", upper case, at most 10 characters.
func DESPassword(password string) ([]byte, error) {
	if password != "" && password[0] >= '0' && password[0] <= '9' {
		password = "Q" + password
	}
	if len(password) > 10 {
		return nil, errors.New("this system allows passwords of at most 10 characters (QPWDLVL 0 or 1)")
	}
	return ebcdic37(strings.ToUpper(password), 10)
}

// shaUserID is the user ID as SHA-1 input: the 10 blank-padded characters as UTF-16BE.
func shaUserID(userID []byte) ([]byte, error) {
	s, err := cp037.NewDecoder().Bytes(userID)
	if err != nil {
		return nil, err
	}
	return utf16be([]rune(string(s))), nil
}

// shaSubstitute is the 20-byte password substitute for QPWDLVL 2/3.
func shaSubstitute(userID []byte, password string, clientSeed, serverSeed []byte) ([]byte, error) {
	if password == "" || password[0] == '*' {
		return nil, errors.New("the password is empty or starts with *")
	}
	pw := []rune(strings.TrimRightFunc(password, func(r rune) bool { return r == 0 || r == ' ' || r == '　' }))
	uid, err := shaUserID(userID)
	if err != nil {
		return nil, err
	}
	h := sha1.New()
	h.Write(uid)
	h.Write(utf16be(pw))
	token := h.Sum(nil)
	h = sha1.New()
	h.Write(token)
	h.Write(serverSeed)
	h.Write(clientSeed)
	h.Write(uid)
	h.Write(sequenceOne)
	return h.Sum(nil), nil
}

// Substitute builds the authentication bytes and scheme byte for the password level the server announced.
func Substitute(level byte, user, password string, clientSeed, serverSeed []byte) (scheme byte, auth []byte, err error) {
	uid, err := UserIDBytes(user)
	if err != nil {
		return 0, nil, err
	}
	switch {
	case level < 2:
		pw, err := DESPassword(password)
		if err != nil {
			return 0, nil, err
		}
		return authSchemeDES, desSubstitute(uid, desToken(uid, pw), clientSeed, serverSeed), nil
	case level < 4:
		sub, err := shaSubstitute(uid, password, clientSeed, serverSeed)
		return authSchemeSHA1, sub, err
	default:
		return 0, nil, fmt.Errorf("password level %d (QPWDLVL 4) is not supported yet", level)
	}
}
