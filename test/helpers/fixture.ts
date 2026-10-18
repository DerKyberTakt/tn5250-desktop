import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CaptureEvent {
  t: number;
  dir: 'in' | 'out';
  hex: string;
}

export interface Capture {
  description: string;
  port: number;
  term: string;
  negotiated: string[];
  records: number;
  events: CaptureEvent[];
}

export function loadCapture(name: string): Capture {
  const path = join(__dirname, '..', 'fixtures', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Capture;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function inboundBytes(capture: Capture): Uint8Array {
  return hexToBytes(capture.events.filter((e) => e.dir === 'in').map((e) => e.hex).join(''));
}

export function outboundHex(capture: Capture): string {
  return capture.events.filter((e) => e.dir === 'out').map((e) => e.hex).join('');
}
