// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabDrag, type DragHost } from '../../src/desktop/tabDrag';

/** Three tabs of 100 px in a bar at y 40..70; rects follow the DOM order so a live reorder moves them. */
function setup() {
  const bar = document.createElement('div');
  document.body.append(bar);
  const items = ['A', 'B', 'C'];
  const buttons = new Map<string, HTMLElement>();
  for (const name of items) {
    const b = document.createElement('div');
    b.className = 'tab';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = name;
    b.append(label);
    bar.append(b);
    buttons.set(name, b);
  }
  const order = (): string[] => [...bar.children].map((c) => c.querySelector('.label')?.textContent ?? '');
  bar.getBoundingClientRect = () => ({ left: 0, right: 300, top: 40, bottom: 70, width: 300, height: 30, x: 0, y: 40, toJSON: () => undefined });
  for (const [name, b] of buttons) {
    b.getBoundingClientRect = () => {
      const i = order().indexOf(name);
      return { left: i * 100, right: i * 100 + 100, top: 40, bottom: 70, width: 100, height: 30, x: i * 100, y: 40, toJSON: () => undefined };
    };
  }
  const ghost = {
    prepare: vi.fn<() => void>(),
    show: vi.fn<(label: string, screenX: number, screenY: number) => void>(),
    move: vi.fn<(screenX: number, screenY: number) => void>(),
    hide: vi.fn<() => void>(),
  };
  const host: DragHost<string> & { live: Array<[string, number]>; final: Array<[string, number]>; splashes: string[]; ghost: typeof ghost } = {
    bar,
    buttonOf: (i) => buttons.get(i) as HTMLElement,
    items: order,
    detachable: () => true,
    windows: async () => [],
    windowName: 'main',
    live: [],
    final: [],
    splashes: [],
    onLiveReorder: (item, to) => {
      host.live.push([item, to]);
      const b = buttons.get(item) as HTMLElement;
      const others = [...bar.children].filter((c) => c !== b);
      bar.insertBefore(b, others[to] ?? null);
    },
    onReorder: (item, to) => host.final.push([item, to]),
    onDetach: vi.fn(),
    onMerge: vi.fn(),
    splash: (_p, kind) => host.splashes.push(kind),
    ghost,
    log: () => undefined,
  };
  const drag = new TabDrag<string>(host);
  for (const name of items) drag.attach(name);
  const fire = (el: Element, type: string, x: number, y: number, extra: MouseEventInit = {}): void => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, screenX: x + 500, screenY: y + 300, ...extra }));
  };
  return { host, drag, buttons, order, fire };
}

beforeEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
});

describe('tab drag: live shuffle', () => {
  it('reorders while the pointer passes other tabs, follows the pointer, and reports the final place on release', () => {
    const { host, buttons, order, fire, drag } = setup();
    const a = buttons.get('A') as HTMLElement;
    fire(a, 'pointerdown', 20, 55);
    fire(a, 'pointermove', 23, 55); // under the threshold: nothing yet
    expect(drag.active).toBe(false);
    fire(a, 'pointermove', 60, 55);
    expect(drag.active).toBe(true);
    expect(a.classList.contains('dragging')).toBe(true);
    expect(host.ghost.prepare).toHaveBeenCalled();
    expect(a.style.transform).toBe('translateX(40px)'); // grabbed 20 px in, pointer at 60
    // Past the middle of B: A moves to the second place at once.
    fire(a, 'pointermove', 170, 55);
    expect(host.live).toEqual([['A', 1]]);
    expect(order()).toEqual(['B', 'A', 'C']);
    // Past C too.
    fire(a, 'pointermove', 270, 55);
    expect(order()).toEqual(['B', 'C', 'A']);
    fire(a, 'pointerup', 270, 55);
    expect(host.final).toEqual([['A', 2]]);
    expect(a.classList.contains('dragging')).toBe(false);
    expect(host.onDetach).not.toHaveBeenCalled();
  });

  it('Escape puts the tab back where it started', () => {
    const { host, buttons, order, fire } = setup();
    const c = buttons.get('C') as HTMLElement;
    fire(c, 'pointerdown', 250, 55);
    fire(c, 'pointermove', 120, 55);
    expect(order()).toEqual(['A', 'C', 'B']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(order()).toEqual(['A', 'B', 'C']);
    expect(host.final).toEqual([]);
  });

  it('near the bar the droplet is held (the tab itself moves); it is drawn only once the pointer leaves the bar', () => {
    const { buttons, fire } = setup();
    const b = buttons.get('B') as HTMLElement;
    fire(b, 'pointerdown', 150, 55);
    fire(b, 'pointermove', 170, 58);
    const ghost = document.querySelector('.tab-ghost') as HTMLElement;
    expect(ghost.classList.contains('held')).toBe(true);
    expect(ghost.classList.contains('free')).toBe(false);
    fire(b, 'pointermove', 170, 200);
    expect(ghost.classList.contains('held')).toBe(false);
    expect(ghost.classList.contains('free')).toBe(true);
    fire(b, 'pointermove', 170, 60);
    expect(ghost.classList.contains('held')).toBe(true);
  });

  it('away from the bar the droplet shows; across the window edge the ghost window takes over and the edge splashes', () => {
    const { host, buttons, fire } = setup();
    const b = buttons.get('B') as HTMLElement;
    fire(b, 'pointerdown', 150, 55);
    fire(b, 'pointermove', 150, 200);
    const ghost = document.querySelector('.tab-ghost') as HTMLElement;
    expect(ghost.classList.contains('free')).toBe(true);
    expect(ghost.textContent).toBe('B');
    fire(b, 'pointermove', -20, 200); // out through the left edge
    expect(host.splashes).toEqual(['leave']);
    expect(host.ghost.show).toHaveBeenCalledWith('B', 480, 500);
    expect(ghost.classList.contains('offscreen')).toBe(true);
    fire(b, 'pointermove', -40, 210);
    expect(host.ghost.move).toHaveBeenCalledWith(460, 510);
    fire(b, 'pointermove', 30, 210); // back in
    expect(host.ghost.hide).toHaveBeenCalled();
    expect(host.splashes).toEqual(['leave', 'enter']);
    expect(ghost.classList.contains('offscreen')).toBe(false);
  });

  it('a drop inside the window but away from the bar detaches too (a maximised window has no outside)', async () => {
    const { host, buttons, fire } = setup();
    const b = buttons.get('B') as HTMLElement;
    fire(b, 'pointerdown', 150, 55);
    fire(b, 'pointermove', 150, 200);
    fire(b, 'pointermove', 400, 400);
    fire(b, 'pointerup', 400, 400);
    await new Promise((r) => setTimeout(r, 0));
    expect(host.onDetach).toHaveBeenCalledWith('B', { x: 840, y: 636 }, { x: 900, y: 700 });
  });

  it('a drop outside the window detaches, with the drop point for the landing splash', async () => {
    const { host, buttons, fire } = setup();
    const b = buttons.get('B') as HTMLElement;
    fire(b, 'pointerdown', 150, 55);
    fire(b, 'pointermove', 150, 200);
    fire(b, 'pointermove', 900, 300);
    fire(b, 'pointerup', 900, 300);
    await new Promise((r) => setTimeout(r, 0));
    expect(host.onDetach).toHaveBeenCalledWith('B', { x: 1340, y: 536 }, { x: 1400, y: 600 });
    expect(host.ghost.hide).toHaveBeenCalled();
  });
});
