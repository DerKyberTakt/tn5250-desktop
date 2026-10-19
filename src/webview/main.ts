import type { ConnectionStatus, HostToWebview, OiaState, TerminalConfig, WebviewToHost } from '../shared/protocol';
import { DEFAULT_OIA } from '../shared/protocol';
import { classifyKey, keyName, type Keymap } from '../shared/keymap';
import { expandTabs, fieldRanges, hotspotAt, urlAt, wordAt } from '../shared/screenText';
import { SETTINGS_DEFAULTS, effectiveKeymap } from '../shared/settings';
import { describeKey, isPassThrough, toKeyEventInfo, zoomActionFor } from './keyboard';
import { Renderer } from './renderer';

const vscode = acquireVsCodeApi();

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const terminal = byId<HTMLDivElement>('terminal');
const viewport = byId<HTMLDivElement>('viewport');
const canvas = byId<HTMLCanvasElement>('screen');
const oiaEl = byId<HTMLDivElement>('oia');
const keylog = byId<HTMLPreElement>('keylog');

const renderer = new Renderer(canvas);
let config: TerminalConfig = { settings: SETTINGS_DEFAULTS, keyOverlay: false };
let oia: OiaState = DEFAULT_OIA;
let status: ConnectionStatus = 'idle';
let statusDetail = '';
let keymap: Keymap = effectiveKeymap({});
const keyLines: string[] = [];

function post(message: WebviewToHost): void {
  vscode.postMessage(message);
}

function logKey(line: string): void {
  if (!config.keyOverlay) return;
  keyLines.push(line);
  while (keyLines.length > 12) keyLines.shift();
  keylog.textContent = keyLines.join('\n');
}

function statusText(): string {
  switch (status) {
    case 'connected':
      return `● ${statusDetail}`;
    case 'connecting':
      return `… Connecting to ${statusDetail}`;
    case 'disconnected':
      return `○ Disconnected: ${statusDetail}`;
    default:
      return '○ Not connected';
  }
}

function pill(text: string, cls: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `pill ${cls}`;
  el.textContent = text;
  return el;
}

function renderOia(): void {
  oiaEl.replaceChildren();
  const left = document.createElement('span');
  left.className = 'left';
  if (config.settings.demoMode) left.append(pill(config.settings.demoLabel || 'DEMO', 'demo'));
  left.append(pill(statusText(), status === 'connected' ? 'status' : 'attention'));
  if (oia.deviceName) left.append(pill(oia.deviceName, 'info'));
  if (oia.inputInhibited === 'system') left.append(pill('X SYSTEM', 'attention'));
  if (oia.inputInhibited === 'error') left.append(pill('X II  (Reset = Left Ctrl, or click / arrow keys)', 'error'));
  if (oia.insert) left.append(pill('INS', 'info'));
  if (oia.messageWaiting) left.append(pill('MW', 'info'));
  const right = document.createElement('span');
  right.className = 'right';
  const cursor = renderer.cursor;
  if (oia.message) right.append(pill(oia.message, oia.inputInhibited === 'error' ? 'error' : 'info'));
  if (cursor) right.append(pill(`${cursor.row + 1}/${cursor.col + 1}`, 'status'));
  oiaEl.append(left, right);
  oiaEl.classList.toggle('error', oia.inputInhibited === 'error');
}

let fontStyleEl: HTMLStyleElement | undefined;
function applyFontFace(face: { family: string; url: string } | undefined): void {
  fontStyleEl?.remove();
  fontStyleEl = undefined;
  if (!face) return;
  fontStyleEl = document.createElement('style');
  fontStyleEl.textContent = `@font-face { font-family: ${JSON.stringify(face.family)}; src: url(${JSON.stringify(face.url)}); }`;
  document.head.append(fontStyleEl);
  void document.fonts.load(`16px ${JSON.stringify(face.family)}`).then(() => renderer.setOptions({}));
}

