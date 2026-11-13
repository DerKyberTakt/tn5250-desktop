import { describe, expect, it } from 'vitest';
import { ENCODINGS, HEX, bomCcsid, keepBom, decodeIfs, ebcdicLineEnd, encodeIfs, encodingLabel, fromBase64, guessCcsid, hexDump, isBinary, toBase64 } from '../../src/desktop/ifsText';

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

describe('IFS text codec', () => {
  it('decodes EBCDIC 37 with NL as the line end and tabs, and encodes it back the same way', () => {
    const raw = bytes(0xc8, 0xc9, 0x40, 0xa3, 0x88, 0x85, 0x99, 0x85, 0x15, 0x05, 0xf1, 0xf2, 0x15); // "HI there\n\t12\n"
    expect(decodeIfs(raw, 37)).toBe('HI there\n\t12\n');
    expect(ebcdicLineEnd(raw)).toBe(0x15);
    expect([...encodeIfs('HI there\n\t12\n', 37, ebcdicLineEnd(raw))]).toEqual([...raw]);
    // A file that uses LF keeps LF.
    const lf = bytes(0xc1, 0x25, 0xc2);
    expect(decodeIfs(lf, 37)).toBe('A\nB');
    expect([...encodeIfs('A\nB', 37, ebcdicLineEnd(lf))]).toEqual([0xc1, 0x25, 0xc2]);
    // 273 differs from 37 in the national characters.
    expect(decodeIfs(bytes(0x7c), 37)).toBe('@');
    expect(decodeIfs(bytes(0x7c), 273)).toBe('\u00a7');
  });

  it('decodes and encodes UTF-8, UTF-16 and Latin-1', () => {
    const text = 'Grüße €';
    expect(decodeIfs(encodeIfs(text, 1208), 1208)).toBe(text);
    expect(decodeIfs(encodeIfs(text, 1200), 1200)).toBe(text);
    expect([...encodeIfs('A€', 819)]).toEqual([0x41, 0x3f]); // no euro in Latin-1
    expect(decodeIfs(bytes(0x41, 0xe9), 819)).toBe('Aé');
  });

  it('guesses: the reported CCSID wins; else valid UTF-8, EBCDIC-looking bytes, or Latin-1', () => {
    expect(guessCcsid(bytes(0x41), 37)).toBe(37);
    expect(guessCcsid(bytes(0x41), 1208)).toBe(1208);
    expect(guessCcsid(new TextEncoder().encode('plain ascii'), 0)).toBe(1208);
    expect(guessCcsid(bytes(0xc8, 0xc9, 0x40, 0xa3, 0x88, 0x85, 0x99, 0x85), 0)).toBe(37);
    expect(guessCcsid(bytes(0xe9, 0xe9, 0xff, 0xfe, 0x41), 0)).toBe(819);
    // An unknown reported CCSID (say 500 is known, 9999 is not) falls back to the guess.
    expect(guessCcsid(new TextEncoder().encode('x'), 9999)).toBe(1208);
  });

  it('calls a file binary when it has NULs, except UTF-16', () => {
    expect(isBinary(bytes(0x41, 0x00, 0x42), 1208)).toBe(true);
    expect(isBinary(bytes(0x00, 0x41, 0x00, 0x42), 1200)).toBe(false);
    expect(isBinary(new TextEncoder().encode('text'), 1208)).toBe(false);
  });

  it('hex dumps 16 bytes per line with offsets and ASCII', () => {
    const dump = hexDump(bytes(0x48, 0x69, 0x00, 0xff));
    expect(dump).toBe('00000000  48 69 00 ff                                      Hi..');
    expect(hexDump(new Uint8Array(40), 16).split('\n')).toHaveLength(2);
  });

  it('round-trips base64 and lists the encodings with labels', () => {
    const raw = bytes(0, 1, 2, 250, 255);
    expect([...fromBase64(toBase64(raw))]).toEqual([...raw]);
    const ccsids = ENCODINGS.map((e) => e.ccsid);
    // Unicode and Latin first, then the EBCDIC pages the engine has, then the other browser pages.
    expect(ccsids.slice(0, 8)).toEqual([1208, 1200, 1202, 13488, 1232, 1234, 819, 1252]);
    expect(ccsids.slice(8, 21)).toEqual([37, 273, 500, 1140, 1141, 1142, 1143, 1144, 1145, 1146, 1147, 1148, 1149]);
    expect(ccsids).toEqual(expect.arrayContaining([923, 1250, 1251, 943, 1386, 970]));
    expect(ENCODINGS.find((e) => e.ccsid === 943)?.readOnly).toBe(true);
    expect(ENCODINGS.find((e) => e.ccsid === 1251)?.readOnly).toBeUndefined();
    // Windows-1251 round-trips through the encoder built from the browser's decoder; UTF-32 by hand.
    expect(decodeIfs(encodeIfs('Привет', 1251), 1251)).toBe('Привет');
    expect([...encodeIfs('A', 1232)]).toEqual([0, 0, 0, 0x41]);
    expect([...encodeIfs('A', 1234)]).toEqual([0x41, 0, 0, 0]);
    expect(decodeIfs(encodeIfs('a\u20ac', 1234), 1234)).toBe('a\u20ac');
    expect(encodingLabel(65535)).toBe('untagged (65535)');
    expect(encodingLabel(37)).toBe('EBCDIC 37 (US, Canada)');
    expect(encodingLabel(9999)).toBe('CCSID 9999');
  });
});

