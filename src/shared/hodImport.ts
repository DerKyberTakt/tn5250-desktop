import { CodePage } from '../engine/codepage';
import { importKmp } from './kmpImport';
import type { ColumnSeparators, ScreenSize, SessionOverrides, TerminalSettings, WatermarkPosition } from './settings';

/**
 * Import of IBM i Access Client Solutions session profiles (.hod).
 *
 * ACS writes its 5250 session profiles in the Host On-Demand format: INI-style text
 * that starts with a `[Host On-Demand Session File]` line, followed by sections such
 * as [Terminal] with `key=value` lines. Only 5250 display sessions are imported, with
 * the values that have a matching emulator setting: the connection (host, port, TLS,
 * screen size, code page, workstation name, user profile, bypass signon), its behavior
 * (auto-connect, auto-reconnect, keep-alive, connection and inactivity timeouts,
 * type-ahead, alarm, key click), the display (rule line, column separators, status line, cursor,
 * font fit and style, watermark, the colors the profile remaps), paste and hotspot
 * options, the mouse wheel and the keyboard map stored in the profile. Everything else
 * keeps the emulator's Defaults. Passwords are never read.
 */

export type HodImport =
  | { ok: true; session: SessionOverrides; notes: string[] }
  | { ok: false; name: string; reason: string };

/** Host On-Demand session types other than the 5250 display (SessionType parameter). */
const OTHER_SESSION_TYPES: Record<string, string> = {
  '1': '3270 display session',
  '3': 'VT display session',
  '4': 'CICS gateway session',
  '5': '3270 printer session',
  '6': '5250 printer session',
};

/** Host On-Demand ScreenSize codes a 5250 display can use. */
const SCREEN_SIZES: Record<string, ScreenSize> = { '2': '24x80', '5': '27x132' };

const RULE_LINE_STYLES: ReadonlyArray<TerminalSettings['ruleLineStyle']> = ['crosshair', 'horizontal', 'vertical'];
const COLUMN_SEPARATORS: readonly ColumnSeparators[] = ['dot', 'line', 'none'];
const WATERMARK_POSITIONS: readonly WatermarkPosition[] = ['center', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'custom', 'tile'];

/** ACS hotspot switches ("enablePFNN" / "disablePFNN" ...) and the emulator setting each one sets. */
const HOTSPOTS: Record<string, 'hotspotsPF' | 'hotspotsFP' | 'hotspotsF' | 'hotspotsNumber'> = {
  showpfnn: 'hotspotsPF',
  showfpnn: 'hotspotsFP',
  showfnn: 'hotspotsF',
  shownn: 'hotspotsNumber',
};

type FieldColor = 'colorGreen' | 'colorWhite' | 'colorRed' | 'colorTurquoise' | 'colorYellow' | 'colorPink' | 'colorBlue';

/** [ColorRemap] keys of the seven 5250 field colors, as ACS names them (lower-cased). */
const FIELD_COLORS: Record<string, [FieldColor, string]> = {
  fgn: ['colorGreen', 'green'],
  fwt: ['colorWhite', 'white'],
  frd: ['colorRed', 'red'],
  ftq: ['colorTurquoise', 'turquoise'],
  fyw: ['colorYellow', 'yellow'],
  fpk: ['colorPink', 'pink'],
  fbl: ['colorBlue', 'blue'],
};

type ScreenColor =
  | 'colorBackground'
  | 'colorOiaStatus'
  | 'colorOiaInfo'
  | 'colorOiaAttention'
  | 'colorOiaError'
  | 'colorOiaBackground'
  | 'colorRuleLine'
  | 'colorColumnSeparator';

/**
 * [ColorRemap] keys of the other colors ACS and the emulator share, and the half of the
 * value each one is in: the screen and status line backgrounds keep their color in the
 * background half, the status line indicators, crosshair ruler and column separators in
 * the text half.
 */
const SCREEN_COLORS: Record<string, [ScreenColor, 'text' | 'background']> = {
  sbg: ['colorBackground', 'background'],
  osi: ['colorOiaStatus', 'text'],
  oii: ['colorOiaInfo', 'text'],
  oai: ['colorOiaAttention', 'text'],
  oei: ['colorOiaError', 'text'],
  oob: ['colorOiaBackground', 'background'],
  crc: ['colorRuleLine', 'text'],
  ccs: ['colorColumnSeparator', 'text'],
};

