import type { KeyAction, Keymap } from './keymap';
import { ACS_KEYMAP } from './keymap';

export type ScreenSize = '24x80' | '27x132';
export type CursorStyle = 'block' | 'underline';
export type ColumnSeparators = 'dot' | 'line' | 'none';
export type WatermarkPosition = 'center' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'custom' | 'tile';
export type TitlePart = 'sessionId' | 'name' | 'host' | 'dimensions' | 'deviceName';

/** Everything that describes one terminal session. Sessions inherit from the defaults. */
export interface TerminalSettings {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  /** TLS only: validate the host certificate (ACS "server authentication"). */
  verifyCertificate: boolean;
  /** TLS client authentication: none, a PKCS#12 (.pfx/.p12) file, or PEM certificate + key files. */
  tlsClientAuth: 'none' | 'pfx' | 'pem';
  tlsClientCert: string;
  tlsClientKey: string;
  deviceName: string;
  screenSize: ScreenSize;
  codePage: number;
  autoConnect: boolean;
  autoReconnect: boolean;
  connectTimeoutSeconds: number;
  /** 0 = never. */
  inactivityTimeoutMinutes: number;
  keepAlive: boolean;
  /** Fill the Sign On screen with signonUser and the stored password. */
  autoSignon: boolean;
  signonUser: string;
  /** Marks the session as a demo/test system: tilted watermark, coloured frame, tab prefix. */
  demoMode: boolean;
  demoLabel: string;
  demoColor: string;

  // Screen > Display
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  pointer: 'default' | 'crosshair';
  blinkText: 'blink' | 'hostColor' | 'mapped';
  colorBlinkMapped: string;
  ruleLine: boolean;
  ruleLineStyle: 'crosshair' | 'horizontal' | 'vertical';
  ruleLineFollowsCursor: boolean;
  columnSeparators: ColumnSeparators;
  showStatusLine: boolean;

  // Screen > Font
  autoFit: boolean;
  fontFamily: string;
  /** A font file imported through Settings > Font (loaded with @font-face). */
  fontFile: string;
  /** Used when autoFit is off. */
  fontSize: number;
  fontStyle: 'plain' | 'bold';
  textRendering: 'smooth' | 'crisp';

  // Screen > Watermark
  watermarkType: 'text' | 'image';
  watermarkText: string;
  watermarkImage: string;
  watermarkOpacity: number;
  watermarkPosition: WatermarkPosition;
  /** Distance from the edge for the corner positions; gap between marks when tiled. */
  watermarkPadding: number;
  /** Position 'custom': where the mark sits, in percent of the free space (0 = left/top, 100 = right/bottom). */
  watermarkX: number;
  watermarkY: number;
  /** Fine adjustment from the chosen position, in pixels (drag in the preview). */
  watermarkOffsetX: number;
  watermarkOffsetY: number;

  // Appearance > Colors
  colorGreen: string;
  colorWhite: string;
  colorRed: string;
  colorTurquoise: string;
  colorYellow: string;
  colorPink: string;
  colorBlue: string;
  colorBackground: string;
  colorCursor: string;
  colorOiaStatus: string;
  colorOiaInfo: string;
  colorOiaAttention: string;
  colorOiaError: string;
  colorOiaBackground: string;
  colorActiveField: string;
  colorRuleLine: string;
  /** Empty = the field's own colour. */
  colorColumnSeparator: string;

  // Appearance > Enhanced UI
  uiMode: 'classic' | 'enhanced';
  enhancedGradientStart: string;
  enhancedGradientEnd: string;
  enhancedGradientAngle: number;
  enhancedFieldBorder: string;
  enhancedFieldFill: string;
  enhancedActiveField: string;
  enhancedCornerRadius: number;
  enhancedTextGlow: boolean;
  /** Glow radius in pixels (0 = off). */
  enhancedGlowStrength: number;
  enhancedGlowColor: string;
  /** Selection highlight gradient; blank = field border to active field colour. */
  enhancedSelectionStart: string;
  enhancedSelectionEnd: string;
  /** 'auto' = black or white for contrast. */
  enhancedSelectionText: string;
  enhancedSelectionOpacity: number;
  enhancedScanlines: boolean;
  enhancedPadding: number;

  // Edit
  pasteFieldWrap: boolean;
  pasteStopAtProtected: boolean;
  pasteMoveCursorToEnd: boolean;
  pasteTabMode: 'spaces' | 'nextField' | 'tabStop';
  pasteTabSpaces: number;
  pasteTabColumns: number;
  copyTrimTrailing: boolean;
  copyKeepSelection: boolean;

