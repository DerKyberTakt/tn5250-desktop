package hostserver

import (
	"encoding/hex"
	"testing"
)

// Vectors recorded from IBM's own client (the JTOpen toolbox) signing on to a fake
// server (cmd/hsrecord) with made-up profiles; server seed 0123456789ABCDEF.
var vectors = []struct {
	name       string
	level      byte
	user, pass string
	clientSeed string
	scheme     byte
	want       string
}{
	{"DES short user and password", 1, "TESTUSER", "SECRET1", "000001a15544392e", authSchemeDES, "db4ad627c64bb192"},
	{"DES 10-character user and password", 1, "TESTUSER10", "PASSWORD10", "000001a1554446c5", authSchemeDES, "6af9fc1738f134d5"},
	{"SHA-1 mixed case", 2, "TESTUSER", "Secret-Pw1", "000001a155444d53", authSchemeSHA1, "2f45faf4688d826b4d7b71d57d7ab3d1b140f052"},
	{"SHA-1 long pass phrase, 10-character user", 3, "LONGUSER10", "A longer pass phrase 9", "000001a1554453e2", authSchemeSHA1, "9b388a26100f5318420772b79da90002573f9141"},
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSubstituteMatchesIBMClient(t *testing.T) {
	serverSeed := mustHex(t, "0123456789abcdef")
	for _, v := range vectors {
		t.Run(v.name, func(t *testing.T) {
			scheme, auth, err := Substitute(v.level, v.user, v.pass, mustHex(t, v.clientSeed), serverSeed)
			if err != nil {
				t.Fatal(err)
			}
			if scheme != v.scheme {
				t.Fatalf("scheme %d, want %d", scheme, v.scheme)
			}
			if got := hex.EncodeToString(auth); got != v.want {
				t.Fatalf("substitute %s, want %s", got, v.want)
			}
		})
	}
}

func TestDESPasswordRules(t *testing.T) {
	if _, err := DESPassword("ELEVENCHARS"); err == nil {
		t.Fatal("11 characters must be rejected at QPWDLVL 0/1")
	}
	p, err := DESPassword("1abc")
	if err != nil {
		t.Fatal(err)
	}
	// A leading digit gets a Q, and the password is upper-cased: "Q1ABC" in CCSID 37, blank padded.
	if got := hex.EncodeToString(p); got != "d8f1c1c2c34040404040" {
		t.Fatalf("got %s", got)
	}
}

func TestLevel4NotSupportedYet(t *testing.T) {
	if _, _, err := Substitute(4, "TESTUSER", "x", make([]byte, 8), make([]byte, 8)); err == nil {
		t.Fatal("QPWDLVL 4 should report that it is not supported")
	}
}
