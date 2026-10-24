import type { KeyAction } from '../shared/keymap';
import { keyName } from '../shared/keymap';
import {
  COLOR_KEYS,
  KEY_ACTION_GROUPS,
  SETTINGS_DEFAULTS,
  buildTitle,
  effectiveKeymap,
  resolveSettings,
  type SessionOverrides,
  type TerminalSettings,
  type TitlePart,
} from '../shared/settings';
import type { HostToSettings, SettingsToHost } from '../shared/settingsProtocol';
import { buildDemoScreen } from '../engine/demoScreen';
import { Renderer } from '../webview/renderer';

const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLDivElement;

let defaults: TerminalSettings = { ...SETTINGS_DEFAULTS };
let sessions: SessionOverrides[] = [];
let selected = -1; // -1 = defaults
let values: TerminalSettings = { ...SETTINGS_DEFAULTS };
let page = 'connection';
let dirty = false;
let capturing: KeyAction | undefined;

function post(msg: SettingsToHost): void {
  vscode.postMessage(msg);
}

type Key = keyof TerminalSettings;
type FieldSpec = { showIf?: Key; hideIf?: Key; showWhen?: [Key, string[]] } & (
  | { kind: 'text'; key: Key; label: string; placeholder?: string }
  | { kind: 'number'; key: Key; label: string; min?: number; max?: number; step?: number }
  | { kind: 'range'; key: Key; label: string; min: number; max: number; step: number }
  | { kind: 'bool'; key: Key; label: string; note?: string }
  | { kind: 'select'; key: Key; label: string; options: Array<[string, string]> }
  | { kind: 'color'; key: Key; label: string }
  | { kind: 'file'; key: Key; label: string; message: 'browseWatermark' | 'browseFile' }
  | { kind: 'font'; key: Key; label: string }
  | { kind: 'watermarkPreview' }
  | { kind: 'titleParts'; label: string }
  | { kind: 'heading'; label: string }
  | { kind: 'static'; label: string; text: string }
  | { kind: 'button'; label: string; text: string; message: 'setPassword' | 'setCertPassphrase' | 'exportColors' | 'importColors' | 'resetColors' }
  | { kind: 'preview' }
);


