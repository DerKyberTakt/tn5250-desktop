/**
 * Dragging session tabs: reorder inside the tab bar, drop outside the window to detach the
 * session into a window of its own, drop on another window of the app to merge it there.
 * The pure helpers (hit tests, ordering) are tested; TabDrag wires them to pointer events.
 */
import type { WindowBounds } from './bridge';

/** Pointer travel before a press becomes a drag. */
export const DRAG_THRESHOLD = 6;
/** Vertical distance from the tab bar within which a dragged tab still "clings" to it. */
export const BAR_REACH = 40;

export interface Point {
  x: number;
  y: number;
}

export interface Span {
  left: number;
  right: number;
}

export function dragStarted(start: Point, now: Point): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) >= DRAG_THRESHOLD;
}

/**
 * Where a tab dragged to x lands among the other tabs (their spans in bar order, the
 * dragged one left out): the number of tabs whose middle lies left of the pointer.
 */
export function insertionIndex(others: Span[], x: number): number {
  let i = 0;
  for (const s of others) if ((s.left + s.right) / 2 < x) i++;
  return i;
}

/** The list with item `from` moved so that it sits at `to` among the others. */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice();
  const [item] = out.splice(from, 1);
  if (item === undefined) return list.slice();
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

/** The window (other than `exclude`) under a screen point, if any. */
export function windowAt(windows: WindowBounds[], x: number, y: number, exclude: string): WindowBounds | undefined {
  return windows.find((w) => w.name !== exclude && x >= w.x && x < w.x + w.width && y >= w.y && y < w.y + w.height);
}

/** Top-left for a window detached at a screen point, so the pointer ends up on its tab. */
export function detachOrigin(x: number, y: number): Point {
  return { x: Math.max(0, Math.round(x - 60)), y: Math.max(0, Math.round(y - 64)) };
}

/** Whether a point (window coordinates) is within reach of the tab bar's rectangle. */
export function nearBar(bar: { top: number; bottom: number }, y: number): boolean {
  return y >= bar.top - BAR_REACH && y <= bar.bottom + BAR_REACH;
}

export interface DragHost<T> {
  /** The tab bar; children are the tab buttons in order. */
  bar: HTMLElement;
  /** The button of an item. */
  buttonOf(item: T): HTMLElement;
  /** Items in bar order. */
  items(): T[];
  /** Whether an item may leave the window (a session, not a settings page). */
  detachable(item: T): boolean;
  windows(): Promise<WindowBounds[]>;
  windowName: string;
  onReorder(item: T, to: number): void;
  onDetach(item: T, origin: Point): void;
  onMerge(item: T, window: string): void;
  log(line: string): void;
}

/**
 * Pointer handling for one tab bar. A press on a tab that travels DRAG_THRESHOLD becomes a
 * drag: a droplet ghost follows the pointer, a marker shows where the tab would land in
 * the bar, and the drop decides between reorder, detach and merge. Escape cancels.
 */
