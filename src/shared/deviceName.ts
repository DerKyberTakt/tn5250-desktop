/**
 * Workstation ID templates, modeled on ACS "Generate Workstation ID":
 *   &COMPN  computer name        &USERN  user name
 *   *       a letter A..Z that differs for each open tab with the same name
 *   =       a number 0..9 that differs for each open tab with the same name
 * The result is upper case, at most 10 characters, letters and digits only.
 */
export interface DeviceNameContext {
  computerName: string;
  userName: string;
  /** How many tabs already use the same template (0 for the first). */
  ordinal: number;
}

const MAX = 10;

function clean(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function expandDeviceName(template: string, ctx: DeviceNameContext): string {
  const t = template.trim();
  if (!t) return '';
  const hasStar = t.includes('*');
  const hasEq = t.includes('=');
  let base = t.replace(/&COMPN/gi, clean(ctx.computerName)).replace(/&USERN/gi, clean(ctx.userName)).replace(/[*=]/g, '');
  base = clean(base);
  const suffix = (hasStar ? String.fromCharCode(65 + (ctx.ordinal % 26)) : '') + (hasEq ? String(ctx.ordinal % 10) : '');
  const room = Math.max(1, MAX - suffix.length);
  return (base.slice(0, room) + suffix).slice(0, MAX);
}