  // Hotspots
  hotspotsPF: boolean;
  hotspotsFP: boolean;
  hotspotsF: boolean;
  hotspotsNumber: boolean;
  hotspotsUrl: boolean;
  hotspots3d: boolean;
  enterAtCursorClick: boolean;

  // Tabs
  titleParts: TitlePart[];
  titleSeparator: string;
  titleMaxLength: number;
  switchToNewTab: boolean;
  warnOnCloseMultiple: boolean;

  // Preferences
  mouseWheelPaging: boolean;
  typeAhead: boolean;
  alarm: boolean;
  keyClick: boolean;

  /** Key name -> action overrides on top of the ACS layout; null unbinds a key. */
  keymap: Record<string, KeyAction | null>;
}

export const SETTINGS_DEFAULTS: TerminalSettings = {
  name: '',
  host: '',
  port: 23,
  tls: false,
  verifyCertificate: true,
  tlsClientAuth: 'none',
  tlsClientCert: '',
  tlsClientKey: '',
  deviceName: '',
  screenSize: '24x80',
  codePage: 37,
  autoConnect: true,
  autoReconnect: false,
  connectTimeoutSeconds: 15,
  inactivityTimeoutMinutes: 0,
  keepAlive: true,
  autoSignon: false,
  signonUser: '',
  demoMode: false,
  demoLabel: 'DEMO',
  demoColor: '#ff9f1c',

  cursorStyle: 'block',
  cursorBlink: true,
  pointer: 'default',
  blinkText: 'blink',
  colorBlinkMapped: '#ff9040',
  ruleLine: false,
  ruleLineStyle: 'crosshair',
  ruleLineFollowsCursor: true,
  columnSeparators: 'dot',
  showStatusLine: true,

  autoFit: true,
  fontFamily: '',
  fontFile: '',
  fontSize: 14,
  fontStyle: 'plain',
  textRendering: 'smooth',

  watermarkType: 'text',
  watermarkText: '',
  watermarkImage: '',
  watermarkOpacity: 0.15,
  watermarkPosition: 'center',
  watermarkPadding: 10,
  watermarkX: 50,
  watermarkY: 50,
  watermarkOffsetX: 0,
  watermarkOffsetY: 0,

  colorGreen: '#00d060',
  colorWhite: '#f0f0f0',
  colorRed: '#ff5050',
  colorTurquoise: '#20d0d0',
  colorYellow: '#f0e040',
  colorPink: '#ff70ff',
  colorBlue: '#6a9cff',
  colorBackground: '#000000',
  colorCursor: '#f0f0f0',
  colorOiaStatus: '#8fb8ff',
  colorOiaInfo: '#f0e040',
  colorOiaAttention: '#ff8080',
  colorOiaError: '#ff5050',
  colorOiaBackground: '#101010',
  colorActiveField: '#1e2a3a',
  colorRuleLine: '#9a9a9a',
  colorColumnSeparator: '',

  uiMode: 'classic',
  enhancedGradientStart: '#0b1020',
  enhancedGradientEnd: '#1a1f3a',
  enhancedGradientAngle: 135,
  enhancedFieldBorder: '#4a6fa5',
  enhancedFieldFill: '#4a6fa520',
  enhancedActiveField: '#7aa2ff',
  enhancedCornerRadius: 4,
  enhancedTextGlow: true,
  enhancedGlowStrength: 3,
  enhancedGlowColor: '#00d060',
  enhancedSelectionStart: '#4a6fa5',
  enhancedSelectionEnd: '#7aa2ff',
  enhancedSelectionText: 'auto',
  enhancedSelectionOpacity: 0.75,
  enhancedScanlines: false,
  enhancedPadding: 24,

  pasteFieldWrap: true,
  pasteStopAtProtected: true,
  pasteMoveCursorToEnd: true,
  pasteTabMode: 'spaces',
  pasteTabSpaces: 1,
  pasteTabColumns: 4,
  copyTrimTrailing: true,
  copyKeepSelection: false,

  hotspotsPF: false,
  hotspotsFP: false,
  hotspotsF: false,
  hotspotsNumber: false,
  hotspotsUrl: true,
  hotspots3d: false,
  enterAtCursorClick: false,

  titleParts: ['sessionId', 'name'],
  titleSeparator: ' - ',
  titleMaxLength: 25,
  switchToNewTab: true,
  warnOnCloseMultiple: false,

  mouseWheelPaging: true,
  typeAhead: true,
  alarm: true,
  keyClick: false,

  keymap: {},
};

export const SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS) as Array<keyof TerminalSettings>;