/** Password Prompting choices under which ACS takes the user ID from its own settings, not from the profile. */
const USER_FROM_ACS = ['1_useacssetting', '2_shared', '5_kerberos'];

/** ACS "Tab character processing" choices for paste (pasteTabOptions) and the emulator's. */
const PASTE_TAB_MODES: Record<string, TerminalSettings['pasteTabMode']> = {
  '1': 'tabStop', // tab stops every n columns
  '2': 'spaces', // replace each tab with n spaces
  '3': 'nextField', // a tab moves to the next field
};

/** The longest Inactivity Timeout the emulator takes, in minutes (a week). */
const MAX_INACTIVITY_MINUTES = 10080;

const hex = (rgb: bigint): string => `#${rgb.toString(16).padStart(6, '0')}`;

/**
 * Reads an ACS color remap value: a 64-bit number with the text RGB in bits 0-23 and the
 * background RGB in bits 32-55, both as #rrggbb. A top byte other than zero marks a
 * special value (default or mapped color), not a color.
 */
export function hodColorPair(value: string): { text: string; background: string } | undefined {
  if (!/^-?\d{1,20}$/.test(value)) return undefined;
  let v = BigInt(value);
  if (v < 0n) v += 1n << 64n;
  if (v >> 56n !== 0n) return undefined;
  return { text: hex(v & 0xffffffn), background: hex((v >> 32n) & 0xffffffn) };
}

/** Splits INI text into sections of key/value pairs; section names and keys are lower-cased. */
export function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current = new Map<string, string>();
  sections.set('', current);
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // byte order mark
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[([^\]]*)\]/.exec(line);
    if (header) {
      const name = (header[1] as string).trim().toLowerCase();
      current = sections.get(name) ?? new Map<string, string>();
      sections.set(name, current);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    current.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  return sections;
}

/**
 * An IPv4 address written with leading zeros ("10.020.3.4") as ACS reads it: each part in
 * decimal ("10.20.3.4"). Node does not take such text as an address and looks it up as a
 * host name, which fails. Anything else comes back unchanged.
 */
export function normalizeIpv4(host: string): string {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return host;
  const parts = m.slice(1).map((p) => Number(p));
  return parts.every((n) => n <= 255) ? parts.join('.') : host;
}

/** The profile name ACS shows in its Session Manager: the file name without folder or extension. */
export function hodProfileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.hod$/i, '').trim();
}