function applyConfig(): void {
  const st = config.settings;
  const root = document.documentElement.style;
  keymap = effectiveKeymap(st.keymap ?? {});
  renderer.setTheme({
    background: st.colorBackground,
    cursor: st.colorCursor,
    colors: {
      green: st.colorGreen,
      white: st.colorWhite,
      red: st.colorRed,
      turquoise: st.colorTurquoise,
      yellow: st.colorYellow,
      pink: st.colorPink,
      blue: st.colorBlue,
    },
    activeField: st.colorActiveField,
    ruleLine: st.colorRuleLine,
    columnSeparator: st.colorColumnSeparator,
    blinkMapped: st.colorBlinkMapped,
    enhanced: {
      gradientStart: st.enhancedGradientStart,
      gradientEnd: st.enhancedGradientEnd,
      gradientAngle: st.enhancedGradientAngle,
      fieldBorder: st.enhancedFieldBorder,
      fieldFill: st.enhancedFieldFill,
      activeField: st.enhancedActiveField,
      cornerRadius: st.enhancedCornerRadius,
      textGlow: st.enhancedTextGlow,
      glowStrength: st.enhancedGlowStrength,
      glowColor: st.enhancedGlowColor,
      selectionStart: st.enhancedSelectionStart,
      selectionEnd: st.enhancedSelectionEnd,
      selectionText: st.enhancedSelectionText,
      selectionOpacity: st.enhancedSelectionOpacity,
      scanlines: st.enhancedScanlines,
      padding: st.enhancedPadding,
    },
  });
  renderer.setOptions({
    uiMode: st.uiMode,
    autoFit: st.autoFit,
    fontFamily: st.fontFamily,
    fontSize: st.fontSize,
    fontStyle: st.fontStyle,
    textRendering: st.textRendering,
    columnSeparators: st.columnSeparators,
    cursorStyle: st.cursorStyle,
    cursorBlink: st.cursorBlink,
    blinkText: st.blinkText,
    ruleLine: st.ruleLine,
    ruleLineStyle: st.ruleLineStyle,
    ruleLineFollowsCursor: st.ruleLineFollowsCursor,
    highlightActiveField: st.uiMode === 'classic' && st.colorActiveField !== st.colorBackground,
    watermarkType: st.watermarkType,
    watermarkText: st.watermarkText,
    watermarkOpacity: st.watermarkOpacity,
    watermarkPosition: st.watermarkPosition,
    watermarkPadding: st.watermarkPadding,
    watermarkX: st.watermarkX,
    watermarkY: st.watermarkY,
    watermarkOffsetX: st.watermarkOffsetX,
    watermarkOffsetY: st.watermarkOffsetY,
    underlineUrls: st.hotspotsUrl,
    keyButtons: st.hotspots3d || st.uiMode === 'enhanced',
    demoMode: st.demoMode,
    demoLabel: st.demoLabel,
    demoColor: st.demoColor,
  });
  root.setProperty('--demo-color', st.demoColor);
  renderer.setWatermarkImage(config.watermarkImageData ?? '');
  applyFontFace(config.fontFace);
  const crosshair = st.pointer === 'crosshair';
  canvas.style.cursor = crosshair ? 'crosshair' : 'default';
  viewport.style.cursor = crosshair ? 'crosshair' : 'default';
  document.body.classList.toggle('pointer-crosshair', crosshair);
  root.setProperty('--oia-status', st.colorOiaStatus);
  root.setProperty('--oia-info', st.colorOiaInfo);
  root.setProperty('--oia-attention', st.colorOiaAttention);
  root.setProperty('--oia-error', st.colorOiaError);
  root.setProperty('--oia-bg', st.colorOiaBackground);
  const bg = st.uiMode === 'enhanced' ? st.enhancedGradientStart : st.colorBackground;
  document.body.style.background = bg;
  terminal.style.background = bg;
  document.body.classList.toggle('enhanced', st.uiMode === 'enhanced');
  oiaEl.hidden = !st.showStatusLine;
  keylog.hidden = !config.keyOverlay;
  if (!config.keyOverlay) {
    keyLines.length = 0;
    keylog.textContent = '';
  }
  if (st.host) vscode.setState({ profile: st });
  renderOia();
}

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'screen':
      lastScreen = { rows: msg.screen.rows, cols: msg.screen.cols, fields: msg.screen.fields };
      renderer.setScreen(msg.screen);
      renderOia();
      break;
    case 'oia':
      oia = msg.oia;
      renderOia();
      break;
    case 'config':
      config = msg.config;
      applyConfig();
      break;
    case 'status':
      status = msg.status;
      statusDetail = msg.detail;
      renderOia();
      break;
    case 'alarm':
      beep(880, 0.15);
      break;
    case 'paste':
      pasteText(msg.text);
      break;
  }
});

