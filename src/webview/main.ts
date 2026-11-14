import type { ConnectionStatus, HostToWebview, OiaState, TerminalConfig, WebviewToHost } from '../shared/protocol';
import { DEFAULT_OIA } from '../shared/protocol';
import { classifyKey, keyName, type Keymap } from '../shared/keymap';
import { doubleClickRange, fieldRanges, hotspotAt, urlAt } from '../shared/screenText';
import { SETTINGS_DEFAULTS, effectiveKeymap } from '../shared/settings';
import { isBareModifier, isPassThrough, toKeyEventInfo, zoomActionFor } from './keyboard';
import { ConnectionOverlay } from './connectionOverlay';
import { dragUnits } from './gui';
import { Renderer, type ScrollBarTarget } from './renderer';

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
const overlay = new ConnectionOverlay(viewport, {
  reconnect: () => post({ type: 'reconnect' }),
  cancel: () => post({ type: 'cancelReconnect' }),
});
let config: TerminalConfig = { settings: SETTINGS_DEFAULTS, keyOverlay: false, host: 'vscode' };
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
  if (oia.queuedKeys) left.append(pill(`Type-ahead ${oia.queuedKeys}`, 'info'));
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

/** Rule line toggled from the keyboard for this tab; undefined = follow the setting. */
let ruleLineOverride: boolean | undefined;

function toggleRuleLine(): void {
  ruleLineOverride = !(ruleLineOverride ?? config.settings.ruleLine);
  renderer.setOptions({ ruleLine: ruleLineOverride });
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
    fillWindow: st.fillWindow,
    screenOverflow: st.screenOverflow,
    fontFamily: st.fontFamily,
    fontSize: st.fontSize,
    fontStyle: st.fontStyle,
    textRendering: st.textRendering,
    columnSeparators: st.columnSeparators,
    cursorStyle: st.cursorStyle,
    cursorBlink: st.cursorBlink,
    blinkText: st.blinkText,
    ruleLine: ruleLineOverride ?? st.ruleLine,
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
    subfileScrollBar: st.subfileScrollBar,
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
      hostMouseEvents = msg.screen.gui?.mouseEvents ?? [];
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
      overlay.update(msg.status, msg.detail, msg.info);
      renderOia();
      break;
    case 'alarm':
      beep(880, 0.15);
      break;
    case 'paste':
      pasteText(msg.text);
      break;
    case 'copySelection':
      copySelection();
      break;
    case 'focus':
      terminal.focus();
      break;
  }
});

// Focus arriving at this frame (a tab switch, Alt+Tab back to the window) goes to the
// terminal, so typing works at once instead of after a click.
window.addEventListener('focus', () => terminal.focus());

/**
 * The box the screen has to fit in. Measured from the border box minus the CSS padding,
 * so a scrollbar (zoomed-in screen) never changes the answer; clientWidth/Height would
 * shrink when a scrollbar appears and the screen would resize itself back and forth.
 */
function viewportBox(): { w: number; h: number } {
  const rect = viewport.getBoundingClientRect();
  const cs = getComputedStyle(viewport);
  const w = rect.width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const h = rect.height - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  return { w: Math.floor(w), h: Math.floor(h) };
}

let lastBox = { w: 0, h: 0 };
let resizePending = false;
function fitToViewport(): void {
  const box = viewportBox();
  if (box.w === lastBox.w && box.h === lastBox.h) return;
  lastBox = box;
  renderer.resize(box.w, box.h);
}
new ResizeObserver(() => {
  // Several observations per frame (a side panel animating open) collapse into one layout.
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    fitToViewport();
  });
}).observe(viewport);
fitToViewport();

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