/** Reads one .hod file. `fileName` names the connection, as the ACS Session Manager does. */
export function importHod(text: string, fileName: string): HodImport {
  const name = hodProfileName(fileName);
  const ini = parseIni(text);
  const terminal = ini.get('terminal');
  const printer = ini.get('hostprintterminal');
  if (!terminal && !printer) return { ok: false, name, reason: 'not an ACS session profile' };

  const type = terminal?.get('sessiontype') || printer?.get('sessiontype') || '';
  if (type !== '2') {
    return { ok: false, name, reason: OTHER_SESSION_TYPES[type] ?? 'unknown session type' };
  }
  const get = (key: string): string => terminal?.get(key) ?? '';

  const written = get('host');
  if (!written) return { ok: false, name, reason: 'no host name' };

  const notes: string[] = [];
  const host = normalizeIpv4(written);
  if (host !== written) notes.push(`address ${written} read as ${host}, as ACS does`);
  const session: SessionOverrides = { name: name || host, host };

  const port = Number(get('port'));
  if (Number.isInteger(port) && port >= 1 && port <= 65535) session.port = port;
  session.tls = get('ssl').toLowerCase() === 'true';

  const size = get('screensize');
  if (size) {
    const screenSize = SCREEN_SIZES[size];
    session.screenSize = screenSize ?? '24x80';
    if (!screenSize) notes.push(`screen size ${size} not in 5250, 24x80 used`);
  }

  const codePage = get('codepage');
  if (codePage) {
    const ccsid = Number(codePage);
    if (CodePage.supported().includes(ccsid)) session.codePage = ccsid;
    else notes.push(`code page ${codePage} not supported, Defaults used`);
  }

  const device = get('workstationid');
  if (device) session.deviceName = device;

  // User ID of the "IBM i signon information": the profile keeps it only when Password
  // Prompting uses the session's own user name; otherwise ACS takes it from its settings.
  const user = get('acspasswordpromptusername');
  if (user && !USER_FROM_ACS.includes(get('acspasswordprompt').toLowerCase())) session.signonUser = user;

  const flag = (key: string): boolean | undefined => {
    const v = get(key).toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : undefined;
  };

  // Bypass signon (encrypted or clear text password in ACS). The profile never holds the
  // password, so it has to be saved here before the emulator can sign on. Only switched
  // on: a profile without it leaves the emulator's own choice alone.
  if (flag('ssoenabled') && /^ssobypasssignon/i.test(get('ssotype'))) {
    session.autoSignon = true;
    notes.push(session.signonUser ? 'bypass signon: set the password with Set Password' : 'bypass signon: set the user ID, then the password with Set Password');
  }
  const autoConnect = flag('autoconnect');
  if (autoConnect !== undefined) session.autoConnect = autoConnect;
  const autoReconnect = flag('autoreconnect');
  if (autoReconnect !== undefined) session.autoReconnect = autoReconnect;
  const keepAlive = flag('keepalive');
  if (keepAlive !== undefined) session.keepAlive = keepAlive;
  // Connection Timeout (seconds) in ACS; 0 means no limit there and here.
  const connectTimeout = get('connectiontimeout');
  if (/^\d{1,4}$/.test(connectTimeout)) session.connectTimeoutSeconds = Number(connectTimeout);
  // Inactivity Timeout: ACS writes it in minutes and again in milliseconds (`timeout`);
  // 0 means none there and here.
  const idleMinutes = get('panelonlytcpipinactivitytimeout');
  const idleMs = get('timeout');
  const idle = /^\d{1,5}$/.test(idleMinutes)
    ? Number(idleMinutes)
    : /^\d{1,9}$/.test(idleMs) && Number(idleMs) % 60000 === 0
      ? Number(idleMs) / 60000
      : undefined;
  if (idle !== undefined && idle <= MAX_INACTIVITY_MINUTES) session.inactivityTimeoutMinutes = idle;
  const typeAheadOff = flag('disable_session_type_ahead');
  if (typeAheadOff !== undefined) session.typeAhead = !typeAheadOff;
  const mute = flag('soundmute');
  const alarm = flag('soundalarm');
  if (mute) session.alarm = false;
  else if (alarm !== undefined) session.alarm = alarm;
  // Clicker: "normal" clicks on every key typed, as the emulator's key click does; "error",
  // the ACS default, only sounds when a key or a paste is refused, so no click here.
  const clicker = get('soundclicker').toLowerCase();
  if (clicker === 'normal' && !mute) session.keyClick = true;
  else if (mute || clicker === 'off' || clicker === 'error') session.keyClick = false;

  // Display.
  const ruleLine = flag('ruleline');
  if (ruleLine !== undefined) session.ruleLine = ruleLine;
  const ruleStyle = RULE_LINE_STYLES.find((s) => s === get('rulelinestyle'));
  if (ruleStyle) session.ruleLineStyle = ruleStyle;
  const ruleFollows = flag('rulelinefollows');
  if (ruleFollows !== undefined) session.ruleLineFollowsCursor = ruleFollows;
  const separators = COLUMN_SEPARATORS.find((s) => s === get('columnseparator'));
  if (separators) session.columnSeparators = separators;
  const statusLine = flag('oiavisible');
  if (statusLine !== undefined) session.showStatusLine = statusLine;
  const block = flag('blockcursor');
  if (block !== undefined) session.cursorStyle = block ? 'block' : 'underline';
  const blinkCursor = ini.get('blinkremap')?.get('blinkcursor')?.toLowerCase();
  if (blinkCursor === 'true' || blinkCursor === 'false') session.cursorBlink = blinkCursor === 'true';
  const autoFit = flag('autofontsize');
  if (autoFit !== undefined) session.autoFit = autoFit;
  const fontStyle = get('fontstyle');
  if (/^[0-3]$/.test(fontStyle)) session.fontStyle = Number(fontStyle) & 1 ? 'bold' : 'plain'; // Java: 1 bold, 2 italic

  // Watermark, only when the profile shows one.
  if (flag('watermark')) {
    const image = get('watermarkimagepath');
    if (flag('haveimageaswatermark') && image) {
      session.watermarkType = 'image';
      session.watermarkImage = image;
    } else if (get('watermarktext')) {
      session.watermarkType = 'text';
      session.watermarkText = get('watermarktext');
    }
    const opacity = Number(get('watermarkopacity'));
    if (get('watermarkopacity') && opacity > 0 && opacity <= 1) session.watermarkOpacity = opacity;
    const position = WATERMARK_POSITIONS.find((p) => p === get('watermarkposition'));
    if (position) session.watermarkPosition = position;
  }

  // Paste.
  const fieldWrap = flag('pastefieldwrap');
  if (fieldWrap !== undefined) session.pasteFieldWrap = fieldWrap;
  const stopAtProtected = flag('pastestopatprotectedline');
  if (stopAtProtected !== undefined) session.pasteStopAtProtected = stopAtProtected;
  const moveCursor = flag('pastemovecursor');
  if (moveCursor !== undefined) session.pasteMoveCursorToEnd = moveCursor;
  if (/^\d{1,2}$/.test(get('pastetabspaces'))) session.pasteTabSpaces = Number(get('pastetabspaces'));
  if (/^\d{1,2}$/.test(get('pastetabcolumns'))) session.pasteTabColumns = Number(get('pastetabcolumns'));
  const tabMode = PASTE_TAB_MODES[get('pastetaboptions')];
  if (tabMode) session.pasteTabMode = tabMode;

  // Hotspots.
  for (const [key, setting] of Object.entries(HOTSPOTS)) {
    const v = get(key);
    if (/^enable/i.test(v)) session[setting] = true;
    else if (/^disable/i.test(v)) session[setting] = false;
  }
  const urls = get('showurlsmode');
  if (/disable|none|off/i.test(urls)) session.hotspotsUrl = false;
  else if (/underline|button|show/i.test(urls)) session.hotspotsUrl = true;
  const enterAtCursor = flag('showenteratcursor');
  if (enterAtCursor !== undefined) session.enterAtCursorClick = enterAtCursor;

  // Mouse wheel: on with Page Up / Page Down (as the emulator does), or off.
  const wheel = flag('mousewheelenabled');
  if (wheel === false) session.mouseWheelPaging = false;
  else if (wheel && /^\[pageup\]$/i.test(get('mousewheelup')) && /^\[page?dn\]$|^\[pagedown\]$/i.test(get('mousewheeldown'))) session.mouseWheelPaging = true;

  // Keyboard map stored in the profile itself (the same [KeyRemap] format as a .kmp file).
  const keymap = importKmp(text).keymap;
  if (Object.keys(keymap).length) session.keymap = keymap;

  // Screen background, status line, crosshair ruler and column separators: one color each.
  const remap = ini.get('colorremap');
  for (const [key, [setting, half]] of Object.entries(SCREEN_COLORS)) {
    const pair = hodColorPair(remap?.get(key) ?? '');
    if (pair) session[setting] = pair[half];
  }

  // Active field: the emulator tints its background (Classic mode), as ACS does with
  // "Highlight active field" on; the text keeps its field color here.
  const active = hodColorPair(remap?.get('actf') ?? '');
  if (active && remap?.get('actfieldhilite')?.toLowerCase() === 'true') {
    session.colorActiveField = active.background;
    notes.push(`active field shown without its ${active.text} text`);
  }

  // The emulator has one color per field color and no block behind it. When ACS draws a
  // field color as dark text on a colored block (a production system in amber, say), the
  // block color becomes the text color, so the remapped look still stands out. A block in
  // the screen background color is no block at all.
  const screen = session.colorBackground ?? '#000000';
  for (const [key, [setting, label]] of Object.entries(FIELD_COLORS)) {
    const pair = hodColorPair(remap?.get(key) ?? '');
    if (!pair) continue;
    if (pair.background === '#000000' || pair.background === screen) {
      session[setting] = pair.text;
    } else if (pair.text === '#000000') {
      session[setting] = pair.background;
      notes.push(`${label} shown as ${pair.background} text (ACS: black on ${pair.background})`);
    } else {
      session[setting] = pair.text;
      notes.push(`${label} shown without its ${pair.background} block`);
    }
  }

  if (get('hostbackup1') || get('hostbackup2')) notes.push('backup hosts left out');

  return { ok: true, session, notes };
}
