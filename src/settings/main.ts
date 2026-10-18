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
type FieldSpec = { showIf?: Key; hideIf?: Key } & (
  | { kind: 'text'; key: Key; label: string; placeholder?: string }
  | { kind: 'number'; key: Key; label: string; min?: number; max?: number; step?: number }
  | { kind: 'range'; key: Key; label: string; min: number; max: number; step: number }
  | { kind: 'bool'; key: Key; label: string; note?: string }
  | { kind: 'select'; key: Key; label: string; options: Array<[string, string]> }
  | { kind: 'color'; key: Key; label: string }
  | { kind: 'file'; key: Key; label: string }
  | { kind: 'titleParts'; label: string }
  | { kind: 'heading'; label: string }
  | { kind: 'static'; label: string; text: string }
  | { kind: 'button'; label: string; text: string; message: 'setPassword' | 'exportColors' | 'importColors' | 'resetColors' }
  | { kind: 'preview' }
);

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
      { kind: 'static', label: '', text: 'Templates: &COMPN computer name, &USERN user name, * letter per open tab, = digit per open tab. Example: OD1N*= gives OD1NA0, OD1NB1, ...' },
      { kind: 'select', key: 'screenSize', label: 'Screen Size', options: [['24x80', '24x80 (IBM-3179-2)'], ['27x132', '27x132 (IBM-3477-FC)']] },
      { kind: 'select', key: 'codePage', label: 'Host Code Page', options: CODEPAGES },
      YESNO('autoConnect', 'Auto-Connect'),
      YESNO('autoReconnect', 'Auto-Reconnect'),
      { kind: 'heading', label: 'Demo / test system' },
      YESNO('demoMode', 'Demo session', 'Tilted watermark, coloured frame, DEMO in the tab title and status line.'),
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
      YESNO('autoSignon', 'Bypass signon', 'Fills the Sign On screen with the user ID and the stored password.'),
      { kind: 'text', key: 'signonUser', label: 'User ID', showIf: 'autoSignon' },
      { kind: 'button', label: 'Password', text: 'Set Password…', message: 'setPassword', showIf: 'autoSignon' },
    ],
  },
  {
    id: 'tls',
    title: 'TLS/SSL',
    group: 'Connection',
    fields: [
      { kind: 'static', label: '', text: 'Enable via the Protocol field on the Connection page.' },
      YESNO('verifyCertificate', 'Server Authentication', 'Validate the host certificate. Turn off for self-signed certificates.'),
      { kind: 'static', label: 'Client Authentication', text: 'Not supported yet.' },
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
      YESNO('autoFit', 'Font Scaling', 'Scale the screen to the tab. Off = fixed size.'),
      { kind: 'number', key: 'fontSize', label: 'Fixed Font Size', min: 6, max: 72, hideIf: 'autoFit' },
      { kind: 'select', key: 'textRendering', label: 'Antialiasing', options: [['smooth', 'Yes (smooth)'], ['crisp', 'No (crisp, pixel-aligned)']] },
      { kind: 'text', key: 'fontFamily', label: 'Font Name', placeholder: 'blank = editor font; e.g. Cascadia Mono, Consolas, Lucida Sans Typewriter' },
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
      { kind: 'file', key: 'watermarkImage', label: 'Image location' },
      { kind: 'select', key: 'watermarkPosition', label: 'Position', options: [['center', 'Center'], ['topLeft', 'Top left'], ['topRight', 'Top right'], ['bottomLeft', 'Bottom left'], ['bottomRight', 'Bottom right']] },
      { kind: 'number', key: 'watermarkPadding', label: 'Padding (px)', min: 0, max: 200 },
      { kind: 'number', key: 'watermarkOpacity', label: 'Opacity (0 - 1)', min: 0, max: 1, step: 0.05 },
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
      { kind: 'static', label: '', text: 'Enhanced mode draws a gradient background, outlines every input field, highlights the active field, shows function keys as buttons and adds a soft glow to text.' },
      { kind: 'color', key: 'enhancedGradientStart', label: 'Gradient start' },
      { kind: 'color', key: 'enhancedGradientEnd', label: 'Gradient end' },
      { kind: 'number', key: 'enhancedGradientAngle', label: 'Gradient angle (degrees)', min: 0, max: 360 },
      { kind: 'color', key: 'enhancedFieldBorder', label: 'Field border' },
      { kind: 'text', key: 'enhancedFieldFill', label: 'Field fill', placeholder: '#rrggbbaa (aa = transparency)' },
      { kind: 'color', key: 'enhancedActiveField', label: 'Active field' },
      { kind: 'number', key: 'enhancedCornerRadius', label: 'Corner radius', min: 0, max: 16 },
      YESNO('enhancedTextGlow', 'Text glow'),
      { kind: 'range', key: 'enhancedGlowStrength', label: 'Glow strength', min: 0, max: 20, step: 1, showIf: 'enhancedTextGlow' },
      { kind: 'text', key: 'enhancedGlowColor', label: 'Glow colour', placeholder: 'blank = text colour', showIf: 'enhancedTextGlow' },
      { kind: 'heading', label: 'Text highlight' },
      YESNO('enhancedTextHighlight', 'Highlight protected text', 'Labels and titles sit on gradient-filled outlined boxes with contrasting text.'),
      { kind: 'color', key: 'enhancedHighlightStart', label: 'Highlight gradient start', showIf: 'enhancedTextHighlight' },
      { kind: 'color', key: 'enhancedHighlightEnd', label: 'Highlight gradient end', showIf: 'enhancedTextHighlight' },
      { kind: 'text', key: 'enhancedHighlightText', label: 'Highlight text colour', placeholder: 'auto = black or white for contrast', showIf: 'enhancedTextHighlight' },
      { kind: 'range', key: 'enhancedHighlightOpacity', label: 'Highlight opacity', min: 0, max: 1, step: 0.05, showIf: 'enhancedTextHighlight' },
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
      YESNO('pasteFieldWrap', 'Field Wrap', 'A line break moves to the next field (off = New Line).'),
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
      { kind: 'static', label: '', text: 'Ctrl+C or Ctrl+Insert copies the selected rectangle; nothing selected copies the whole screen. Password fields are always blanked.' },
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
      { kind: 'select', key: 'doubleClick', label: 'Double-click', options: [['none', 'Does nothing'], ['enter', 'Sends Enter']] },
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
    fields: [YESNO('mouseWheelPaging', 'Mouse Wheel = Page Up / Down')],
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
  if (typeof current === 'boolean' || key === 'watermarkType' || key === 'uiMode' || key === 'blinkText') render();
  else {
    renderButtons();
    updatePreview();
  }
}

function renderNav(): HTMLElement {
  const nav = el('div', 'nav');
  const entries = el('div', 'entries');
  entries.append(el('h3', undefined, 'Profiles'));
  const mk = (label: string, index: number): void => {
    const b = el('button', 'entry' + (index === selected ? ' active' : ''), label);
    b.onclick = () => select(index);
    entries.append(b);
  };
  mk('Defaults', -1);
  sessions.forEach((s, i) => mk(s.name || s.host || `Session ${i + 1}`, i));
  const add = el('button', 'link', '+ Add connection');
  add.onclick = () => post({ type: 'addSession' });
  entries.append(add);
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
      textHighlight: v.enhancedTextHighlight,
      highlightStart: v.enhancedHighlightStart,
      highlightEnd: v.enhancedHighlightEnd,
      highlightText: v.enhancedHighlightText,
      highlightOpacity: v.enhancedHighlightOpacity,
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
    watermarkType: 'text',
    watermarkText: v.watermarkType === 'text' ? v.watermarkText : '',
    watermarkOpacity: v.watermarkOpacity,
    watermarkPosition: v.watermarkPosition,
    watermarkPadding: 4,
    underlineUrls: v.hotspotsUrl,
    keyButtons: v.hotspots3d || v.uiMode === 'enhanced',
    demoMode: v.demoMode,
    demoLabel: v.demoLabel,
    demoColor: v.demoColor,
  });
  const demo = buildDemoScreen(24, 80);
  // A few fake input fields so the preview shows boxes and the active field.
  demo.fields = [
    { start: 24 * 80 - 4 * 80 + 20, length: 10, bypass: false },
    { start: 24 * 80 - 4 * 80 + 40, length: 10, bypass: false },
  ];
  demo.cursor = { row: 20, col: 20 };
  r.resize(560, 240);
  r.setScreen(demo);
}

