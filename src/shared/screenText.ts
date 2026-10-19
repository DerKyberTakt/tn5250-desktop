import { ATTR_NORMAL, decodeAttribute, isAttribute } from '../engine/attributes';
import type { KeyAction } from './keymap';
import type { ScreenSnapshot } from './protocol';

const NULL = '\u0000';

/** One horizontal run of a field on a row. */
export interface FieldRange {
  row: number;
  col: number;
  length: number;
  fieldIndex: number;
  bypass: boolean;
}

/** Splits every field of the snapshot into per-row runs (fields can wrap). */
export function fieldRanges(s: Pick<ScreenSnapshot, 'rows' | 'cols' | 'fields'>): FieldRange[] {
  const out: FieldRange[] = [];
  s.fields.forEach((f, fieldIndex) => {
    let start = f.start;
    let remaining = f.length;
    while (remaining > 0 && start < s.rows * s.cols) {
      const row = Math.floor(start / s.cols);
      const col = start % s.cols;
      const length = Math.min(remaining, s.cols - col);
      out.push({ row, col, length, fieldIndex, bypass: f.bypass });
      start += length;
      remaining -= length;
    }
  });
  return out;
}

/**
 * The parts of each field run the host actually marks as input: cells whose
 * attribute in effect is underlined or reverse. Programs such as WRKDBF define
 * a long input field and then write a plain attribute after the data length,
 * so ACS shows only the data length as the field; boxes should do the same.
 * A field with no marked cell at all (nondisplay password, plain field) is
 * kept whole, so it still gets a box.
 */
export function markedFieldRanges(s: Pick<ScreenSnapshot, 'rows' | 'cols' | 'fields' | 'attrs'>): FieldRange[] {
  const all = fieldRanges(s);
  const runs: FieldRange[] = [];
  for (const r of all) {
    const start = r.row * s.cols + r.col;
    let attr = ATTR_NORMAL;
    for (let i = start - 1; i >= 0; i--) {
      if (isAttribute(s.attrs[i] ?? 0)) {
        attr = s.attrs[i]!;
        break;
      }
    }
    let marked = isMarked(attr);
    let runStart = -1;
    for (let c = 0; c <= r.length; c++) {
      if (c < r.length && isAttribute(s.attrs[start + c] ?? 0)) marked = isMarked(s.attrs[start + c]!);
      const on = c < r.length && marked;
      if (on && runStart < 0) runStart = c;
      if (!on && runStart >= 0) {
        runs.push({ ...r, col: r.col + runStart, length: c - runStart });
        runStart = -1;
      }
    }
  }
  const markedFields = new Set(runs.map((r) => r.fieldIndex));
  return [...runs, ...all.filter((r) => !markedFields.has(r.fieldIndex))].sort(
    (x, y) => x.fieldIndex - y.fieldIndex || x.row - y.row || x.col - y.col,
  );
}

function isMarked(attr: number): boolean {
  const a = decodeAttribute(attr);
  return !a.nondisplay && (a.underline || a.reverse);
}

export function rowText(s: Pick<ScreenSnapshot, 'cols' | 'text'>, row: number): string {
  return s.text.slice(row * s.cols, (row + 1) * s.cols).split(NULL).join(' ');
}

/** The run of non-blank characters under a column. */
export function wordAt(line: string, col: number): { text: string; start: number } {
  let a = col;
  let b = col;
  while (a > 0 && line.charAt(a - 1) !== ' ') a -= 1;
  while (b < line.length && line.charAt(b) !== ' ') b += 1;
  return { text: line.slice(a, b), start: a };
}

export interface UrlHit {
  url: string;
  start: number;
  end: number;
}

const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

/** URLs on a line, with their column spans. */
export function urlsIn(line: string): UrlHit[] {
  const out: UrlHit[] = [];
  for (const m of line.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:)]+$/, '');
    out.push({ url, start: m.index, end: m.index + url.length });
  }
  return out;
}

export function urlAt(line: string, col: number): string | undefined {
  return urlsIn(line).find((u) => col >= u.start && col < u.end)?.url;
}

export interface HotspotOptions {
  pf: boolean;
  fp: boolean;
  f: boolean;
  number: boolean;
}

export type Hotspot = { kind: 'key'; action: KeyAction; start: number; length: number } | { kind: 'option'; text: string; start: number; length: number };

/** Classifies the word under a column as a function-key or menu-number hotspot. */
export function hotspotAt(line: string, col: number, opt: HotspotOptions): Hotspot | undefined {
  const w = wordAt(line, col);
  if (!w.text) return undefined;
  const fkey = (n: number, length: number): Hotspot | undefined =>
    n >= 1 && n <= 24 ? { kind: 'key', action: `pf${n}` as KeyAction, start: w.start, length } : undefined;
  let m = /^PF(\d{1,2})\b/i.exec(w.text);
  if (m && opt.pf) return fkey(Number(m[1]), m[0].length);
  m = /^FP(\d{1,2})\b/i.exec(w.text);
  if (m && opt.fp) return fkey(Number(m[1]), m[0].length);
  m = /^F(\d{1,2})\b/i.exec(w.text);
  if (m && opt.f) return fkey(Number(m[1]), m[0].length);
  m = /^(\d{1,2})\.?$/.exec(w.text);
  if (m && opt.number) return { kind: 'option', text: m[1] as string, start: w.start, length: w.text.length };
  return undefined;
}

/** Spans of function-key labels on a line (for 3-D buttons). */
export function keyLabelsIn(line: string): Array<{ start: number; length: number; action: KeyAction }> {
  const out: Array<{ start: number; length: number; action: KeyAction }> = [];
  for (const m of line.matchAll(/(?:^|\s)((?:PF|FP|F)(\d{1,2}))(?=[=:\s]|$)/gi)) {
    const n = Number(m[2]);
    if (n < 1 || n > 24) continue;
    const start = m.index + m[0].length - (m[1] as string).length;
    out.push({ start, length: (m[1] as string).length, action: `pf${n}` as KeyAction });
  }
  return out;
}

export interface PasteOptions {
  tabMode: 'spaces' | 'nextField' | 'tabStop';
  tabSpaces: number;
  tabColumns: number;
}

/** Splits a pasted line into text runs and tab actions according to the paste options. */
export function expandTabs(line: string, opt: PasteOptions): Array<{ text: string } | { action: 'tab' }> {
  const out: Array<{ text: string } | { action: 'tab' }> = [];
  let col = 0;
  let buf = '';
  for (const ch of line) {
    if (ch !== '\t') {
      buf += ch;
      col += 1;
      continue;
    }
    if (opt.tabMode === 'nextField') {
      if (buf) out.push({ text: buf });
      buf = '';
      out.push({ action: 'tab' });
      col = 0;
    } else if (opt.tabMode === 'tabStop') {
      const n = Math.max(1, opt.tabColumns);
      const pad = n - (col % n);
      buf += ' '.repeat(pad);
      col += pad;
    } else {
      buf += ' '.repeat(Math.max(0, opt.tabSpaces));
      col += opt.tabSpaces;
    }
  }
  if (buf) out.push({ text: buf });
  return out;
}