export class TabDrag<T> {
  private press: { item: T; start: Point; pointerId: number; button: HTMLElement } | undefined;
  private dragging = false;
  private ghost: HTMLElement | undefined;
  private marker: HTMLElement | undefined;
  private free = false;
  private readonly onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && this.press) this.cancel();
  };

  constructor(private readonly host: DragHost<T>) {}

  /** Call for every tab button once it is in the bar. */
  attach(item: T): void {
    const button = this.host.buttonOf(item);
    button.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || (ev.target instanceof HTMLElement && ev.target.closest('.close'))) return;
      this.press = { item, start: { x: ev.clientX, y: ev.clientY }, pointerId: ev.pointerId, button };
      this.dragging = false;
      button.addEventListener('pointermove', this.onMove);
      button.addEventListener('pointerup', this.onUp);
      button.addEventListener('pointercancel', this.onCancel);
      button.addEventListener('lostpointercapture', this.onCancel);
      document.addEventListener('keydown', this.onKey, true);
    });
  }

  get active(): boolean {
    return this.dragging;
  }

  /** The item left the bar (closed or moved away) while it may have been pressed. */
  detach(item: T): void {
    if (this.press?.item === item) this.release();
  }

  private readonly onMove = (ev: PointerEvent): void => {
    const p = this.press;
    if (!p) return;
    const now = { x: ev.clientX, y: ev.clientY };
    if (!this.dragging) {
      if (!dragStarted(p.start, now)) return;
      this.dragging = true;
      try {
        p.button.setPointerCapture(p.pointerId);
      } catch {
        // capture is best effort
      }
      p.button.classList.add('dragging');
      this.host.bar.classList.add('drag-active');
      this.ghost = this.makeGhost(p.button);
    }
    this.moveGhost(now);
    const bar = this.host.bar.getBoundingClientRect();
    const near = nearBar(bar, now.y) && now.x >= bar.left - BAR_REACH && now.x <= bar.right + BAR_REACH;
    this.setFree(!near);
    if (near) this.showMarker(this.targetIndex(now.x));
    else this.hideMarker();
  };

  private readonly onUp = (ev: PointerEvent): void => {
    const p = this.press;
    if (!p) return;
    if (!this.dragging) {
      this.release();
      return;
    }
    const now = { x: ev.clientX, y: ev.clientY };
    const bar = this.host.bar.getBoundingClientRect();
    const near = nearBar(bar, now.y) && now.x >= bar.left - BAR_REACH && now.x <= bar.right + BAR_REACH;
    const screen = { x: ev.screenX, y: ev.screenY };
    const item = p.item;
    if (near) {
      const to = this.targetIndex(now.x);
      this.release();
      this.host.onReorder(item, to);
      return;
    }
    if (!this.host.detachable(item)) {
      this.release();
      return;
    }
    const inside = now.x >= 0 && now.y >= 0 && now.x < window.innerWidth && now.y < window.innerHeight;
    this.release(true);
    void this.host
      .windows()
      .catch(() => [] as WindowBounds[])
      .then((windows) => {
        const target = windowAt(windows, screen.x, screen.y, this.host.windowName);
        if (target) this.host.onMerge(item, target.name);
        else if (!inside) this.host.onDetach(item, detachOrigin(screen.x, screen.y));
        this.dropGhost();
      });
  };

  private readonly onCancel = (): void => {
    if (this.press) this.cancel();
  };

  private cancel(): void {
    this.release();
  }

  /** Ends the press; with keepGhost the droplet stays for the detach animation. */
  private release(keepGhost = false): void {
    const p = this.press;
    if (!p) return;
    p.button.removeEventListener('pointermove', this.onMove);
    p.button.removeEventListener('pointerup', this.onUp);
    p.button.removeEventListener('pointercancel', this.onCancel);
    p.button.removeEventListener('lostpointercapture', this.onCancel);
    document.removeEventListener('keydown', this.onKey, true);
    try {
      p.button.releasePointerCapture(p.pointerId);
    } catch {
      // not captured
    }
    p.button.classList.remove('dragging');
    this.host.bar.classList.remove('drag-active');
    this.hideMarker();
    if (!keepGhost) this.dropGhost(false);
    this.press = undefined;
    this.dragging = false;
  }

  private targetIndex(x: number): number {
    const p = this.press;
    const others: Span[] = [];
    for (const item of this.host.items()) {
      if (item === p?.item) continue;
      const r = this.host.buttonOf(item).getBoundingClientRect();
      others.push({ left: r.left, right: r.right });
    }
    return insertionIndex(others, x);
  }

  private makeGhost(button: HTMLElement): HTMLElement {
    const g = document.createElement('div');
    g.className = 'tab-ghost';
    g.textContent = button.querySelector('.label')?.textContent ?? '';
    document.body.append(g);
    return g;
  }

  private moveGhost(p: Point): void {
    if (!this.ghost) return;
    this.ghost.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  private setFree(free: boolean): void {
    if (free === this.free || !this.ghost) return;
    this.free = free;
    this.ghost.classList.toggle('free', free);
    if (free) {
      // Snapping loose from the bar: a short wobble.
      this.ghost.classList.remove('snap');
      void this.ghost.offsetWidth;
      this.ghost.classList.add('snap');
    }
  }

  /** The droplet shrinks away (a detach or merge happened) or just goes. */
  private dropGhost(animate = true): void {
    const g = this.ghost;
    this.ghost = undefined;
    this.free = false;
    if (!g) return;
    if (!animate) {
      g.remove();
      return;
    }
    g.classList.add('gone');
    setTimeout(() => g.remove(), 300);
  }

  private showMarker(index: number): void {
    const p = this.press;
    if (!this.marker) {
      this.marker = document.createElement('div');
      this.marker.className = 'tab-marker';
      this.host.bar.append(this.marker);
    }
    const others = this.host.items().filter((i) => i !== p?.item);
    const bar = this.host.bar.getBoundingClientRect();
    let x: number;
    if (index < others.length) x = this.host.buttonOf(others[index] as T).getBoundingClientRect().left;
    else if (others.length) x = this.host.buttonOf(others[others.length - 1] as T).getBoundingClientRect().right;
    else x = bar.left + 4;
    this.marker.style.left = `${x - bar.left + this.host.bar.scrollLeft - 1}px`;
    this.marker.hidden = false;
  }

  private hideMarker(): void {
    if (this.marker) this.marker.hidden = true;
  }
}