/** Information bubbles: what each setting does, with generic examples. */
const HELP: Partial<Record<Key, string>> = {
  name: 'Name shown in the side bar and in the tab title. Example: Production, Test box.',
  host: 'Host name or IP address of the IBM i. Example: myibmi.example.com or 192.168.1.10.',
  port: 'Telnet port. 23 for plain telnet, 992 for telnet over TLS.',
  tls: 'Telnet sends everything in clear text. Telnet over TLS encrypts the session; the host must have the TLS telnet server started (usually port 992).',
  deviceName: 'Workstation (device) name requested from the host; blank lets the host assign QPADEVnnnn. Templates: &COMPN = computer name, &USERN = user name, * = a letter A-Z that differs for each open tab, = = a digit 0-9 per open tab. Example: USER*= gives USERA0 for the first tab and USERB1 for the second. If a name is already in use the tab automatically tries the next one.',
  screenSize: '24x80 negotiates an IBM-3179-2 terminal; 27x132 negotiates an IBM-3477-FC, which also shows 80-column screens.',
  codePage: 'EBCDIC code page the host uses for this session. 037 for US English; others for European keyboards and the euro sign.',
  autoConnect: 'Connect as soon as the tab opens. Off: the tab opens disconnected and you use TN5250: Reconnect.',
  autoReconnect: 'When the host closes the connection, reconnect automatically with increasing delays (2 s, 5 s, 10 s, 20 s, 30 s).',
  demoMode: 'Marks the session as a demo or test system: tilted label across the screen, coloured frame, label in the tab title and status line. Duplicate a connection and turn this on for the copy.',
  demoLabel: 'Text used for the demo watermark and badges. Example: DEMO, TEST, TRAINING.',
  demoColor: 'Colour of the demo watermark, frame and badge.',
  connectTimeoutSeconds: 'How long to wait for the host to answer the connection before giving up.',
  inactivityTimeoutMinutes: 'Disconnect after this many minutes without keyboard or host activity. 0 keeps the session open.',
  keepAlive: 'Send TCP keep-alive probes so firewalls do not drop an idle session.',
  autoSignon: 'Fill the Sign On screen automatically: the user ID and the saved password below, then Enter. Works at every system password level because it types into the screen. Without it, the saved password is still used by the other tools (desktop app: IFS, SQL).',
  signonUser: 'The IBM i user profile for this session: typed on the Sign On screen by Bypass signon, and the account the saved password belongs to. Example: USER1.',
  verifyCertificate: 'Check that the host certificate is valid and matches the host name. Turn off for self-signed certificates on internal systems.',
  tlsClientAuth: 'Present a client certificate when the host requires one (ACS "Client Authentication"). EXPERIMENTAL: implemented per the TLS and IBM i telnet specifications but not yet verified against a host that enforces client certificates; report problems with the Output channel log.',
  tlsClientCert: 'PKCS#12 (.pfx/.p12) bundle, or the PEM certificate when using separate files.',
  tlsClientKey: 'PEM private key, only for the PEM mode. The passphrase, if any, is set with the button below and kept in the secret store.',
  fontFile: 'Font file imported into the extension storage.',
  watermarkOffsetX: 'Moves the watermark left (negative) or right (positive) from its position. Drag it in the preview.',
  watermarkOffsetY: 'Moves the watermark up (negative) or down (positive) from its position. Drag it in the preview.',
  cursorStyle: 'Block fills the whole cell; Underline draws a line under it.',
  pointer: 'Mouse pointer shape over the screen.',
  cursorBlink: 'Blink the cursor. Off keeps it steady.',
  blinkText: 'How fields with the 5250 blink attribute are shown: blinking, steady in the host colour, or steady in the mapped colour below.',
  colorBlinkMapped: 'Colour used for blinking text when "Mapped colour" is selected.',
  ruleLine: 'Draws a thin guide line through the cursor row and/or column, like the ACS rule line.',
  ruleLineStyle: 'Crosshair = both lines, Horizontal = row only, Vertical = column only.',
  ruleLineFollowsCursor: 'On: the rule line moves with the cursor. Off: it stays where you last clicked.',
  columnSeparators: 'How the 5250 column separator attribute (turquoise and yellow fields) is drawn: a dot at the base of each cell, a vertical line, or nothing.',
  showStatusLine: 'Show the operator information area under the screen: connection, X SYSTEM / X II, insert mode, message waiting, cursor position.',
  autoFit: 'On: the font scales so the whole screen fits the tab (zoom with Ctrl+wheel, Ctrl+0 resets). Off: the fixed font size below is used.',
  fontSize: 'Font size in pixels when Font Scaling is off.',
  textRendering: 'Smooth = antialiased text. Crisp = cells snapped to whole pixels for sharper edges at small sizes.',
  fontFamily: 'Pick an installed font (monospaced fonts are listed first; untick the filter to see every font) or Browse to import a .ttf/.otf file, which is copied into the extension storage and loaded only for the terminal. Blank uses the VS Code editor font.',
  fontStyle: 'Plain or bold text.',
  watermarkType: 'Show text or a picture faintly over the screen, for example to mark an environment.',
  watermarkText: 'Text of the watermark. Example: PRODUCTION.',
  watermarkImage: 'Picture file (PNG, JPG, GIF, SVG, WebP) drawn as the watermark. Browse to pick it.',
  watermarkPosition: 'Where the watermark sits. Custom places it anywhere with the position sliders; Tile repeats it over the whole screen.',
  watermarkX: 'Custom position: 0 = left edge, 50 = centre, 100 = right edge. Stays in place when the window is resized.',
  watermarkY: 'Custom position: 0 = top, 50 = middle, 100 = bottom. Stays in place when the window is resized.',
  watermarkPadding: 'Corner positions: distance in pixels from the screen edge. Tile: gap between the marks.',
  watermarkOpacity: '0 = invisible, 1 = solid. 0.1 to 0.2 is a typical watermark.',
  colorGreen: 'Colour for the 5250 green attribute (normal text and most input fields).',
  colorWhite: 'Colour for the white (high intensity) attribute.',
  colorRed: 'Colour for the red attribute (errors, warnings).',
  colorTurquoise: 'Colour for the turquoise attribute (often column headings).',
  colorYellow: 'Colour for the yellow attribute (often option numbers).',
  colorPink: 'Colour for the pink attribute.',
  colorBlue: 'Colour for the blue attribute (often function key labels).',
  colorBackground: 'Screen background in Classic mode.',
  colorCursor: 'Cursor colour.',
  colorActiveField: 'Background tint of the input field that holds the cursor (Classic mode).',
  colorRuleLine: 'Colour of the rule line.',
  colorColumnSeparator: 'Colour of the column separator dots or lines. Blank uses the field colour.',
  colorOiaStatus: 'Status line: connection and cursor position.',
  colorOiaInfo: 'Status line: device name, insert mode, message waiting.',
  colorOiaAttention: 'Status line: X SYSTEM and disconnected.',
  colorOiaError: 'Status line: X II and operator error codes.',
  colorOiaBackground: 'Status line background (Classic mode).',
  uiMode: 'Classic draws the screen like a terminal. Enhanced adds a gradient background, outlined input fields, highlighted text, function keys as buttons and glow.',
  enhancedGradientStart: 'First colour of the background gradient.',
  enhancedGradientEnd: 'Second colour of the background gradient.',
  enhancedGradientAngle: 'Direction of the gradient in degrees. 0 = bottom to top, 90 = left to right, 135 = diagonal.',
  enhancedFieldBorder: 'Outline colour of input fields.',
  enhancedFieldFill: 'Fill colour of input fields. Use 8 hex digits for transparency, for example #4a6fa520.',
  enhancedActiveField: 'Outline and glow colour of the input field that holds the cursor.',
  enhancedCornerRadius: 'Rounding of field boxes, text highlights and buttons, in pixels.',
  enhancedTextGlow: 'Soft glow behind text that is not on a highlight box.',
  enhancedGlowStrength: 'Glow radius in pixels. 0 = no glow, 3 = subtle, 10+ = strong.',
  enhancedGlowColor: 'Colour of the text glow.',
  enhancedScanlines: 'Faint horizontal lines over the screen, like a CRT.',
  enhancedSelectionStart: 'Left colour of the gradient drawn behind a mouse selection or a double-clicked word. ',
  enhancedSelectionEnd: 'Right colour of the selection gradient. ',
  enhancedSelectionText: 'Text colour inside the selection. "auto" picks black or white for contrast; or enter a colour like #ffffff.',
  enhancedSelectionOpacity: 'Opacity of the selection highlight. 0 = invisible, 1 = solid.',
  enhancedPadding: 'Space around the screen in pixels so it floats like a card.',
  pasteFieldWrap: 'A line break in pasted text presses Field Exit (next field). Off: it presses New Line instead.',
  pasteStopAtProtected: 'Stop when pasted text runs into a protected area instead of leaving the keyboard in an error state.',
  pasteMoveCursorToEnd: 'Leave the cursor after the pasted text. Off: return it to where the paste started.',
  pasteTabMode: 'What a tab character in pasted text does: replaced by spaces, padded to the next tab stop, or pressed as Tab to move to the next field.',
  pasteTabSpaces: 'Spaces per tab character when tabs are replaced with spaces.',
  pasteTabColumns: 'Width of a tab stop when tabs advance to the next tab stop.',
  copyTrimTrailing: 'Remove blanks at the end of each copied line.',
  copyKeepSelection: 'Keep the selection rectangle highlighted after copying.',
  hotspotsUrl: 'Underline web addresses on the screen; a click opens them in the browser.',
  hotspotsPF: 'A click on text like PF3 presses that function key.',
  hotspotsFP: 'A click on text like FP3 presses that function key.',
  hotspotsF: 'A click on text like F3=Exit presses that function key.',
  hotspotsNumber: 'A click on a menu option number such as 15. enters that option and presses Enter.',
  hotspots3d: 'Draw function key labels as buttons so hotspots are easy to see. Always on in Enhanced mode.',
  enterAtCursorClick: 'A click moves the cursor and also presses Enter.',
  titleSeparator: 'Text placed between the parts of the tab title. Example: " - ".',
  titleMaxLength: 'Longer titles are shortened with an ellipsis. 0 = no limit.',
  switchToNewTab: 'Focus a new tab as soon as it opens. Off: it opens in the background.',
  warnOnCloseMultiple: 'Ask for confirmation when TN5250: Disconnect All would disconnect more than one tab.',
  alarm: 'Play a short tone when the host sounds the alarm.',
  keyClick: 'Play a quiet click for every key press.',
  typeAhead:
    'Keys pressed while the keyboard is locked (X SYSTEM) are kept and replayed when the host unlocks it, so you can type the next screen before it appears. An error message or Reset discards them.',
  mouseWheelPaging: 'The mouse wheel presses Page Up and Page Down (Roll). Ctrl+wheel always zooms.',
};

