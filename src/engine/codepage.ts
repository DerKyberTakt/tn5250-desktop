import { CODEPAGE_TABLES } from './codepages.generated';

/** EBCDIC single-byte code page: byte <-> Unicode character. */
/** What a byte that is not a printable character shows as (hollow box, as on ACS). */
export const UNPRINTABLE = '\u25a1';

export class CodePage {
  private readonly encodeMap = new Map<string, number>();

  private constructor(
    readonly ccsid: number,
    private readonly table: string,
  ) {
    for (let b = 255; b >= 0; b--) {
      // Iterate downward so that lower byte values win when a character maps twice.
      this.encodeMap.set(table.charAt(b), b);
    }
  }

  static get(ccsid: number): CodePage {
    const table = CODEPAGE_TABLES[ccsid];
    if (!table) {
      throw new RangeError(`unsupported code page ${ccsid}`);
    }
    let cp = cache.get(ccsid);
    if (!cp) {
      cp = new CodePage(ccsid, table);
      cache.set(ccsid, cp);
    }
    return cp;
  }

  static supported(): number[] {
    return Object.keys(CODEPAGE_TABLES).map(Number);
  }

  /**
   * Decodes one byte. Nulls and the attribute range (X'20'-X'3F', never text) decode to a
   * space; control bytes the host wrote as data (X'01'-X'1F', and X'FF' which maps to a
   * C1 control) decode to UNPRINTABLE, the box a 5250 display and ACS show for them.
   */
  decode(byte: number): string {
    if (byte === 0x00 || (byte >= 0x20 && byte < 0x40)) return ' ';
    if (byte < 0x20) return UNPRINTABLE;
    const ch = this.table.charAt(byte);
    const code = ch.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? UNPRINTABLE : ch;
  }

  /** Encodes one character; returns the substitute 0x6F ('?') when unmapped. */
  encode(ch: string): number {
    return this.encodeMap.get(ch) ?? 0x6f;
  }

  decodeBytes(bytes: ArrayLike<number>, start = 0, end = bytes.length): string {
    let out = '';
    for (let i = start; i < end; i++) {
      out += this.decode(bytes[i] ?? 0);
    }
    return out;
  }

  encodeString(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      out[i] = this.encode(text.charAt(i));
    }
    return out;
  }
}

const cache = new Map<number, CodePage>();
