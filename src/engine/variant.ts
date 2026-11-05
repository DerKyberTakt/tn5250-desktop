import type { CodePage } from './codepage';
import { CODEPAGE_TABLES } from './codepages.generated';

/**
 * Bytes whose character is not the same in every code page this emulator offers (the
 * "variant" characters of EBCDIC: ! @ # $ [ ] { } | \ ^ ~ and the accented letters).
 * The emulator sends raw EBCDIC and the host reads it with the CCSID of the sign-on job,
 * so a password typed with the wrong code page arrives as other characters and fails
 * even though it is right. This set is what the sign-on hint looks for.
 */
export const VARIANT_BYTES: ReadonlySet<number> = (() => {
  const tables = Object.values(CODEPAGE_TABLES);
  const out = new Set<number>();
  for (let b = 0x40; b < 256; b++) {
    const first = tables[0]!.charAt(b);
    if (tables.some((t) => t.charAt(b) !== first)) out.add(b);
  }
  return out;
})();

/** Bytes below X'40' are nulls and controls, never typed characters. */
const LOWEST_GRAPHIC = 0x40;

/**
 * The distinct variant characters among `bytes`, decoded with the session's code page,
 * in the order they appear (at most `limit`). Empty when every byte means the same thing
 * in every code page. Blanks and nulls are skipped.
 */
export function variantChars(bytes: ArrayLike<number>, cp: CodePage, limit = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < bytes.length && out.length < limit; i++) {
    const b = bytes[i] ?? 0;
    if (b < LOWEST_GRAPHIC || b === 0x40 || !VARIANT_BYTES.has(b)) continue;
    const ch = cp.decode(b);
    if (!out.includes(ch)) out.push(ch);
  }
  return out;
}