function renderField(f: FieldSpec): HTMLElement | undefined {
  if (f.showIf && !values[f.showIf]) return undefined;
  if (f.hideIf && values[f.hideIf]) return undefined;
  if (f.kind === 'heading') return el('h4', 'heading', f.label);
  if (f.kind === 'preview') {
    const box = el('div', 'preview');
    const c = el('canvas');
    c.id = 'preview';
    box.append(c);
    queueMicrotask(updatePreview);
    return box;
  }
  const row = el('div', 'row');
  row.append(el('label', undefined, f.label));
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
    if (f.message === 'setPassword') wrap.append(el('span', 'note', ' Stored in the VS Code secret store, never in settings.'));
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
    if (f.note) row.append(el('span', 'note', f.note));
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
    b.onclick = () => post({ type: 'browseWatermark' });
    wrap.append(i, b);
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

function renderKeyboard(): HTMLElement {
  const box = el('div', 'keyboard');
  box.append(el('p', 'note', 'Click Assign, then press the key combination. Changes apply to this profile only; sessions inherit the defaults.'));
  const map = effectiveKeymap(values.keymap);
  const keysFor = (action: KeyAction): string[] => Object.entries(map).filter(([, a]) => a === action).map(([k]) => k);
  for (const group of KEY_ACTION_GROUPS) {
    box.append(el('h4', undefined, group.title));
    const table = el('table');
    for (const [action, label] of group.actions) {
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
    box.append(table);
  }
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

function render(): void {
  app.replaceChildren();
  app.append(renderNav());
  const main = el('div', 'main');
  const p = PAGES.find((x) => x.id === page) ?? PAGES[0]!;
  const title = selected < 0 ? 'Defaults' : sessions[selected]?.name || sessions[selected]?.host || 'Session';
  main.append(el('h2', undefined, `${title} › ${p.group} › ${p.title}`));
  if (p.id === 'keyboard') main.append(renderKeyboard());
  else
    for (const f of p.fields) {
      const node = renderField(f);
      if (node) main.append(node);
    }
  const bar = el('div', 'buttons');
  bar.id = 'buttons';
  main.append(bar);
  app.append(main);
  previewRenderer = undefined;
  renderButtons();
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
  if (ev.data.type !== 'data') return;
  defaults = ev.data.defaults;
  sessions = ev.data.sessions;
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
