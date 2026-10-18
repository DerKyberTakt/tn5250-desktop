/** Pure TrueType/OpenType name-table parsing (no VS Code dependency). */

function u16(b: Buffer, o: number): number {
  return b.readUInt16BE(o);
}
function u32(b: Buffer, o: number): number {
  return b.readUInt32BE(o);
}

/** Reads the family name and fixed-pitch flag from a TrueType/OpenType font (first face of a collection). */
export function parseFont(buf: Buffer): { family: string; monospace: boolean } | undefined {
  if (buf.length < 12) return undefined;
  let base = 0;
  if (buf.toString('latin1', 0, 4) === 'ttcf') {
    if (buf.length < 16) return undefined;
    base = u32(buf, 12);
  }
  if (base + 12 > buf.length) return undefined;
  const numTables = u16(buf, base + 4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > buf.length) return undefined;
    tables.set(buf.toString('latin1', rec, rec + 4), { offset: u32(buf, rec + 8), length: u32(buf, rec + 12) });
  }
  const name = tables.get('name');
  if (!name || name.offset + 6 > buf.length) return undefined;
  const count = u16(buf, name.offset + 2);
  const strings = name.offset + u16(buf, name.offset + 4);
  let best: { score: number; value: string } | undefined;
  for (let i = 0; i < count; i++) {
    const rec = name.offset + 6 + i * 12;
    if (rec + 12 > buf.length) break;
    const platform = u16(buf, rec);
    const nameId = u16(buf, rec + 6);
    const length = u16(buf, rec + 8);
    const offset = strings + u16(buf, rec + 10);
    if ((nameId !== 1 && nameId !== 16) || offset + length > buf.length) continue;
    let value: string;
    if (platform === 3 || platform === 0) {
      if (length % 2 !== 0) continue;
      value = Buffer.from(buf.subarray(offset, offset + length)).swap16().toString('utf16le');
    }
    else if (platform === 1) value = buf.toString('latin1', offset, offset + length);
    else continue;
    value = value.split(String.fromCharCode(0)).join('').trim();
    if (!value) continue;
    const score = (nameId === 16 ? 2 : 0) + (platform === 3 ? 1 : 0);
    if (!best || score > best.score) best = { score, value };
  }
  if (!best) return undefined;
  const post = tables.get('post');
  const monospace = post !== undefined && post.offset + 16 <= buf.length && u32(buf, post.offset + 12) !== 0;
  return { family: best.value, monospace };
}

