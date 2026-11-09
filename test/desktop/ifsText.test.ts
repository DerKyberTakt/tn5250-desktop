import { describe, expect, it } from 'vitest';
import { ENCODINGS, decodeIfs, ebcdicLineEnd, encodeIfs, encodingLabel, fromBase64, guessCcsid, hexDump, isBinary, toBase64 } from '../../src/desktop/ifsText';

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
    expect(ENCODINGS.map((e) => e.ccsid)).toEqual([1208, 1200, 819, 1252, 37, 273, 500, 1140, 1141, 1142, 1143, 1144, 1145, 1146, 1147, 1148, 1149]);
    expect(encodingLabel(37)).toBe('EBCDIC 37 (US, Canada)');
    expect(encodingLabel(9999)).toBe('CCSID 9999');
  });
});