const YESNO = (key: Key, label: string, note?: string): FieldSpec => ({ kind: 'bool', key, label, note });
const CODEPAGES: Array<[string, string]> = [
  ['37', '037 United States'],
  ['273', '273 Germany / Austria'],
  ['500', '500 International'],
  ['1140', '1140 United States (euro)'],
  ['1141', '1141 Germany (euro)'],
  ['1142', '1142 Denmark / Norway (euro)'],
  ['1143', '1143 Finland / Sweden (euro)'],
  ['1144', '1144 Italy (euro)'],
  ['1145', '1145 Spain (euro)'],
  ['1146', '1146 United Kingdom (euro)'],
  ['1147', '1147 France (euro)'],
  ['1148', '1148 International (euro)'],
  ['1149', '1149 Iceland (euro)'],
];

const PAGES: Array<{ id: string; title: string; group: string; fields: FieldSpec[] }> = [
  {
    id: 'connection',
    title: 'Connection',
    group: 'Connection',
    fields: [
      { kind: 'text', key: 'name', label: 'Session Name' },
      { kind: 'text', key: 'host', label: 'Destination Address', placeholder: 'host name or IP address' },
      { kind: 'number', key: 'port', label: 'Destination Port', min: 1, max: 65535 },
      { kind: 'select', key: 'tls', label: 'Protocol', options: [['false', 'Telnet'], ['true', 'Telnet over TLS (telnet-ssl, usually port 992)']] },
      { kind: 'text', key: 'deviceName', label: 'Workstation ID', placeholder: 'blank = assigned by the host' },
      { kind: 'select', key: 'screenSize', label: 'Screen Size', options: [['24x80', '24x80 (IBM-3179-2)'], ['27x132', '27x132 (IBM-3477-FC)']] },
      { kind: 'select', key: 'codePage', label: 'Host Code Page', options: CODEPAGES },
      YESNO('autoConnect', 'Auto-Connect'),
      YESNO('autoReconnect', 'Auto-Reconnect'),
      { kind: 'heading', label: 'Demo / test system' },
      YESNO('demoMode', 'Demo session'),
      { kind: 'text', key: 'demoLabel', label: 'Label', showIf: 'demoMode' },
      { kind: 'color', key: 'demoColor', label: 'Colour', showIf: 'demoMode' },
    ],
  },
  {
    id: 'advanced',
    title: 'Advanced',
    group: 'Connection',
    fields: [
      { kind: 'number', key: 'connectTimeoutSeconds', label: 'Connection Timeout (seconds)', min: 1, max: 600 },
      { kind: 'number', key: 'inactivityTimeoutMinutes', label: 'Inactivity Timeout (minutes, 0 = none)', min: 0, max: 10080 },
      YESNO('keepAlive', 'Keep-Alive'),
      { kind: 'static', label: 'Enable ENPTUI', text: 'Not supported yet. Windows and menus are drawn as text by the host.' },
      { kind: 'heading', label: 'IBM i signon information' },
      YESNO('autoSignon', 'Bypass signon'),
      { kind: 'text', key: 'signonUser', label: 'User ID' },
      { kind: 'button', label: 'Password', text: 'Set Password…', message: 'setPassword' },
    ],
  },
  {
    id: 'tls',
    title: 'TLS/SSL',
    group: 'Connection',
    fields: [
      YESNO('verifyCertificate', 'Server Authentication'),
      { kind: 'heading', label: 'Client Authentication' },
      { kind: 'select', key: 'tlsClientAuth', label: 'Send a Certificate', options: [['none', 'No'], ['pfx', 'Yes, from a PKCS#12 file (.pfx / .p12)'], ['pem', 'Yes, from PEM certificate and key files']] },
      { kind: 'file', key: 'tlsClientCert', label: 'Certificate file', message: 'browseFile', showIf: 'tlsClientAuth' },
      { kind: 'file', key: 'tlsClientKey', label: 'Private key file (PEM)', message: 'browseFile', showIf: 'tlsClientAuth' },
      { kind: 'button', label: 'Passphrase', text: 'Set Passphrase…', message: 'setCertPassphrase', showIf: 'tlsClientAuth' },
    ],
  },
  {
    id: 'display',
    title: 'Display',
    group: 'Screen',
    fields: [
      { kind: 'heading', label: 'Cursor' },
      { kind: 'select', key: 'cursorStyle', label: 'Shape', options: [['block', 'Block'], ['underline', 'Underline']] },
      { kind: 'select', key: 'pointer', label: 'Pointer', options: [['default', 'Default'], ['crosshair', 'Crosshair']] },
      YESNO('cursorBlink', 'Allow blinking cursor'),
      { kind: 'select', key: 'blinkText', label: 'Show blinking text with', options: [['blink', 'Blinking text'], ['hostColor', 'Host colour (steady)'], ['mapped', 'Mapped colour']] },
      { kind: 'color', key: 'colorBlinkMapped', label: 'Mapped colour', showIf: 'blinkText' },
      { kind: 'heading', label: 'Rule line' },
      YESNO('ruleLine', 'Rule line'),
      { kind: 'select', key: 'ruleLineStyle', label: 'Style', options: [['crosshair', 'Crosshair'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical']], showIf: 'ruleLine' },
      YESNO('ruleLineFollowsCursor', 'Follows the cursor (off = last click)'),
      { kind: 'heading', label: 'Viewing' },
      { kind: 'select', key: 'columnSeparators', label: 'Column Separators', options: [['dot', 'Dot'], ['line', 'Line'], ['none', 'None']] },
      YESNO('showStatusLine', 'Status Bar (OIA)'),
    ],
  },
  {
    id: 'font',
    title: 'Font',
    group: 'Screen',
    fields: [
      YESNO('autoFit', 'Font Scaling'),
      { kind: 'number', key: 'fontSize', label: 'Fixed Font Size', min: 6, max: 72, hideIf: 'autoFit' },
      { kind: 'select', key: 'textRendering', label: 'Antialiasing', options: [['smooth', 'Yes (smooth)'], ['crisp', 'No (crisp, pixel-aligned)']] },
      { kind: 'font', key: 'fontFamily', label: 'Font Name' },
      { kind: 'select', key: 'fontStyle', label: 'Font Style', options: [['plain', 'Plain'], ['bold', 'Bold']] },
      { kind: 'preview' },
    ],
  },
  {
    id: 'watermark',
    title: 'Watermark',
    group: 'Screen',
    fields: [
      { kind: 'select', key: 'watermarkType', label: 'Watermark type', options: [['text', 'Text'], ['image', 'Image']] },
      { kind: 'text', key: 'watermarkText', label: 'Display text', placeholder: 'e.g. PRODUCTION' },
      { kind: 'file', key: 'watermarkImage', label: 'Image location', message: 'browseWatermark' },
      { kind: 'select', key: 'watermarkPosition', label: 'Position', options: [['center', 'Center'], ['topLeft', 'Top left'], ['topRight', 'Top right'], ['bottomLeft', 'Bottom left'], ['bottomRight', 'Bottom right'], ['custom', 'Custom (free position)'], ['tile', 'Tile (repeat over the screen)']] },
      { kind: 'range', key: 'watermarkX', label: 'Horizontal position (%)', min: 0, max: 100, step: 0.5, showWhen: ['watermarkPosition', ['custom']] },
      { kind: 'range', key: 'watermarkY', label: 'Vertical position (%)', min: 0, max: 100, step: 0.5, showWhen: ['watermarkPosition', ['custom']] },
      { kind: 'range', key: 'watermarkPadding', label: 'Edge distance (px)', min: 0, max: 200, step: 1, showWhen: ['watermarkPosition', ['topLeft', 'topRight', 'bottomLeft', 'bottomRight']] },
      { kind: 'range', key: 'watermarkPadding', label: 'Gap between marks (px)', min: 0, max: 200, step: 1, showWhen: ['watermarkPosition', ['tile']] },
      { kind: 'range', key: 'watermarkOffsetX', label: 'Horizontal offset (px)', min: -600, max: 600, step: 1 },
      { kind: 'range', key: 'watermarkOffsetY', label: 'Vertical offset (px)', min: -400, max: 400, step: 1 },
      { kind: 'range', key: 'watermarkOpacity', label: 'Opacity', min: 0, max: 1, step: 0.05 },
      { kind: 'watermarkPreview' },
    ],
  },
  {
    id: 'colors',
    title: 'Colors',
    group: 'Appearance',
    fields: [
      { kind: 'heading', label: 'Field colours' },
      { kind: 'color', key: 'colorGreen', label: 'Green' },
      { kind: 'color', key: 'colorWhite', label: 'White' },
      { kind: 'color', key: 'colorRed', label: 'Red' },
      { kind: 'color', key: 'colorTurquoise', label: 'Turquoise' },
      { kind: 'color', key: 'colorYellow', label: 'Yellow' },
      { kind: 'color', key: 'colorPink', label: 'Pink' },
      { kind: 'color', key: 'colorBlue', label: 'Blue' },
      { kind: 'heading', label: 'OIA colours' },
      { kind: 'color', key: 'colorOiaStatus', label: 'Status indicators' },
      { kind: 'color', key: 'colorOiaInfo', label: 'Information indicators' },
      { kind: 'color', key: 'colorOiaAttention', label: 'Attention indicators' },
      { kind: 'color', key: 'colorOiaError', label: 'Error indicators' },
      { kind: 'color', key: 'colorOiaBackground', label: 'OIA background' },
      { kind: 'heading', label: 'Other' },
      { kind: 'color', key: 'colorBackground', label: 'Screen background' },
      { kind: 'color', key: 'colorCursor', label: 'Cursor' },
      { kind: 'color', key: 'colorActiveField', label: 'Active field' },
      { kind: 'color', key: 'colorRuleLine', label: 'Crosshair ruler' },
      { kind: 'text', key: 'colorColumnSeparator', label: 'Column separator', placeholder: 'blank = field colour, or #rrggbb' },
      { kind: 'button', label: '', text: 'Export…', message: 'exportColors' },
      { kind: 'button', label: '', text: 'Import…', message: 'importColors' },
      { kind: 'button', label: '', text: 'Reset All', message: 'resetColors' },
      { kind: 'preview' },
    ],
  },
  {
    id: 'enhanced',
    title: 'Enhanced UI',
    group: 'Appearance',
    fields: [
      { kind: 'select', key: 'uiMode', label: 'Screen style', options: [['classic', 'Classic (ACS-like)'], ['enhanced', 'Enhanced (modern)']] },
      { kind: 'color', key: 'enhancedGradientStart', label: 'Gradient start' },
      { kind: 'color', key: 'enhancedGradientEnd', label: 'Gradient end' },
      { kind: 'number', key: 'enhancedGradientAngle', label: 'Gradient angle (degrees)', min: 0, max: 360 },
      { kind: 'color', key: 'enhancedFieldBorder', label: 'Field border' },
      { kind: 'text', key: 'enhancedFieldFill', label: 'Field fill', placeholder: '#rrggbbaa (aa = transparency)' },
      { kind: 'color', key: 'enhancedActiveField', label: 'Active field' },
      { kind: 'number', key: 'enhancedCornerRadius', label: 'Corner radius', min: 0, max: 16 },
      YESNO('enhancedTextGlow', 'Text glow'),
      { kind: 'range', key: 'enhancedGlowStrength', label: 'Glow strength', min: 0, max: 20, step: 1, showIf: 'enhancedTextGlow' },
      { kind: 'color', key: 'enhancedGlowColor', label: 'Glow colour', showIf: 'enhancedTextGlow' },
      { kind: 'heading', label: 'Highlight (mouse selection)' },
      { kind: 'color', key: 'enhancedSelectionStart', label: 'Gradient start' },
      { kind: 'color', key: 'enhancedSelectionEnd', label: 'Gradient end' },
      { kind: 'text', key: 'enhancedSelectionText', label: 'Text colour', placeholder: 'auto = black or white for contrast, or #rrggbb' },
      { kind: 'range', key: 'enhancedSelectionOpacity', label: 'Opacity', min: 0, max: 1, step: 0.05 },
      { kind: 'heading', label: 'Effects' },
      YESNO('enhancedScanlines', 'Scanlines'),
      { kind: 'number', key: 'enhancedPadding', label: 'Padding around the screen', min: 0, max: 120 },
      { kind: 'preview' },
    ],
  },
  {
    id: 'paste',
    title: 'Paste',
    group: 'Edit',
    fields: [
      YESNO('pasteFieldWrap', 'Field Wrap'),
      YESNO('pasteStopAtProtected', 'Stop pasting when protected line encountered'),
      YESNO('pasteMoveCursorToEnd', 'Move cursor to end of paste'),
      { kind: 'heading', label: 'Tab character processing' },
      { kind: 'select', key: 'pasteTabMode', label: 'Tab characters', options: [['spaces', 'Replace with spaces'], ['tabStop', 'Advance to next tab stop'], ['nextField', 'Paste data to fields (Tab)']] },
      { kind: 'number', key: 'pasteTabSpaces', label: 'Space(s) per tab', min: 0, max: 16 },
      { kind: 'number', key: 'pasteTabColumns', label: 'Column(s) per tab stop', min: 1, max: 32 },
    ],
  },
  {
    id: 'copy',
    title: 'Copy',
    group: 'Edit',
    fields: [
      YESNO('copyTrimTrailing', 'Trim trailing blanks'),
      YESNO('copyKeepSelection', 'Trim rectangle remains after copy'),
    ],
  },
  {
    id: 'hotspots',
    title: 'Hotspots',
    group: 'Hotspots',
    fields: [
      { kind: 'heading', label: 'URL hotspots' },
      YESNO('hotspotsUrl', 'Display URLs as hotspots (underline, click to open)'),
      { kind: 'heading', label: 'Function / number hotspots' },
      YESNO('hotspotsPF', 'PFnn'),
      YESNO('hotspotsFP', 'FPnn'),
      YESNO('hotspotsF', 'Fnn'),
      YESNO('hotspotsNumber', 'nn (menu option numbers)'),
      YESNO('hotspots3d', 'Show as 3-D buttons'),
      { kind: 'heading', label: 'Point-and-select' },
      YESNO('enterAtCursorClick', 'ENTER at cursor position (a click also presses Enter)'),
    ],
  },
  {
    id: 'title',
    title: 'Window Title',
    group: 'Tabs',
    fields: [
      { kind: 'titleParts', label: 'Tab title' },
      { kind: 'text', key: 'titleSeparator', label: 'Separator' },
      { kind: 'number', key: 'titleMaxLength', label: 'Max tab title length (0 = unlimited)', min: 0, max: 80 },
    ],
  },
  {
    id: 'tabs',
    title: 'Tab Setup',
    group: 'Tabs',
    fields: [
      YESNO('switchToNewTab', 'Switch to new tab when created'),
      YESNO('warnOnCloseMultiple', 'Send a warning when disconnecting multiple tabs'),
      { kind: 'static', label: 'New tab action', text: 'TN5250: New Tab (Ctrl+Alt+N) runs the same session as the focused tab.' },
      { kind: 'static', label: 'Tab appearance', text: 'VS Code does not allow per-tab colours, fonts or sizes; the title is composed on the Window Title page.' },
    ],
  },
  { id: 'keyboard', title: 'Keyboard', group: 'Keyboard', fields: [] },
  {
    id: 'sound',
    title: 'Sound',
    group: 'Preferences',
    fields: [YESNO('alarm', 'Sound alarm'), YESNO('keyClick', 'Keyboard clicker')],
  },
  {
    id: 'behavior',
    title: 'Behavior',
    group: 'Preferences',
    fields: [YESNO('mouseWheelPaging', 'Mouse Wheel = Page Up / Down'), YESNO('typeAhead', 'Type-ahead (buffer keys while locked)')],
  },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setValue(key: Key, raw: string | boolean | number): void {
  const current = values[key];
  let v: unknown = raw;
  if (typeof current === 'number') v = Number(raw);
  else if (typeof current === 'boolean') v = raw === true || raw === 'true';
  (values as unknown as Record<string, unknown>)[key] = v;
  dirty = true;
  if (typeof current === 'boolean' || key === 'watermarkType' || key === 'watermarkPosition' || key === 'uiMode' || key === 'blinkText') render();
  else {
    renderButtons();
    updatePreview();
  }
}

let fontStyleEl: HTMLStyleElement | undefined;
function applyFontFace(): void {
  fontStyleEl?.remove();
  fontStyleEl = undefined;
  if (!fontFace) return;
  fontStyleEl = document.createElement('style');
  fontStyleEl.textContent = `@font-face { font-family: ${JSON.stringify(fontFace.family)}; src: url(${JSON.stringify(fontFace.url)}); }`;
  document.head.append(fontStyleEl);
}

function infoBubble(text: string): HTMLElement {
  const i = el('span', 'info', '\u24D8');
  i.tabIndex = 0;
  i.setAttribute('role', 'button');
  i.setAttribute('aria-label', 'Information');
  const tip = el('span', 'tip', text);
  i.append(tip);
  return i;
}

/** Fields across all pages whose label or help text matches the search. */
function searchFields(query: string): Array<{ page: (typeof PAGES)[number]; field: FieldSpec }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: Array<{ page: (typeof PAGES)[number]; field: FieldSpec }> = [];
  for (const p of PAGES) {
    for (const f of p.fields) {
      if (f.kind === 'heading' || f.kind === 'preview' || f.kind === 'watermarkPreview' || f.kind === 'static') continue;
      const hay = [f.label, 'key' in f ? String(f.key) : '', 'key' in f ? (HELP[f.key] ?? '') : '', p.title, p.group].join(' ').toLowerCase();
      if (hay.includes(q)) out.push({ page: p, field: f });
    }
  }
  return out;
}

let searchQuery = '';
/** Filter typed into the Keyboard page's own search box. */
let keySearch = '';
let fonts: Array<{ family: string; monospace: boolean }> = [];
let watermarkImageData: string | undefined;
let fontFace: { family: string; url: string } | undefined;
let monospaceOnly = true;

function renderNav(): HTMLElement {
  const nav = el('div', 'nav');
  const search = el('input', 'search');
  search.type = 'search';
  search.placeholder = 'Search settings\u2026';
  search.value = searchQuery;
  search.oninput = () => {
    searchQuery = search.value;
    const main = document.getElementById('main');
    if (main) renderMain(main);
  };
  nav.append(search);
  const entries = el('div', 'entries');
  entries.append(el('h3', undefined, 'Profiles'));
  const mk = (label: string, index: number): void => {
    const b = el('button', 'entry' + (index === selected ? ' active' : ''), label);
    b.onclick = () => {
      select(index);
      // The watermark image and imported font of this profile come from the host.
      post({ type: 'select', index });
    };
    entries.append(b);
  };
  mk('Defaults', -1);
  sessions.forEach((s, i) => mk(s.name || s.host || `Session ${i + 1}`, i));
  const add = el('button', 'link', '+ Add connection');
  add.onclick = () => post({ type: 'addSession' });
  entries.append(add);
  if (selected >= 0) {
    const copy = el('button', 'link', '⎘ Copy connection');
    copy.title = 'New connection with all the settings of the selected one: change its name and host, keep the rest.';
    copy.onclick = () => post({ type: 'copySession', index: selected });
    entries.append(copy);
  }
  nav.append(entries);

  const tree = el('div', 'tree');
  let group = '';
  for (const p of PAGES) {
    if (p.group !== group) {
      group = p.group;
      tree.append(el('div', 'group', group));
    }
    const b = el('button', 'page' + (p.id === page ? ' active' : ''), p.title);
    b.onclick = () => {
      searchQuery = '';
      page = p.id;
      render();
    };
    tree.append(b);
  }
  nav.append(tree);
  return nav;
}

function colorInput(key: Key): HTMLElement {
  const wrap = el('span', 'colorrow');
  const current = String(values[key] ?? '');
  const c = el('input');
  c.type = 'color';
  c.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : '#000000';
  const t = el('input');
  t.type = 'text';
  t.value = current;
  t.className = 'hex';
  c.oninput = () => {
    t.value = c.value;
    setValue(key, c.value);
  };
  t.oninput = () => {
    if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(t.value) || t.value === '') {
      if (t.value.length === 7) c.value = t.value;
      setValue(key, t.value);
    }
  };
  wrap.append(c, t);
  return wrap;
}

let previewRenderer: Renderer | undefined;
function updatePreview(): void {
  const canvas = document.getElementById('preview') as HTMLCanvasElement | null;
  if (!canvas) return;
  previewRenderer ??= new Renderer(canvas);
  const r = previewRenderer;
  const v = values;
  r.setTheme({
    background: v.colorBackground,
    cursor: v.colorCursor,
    colors: { green: v.colorGreen, white: v.colorWhite, red: v.colorRed, turquoise: v.colorTurquoise, yellow: v.colorYellow, pink: v.colorPink, blue: v.colorBlue },
    activeField: v.colorActiveField,
    ruleLine: v.colorRuleLine,
    columnSeparator: v.colorColumnSeparator,
    blinkMapped: v.colorBlinkMapped,
    enhanced: {
      gradientStart: v.enhancedGradientStart,
      gradientEnd: v.enhancedGradientEnd,
      gradientAngle: v.enhancedGradientAngle,
      fieldBorder: v.enhancedFieldBorder,
      fieldFill: v.enhancedFieldFill,
      activeField: v.enhancedActiveField,
      cornerRadius: v.enhancedCornerRadius,
      textGlow: v.enhancedTextGlow,
      glowStrength: v.enhancedGlowStrength,
      glowColor: v.enhancedGlowColor,
      selectionStart: v.enhancedSelectionStart,
      selectionEnd: v.enhancedSelectionEnd,
      selectionText: v.enhancedSelectionText,
      selectionOpacity: v.enhancedSelectionOpacity,
      scanlines: v.enhancedScanlines,
      padding: Math.min(12, v.enhancedPadding),
    },
  });
  r.setOptions({
    uiMode: v.uiMode,
    autoFit: true,
    fontFamily: v.fontFamily,
    fontSize: v.fontSize,
    fontStyle: v.fontStyle,
    textRendering: v.textRendering,
    columnSeparators: v.columnSeparators,
    cursorStyle: v.cursorStyle,
    cursorBlink: false,
    blinkText: v.blinkText,
    ruleLine: v.ruleLine,
    ruleLineStyle: v.ruleLineStyle,
    highlightActiveField: v.uiMode === 'classic',
    watermarkType: v.watermarkType,
    watermarkText: v.watermarkText,
    watermarkOpacity: v.watermarkOpacity,
    watermarkPosition: v.watermarkPosition,
    watermarkPadding: Math.round(v.watermarkPadding / 2),
    watermarkX: v.watermarkX,
    watermarkY: v.watermarkY,
    watermarkOffsetX: Math.round(v.watermarkOffsetX / 2),
    watermarkOffsetY: Math.round(v.watermarkOffsetY / 2),
    underlineUrls: v.hotspotsUrl,
    keyButtons: v.hotspots3d || v.uiMode === 'enhanced',
    demoMode: v.demoMode,
    demoLabel: v.demoLabel,
    demoColor: v.demoColor,
  });
  r.setWatermarkImage(watermarkImageData ?? '');
  const demo = buildDemoScreen(24, 80);
  // A few fake input fields so the preview shows boxes and the active field.
  demo.fields = [
    { start: 24 * 80 - 4 * 80 + 20, length: 10, bypass: false },
    { start: 24 * 80 - 4 * 80 + 40, length: 10, bypass: false },
  ];
  demo.cursor = { row: 20, col: 20 };
  // 80 columns at ~7 px per cell fills the 560 px preview; keep rows readable.
  r.resize(560, 24 * 8.4);
  r.setScreen(demo);
}

function renderField(f: FieldSpec): HTMLElement | undefined {
  if (f.showIf && !values[f.showIf]) return undefined;
  if (f.showWhen && !f.showWhen[1].includes(String(values[f.showWhen[0]]))) return undefined;
  if (f.hideIf && values[f.hideIf]) return undefined;
  if (f.kind === 'heading') return el('h4', 'heading', f.label);
  if (f.kind === 'watermarkPreview') {
    const box = el('div', 'preview');
    const c = el('canvas');
    c.id = 'preview';
    c.title = 'Drag the watermark to adjust its offset';
    box.append(c);
    let drag: { x: number; y: number; ox: number; oy: number } | undefined;
    c.onmousedown = (e) => {
      drag = { x: e.clientX, y: e.clientY, ox: values.watermarkOffsetX, oy: values.watermarkOffsetY };
    };
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      // The preview is 560 px wide for an 80-column screen; scale to full-size pixels.
      const scale = 2;
      values.watermarkOffsetX = Math.round(drag.ox + (e.clientX - drag.x) * scale);
      values.watermarkOffsetY = Math.round(drag.oy + (e.clientY - drag.y) * scale);
      dirty = true;
      updatePreview();
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = undefined;
      render();
    });
    queueMicrotask(updatePreview);
    return box;
  }
  if (f.kind === 'preview') {
    const box = el('div', 'preview');
    const c = el('canvas');
    c.id = 'preview';
    box.append(c);
    queueMicrotask(updatePreview);
    return box;
  }
  const row = el('div', 'row');
  const label = el('label', undefined, f.label);
  const helpText = 'key' in f ? HELP[f.key] : f.kind === 'button' && f.message === 'setPassword' ? 'Kept in the secret store (VS Code secret storage, or the Windows Credential Manager / keyring in the desktop app), never in settings or files.' : f.kind === 'titleParts' ? 'Parts of the tab title, in this order. The session ID is a letter A, B, C per open tab, like ACS.' : undefined;
  if (helpText) label.append(infoBubble(helpText));
  row.append(label);
  if (f.kind === 'static') {
    row.append(el('span', 'static', f.text));
    return row;
  }
  if (f.kind === 'button') {
    const b = el('button', 'secondary', f.text);
    b.onclick = () => {
      if (f.message === 'resetColors') {
        for (const k of COLOR_KEYS) (values as unknown as Record<string, unknown>)[k] = SETTINGS_DEFAULTS[k];
        dirty = true;
        render();
      } else if (f.message === 'exportColors') {
        const out: Record<string, string> = {};
        for (const k of COLOR_KEYS) out[k] = String(values[k]);
        post({ type: 'exportColors', values: out });
      } else post({ type: f.message, target: selected });
    };
    const wrap = el('span');
    wrap.append(b);
    row.append(wrap);
    return row;
  }
  if (f.kind === 'titleParts') {
    const wrap = el('div', 'titleparts');
    const all: Array<[TitlePart, string]> = [
      ['sessionId', 'Session ID (A, B, C...)'],
      ['name', 'Session Name'],
      ['host', 'Host'],
      ['dimensions', 'Session Dimensions'],
      ['deviceName', 'Workstation ID'],
    ];
    for (const [part, label] of all) {
      const lab = el('label', 'check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = values.titleParts.includes(part);
      cb.onchange = () => {
        values.titleParts = cb.checked ? [...values.titleParts, part] : values.titleParts.filter((p) => p !== part);
        dirty = true;
        render();
      };
      lab.append(cb, document.createTextNode(label));
      wrap.append(lab);
    }
    wrap.append(el('div', 'note', `Preview: ${buildTitle({ ...values, name: values.name || 'Session', host: values.host || 'host' }, 'A')}`));
    row.append(wrap);
    return row;
  }
  const key = f.key;
  if (f.kind === 'bool') {
    const wrap = el('span', 'radios');
    for (const [v, label] of [
      [true, 'Yes'],
      [false, 'No'],
    ] as Array<[boolean, string]>) {
      const lab = el('label', 'radio');
      const r = el('input');
      r.type = 'radio';
      r.name = String(key);
      r.checked = values[key] === v;
      r.onchange = () => setValue(key, v);
      lab.append(r, document.createTextNode(label));
      wrap.append(lab);
    }
    row.append(wrap);
    return row;
  }
  if (f.kind === 'select') {
    const s = el('select');
    for (const [v, label] of f.options) {
      const o = el('option', undefined, label);
      o.value = v;
      o.selected = String(values[key]) === v;
      s.append(o);
    }
    s.onchange = () => setValue(key, s.value);
    row.append(s);
    return row;
  }
  if (f.kind === 'color') {
    row.append(colorInput(key));
    return row;
  }
  if (f.kind === 'file') {
    const wrap = el('span', 'filerow');
    const i = el('input');
    i.type = 'text';
    i.value = String(values[key] ?? '');
    i.oninput = () => setValue(key, i.value);
    const b = el('button', 'secondary', 'Browse…');
    b.onclick = () => (f.message === 'browseFile' ? post({ type: 'browseFile', key: key as 'tlsClientCert' | 'tlsClientKey' }) : post({ type: 'browseWatermark' }));
    wrap.append(i, b);
    row.append(wrap);
    return row;
  }
  if (f.kind === 'font') {
    const wrap = el('div', 'fontrow');
    const s = el('select');
    const current = String(values.fontFamily ?? '');
    const add = (v: string, label: string): void => {
      const o = el('option', undefined, label);
      o.value = v;
      o.selected = v === current;
      s.append(o);
    };
    add('', 'Editor font (default)');
    if (current && !fonts.some((x) => x.family === current)) add(current, `${current} (not installed)`);
    for (const x of fonts) if (!monospaceOnly || x.monospace) add(x.family, x.monospace ? x.family : `${x.family} (proportional)`);
    s.onchange = () => {
      values.fontFile = '';
      setValue('fontFamily', s.value);
    };
    const filter = el('label', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = monospaceOnly;
    cb.onchange = () => {
      monospaceOnly = cb.checked;
      render();
    };
    filter.append(cb, document.createTextNode('Monospaced fonts only'));
    const browse = el('button', 'iconbtn', '📁');
    browse.title = 'Browse for a font file (.ttf / .otf) to import';
    browse.setAttribute('aria-label', 'Browse font file');
    browse.onclick = () => post({ type: 'browseFont' });
    wrap.append(s, browse, filter);
    if (values.fontFile) wrap.append(el('span', 'note', `Imported: ${values.fontFile}`));
    row.append(wrap);
    return row;
  }
  if (f.kind === 'range') {
    const wrap = el('span', 'rangerow');
    const r = el('input');
    r.type = 'range';
    r.min = String(f.min);
    r.max = String(f.max);
    r.step = String(f.step);
    r.value = String(values[key]);
    const out = el('span', 'rangeval', String(values[key]));
    r.oninput = () => {
      out.textContent = r.value;
      setValue(key, r.value);
    };
    wrap.append(r, out);
    row.append(wrap);
    return row;
  }
  const i = el('input');
  i.type = f.kind === 'number' ? 'number' : 'text';
  i.value = String(values[key] ?? '');
  if (f.kind === 'number') {
    if (f.min !== undefined) i.min = String(f.min);
    if (f.max !== undefined) i.max = String(f.max);
    if (f.step !== undefined) i.step = String(f.step);
  } else if (f.placeholder) i.placeholder = f.placeholder;
  i.oninput = () => setValue(key, i.value);
  row.append(i);
  return row;
}

/**
 * The key assignment tables, one per group, keeping only the actions whose label, id or
 * bound key contains `query` (case-insensitive); empty groups are left out.
 */
function renderKeyTables(query: string): HTMLElement[] {
  const q = query.trim().toLowerCase();
  const map = effectiveKeymap(values.keymap);
  const keysFor = (action: KeyAction): string[] => Object.entries(map).filter(([, a]) => a === action).map(([k]) => k);
  const out: HTMLElement[] = [];
  for (const group of KEY_ACTION_GROUPS) {
    const rows = group.actions.filter(([action, label]) => !q || [action, label, ...keysFor(action)].join(' ').toLowerCase().includes(q));
    if (!rows.length) continue;
    out.push(el('h4', undefined, group.title));
    const table = el('table');
    for (const [action, label] of rows) {
      const tr = el('tr');
      tr.append(el('td', 'fn', label));
      const td = el('td', 'keys');
      for (const k of keysFor(action)) {
        const chip = el('span', 'chip', k);
        const x = el('button', 'x', '×');
        x.title = 'Unassign';
        x.onclick = () => {
          values.keymap = { ...values.keymap, [k]: null };
          dirty = true;
          render();
        };
        chip.append(x);
        td.append(chip);
      }
      tr.append(td);
      const act = el('td', 'assign');
      const b = el('button', undefined, capturing === action ? 'Press a key…' : 'Assign');
      b.onclick = () => {
        capturing = action;
        render();
      };
      act.append(b);
      tr.append(act);
      table.append(tr);
    }
    out.push(table);
  }
  return out;
}

function renderKeyboard(): HTMLElement {
  const box = el('div', 'keyboard');
  box.append(el('p', 'note', 'Click Assign, then press the key combination. Changes apply to this profile only; sessions inherit the defaults.'));
  const search = el('input', 'search');
  search.type = 'search';
  search.placeholder = 'Find a key or function (e.g. F13, field exit, End)\u2026';
  search.value = keySearch;
  const tables = el('div', 'tables');
  const fill = (): void => {
    const nodes = renderKeyTables(keySearch);
    tables.replaceChildren(...(nodes.length ? nodes : [el('p', 'note', 'No keys or functions match.')]));
  };
  search.oninput = () => {
    keySearch = search.value;
    fill();
  };
  box.append(search, tables);
  fill();
  const imp = el('button', 'secondary', 'Import ACS keyboard map (.kmp)…');
  imp.onclick = () => post({ type: 'importKmp', target: selected });
  box.append(imp);
  const reset = el('button', 'secondary', 'Reset all keys to the ACS layout');
  reset.onclick = () => {
    values.keymap = {};
    dirty = true;
    render();
  };
  box.append(reset);
  return box;
}

function renderButtons(): void {
  const bar = document.getElementById('buttons');
  if (!bar) return;
  bar.replaceChildren();
  const save = el('button', 'primary', selected < 0 ? 'Save Defaults' : 'Save Session');
  save.disabled = !dirty;
  save.onclick = () => post({ type: 'save', target: selected, values });
  bar.append(save);
  const cancel = el('button', 'secondary', 'Revert');
  cancel.disabled = !dirty;
  cancel.onclick = () => select(selected);
  bar.append(cancel);
  if (selected >= 0) {
    const connect = el('button', 'secondary', 'Connect');
    connect.onclick = () => post({ type: 'connect', index: selected });
    bar.append(connect);
    const remove = el('button', 'secondary danger', 'Remove Connection');
    remove.onclick = () => post({ type: 'removeSession', index: selected });
    bar.append(remove);
  }
  const json = el('button', 'link', 'Open in VS Code Settings');
  json.onclick = () => post({ type: 'openJson' });
  bar.append(json);
}

function renderMain(main: HTMLElement): void {
  main.replaceChildren();
  const title = selected < 0 ? 'Defaults' : sessions[selected]?.name || sessions[selected]?.host || 'Session';
  if (searchQuery.trim()) {
    main.append(el('h2', undefined, `${title} › Search: ${searchQuery.trim()}`));
    const hits = searchFields(searchQuery);
    const keyTables = renderKeyTables(searchQuery);
    if (!hits.length && !keyTables.length) main.append(el('p', 'note', 'No settings match.'));
    let lastPage = '';
    for (const hit of hits) {
      if (hit.page.id !== lastPage) {
        lastPage = hit.page.id;
        const h = el('h4', 'heading link', `${hit.page.group} › ${hit.page.title}`);
        h.onclick = () => {
          searchQuery = '';
          page = hit.page.id;
          render();
        };
        main.append(h);
      }
      const node = renderField({ ...hit.field, showIf: undefined, hideIf: undefined });
      if (node) main.append(node);
    }
    if (keyTables.length) {
      const h = el('h4', 'heading link', 'Keyboard › Keyboard');
      h.onclick = () => {
        keySearch = searchQuery.trim();
        searchQuery = '';
        page = 'keyboard';
        render();
      };
      main.append(h);
      const box = el('div', 'keyboard');
      box.append(...keyTables);
      main.append(box);
    }
  } else {
    const p = PAGES.find((x) => x.id === page) ?? PAGES[0]!;
    main.append(el('h2', undefined, `${title} › ${p.group} › ${p.title}`));
    if (p.id === 'keyboard') main.append(renderKeyboard());
    else
      for (const f of p.fields) {
        const node = renderField(f);
        if (node) main.append(node);
      }
  }
  const bar = el('div', 'buttons');
  bar.id = 'buttons';
  main.append(bar);
  previewRenderer = undefined;
  renderButtons();
}

function render(): void {
  app.replaceChildren();
  app.append(renderNav());
  const main = el('div', 'main');
  main.id = 'main';
  app.append(main);
  renderMain(main);
}

function select(index: number): void {
  selected = index;
  values = index < 0 ? { ...defaults, keymap: { ...defaults.keymap }, titleParts: [...defaults.titleParts] } : resolveSettings(defaults, sessions[index] ?? { host: '' });
  if (index >= 0) values.keymap = { ...(sessions[index]?.keymap ?? {}) };
  dirty = false;
  capturing = undefined;
  render();
}

window.addEventListener('message', (ev: MessageEvent<HostToSettings>) => {
  if (ev.data.type === 'assets') {
    if (ev.data.select !== selected) return; // a later click already moved on
    watermarkImageData = ev.data.watermarkImageData;
    fontFace = ev.data.fontFace;
    applyFontFace();
    updatePreview();
    return;
  }
  if (ev.data.type !== 'data') return;
  defaults = ev.data.defaults;
  sessions = ev.data.sessions;
  if (ev.data.fonts) fonts = ev.data.fonts;
  watermarkImageData = ev.data.watermarkImageData;
  fontFace = ev.data.fontFace;
  applyFontFace();
  if (ev.data.patch) {
    // Keep the user's unsaved edits and apply the browse/import result.
    Object.assign(values, ev.data.patch);
    dirty = true;
    render();
    return;
  }
  select(Math.min(ev.data.select, sessions.length - 1));
});

window.addEventListener(
  'keydown',
  (e) => {
    if (!capturing) return;
    const info = { key: e.key, code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key) && !(e.code === 'ControlLeft' || e.code === 'ControlRight')) return;
    e.preventDefault();
    e.stopPropagation();
    values.keymap = { ...values.keymap, [keyName(info)]: capturing };
    capturing = undefined;
    dirty = true;
    render();
  },
  { capture: true },
);

post({ type: 'ready' });