new ResizeObserver(() => {
  renderer.resize(viewport.clientWidth, viewport.clientHeight);
}).observe(viewport);

let audio: AudioContext | undefined;
function beep(freq: number, seconds: number): void {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.value = seconds < 0.05 ? 0.03 : 0.08;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + seconds);
  } catch {
    // no audio device
  }
}

/** Shift+Arrow selection, anchored at the cursor when it starts. */
let keyAnchor: { row: number; col: number } | undefined;
let keyEnd: { row: number; col: number } | undefined;
function extendKeyboardSelection(key: string): void {
  const size = renderer.size;
  const cursor = renderer.cursor;
  if (!size || !cursor) return;
  if (!keyAnchor) {
    keyAnchor = { ...cursor };
    keyEnd = { ...cursor };
    renderer.startSelection(cursor.row, cursor.col);
  }
  const end = keyEnd ?? cursor;
  const next = { row: end.row, col: end.col };
  if (key === 'ArrowUp') next.row = Math.max(0, end.row - 1);
  if (key === 'ArrowDown') next.row = Math.min(size.rows - 1, end.row + 1);
  if (key === 'ArrowLeft') next.col = Math.max(0, end.col - 1);
  if (key === 'ArrowRight') next.col = Math.min(size.cols - 1, end.col + 1);
  keyEnd = next;
  renderer.extendSelection(next.row, next.col);
}

window.addEventListener(
  'keydown',
  (e) => {
    const info = toKeyEventInfo(e);
    if (info.shift && !info.ctrl && !info.alt && !info.meta && /^Arrow(Up|Down|Left|Right)$/.test(info.key)) {
      e.preventDefault();
      e.stopPropagation();
      extendKeyboardSelection(info.key);
      logKey(`${keyName(info)}  -> select`);
      return;
    }
    if (info.key !== 'Shift') {
      keyAnchor = undefined;
      keyEnd = undefined;
    }
    if (isPassThrough(info)) {
      logKey(`${describeKey(info)}  [${info.code}]  -> VS Code`);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && info.key === 'Control') return;
    const zoom = zoomActionFor(info);
    if (zoom) {
      const current = renderer.zoom;
      const next = zoom === 'reset' ? 1 : zoom === 'in' ? Math.min(4, current * 1.1) : Math.max(0.3, current / 1.1);
      renderer.setOptions({ zoom: next });
      logKey(`${describeKey(info)}  -> zoom ${next.toFixed(2)}`);
      return;
    }
    if (config.keyOverlay) post({ type: 'key', event: info });
    if ((info.ctrl && !info.shift && !info.alt && info.key.toLowerCase() === 'c') || (info.ctrl && info.key === 'Insert')) {
      post({ type: 'copy', text: renderer.selectedText(config.settings.copyTrimTrailing) });
      if (!config.settings.copyKeepSelection) renderer.clearSelection();
      logKey(`${keyName(info)}  -> copy`);
      return;
    }
    // Paste: the keydown is cancelled above, so the browser never fires its own paste event;
    // the host reads the clipboard and answers with a 'paste' message.
    if ((info.ctrl && !info.shift && !info.alt && info.key.toLowerCase() === 'v') || (info.shift && !info.ctrl && !info.alt && info.key === 'Insert')) {
      post({ type: 'paste' });
      logKey(`${keyName(info)}  -> paste`);
      return;
    }
    if (config.settings.keyClick) beep(1200, 0.02);
    const result = classifyKey(info, keymap);
    if (result.kind === 'text') {
      logKey(`${describeKey(info)}  -> text`);
      post({ type: 'text', text: result.text });
    } else if (result.kind === 'action' && result.action === 'printScreen') {
      post({ type: 'printScreen' });
    } else if (result.kind === 'action') {
      logKey(`${keyName(info)}  -> ${result.action}`);
      post({ type: 'action', action: result.action });
    } else {
      logKey(`${keyName(info)}  -> (unmapped)`);
    }
  },
  { capture: true },
);