// Key-ups of keys the terminal takes are cancelled too: an unhandled F10 key-up
// puts the window (Windows, or VS Code) into menu mode, and the next key press is
// spent leaving it — F10 had to be pressed twice. The same goes for a bare Alt: the
// terminal takes Alt+arrow chords, so the host must not see the Alt press and release
// on their own (VS Code's menu bar would take the focus).
window.addEventListener(
  'keyup',
  (e) => {
    if (isPassThrough(toKeyEventInfo(e), keymap, config.host)) return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

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
    // A macro key is the host's: it wins over the keyboard map and over pass-through.
    if (config.macroKeys?.length && !isBareModifier(info)) {
      const name = keyName(info);
      if (config.macroKeys.includes(name)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) {
          logKey(`${name}  -> macro`);
          post({ type: 'macro', key: name });
        }
        return;
      }
    }
    if (isPassThrough(info, keymap, config.host)) {
      logKey(`${keyName(info)}  [${info.code}]  -> ${config.host === 'desktop' ? 'app' : 'VS Code'}`);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // A held Control key auto-repeats: one Enter (Right Ctrl) or Reset, not a stream.
    if (e.repeat && isBareModifier(info)) return;
    const zoom = zoomActionFor(info);
    if (zoom) {
      const current = renderer.zoom;
      const next = zoom === 'reset' ? 1 : zoom === 'in' ? Math.min(4, current * 1.1) : Math.max(0.3, current / 1.1);
      renderer.setOptions({ zoom: next });
      showZoom(next);
      logKey(`${keyName(info)}  -> zoom ${next.toFixed(2)}`);
      return;
    }
    if (config.keyOverlay) post({ type: 'key', event: info });
    const result = classifyKey(info, keymap);
    // Copy, paste and the rule line are the terminal's own keys (the keymap decides which):
    // they work while disconnected too.
    if (result.kind === 'action' && (result.action === 'copy' || result.action === 'paste' || result.action === 'rule')) {
      logKey(`${keyName(info)}  -> ${result.action}`);
      if (result.action === 'copy') copySelection();
      // Paste: the keydown is cancelled above, so the browser never fires its own paste event;
      // the host reads the clipboard and answers with a 'paste' message.
      else if (result.action === 'paste') post({ type: 'paste' });
      else toggleRuleLine();
      return;
    }
    if (config.settings.keyClick) beep(1200, 0.02);
    // Not connected: the overlay takes Enter (reconnect) and Escape (stop); other keys go nowhere.
    if (overlay.visible) {
      overlay.handleKey(info.key);
      logKey(`${keyName(info)}  -> (not connected)`);
      return;
    }
    if (result.kind === 'text') {
      logKey(`${keyName(info)}  -> text`);
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

/** The zoom level, bottom right of the screen for a moment after every change (Ctrl+wheel, Ctrl and +, -, 0). */
let zoomToast: HTMLDivElement | undefined;
let zoomToastTimer: ReturnType<typeof setTimeout> | undefined;
function showZoom(zoom: number): void {
  if (!zoomToast) {
    zoomToast = document.createElement('div');
    zoomToast.id = 'zoom-toast';
    zoomToast.setAttribute('role', 'status');
    viewport.append(zoomToast);
  }
  zoomToast.textContent = `${Math.round(zoom * 100)} %`;
  zoomToast.classList.add('show');
  if (zoomToastTimer) clearTimeout(zoomToastTimer);
  zoomToastTimer = setTimeout(() => zoomToast?.classList.remove('show'), 1200);
}

let wheelAccum = 0;
viewport.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const current = renderer.zoom;
      const next = e.deltaY < 0 ? Math.min(4, current * 1.1) : Math.max(0.3, current / 1.1);
      renderer.setOptions({ zoom: next });
      showZoom(next);
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
/** Pointer event codes the host programmed (Programmable Mouse Buttons). */
let hostMouseEvents: number[] = [];

/**
 * 5250 pointer event code for a mouse event: 1-3 left (pressed, released, double click),
 * 4-6 right, 7-9 middle, +9 with Shift. Undefined for other buttons.
 */
function mouseEventCode(e: MouseEvent, kind: 'down' | 'up' | 'dbl'): number | undefined {
  const base = e.button === 0 ? 1 : e.button === 2 ? 4 : e.button === 1 ? 7 : undefined;
  if (base === undefined) return undefined;
  return base + (kind === 'down' ? 0 : kind === 'up' ? 1 : 2) + (e.shiftKey ? 9 : 0);
}

/** Reports a pointer event the host asked for; true when it was one. */
function hostMouseEvent(e: MouseEvent, kind: 'down' | 'up' | 'dbl'): boolean {
  const code = mouseEventCode(e, kind);
  if (code === undefined || !hostMouseEvents.includes(code)) return false;
  const cell = cellFromMouse(e);
  if (!cell) return false;
  e.preventDefault();
  post({ type: 'mouse', event: code, row: cell.row, col: cell.col });
  return true;
}
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // A host that asked for the right button gets it; otherwise the screen's own menu.
  if (hostMouseEvents.some((c) => c === 4 || c === 5 || c === 6 || c === 13 || c === 14 || c === 15)) return;
  showContextMenu(e.clientX, e.clientY);
});
canvas.addEventListener('mouseup', (e) => {
  hostMouseEvent(e, 'up');
});

/**
 * Double-click: on a word, the word (kept inside the input field when there is one); on a
 * blank inside an input field, that field's run on the row (a PDM or SEU line, a 30-byte
 * description); on a blank elsewhere, nothing.
 */
canvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  if (hostMouseEvent(e, 'dbl')) return;
  const cell = cellFromMouse(e);
  if (!cell || !lastScreen) return;
  const field = fieldRanges(lastScreen).find((r) => r.row === cell.row && !r.bypass && cell.col >= r.col && cell.col < r.col + r.length);
  const range = doubleClickRange(renderer.rowText(cell.row), cell.col, field && { col: field.col, length: field.length });
  if (range) renderer.selectRange(cell.row, range.start, range.end);
});

