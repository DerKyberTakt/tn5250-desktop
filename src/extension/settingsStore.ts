import * as vscode from 'vscode';
import {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  diffSettings,
  resolveSettings,
  type SessionOverrides,
  type TerminalSettings,
} from '../shared/settings';

/** Where each default lives in VS Code settings (section, key). */
const DEFAULT_KEYS: Record<keyof TerminalSettings, string | undefined> = {
  name: undefined,
  host: 'connection.defaultHost',
  port: 'connection.defaultPort',
  tls: 'connection.tls',
  verifyCertificate: 'connection.verifyCertificate',
  deviceName: 'connection.deviceName',
  screenSize: 'connection.defaultScreenSize',
  codePage: 'connection.defaultCodePage',
  autoConnect: 'connection.autoConnect',
  autoReconnect: 'connection.autoReconnect',
  connectTimeoutSeconds: 'connection.connectTimeoutSeconds',
  inactivityTimeoutMinutes: 'connection.inactivityTimeoutMinutes',
  keepAlive: 'connection.keepAlive',
  autoSignon: 'connection.autoSignon',
  signonUser: 'connection.signonUser',
  demoMode: 'connection.demoMode',
  demoLabel: 'connection.demoLabel',
  demoColor: 'connection.demoColor',
  cursorStyle: 'display.cursorStyle',
  cursorBlink: 'display.cursorBlink',
  pointer: 'display.pointer',
  blinkText: 'display.blinkText',
  colorBlinkMapped: 'colors.blinkMapped',
  ruleLine: 'display.ruleLine',
  ruleLineStyle: 'display.ruleLineStyle',
  ruleLineFollowsCursor: 'display.ruleLineFollowsCursor',
  columnSeparators: 'display.columnSeparators',
  showStatusLine: 'display.showStatusLine',
  autoFit: 'font.autoFit',
  fontFamily: 'font.family',
  fontSize: 'font.size',
  fontStyle: 'font.style',
  textRendering: 'font.rendering',
  watermarkType: 'watermark.type',
  watermarkText: 'watermark.text',
  watermarkImage: 'watermark.image',
  watermarkOpacity: 'watermark.opacity',
  watermarkPosition: 'watermark.position',
  watermarkPadding: 'watermark.padding',
  colorGreen: 'colors.green',
  colorWhite: 'colors.white',
  colorRed: 'colors.red',
  colorTurquoise: 'colors.turquoise',
  colorYellow: 'colors.yellow',
  colorPink: 'colors.pink',
  colorBlue: 'colors.blue',
  colorBackground: 'colors.background',
  colorCursor: 'colors.cursor',
  colorOiaStatus: 'colors.oiaStatus',
  colorOiaInfo: 'colors.oiaInfo',
  colorOiaAttention: 'colors.oiaAttention',
  colorOiaError: 'colors.oiaError',
  colorOiaBackground: 'colors.oiaBackground',
  colorActiveField: 'colors.activeField',
  colorRuleLine: 'colors.ruleLine',
  colorColumnSeparator: 'colors.columnSeparator',
  uiMode: 'enhanced.mode',
  enhancedGradientStart: 'enhanced.gradientStart',
  enhancedGradientEnd: 'enhanced.gradientEnd',
  enhancedGradientAngle: 'enhanced.gradientAngle',
  enhancedFieldBorder: 'enhanced.fieldBorder',
  enhancedFieldFill: 'enhanced.fieldFill',
  enhancedActiveField: 'enhanced.activeField',
  enhancedCornerRadius: 'enhanced.cornerRadius',
  enhancedTextGlow: 'enhanced.textGlow',
  enhancedGlowStrength: 'enhanced.glowStrength',
  enhancedGlowColor: 'enhanced.glowColor',
  enhancedScanlines: 'enhanced.scanlines',
  enhancedPadding: 'enhanced.padding',
  pasteFieldWrap: 'edit.pasteFieldWrap',
  pasteStopAtProtected: 'edit.pasteStopAtProtected',
  pasteMoveCursorToEnd: 'edit.pasteMoveCursorToEnd',
  pasteTabMode: 'edit.pasteTabMode',
  pasteTabSpaces: 'edit.pasteTabSpaces',
  pasteTabColumns: 'edit.pasteTabColumns',
  copyTrimTrailing: 'edit.copyTrimTrailing',
  copyKeepSelection: 'edit.copyKeepSelection',
  hotspotsPF: 'hotspots.pf',
  hotspotsFP: 'hotspots.fp',
  hotspotsF: 'hotspots.f',
  hotspotsNumber: 'hotspots.number',
  hotspotsUrl: 'hotspots.url',
  hotspots3d: 'hotspots.buttons',
  enterAtCursorClick: 'hotspots.enterAtCursorClick',
  titleParts: 'tabs.titleParts',
  titleSeparator: 'tabs.titleSeparator',
  titleMaxLength: 'tabs.titleMaxLength',
  switchToNewTab: 'tabs.switchToNewTab',
  warnOnCloseMultiple: 'tabs.warnOnCloseMultiple',
  mouseWheelPaging: 'behavior.mouseWheelPaging',
  doubleClick: 'behavior.doubleClick',
  alarm: 'behavior.alarm',
  keyClick: 'behavior.keyClick',
  keymap: 'keyboard.keymap',
};

export function readDefaults(): TerminalSettings {
  const cfg = vscode.workspace.getConfiguration('tn5250');
  const out: TerminalSettings = { ...SETTINGS_DEFAULTS, keymap: {} };
  for (const key of SETTINGS_KEYS) {
    const path = DEFAULT_KEYS[key];
    if (!path) continue;
    const v = cfg.get<unknown>(path);
    if (v !== undefined && v !== null) (out as unknown as Record<string, unknown>)[key] = v;
  }
  return out;
}

export async function writeDefaults(values: TerminalSettings): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('tn5250');
  for (const key of SETTINGS_KEYS) {
    const path = DEFAULT_KEYS[key];
    if (!path) continue;
    const current = cfg.get<unknown>(path);
    const next = values[key];
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      await cfg.update(path, next, vscode.ConfigurationTarget.Global);
    }
  }
}

export function readSessions(): SessionOverrides[] {
  const stored = vscode.workspace.getConfiguration('tn5250').get<SessionOverrides[]>('sessions', []);
  return stored.filter((s) => typeof s?.host === 'string' && s.host.trim());
}

export async function writeSessions(sessions: SessionOverrides[]): Promise<void> {
  await vscode.workspace.getConfiguration('tn5250').update('sessions', sessions, vscode.ConfigurationTarget.Global);
}

/** Fully resolved settings for every saved session. */
export function resolvedSessions(): TerminalSettings[] {
  const defaults = readDefaults();
  return readSessions().map((s) => resolveSettings(defaults, s));
}

export async function saveSession(index: number, values: TerminalSettings): Promise<void> {
  const sessions = readSessions();
  const entry = diffSettings(readDefaults(), values);
  if (index >= 0 && index < sessions.length) sessions[index] = entry;
  else sessions.push(entry);
  await writeSessions(sessions);
}

export async function removeSessionAt(index: number): Promise<void> {
  const sessions = readSessions();
  sessions.splice(index, 1);
  await writeSessions(sessions);
}

/** Settings for an ad-hoc connection: the defaults with a host and port. */
export function adHocSettings(host: string, port: number): TerminalSettings {
  return resolveSettings(readDefaults(), { host, port, name: '' });
}
