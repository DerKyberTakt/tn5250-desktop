import { CodePage } from '../engine/codepage';

/**
 * Text in IFS stream files. The file server moves bytes; the file's data CCSID says what they
 * mean. Unicode and Latin CCSIDs go through TextDecoder; EBCDIC ones use the engine's code
 * page tables (the same ones the 5250 screen uses), with the stream-file control bytes
 * (NL, LF, CR, tab) mapped to their ASCII meaning.
 */

/** A choice in the viewer's encoding list. */
export interface Encoding {
  ccsid: number;
  label: string;
  /** The page can be read but not written back (multi-byte pages without an encoder here). */
  readOnly?: boolean;
}

const UNICODE: Encoding[] = [
  { ccsid: 1208, label: 'UTF-8 (1208)' },
  { ccsid: 1200, label: 'UTF-16 BE (1200)' },
  { ccsid: 1202, label: 'UTF-16 LE (1202)' },
  { ccsid: 13488, label: 'UCS-2 (13488)' },
  { ccsid: 1232, label: 'UTF-32 BE (1232)' },
  { ccsid: 1234, label: 'UTF-32 LE (1234)' },
  { ccsid: 819, label: 'ISO-8859-1 (819)' },
  { ccsid: 1252, label: 'Windows-1252 (1252)' },
];

/** Single-byte pages the browser decodes; their encoders are built from the decoder (every byte once). */
const SINGLE_BYTE: Record<number, [label: string, decoder: string]> = {
  923: ['ISO-8859-15 (923, euro)', 'iso-8859-15'],
  912: ['ISO-8859-2 (912, Central Europe)', 'iso-8859-2'],
  915: ['ISO-8859-5 (915, Cyrillic)', 'iso-8859-5'],
  813: ['ISO-8859-7 (813, Greek)', 'iso-8859-7'],
  920: ['ISO-8859-9 (920, Turkish)', 'iso-8859-9'],
  1250: ['Windows-1250 (Central Europe)', 'windows-1250'],
  1251: ['Windows-1251 (Cyrillic)', 'windows-1251'],
  1253: ['Windows-1253 (Greek)', 'windows-1253'],
  1254: ['Windows-1254 (Turkish)', 'windows-1254'],
  1255: ['Windows-1255 (Hebrew)', 'windows-1255'],
  1256: ['Windows-1256 (Arabic)', 'windows-1256'],
  1257: ['Windows-1257 (Baltic)', 'windows-1257'],
  1258: ['Windows-1258 (Vietnamese)', 'windows-1258'],
  878: ['KOI8-R (878, Russian)', 'koi8-r'],
  866: ['DOS 866 (Cyrillic)', 'ibm866'],
};

/** Multi-byte pages the browser decodes; read only. */
const MULTI_BYTE: Record<number, [label: string, decoder: string]> = {
  943: ['Shift_JIS (943, Japanese)', 'shift_jis'],
  932: ['Shift_JIS (932, Japanese)', 'shift_jis'],
  1386: ['GBK (1386, Chinese)', 'gbk'],
  1381: ['GBK (1381, Chinese)', 'gbk'],
  950: ['Big5 (950, Traditional Chinese)', 'big5'],
  970: ['EUC-KR (970, Korean)', 'euc-kr'],
  1363: ['EUC-KR (1363, Korean)', 'euc-kr'],
  33722: ['EUC-JP (33722, Japanese)', 'euc-jp'],
};

const BROWSER_PAGES: Encoding[] = [
  ...Object.entries(SINGLE_BYTE).map(([c, [label]]) => ({ ccsid: Number(c), label })),
  ...Object.entries(MULTI_BYTE).map(([c, [label]]) => ({ ccsid: Number(c), label, readOnly: true })),
];

const EBCDIC_LABELS: Record<number, string> = {
  37: 'EBCDIC 37 (US, Canada)',
  273: 'EBCDIC 273 (Germany, Austria)',
  500: 'EBCDIC 500 (International)',
  1140: 'EBCDIC 1140 (US, euro)',
  1141: 'EBCDIC 1141 (Germany, euro)',
  1142: 'EBCDIC 1142 (Denmark, Norway, euro)',
  1143: 'EBCDIC 1143 (Finland, Sweden, euro)',
  1144: 'EBCDIC 1144 (Italy, euro)',
  1145: 'EBCDIC 1145 (Spain, euro)',
  1146: 'EBCDIC 1146 (UK, euro)',
  1147: 'EBCDIC 1147 (France, euro)',
  1148: 'EBCDIC 1148 (International, euro)',
  1149: 'EBCDIC 1149 (Iceland, euro)',
};

