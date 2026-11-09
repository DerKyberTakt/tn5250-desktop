// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTitleBar } from '../../src/desktop/titlebar';

function page() {
  document.body.replaceChildren();
  document.documentElement.className = '';
  const header = document.createElement('header');
  header.id = 'titlebar';
  header.hidden = true;
  const menubar = document.createElement('nav');
  menubar.id = 'menubar';
  document.body.append(header, menubar);
  return { header, menubar };
}

function host() {
  let maxCb: ((on: boolean) => void) | undefined;
  return {
    minimise: vi.fn(),
    toggleMaximise: vi.fn(),
    close: vi.fn(),
    isMaximised: vi.fn(async () => false),
    onMaximised: (cb: (on: boolean) => void) => (maxCb = cb),
    fireMax: (on: boolean) => maxCb?.(on),
  };
}

beforeEach(() => {
  document.documentElement.className = '';
});

describe('title bar', () => {
  it('does nothing with a system frame', () => {
    const { header, menubar } = page();
    const bar = installTitleBar(header, menubar, '<svg/>', { custom: false, platform: 'windows' }, host());
    expect(bar).toBeUndefined();
    expect(header.hidden).toBe(true);
    expect(menubar.parentElement).toBe(document.body);
  });

  it('fills the header: icon, menus, caption, buttons; the title and the maximised state follow the host', async () => {
    const { header, menubar } = page();
    const h = host();
    const bar = installTitleBar(header, menubar, '<svg/>', { custom: true, platform: 'windows' }, h);
    expect(bar).toBeDefined();
    expect(header.hidden).toBe(false);
    expect(document.documentElement.classList.contains('custom-frame')).toBe(true);
    expect(document.documentElement.classList.contains('frame-windows')).toBe(true);
    // The menu bar moved into the title bar, after the icon.
    expect(menubar.parentElement).toBe(header);
    expect([...header.children].map((c) => c.className || c.id)).toEqual(['app-icon', 'menubar', 'caption', 'win-controls']);
    const caption = header.querySelector('.caption') as HTMLElement;
    // No non-client regions: Wails 3.1 only tracks them under composition hosting; the caption drags through the runtime.
    expect(caption.style.getPropertyValue('--wails-non-client-region')).toBe('');
    expect(caption.style.getPropertyValue('--wails-draggable')).toBe('drag');
    (header.querySelector('.win-close') as HTMLButtonElement).click();
    expect(h.close).toHaveBeenCalledTimes(1);
    bar?.setTitle('A - PUB400 - TN5250 Terminal');
    expect(header.querySelector('.win-title')?.textContent).toBe('A - PUB400 - TN5250 Terminal');
    // Maximised: the glyph and a class change.
    await Promise.resolve();
    h.fireMax(true);
    expect(header.classList.contains('maximised')).toBe(true);
    expect((header.querySelector('.win-maximise') as HTMLButtonElement).title).toBe('Restore');
    h.fireMax(false);
    expect((header.querySelector('.win-maximise') as HTMLButtonElement).title).toBe('Maximize');
  });

  it('the buttons call the host and a double-click on the caption toggles maximise (Linux too)', () => {
    const { header, menubar } = page();
    const h = host();
    installTitleBar(header, menubar, '<svg/>', { custom: true, platform: 'linux' }, h);
    const caption = header.querySelector('.caption') as HTMLElement;
    expect(caption.style.getPropertyValue('--wails-draggable')).toBe('drag');
    expect(caption.style.getPropertyValue('--wails-non-client-region')).toBe('');
    (header.querySelector('.win-minimise') as HTMLButtonElement).click();
    (header.querySelector('.win-maximise') as HTMLButtonElement).click();
    (header.querySelector('.win-close') as HTMLButtonElement).click();
    expect(h.minimise).toHaveBeenCalledTimes(1);
    expect(h.toggleMaximise).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
    caption.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(h.toggleMaximise).toHaveBeenCalledTimes(2);
  });
});