describe('IFS text codec: PC files', () => {
  const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

  it('reads a byte-order mark before anything else and keeps it on the way back', () => {
    expect(bomCcsid(bytes(0xff, 0xfe, 0x48, 0x00))).toBe(1202);
    expect(bomCcsid(bytes(0xfe, 0xff, 0x00, 0x48))).toBe(1200);
    expect(bomCcsid(bytes(0xef, 0xbb, 0xbf, 0x48))).toBe(1208);
    expect(bomCcsid(bytes(0x48, 0x69))).toBeUndefined();
    // PowerShell's "> file.txt": UTF-16 LE with a mark, tagged 1208 by an upload.
    const ps = bytes(0xff, 0xfe, 0x48, 0x00, 0x69, 0x00);
    expect(guessCcsid(ps, 1208)).toBe(1202);
    expect(isBinary(ps, 1202)).toBe(false);
    expect(decodeIfs(ps, 1202)).toBe('Hi');
    expect([...keepBom(encodeIfs('Hi', 1202), ps, 1202)]).toEqual([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect([...keepBom(encodeIfs('Hi', 1208), ps, 1208)]).toEqual([0x48, 0x69]); // the file had no UTF-8 mark
  });

  it('does not believe a UTF-16 tag on bytes without a single NUL (files an earlier upload tagged 1200)', () => {
    expect(guessCcsid(new TextEncoder().encode('plain text\n'), 1200)).toBe(1208);
    expect(guessCcsid(bytes(0x41, 0xe9, 0x42), 1200)).toBe(819);
    expect(guessCcsid(bytes(0x00, 0x48, 0x00, 0x69), 1200)).toBe(1200);
  });

  it('guesses UTF-16 without a mark from where the NULs sit', () => {
    expect(guessCcsid(bytes(0x48, 0x00, 0x69, 0x00, 0x21, 0x00), 0)).toBe(1202);
    expect(guessCcsid(bytes(0x00, 0x48, 0x00, 0x69, 0x00, 0x21), 0)).toBe(1200);
    expect(decodeIfs(encodeIfs('Grüße', 1202), 1202)).toBe('Grüße');
  });

  it('has a hex choice that is not a CCSID', () => {
    expect(HEX).toBeLessThan(0);
    expect(encodingLabel(HEX)).toBe('Bytes (hex)');
    expect(ENCODINGS.some((e) => e.ccsid === 1202)).toBe(true);
  });
});