/** Every encoding the viewer offers: Unicode and Latin first, then the EBCDIC pages the engine knows, then the other browser pages. */
export const ENCODINGS: Encoding[] = [...UNICODE, ...CodePage.supported().map((ccsid) => ({ ccsid, label: EBCDIC_LABELS[ccsid] ?? `EBCDIC ${ccsid}` })), ...BROWSER_PAGES];

/** Whether text can be written back in this page (the multi-byte browser pages are read only). */
export function canEncode(ccsid: number): boolean {
  return !(ccsid in MULTI_BYTE);
}

/** Not a CCSID: the viewer's "show me the bytes" choice. */
export const HEX = -1;

export function isEbcdic(ccsid: number): boolean {
  return CodePage.supported().includes(ccsid);
}

export function encodingLabel(ccsid: number): string {
  if (ccsid === HEX) return 'Bytes (hex)';
  if (ccsid === 65535) return 'untagged (65535)';
  return ENCODINGS.find((e) => e.ccsid === ccsid)?.label ?? `CCSID ${ccsid}`;
}

/** UTF-16 big endian, the IBM i byte order. */
const UTF16 = new Set([1200, 13488, 17584, 61952]);
/** UTF-16 little endian: what Windows Notepad and PowerShell write. */
const UTF16LE = 1202;
const UTF32BE = 1232;
const UTF32LE = 1234;

function decodeUtf32(bytes: Uint8Array, le: boolean): string {
  let out = '';
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const cp = le ? (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0 : ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
    out += cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
  }
  return out;
}

function encodeUtf32(text: string, le: boolean): Uint8Array {
  const cps = [...text].map((ch) => ch.codePointAt(0) ?? 0);
  const out = new Uint8Array(cps.length * 4);
  cps.forEach((cp, i) => {
    const b = [(cp >>> 24) & 0xff, (cp >>> 16) & 0xff, (cp >>> 8) & 0xff, cp & 0xff];
    if (le) b.reverse();
    out.set(b, i * 4);
  });
  return out;
}

/** The byte for each character of a single-byte browser page, from decoding every byte once. */
const reverseTables = new Map<number, Map<string, number>>();

function reverseTable(ccsid: number): Map<string, number> {
  let t = reverseTables.get(ccsid);
  if (!t) {
    t = new Map();
    const dec = new TextDecoder(SINGLE_BYTE[ccsid]![1]);
    for (let b = 0; b < 256; b++) {
      const ch = dec.decode(Uint8Array.of(b));
      if (!t.has(ch)) t.set(ch, b);
    }
    reverseTables.set(ccsid, t);
  }
  return t;
}

function validUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** EBCDIC text has most of its letters above X'80' and its blanks at X'40'. */
function looksEbcdic(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  if (!n) return false;
  let high = 0;
  let blanks = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i] as number;
    if (b >= 0x81) high++;
    if (b === 0x40) blanks++;
  }
  return high / n > 0.4 && blanks > 0;
}

/**
 * What to decode with, when the file's CCSID does not say: valid UTF-8 is UTF-8, text that
 * looks like EBCDIC is CCSID 37, anything else Latin-1.
 */
export function guessCcsid(bytes: Uint8Array, reported: number): number {
  const bom = bomCcsid(bytes);
  if (bom) return bom;
  if (reported && (UTF16.has(reported) || reported === UTF16LE || reported === UTF32BE || reported === UTF32LE || reported === 1208 || reported === 819 || reported === 1252 || isEbcdic(reported) || reported in SINGLE_BYTE || reported in MULTI_BYTE)) {
    // Tagged UTF-16 but not a NUL in sight: a PC file an earlier upload tagged 1200. Read the bytes for what they are.
    if ((UTF16.has(reported) || reported === UTF16LE) && bytes.length && !bytes.subarray(0, 8192).includes(0)) return validUtf8(bytes) ? 1208 : 819;
    return reported;
  }
  const utf16 = utf16Guess(bytes);
  if (utf16) return utf16;
  if (validUtf8(bytes)) return 1208;
  if (looksEbcdic(bytes)) return 37;
  return 819;
}

