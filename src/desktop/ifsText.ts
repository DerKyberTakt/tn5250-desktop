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
}

const UNICODE: Encoding[] = [
  { ccsid: 1208, label: 'UTF-8 (1208)' },
  { ccsid: 1200, label: 'UTF-16 (1200)' },
  { ccsid: 819, label: 'ISO-8859-1 (819)' },
  { ccsid: 1252, label: 'Windows-1252 (1252)' },
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

/** Every encoding the viewer offers: Unicode and Latin first, then the EBCDIC pages the engine knows. */
export const ENCODINGS: Encoding[] = [...UNICODE, ...CodePage.supported().map((ccsid) => ({ ccsid, label: EBCDIC_LABELS[ccsid] ?? `EBCDIC ${ccsid}` }))];

export function isEbcdic(ccsid: number): boolean {
  return CodePage.supported().includes(ccsid);
}

export function encodingLabel(ccsid: number): string {
  return ENCODINGS.find((e) => e.ccsid === ccsid)?.label ?? `CCSID ${ccsid}`;
}

const UTF16 = new Set([1200, 13488, 17584, 61952]);

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
  if (reported && (UTF16.has(reported) || reported === 1208 || reported === 819 || reported === 1252 || isEbcdic(reported))) return reported;
  if (validUtf8(bytes)) return 1208;
  if (looksEbcdic(bytes)) return 37;
  return 819;
}

/** A file is binary when it has NULs where text would not (UTF-16 has them between every byte pair). */
export function isBinary(bytes: Uint8Array, ccsid: number): boolean {
  if (UTF16.has(ccsid)) return false;
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
  if (ccsid === 1252) return new TextDecoder('windows-1252').decode(bytes);
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
  if (UTF16.has(ccsid)) {
    const out = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[2 * i] = c >> 8;
      out[2 * i + 1] = c & 0xff;
    }
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