/** Keys of the colour mapping, for import/export. */
export const COLOR_KEYS = SETTINGS_KEYS.filter((k) => k.startsWith('color')) as Array<keyof TerminalSettings>;

/** A saved session: only the values that differ from the defaults. */
export type SessionOverrides = Partial<TerminalSettings> & { host: string };

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function resolveSettings(defaults: TerminalSettings, overrides: Partial<TerminalSettings>): TerminalSettings {
  const out: TerminalSettings = { ...defaults, keymap: { ...defaults.keymap }, titleParts: [...defaults.titleParts] };
  for (const key of SETTINGS_KEYS) {
    const v = overrides[key];
    if (v === undefined || v === null) continue;
    if (key === 'keymap') out.keymap = { ...defaults.keymap, ...(v as Record<string, KeyAction | null>) };
    else (out as unknown as Record<string, unknown>)[key] = v;
  }
  if (!out.name) out.name = out.port === defaults.port ? out.host : `${out.host}:${out.port}`;
  return out;
}

/** Keeps only the values that differ from the defaults (plus host and name). */
export function diffSettings(defaults: TerminalSettings, values: TerminalSettings): SessionOverrides {
  const out: Partial<TerminalSettings> = {};
  for (const key of SETTINGS_KEYS) {
    if (key === 'keymap') {
      if (Object.keys(values.keymap).length) out.keymap = values.keymap;
      continue;
    }
    if (!same(values[key], defaults[key])) (out as unknown as Record<string, unknown>)[key] = values[key];
  }
  out.host = values.host;
  out.name = values.name;
  return out as SessionOverrides;
}

/** The effective keymap: ACS layout with the session's overrides applied. */
export function effectiveKeymap(overrides: Record<string, KeyAction | null>): Keymap {
  const map: Keymap = { ...ACS_KEYMAP };
  for (const [key, action] of Object.entries(overrides)) {
    if (action === null) delete map[key];
    else map[key] = action;
  }
  return map;
}

/** Builds a tab title the way ACS "Window Setup" does. */
export function buildTitle(s: TerminalSettings, sessionId: string): string {
  const parts: string[] = [];
  for (const p of s.titleParts) {
    switch (p) {
      case 'sessionId':
        parts.push(sessionId);
        break;
      case 'name':
        parts.push(s.name || s.host);
        break;
      case 'host':
        parts.push(s.host);
        break;
      case 'dimensions':
        parts.push(`[${s.screenSize}]`);
        break;
      case 'deviceName':
        if (s.deviceName) parts.push(s.deviceName);
        break;
    }
  }
  let title = parts.filter(Boolean).join(s.titleSeparator) || s.host;
  if (s.demoMode) title = `[${s.demoLabel || 'DEMO'}] ${title}`;
  return s.titleMaxLength > 0 && title.length > s.titleMaxLength ? title.slice(0, s.titleMaxLength - 1) + '…' : title;
}

/** Human labels for the keyboard page, grouped like ACS's key assignment list. */
export const KEY_ACTION_GROUPS: Array<{ title: string; actions: Array<[KeyAction, string]> }> = [
  {
    title: 'Control',
    actions: [
      ['enter', 'Enter'],
      ['fieldExit', 'Field Exit'],
      ['fieldPlus', 'Field +'],
      ['fieldMinus', 'Field -'],
      ['reset', 'Reset'],
      ['attn', 'Attention'],
      ['sysreq', 'System Request'],
      ['clear', 'Clear'],
      ['help', 'Help'],
      ['print', 'Print (host AID)'],
      ['printScreen', 'Print Screen (open as text)'],
      ['pageUp', 'Page Up (Roll Down)'],
      ['pageDown', 'Page Down (Roll Up)'],
      ['recordBackspace', 'Record Backspace'],
    ],
  },
  {
    title: 'Cursor',
    actions: [
      ['tab', 'Tab (next field)'],
      ['backtab', 'Back Tab'],
      ['home', 'Home'],
      ['newline', 'New Line'],
      ['up', 'Cursor Up'],
      ['down', 'Cursor Down'],
      ['left', 'Cursor Left'],
      ['right', 'Cursor Right'],
    ],
  },
  {
    title: 'Edit',
    actions: [
      ['insert', 'Insert'],
      ['delete', 'Delete'],
      ['backspace', 'Backspace'],
      ['eraseEof', 'Erase to End of Field'],
      ['eraseInput', 'Erase Input'],
      ['dup', 'Dup'],
      ['fieldMark', 'Field Mark'],
    ],
  },
  {
    title: 'Function keys',
    actions: Array.from({ length: 24 }, (_, i) => [`pf${i + 1}` as KeyAction, `F${i + 1}`]),
  },
];