/** A file is binary when it has NULs where text would not (UTF-16 has them between every byte pair). */
export function isBinary(bytes: Uint8Array, ccsid: number): boolean {
  if (UTF16.has(ccsid) || ccsid === UTF16LE || ccsid === UTF32BE || ccsid === UTF32LE) return false;
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** EBCDIC stream-file controls: NL (the IBM i line end), LF, CR, tab. */
const EBCDIC_NL = 0x15;
const EBCDIC_LF = 0x25;
const EBCDIC_CR = 0x0d;
const EBCDIC_TAB = 0x05;

/** Decodes bytes as the given CCSID (one from ENCODINGS; anything else is Latin-1). */
export function decodeIfs(bytes: Uint8Array, ccsid: number): string {
  if (ccsid === 1208) return new TextDecoder('utf-8').decode(bytes);
  if (UTF16.has(ccsid)) return new TextDecoder('utf-16be').decode(bytes);
  if (ccsid === UTF16LE) return new TextDecoder('utf-16le').decode(bytes);
  if (ccsid === UTF32BE || ccsid === UTF32LE) return decodeUtf32(bytes, ccsid === UTF32LE);
  if (ccsid === 1252) return new TextDecoder('windows-1252').decode(bytes);
  if (ccsid in SINGLE_BYTE) return new TextDecoder(SINGLE_BYTE[ccsid]![1]).decode(bytes);
  if (ccsid in MULTI_BYTE) return new TextDecoder(MULTI_BYTE[ccsid]![1]).decode(bytes);
  if (isEbcdic(ccsid)) {
    const cp = CodePage.get(ccsid);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] as number;
      if (b === EBCDIC_NL || b === EBCDIC_LF) out += '\n';
      else if (b === EBCDIC_CR) out += '\r';
      else if (b === EBCDIC_TAB) out += '\t';
      else if (b === 0x40) out += ' ';
      else out += cp.decode(b);
    }
    return out;
  }
  // Latin-1: every byte is the character with that code.
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] as number);
  return out;
}

/** The line end an EBCDIC file uses (NL unless it only has LFs), so a save keeps it. */
export function ebcdicLineEnd(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === EBCDIC_NL) return EBCDIC_NL;
    if (b === EBCDIC_LF) return EBCDIC_LF;
  }
  return EBCDIC_NL;
}

/** Encodes text for a file of the given CCSID; characters the page lacks become '?' (EBCDIC X'6F'). */
export function encodeIfs(text: string, ccsid: number, lineEnd = EBCDIC_NL): Uint8Array {
  if (ccsid === 1208) return new TextEncoder().encode(text);
  if (UTF16.has(ccsid) || ccsid === UTF16LE) {
    const le = ccsid === UTF16LE;
    const out = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[2 * i] = le ? c & 0xff : c >> 8;
      out[2 * i + 1] = le ? c >> 8 : c & 0xff;
    }
    return out;
  }
  if (ccsid === UTF32BE || ccsid === UTF32LE) return encodeUtf32(text, ccsid === UTF32LE);
  if (ccsid in SINGLE_BYTE) {
    const table = reverseTable(ccsid);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = table.get(text.charAt(i)) ?? 0x3f;
    return out;
  }
  if (isEbcdic(ccsid)) {
    const cp = CodePage.get(ccsid);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      out[i] = ch === '\n' ? lineEnd : ch === '\r' ? EBCDIC_CR : ch === '\t' ? EBCDIC_TAB : ch === ' ' ? 0x40 : cp.encode(ch);
    }
    return out;
  }
  // Latin-1 / Windows-1252: the low 256 code points, '?' for the rest.
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i] = c < 256 ? c : 0x3f;
  }
  return out;
}

/** A classic hex dump: offset, 16 bytes, the printable ASCII. */
export function hexDump(bytes: Uint8Array, limit = 1 << 20): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, limit);
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > n) lines.push(`… ${bytes.length - n} more bytes`);
  return lines.join('\n');
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The encoding a byte-order mark announces, when the file starts with one. */
export function bomCcsid(bytes: Uint8Array): number | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 1208;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return UTF16LE;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 1200;
  return undefined;
}

/** UTF-16 without a mark: Latin text has a NUL in every other byte (odd positions = little endian). */
function utf16Guess(bytes: Uint8Array): number | undefined {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 4) return undefined;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) even++;
    if (bytes[i + 1] === 0) odd++;
  }
  const pairs = n / 2;
  if (odd / pairs > 0.3 && even === 0) return UTF16LE;
  if (even / pairs > 0.3 && odd === 0) return 1200;
  return undefined;
}

/** Puts back the byte-order mark the file had, so a save keeps it. TextDecoder drops it when reading. */
export function keepBom(encoded: Uint8Array, original: Uint8Array, ccsid: number): Uint8Array {
  if (bomCcsid(original) !== ccsid) return encoded;
  const bom = ccsid === 1208 ? [0xef, 0xbb, 0xbf] : ccsid === UTF16LE ? [0xff, 0xfe] : [0xfe, 0xff];
  const out = new Uint8Array(bom.length + encoded.length);
  out.set(bom, 0);
  out.set(encoded, bom.length);
  return out;
}
