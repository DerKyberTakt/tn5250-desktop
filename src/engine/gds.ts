/** General Data Stream record framing used by TN5250 (RFC 1205 section 3). */

export const GDS_TYPE = 0x12a0;

/** Record header flag bits (first flag byte). */
export const FLAG_ERR = 0x80;
export const FLAG_ATN = 0x40;
export const FLAG_SRQ = 0x04;
export const FLAG_TRQ = 0x02;
export const FLAG_HLP = 0x01;

/** Record opcodes. */
export const OP_NOOP = 0x00;
export const OP_INVITE = 0x01;
export const OP_OUTPUT_ONLY = 0x02;
export const OP_PUT_GET = 0x03;
export const OP_SAVE_SCREEN = 0x04;
export const OP_RESTORE_SCREEN = 0x05;
export const OP_READ_IMMEDIATE = 0x06;
export const OP_READ_SCREEN = 0x08;
export const OP_CANCEL_INVITE = 0x0a;
export const OP_MESSAGE_LIGHT_ON = 0x0b;
export const OP_MESSAGE_LIGHT_OFF = 0x0c;

export interface GdsRecord {
  length: number;
  flags1: number;
  flags2: number;
  opcode: number;
  data: Uint8Array;
}

export class GdsError extends Error {}

export function parseRecord(bytes: Uint8Array): GdsRecord {
  if (bytes.length < 10) {
    throw new GdsError(`record too short (${bytes.length} bytes)`);
  }
  const length = ((bytes[0] as number) << 8) | (bytes[1] as number);
  const type = ((bytes[2] as number) << 8) | (bytes[3] as number);
  if (type !== GDS_TYPE) {
    throw new GdsError(`unexpected GDS type 0x${type.toString(16)}`);
  }
  const varHdrLen = bytes[6] as number;
  if (varHdrLen < 4) {
    throw new GdsError(`invalid variable header length ${varHdrLen}`);
  }
  const flags1 = bytes[7] as number;
  const flags2 = bytes[8] as number;
  const opcode = bytes[9] as number;
  const dataStart = 6 + varHdrLen;
  return { length, flags1, flags2, opcode, data: bytes.subarray(dataStart) };
}

export function buildRecord(opcode: number, flags1: number, data: ArrayLike<number>): Uint8Array {
  const total = 10 + data.length;
  const out = new Uint8Array(total);
  out[0] = (total >> 8) & 0xff;
  out[1] = total & 0xff;
  out[2] = 0x12;
  out[3] = 0xa0;
  out[4] = 0;
  out[5] = 0;
  out[6] = 0x04;
  out[7] = flags1;
  out[8] = 0;
  out[9] = opcode;
  out.set(Array.from(data), 10);
  return out;
}
