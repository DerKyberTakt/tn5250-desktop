/**
 * 5250 display attribute bytes (0x20..0x3F).
 *
 * Bit layout (5494 Functions Reference, display attribute table):
 *   0x01  reverse image
 *   0x02  colour variant (white / blink / yellow / blue, by group)
 *   0x04  underline
 *   0x18  colour group: 0 green/white, 1 red, 2 turquoise/yellow, 3 pink/blue
 *   low three bits all set (x7, xF) = nondisplay
 * Group 2 (turquoise/yellow) always carries column separators.
 */

export type Color = 'green' | 'white' | 'red' | 'turquoise' | 'yellow' | 'pink' | 'blue';

export interface DecodedAttribute {
  color: Color;
  reverse: boolean;
  underline: boolean;
  blink: boolean;
  columnSeparators: boolean;
  nondisplay: boolean;
}

export const ATTR_MIN = 0x20;
export const ATTR_MAX = 0x3f;
/** Green, normal intensity: the attribute in effect at the start of a screen. */
export const ATTR_NORMAL = 0x20;

export function isAttribute(byte: number): boolean {
  return byte >= ATTR_MIN && byte <= ATTR_MAX;
}

export function decodeAttribute(attr: number): DecodedAttribute {
  if (!isAttribute(attr)) {
    throw new RangeError(`not a 5250 attribute byte: 0x${attr.toString(16)}`);
  }
  const group = (attr >> 3) & 0x03;
  const variant = (attr & 0x02) !== 0;
  const reverse = (attr & 0x01) !== 0;
  const underline = (attr & 0x04) !== 0;
  const nondisplay = (attr & 0x07) === 0x07;

  let color: Color;
  let blink = false;
  let columnSeparators = false;
  switch (group) {
    case 0:
      color = variant ? 'white' : 'green';
      break;
    case 1:
      color = 'red';
      blink = variant;
      break;
    case 2:
      color = variant ? 'yellow' : 'turquoise';
      columnSeparators = true;
      break;
    default:
      color = variant ? 'blue' : 'pink';
      break;
  }
  return { color, reverse, underline, blink, columnSeparators, nondisplay };
}
