import { describe, expect, it } from 'vitest';
import { parseFont } from '../../src/extension/fontParse';

/** Builds a minimal TrueType file with a name table (and optionally a post table). */
function fakeFont(family: string, fixedPitch: boolean, platform = 3): Buffer {
  const nameStr = platform === 3 ? Buffer.from(family, 'utf16le').swap16() : Buffer.from(family, 'latin1');
  const nameTable = Buffer.alloc(6 + 12 + nameStr.length);
  nameTable.writeUInt16BE(0, 0);
  nameTable.writeUInt16BE(1, 2);
  nameTable.writeUInt16BE(18, 4);
  nameTable.writeUInt16BE(platform, 6);
  nameTable.writeUInt16BE(platform === 3 ? 1 : 0, 8);
  nameTable.writeUInt16BE(0, 10);
  nameTable.writeUInt16BE(1, 12);
  nameTable.writeUInt16BE(nameStr.length, 14);
  nameTable.writeUInt16BE(0, 16);
  nameStr.copy(nameTable, 18);
  const post = Buffer.alloc(32);
  post.writeUInt32BE(fixedPitch ? 1 : 0, 12);
  const header = Buffer.alloc(12 + 2 * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(2, 4);
  const nameOff = header.length;
  const postOff = nameOff + nameTable.length;
  header.write('name', 12, 'latin1');
  header.writeUInt32BE(nameOff, 20);
  header.writeUInt32BE(nameTable.length, 24);
  header.write('post', 28, 'latin1');
  header.writeUInt32BE(postOff, 36);
  header.writeUInt32BE(post.length, 40);
  return Buffer.concat([header, nameTable, post]);
}

describe('parseFont', () => {
  it('reads the family name and the fixed-pitch flag', () => {
    expect(parseFont(fakeFont('Mono Test', true))).toEqual({ family: 'Mono Test', monospace: true });
    expect(parseFont(fakeFont('Proportional', false))).toEqual({ family: 'Proportional', monospace: false });
    expect(parseFont(fakeFont('MacName', true, 1))).toEqual({ family: 'MacName', monospace: true });
  });

  it('rejects junk', () => {
    expect(parseFont(Buffer.from('not a font at all'))).toBeUndefined();
    expect(parseFont(Buffer.alloc(4))).toBeUndefined();
  });
});
