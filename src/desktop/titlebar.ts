/**
 * The app's own title bar, used when the window is frameless (Windows, and Linux as an
 * experiment): app icon, the menu bar, the window title in the middle, and the minimise /
 * maximise / close buttons. On Windows the buttons and the caption are "non-client regions"
 * (WebView2 tells the system where they are): dragging, double-click to maximise, Snap
 * Layouts on the maximise button and the clicks themselves are the system's. Elsewhere the
 * page handles them through the runtime.
 */

export interface FrameInfo {
  /** The window has no system frame; the page draws the title bar. */
  custom: boolean;
  /** 'windows', 'linux', 'darwin'. */
  platform: string;
}

export interface TitleBarHost {
  minimise(): void;
  toggleMaximise(): void;
  close(): void;
  isMaximised(): Promise<boolean>;
  /** Called with the new state whenever the window is maximised or restored. */
  onMaximised(cb: (max: boolean) => void): void;
}

export interface TitleBar {
  setTitle(text: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const svg = (body: string): string => `<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">${body}</svg>`;
const GLYPHS = {
  minimise: svg('<path d="M0 5h10"/>'),
  maximise: svg('<rect x="0.5" y="0.5" width="9" height="9"/>'),
  restore: svg('<path d="M2.5 2.5V0.5h7v7h-2"/><rect x="0.5" y="2.5" width="7" height="7"/>'),
  close: svg('<path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/>'),
};

/**
 * Fills the header and moves the menu bar into it. Returns the title setter. Does nothing
 * (header stays hidden) when the window has a system frame.
 */
export function installTitleBar(header: HTMLElement, menubar: HTMLElement, icon: string, info: FrameInfo, host: TitleBarHost): TitleBar | undefined {
  if (!info.custom) return undefined;
  const native = info.platform === 'windows';
  document.documentElement.classList.add('custom-frame', `frame-${info.platform}`);
  header.hidden = false;
  header.replaceChildren();

  const app = el('span', 'app-icon');
  app.innerHTML = icon;
  const caption = el('div', 'caption');
  const title = el('span', 'win-title');
  caption.append(title);
  const controls = el('div', 'win-controls');
  const button = (kind: 'minimise' | 'maximise' | 'close', label: string, region: string, run: () => void): HTMLButtonElement => {
    const b = el('button', `win-${kind}`);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = GLYPHS[kind];
    if (native) b.style.setProperty('--wails-non-client-region', region);
    else b.addEventListener('click', run);
    return b;
  };
  const max = button('maximise', 'Maximize', 'maximize', () => host.toggleMaximise());
  controls.append(button('minimise', 'Minimize', 'minimize', () => host.minimise()), max, button('close', 'Close', 'close', () => host.close()));
  header.append(app, menubar, caption, controls);

  if (native) caption.style.setProperty('--wails-non-client-region', 'caption');
  else {
    caption.style.setProperty('--wails-draggable', 'drag');
    caption.addEventListener('dblclick', () => host.toggleMaximise());
  }

  const setMax = (on: boolean): void => {
    header.classList.toggle('maximised', on);
    max.innerHTML = on ? GLYPHS.restore : GLYPHS.maximise;
    max.title = on ? 'Restore' : 'Maximize';
    max.setAttribute('aria-label', max.title);
  };
  host.onMaximised(setMax);
  void host
    .isMaximised()
    .then(setMax)
    .catch(() => undefined);

  return {
    setTitle: (text) => {
      title.textContent = text;
    },
  };
}