let wheelAccum = 0;
viewport.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const current = renderer.zoom;
      renderer.setOptions({ zoom: e.deltaY < 0 ? Math.min(4, current * 1.1) : Math.max(0.3, current / 1.1) });
      return;
    }
    if (!config.settings.mouseWheelPaging) return;
    e.preventDefault();
    wheelAccum += e.deltaY;
    if (Math.abs(wheelAccum) >= 100) {
      post({ type: 'action', action: wheelAccum > 0 ? 'pageDown' : 'pageUp' });
      wheelAccum = 0;
    }
  },
  { passive: false },
);

function cellFromMouse(e: MouseEvent): { row: number; col: number } | undefined {
  const rect = canvas.getBoundingClientRect();
  return renderer.cellAt(e.clientX - rect.left, e.clientY - rect.top);
}

/** Hotspot handling for a click; returns true when the click was consumed. */
function handleHotspot(cell: { row: number; col: number }): boolean {
  const st = config.settings;
  const line = renderer.rowText(cell.row);
  if (st.hotspotsUrl) {
    const url = urlAt(line, cell.col);
    if (url) {
      post({ type: 'openUrl', url });
      return true;
    }
  }
  const hs = hotspotAt(line, cell.col, { pf: st.hotspotsPF, fp: st.hotspotsFP, f: st.hotspotsF, number: st.hotspotsNumber });
  if (!hs) return false;
  if (hs.kind === 'key') post({ type: 'action', action: hs.action });
  else {
    post({ type: 'action', action: 'home' });
    post({ type: 'text', text: hs.text });
    post({ type: 'action', action: 'enter' });
  }
  return true;
}

let lastScreen: { rows: number; cols: number; fields: Array<{ start: number; length: number; bypass: boolean }> } | undefined;

/** Double-click selects the word under the pointer, or the whole input field when inside one. */
canvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  const cell = cellFromMouse(e);
  if (!cell || !lastScreen) return;
  const field = fieldRanges(lastScreen).find((r) => r.row === cell.row && !r.bypass && cell.col >= r.col && cell.col < r.col + r.length);
  if (field) {
    renderer.selectRange(cell.row, field.col, field.col + field.length - 1);
    return;
  }
  const line = renderer.rowText(cell.row);
  const w = wordAt(line, cell.col);
  if (!w.text) return;
  renderer.selectRange(cell.row, w.start, w.start + w.text.length - 1);
});

let dragging = false;
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  terminal.focus();
  const cell = cellFromMouse(e);
  if (!cell) return;
  dragging = true;
  keyAnchor = undefined;
  keyEnd = undefined;
  renderer.startSelection(cell.row, cell.col);
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const cell = cellFromMouse(e);
  if (cell) renderer.extendSelection(cell.row, cell.col);
});
window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  renderer.endSelection();
  const cell = cellFromMouse(e);
  if (renderer.hasSelection || !cell) return;
  if (handleHotspot(cell)) return;
  // A plain click moves the cursor.
  renderer.setCursor(cell.row, cell.col);
  renderer.setRuleCell(cell.row, cell.col);
  renderOia();
  post({ type: 'click', row: cell.row, col: cell.col });
  if (config.settings.enterAtCursorClick) post({ type: 'action', action: 'enter' });
});

/** Types clipboard text into the screen, line by line, honouring the paste settings. */
function pasteText(text: string): void {
  if (!text) return;
  const st = config.settings;
  const start = renderer.cursor;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, i) => {
    for (const part of expandTabs(line, { tabMode: st.pasteTabMode, tabSpaces: st.pasteTabSpaces, tabColumns: st.pasteTabColumns })) {
      if ('text' in part) post({ type: 'text', text: part.text });
      else post({ type: 'action', action: 'tab' });
    }
    if (i < lines.length - 1) post({ type: 'action', action: st.pasteFieldWrap ? 'fieldExit' : 'newline' });
  });
  if (st.pasteStopAtProtected) post({ type: 'action', action: 'reset' });
  if (!st.pasteMoveCursorToEnd && start) post({ type: 'click', row: start.row, col: start.col });
}

// Paste from a context menu or the host's Edit > Paste.
document.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  pasteText(text);
});

terminal.focus();
renderOia();
post({ type: 'ready' });
