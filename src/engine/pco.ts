import type { CodePage } from './codepage';
import type { Screen } from './screen';

/**
 * PC Organizer: STRPCCMD on the host writes a nondisplay field at row 1 column 1 whose
 * data starts with X'80FC' "PCO " X'8380A180', then a flag byte and the PC command, and
 * reads the screen. A PC Organizer-aware emulator runs the command and answers Enter;
 * anything else shows the host's fallback text ("Required PC program (PCO.EXE) is not
 * active"). The command is at most 123 characters before IBM i 7.1 and 1023 since.
 */
export interface PcCommandRequest {
  command: string;
  /** PAUSE(*YES): press Enter only after the command has finished. */
  wait: boolean;
}

const PCO_HEADER = [0x80, 0xfc, 0xd7, 0xc3, 0xd6, 0x40, 0x83, 0x80, 0xa1, 0x80];
/** EBCDIC 'a' in the flag byte = PAUSE(*NO). */
const FLAG_NO_PAUSE = 0x81;
const MAX_COMMAND = 1023;

/** The PC command the host just wrote, if the screen is a PC Organizer request. */
export function detectPcCommand(screen: Screen, codePage: CodePage): PcCommandRequest | undefined {
  // The field attribute sits at row 1 column 1, so the data starts at the next cell.
  const field = screen.fields.find((f) => f.start === 1);
  if (!field || (field.attr & 0x07) !== 0x07 || field.length <= PCO_HEADER.length + 1) return undefined;
  const bytes = screen.fieldBytes(field);
  for (let i = 0; i < PCO_HEADER.length; i++) {
    if (bytes[i] !== PCO_HEADER[i]) return undefined;
  }
  const wait = bytes[PCO_HEADER.length] !== FLAG_NO_PAUSE;
  const start = PCO_HEADER.length + 1;
  let end = Math.min(bytes.length, start + MAX_COMMAND);
  while (end > start && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0x40)) end--;
  let command = '';
  for (const ch of codePage.decodeBytes(bytes, start, end)) {
    const code = ch.charCodeAt(0);
    command += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  command = command.trim();
  return command ? { command, wait } : undefined;
}