function canvasPoint(e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/** Sends one scroll request for a scroll bar part: arrows one row, the track a page. */
function scrollRequest(target: ScrollBarTarget): void {
  const forward = target.hit.part === 'forward' || (target.hit.part === 'track' && target.hit.forward);
  if (target.ref.kind === 'subfile') {
    post({ type: 'action', action: forward ? 'pageDown' : 'pageUp' });
    return;
  }
  const increment = target.hit.part === 'track' ? 0 : 1;
  post({ type: 'scroll', addr: target.ref.bar.addr, forward, increment });
}

let dragging = false;
/** A host scroll bar thumb being dragged: where it started and what it stands for. */
let thumbDrag: { target: ScrollBarTarget; startPx: number; units: number } | undefined;
canvas.addEventListener('mousedown', (e) => {
  // Scroll bars first, then pointer events the host programmed, then the ordinary click.
  const p0 = canvasPoint(e);
  if (e.button === 0 && renderer.scrollBarAt(p0.x, p0.y) === undefined && hostMouseEvent(e, 'down')) {
    terminal.focus();
    return;
  }
  if (e.button !== 0) {
    hostMouseEvent(e, 'down');
    return;
  }
  terminal.focus();
  const p = canvasPoint(e);
  const target = renderer.scrollBarAt(p.x, p.y);
  if (target) {
    e.preventDefault();
    if (target.hit.part === 'thumb' && target.ref.kind === 'host') {
      thumbDrag = { target, startPx: target.geometry.horizontal ? p.x : p.y, units: 0 };
    } else {
      scrollRequest(target);
    }
    return;
  }
  const cell = cellFromMouse(e);
  if (!cell) return;
  dragging = true;
  keyAnchor = undefined;
  keyEnd = undefined;
  renderer.startSelection(cell.row, cell.col);
});
window.addEventListener('mousemove', (e) => {
  if (thumbDrag) {
    const { target, startPx } = thumbDrag;
    if (target.ref.kind !== 'host') return;
    const p = canvasPoint(e);
    const bar = target.ref.bar;
    const page = bar.horizontal ? bar.size - 2 : bar.size;
    thumbDrag.units = dragUnits(target.geometry, target.geometry.horizontal ? (p.x - startPx) / renderer.scaleX : p.y - startPx, bar.total, bar.pos, page);
    renderer.setThumbPreview(bar.addr, bar.pos + thumbDrag.units);
    return;
  }
  if (!dragging) {
    // Hover feedback on scroll bars (only while the mouse is over the canvas).
    if (e.target === canvas) {
      const p = canvasPoint(e);
      const target = renderer.scrollBarAt(p.x, p.y);
      renderer.setScrollHover(target);
      canvas.style.cursor = target ? 'pointer' : config.settings.pointer === 'crosshair' ? 'crosshair' : 'default';
    }
    return;
  }
  const cell = cellFromMouse(e);
  if (cell) renderer.extendSelection(cell.row, cell.col);
});
canvas.addEventListener('mouseleave', () => renderer.setScrollHover(undefined));
window.addEventListener('mouseup', (e) => {
  if (thumbDrag) {
    const { target, units } = thumbDrag;
    thumbDrag = undefined;
    renderer.clearThumbPreview();
    if (target.ref.kind === 'host' && units !== 0) {
      post({ type: 'scroll', addr: target.ref.bar.addr, forward: units > 0, increment: Math.abs(units) });
    }
    return;
  }
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

/** Copies the selection (or the whole screen) through the host clipboard. */
function copySelection(): void {
  post({ type: 'copy', text: renderer.selectedText(config.settings.copyTrimTrailing) });
  if (!config.settings.copyKeepSelection) renderer.clearSelection();
}

/** Hands clipboard text to the engine, which pastes it as a block at the cursor with the paste settings. */
function pasteText(text: string): void {
  if (!text) return;
  const st = config.settings;
  post({
    type: 'pasteText',
    text,
    options: {
      fieldWrap: st.pasteFieldWrap,
      stopAtProtected: st.pasteStopAtProtected,
      moveCursorToEnd: st.pasteMoveCursorToEnd,
      tabMode: st.pasteTabMode,
      tabSpaces: st.pasteTabSpaces,
      tabColumns: st.pasteTabColumns,
    },
  });
}

// Paste from a context menu or the host's Edit > Paste.
document.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  pasteText(text);
});

// Copy from the host's Edit > Copy (VS Code routes Cmd+C / Ctrl+C in a webview this way too):
// the selection, or the whole screen, as the Copy key does.
document.addEventListener('copy', (e) => {
  if (!lastScreen || !e.clipboardData) return;
  e.clipboardData.setData('text/plain', renderer.selectedText(config.settings.copyTrimTrailing));
  e.preventDefault();
  if (!config.settings.copyKeepSelection) renderer.clearSelection();
});

// Right-click menu on the screen: Copy (the selection, or the screen), Paste, Select All,
// the three things ACS offers there. Escape, a click elsewhere or losing focus closes it.
const contextMenu = document.createElement('div');
contextMenu.id = 'ctx-menu';
contextMenu.hidden = true;
document.body.append(contextMenu);

function hideContextMenu(): void {
  contextMenu.hidden = true;
}

function showContextMenu(x: number, y: number): void {
  contextMenu.replaceChildren();
  const item = (label: string, enabled: boolean, run: () => void): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.disabled = !enabled;
    b.addEventListener('click', () => {
      hideContextMenu();
      run();
      terminal.focus();
    });
    contextMenu.append(b);
  };
  const live = lastScreen !== undefined;
  item(renderer.hasSelection ? 'Copy' : 'Copy Screen', live, () => copySelection());
  item('Paste', live, () => post({ type: 'paste' }));
  item('Select All', live, () => renderer.selectAll());
  contextMenu.hidden = false;
  contextMenu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - contextMenu.offsetWidth - 4))}px`;
  contextMenu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - contextMenu.offsetHeight - 4))}px`;
}

document.addEventListener('mousedown', (e) => {
  if (!contextMenu.hidden && !contextMenu.contains(e.target as Node)) hideContextMenu();
});
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && !contextMenu.hidden) {
      e.stopPropagation();
      hideContextMenu();
    }
  },
  true,
);
window.addEventListener('blur', hideContextMenu);

terminal.focus();
renderOia();
post({ type: 'ready' });
