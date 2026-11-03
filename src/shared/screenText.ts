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

/**
 * Cells covered by an Enhanced-mode field decoration (box or long-field line):
 * every cell of an input field that is not bypass (protected). Everywhere else
 * the host's own underline attribute is drawn as it is (underlined headings,
 * protected fields), the same as ACS and Classic mode.
 */
export function decoratedFieldCells(s: Pick<ScreenSnapshot, 'rows' | 'cols' | 'fields'>): Uint8Array<ArrayBuffer> {
  const mask = new Uint8Array(s.rows * s.cols);
  for (const f of s.fields) {
    if (!f.bypass) mask.fill(1, f.start, Math.min(mask.length, f.start + f.length));
  }
  return mask;
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

/**
 * What a double-click at `col` selects on a row (inclusive columns): the word under the
 * pointer, clipped to the input field it sits in; a blank inside an input field selects
 * the field's run on that row; a blank anywhere else selects nothing.
 */
export function doubleClickRange(line: string, col: number, field?: { col: number; length: number }): { start: number; end: number } | undefined {
  if (line.charAt(col) !== ' ' && col < line.length) {
    const w = wordAt(line, col);
    let start = w.start;
    let end = w.start + w.text.length - 1;
    if (field) {
      start = Math.max(start, field.col);
      end = Math.min(end, field.col + field.length - 1);
    }
    return { start, end };
  }
  return field ? { start: field.col, end: field.col + field.length - 1 } : undefined;
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

/** A subfile found on the screen by its SFLEND marker; rows are 0-based and inclusive. */
export interface SubfileArea {
  top: number;
  bottom: number;
  /** 'more' = More... or + (there are records after this page); 'bottom' = Bottom (the last page). */
  end: 'more' | 'bottom';
  /** Column of the marker text, where the scroll bar should sit. */
  col: number;
}

/**
 * Finds subfiles by the text SFLEND(*MORE) / (*PLUS) puts at the right end of the row
 * after the last record: "More...", "Bottom" or "+". The subfile is taken to be the block
 * of rows above the marker up to (not including) the nearest row that is blank or holds
 * an underlined heading, which is how subfile headings are usually written. Rows with
 * host scroll bars are not considered; the host's own bar wins.
 */
export function detectSubfiles(s: Pick<ScreenSnapshot, 'rows' | 'cols' | 'text' | 'attrs'>): SubfileArea[] {
  const out: SubfileArea[] = [];
  const underlined = (row: number): boolean => {
    let attr = ATTR_NORMAL;
    for (let i = row * s.cols; i < (row + 1) * s.cols; i++) {
      const a = s.attrs[i] ?? 0;
      if (isAttribute(a)) attr = a;
      else if (s.text.charAt(i) !== ' ' && s.text.charAt(i) !== NULL && decodeAttribute(attr).underline) return true;
    }
    return false;
  };
  const blank = (row: number): boolean => rowText(s, row).trim() === '';
  for (let row = 1; row < s.rows; row++) {
    const line = rowText(s, row);
    const trimmed = line.trimEnd();
    const m = /(More\.\.\.|Bottom|\+)$/.exec(trimmed);
    if (!m || m.index < s.cols - 12) continue;
    // The marker row itself is the row after the last record; the records are above it.
    let top = row - 1;
    while (top > 0 && !blank(top - 1) && !underlined(top - 1)) top--;
    if (top > row - 1 || blank(top)) continue;
    out.push({ top, bottom: row, end: m[1] === 'Bottom' ? 'bottom' : 'more', col: m.index });
    row = row + 1;
  }
  return out;
}
