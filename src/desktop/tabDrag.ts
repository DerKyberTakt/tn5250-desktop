/**
 * Dragging tabs: reorder inside the bar (the other tabs shuffle aside while the dragged
 * one follows the pointer), drop anywhere away from the bar to detach the tab into a
 * window of its own (so it works in a maximised window too), drop on another window of
 * the app to merge it there. The pure helpers (hit tests, ordering) are tested; TabDrag
 * wires them to pointer events.
 */
import type { WindowBounds } from './bridge';
import { layoutRect, settle } from './flip';

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

/**
 * The list with `item` moved to place `to` among the members of its own group (the tabs
 * of one bar), the other members keeping their places in the list.
 */
export function reorderWithin<T>(list: T[], inGroup: (t: T) => boolean, item: T, to: number): T[] {
  const group = list.filter(inGroup);
  const from = group.indexOf(item);
  if (from < 0) return list.slice();
  const moved = reorder(group, from, to);
  let i = 0;
  return list.map((t) => (inGroup(t) ? (moved[i++] as T) : t));
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

/** How far a dragged tab may be moved so it stays inside the bar. */
export function clampShift(dx: number, tab: Span, bar: Span): number {
  return Math.max(bar.left - tab.left, Math.min(dx, bar.right - tab.right));
}

/** The pointer's point clipped to the window, where a ring is drawn when the pointer crosses the edge. */
export function edgePoint(p: Point, width: number, height: number): Point {
  return { x: Math.max(0, Math.min(p.x, width - 1)), y: Math.max(0, Math.min(p.y, height - 1)) };
}

/** A ghost of the tab that another window of the app draws when the pointer is outside this one. */
export interface GhostHost {
  /** The drag began: get the ghost window ready (it takes a moment to start). */
  prepare(): void;
  show(label: string, screenX: number, screenY: number): void;
  move(screenX: number, screenY: number): void;
  hide(): void;
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
  /** The dragged tab passed another one: put it at `to` now so the others slide aside (no other side effects). */
  onLiveReorder(item: T, to: number): void;
  /** The drop inside the bar; the order is already as shown. */
  onReorder(item: T, to: number): void;
  onDetach(item: T, origin: Point, at: Point): void;
  onMerge(item: T, window: string, at: Point): void;
  /** Water-drop rings at a client point: the pointer left or came back through the window edge. */
  splash?(p: Point, kind: 'leave' | 'enter'): void;
  ghost?: GhostHost;
  log(line: string): void;
}

/**
 * Pointer handling for one tab bar. A press on a tab that travels DRAG_THRESHOLD becomes a
 * drag: near the bar the tab itself follows the pointer and the others shuffle out of its
 * way; away from the bar a droplet ghost follows the pointer (a ghost window once the
 * pointer leaves this window), and the drop decides between reorder, detach and merge.
 * Escape cancels and puts the tab back where it was.
 */
export class TabDrag<T> {
  private press: { item: T; start: Point; pointerId: number; button: HTMLElement; grabDX: number; startIndex: number } | undefined;
  private dragging = false;
  private ghost: HTMLElement | undefined;
  private free = false;
  private outside = false;
  /** The dragged button's laid-out place; measured again after every live reorder. */
  private base: DOMRect | undefined;
  private readonly onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && this.press) this.cancel();
  };

  constructor(private readonly host: DragHost<T>) {}

  /** Call for every tab button once it is in the bar. */
  attach(item: T): void {
    const button = this.host.buttonOf(item);
    button.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || (ev.target instanceof HTMLElement && ev.target.closest('.close'))) return;
      const rect = button.getBoundingClientRect();
      this.press = { item, start: { x: ev.clientX, y: ev.clientY }, pointerId: ev.pointerId, button, grabDX: ev.clientX - rect.left, startIndex: this.host.items().indexOf(item) };
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

  private nearBar(now: Point): boolean {
    const bar = this.host.bar.getBoundingClientRect();
    return nearBar(bar, now.y) && now.x >= bar.left - BAR_REACH && now.x <= bar.right + BAR_REACH;
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
      this.host.ghost?.prepare();
    }
    const near = this.nearBar(now);
    if (near) {
      this.setFree(false);
      // Passing another tab: the order changes under the pointer, the others slide aside.
      const to = this.targetIndex(now.x);
      if (to !== this.host.items().indexOf(p.item)) {
        this.base = undefined;
        this.host.onLiveReorder(p.item, to);
      }
      this.follow(now.x);
    } else {
      this.unfollow();
      this.setFree(true);
    }
    this.moveGhost(now);
    // Across the window edge: this page cannot draw there, a ghost window takes over.
    const inside = now.x >= 0 && now.y >= 0 && now.x < window.innerWidth && now.y < window.innerHeight;
    if (!inside && !this.outside) {
      this.outside = true;
      this.ghost?.classList.add('offscreen');
      this.host.splash?.(edgePoint(now, window.innerWidth, window.innerHeight), 'leave');
      this.host.ghost?.show(this.label(p.button), ev.screenX, ev.screenY);
    } else if (inside && this.outside) {
      this.outside = false;
      this.ghost?.classList.remove('offscreen');
      this.host.ghost?.hide();
      this.host.splash?.(edgePoint(now, window.innerWidth, window.innerHeight), 'enter');
    } else if (this.outside) {
      this.host.ghost?.move(ev.screenX, ev.screenY);
    }
  };

  /** Keeps the dragged tab under the pointer, inside the bar. */
  private follow(x: number): void {
    const p = this.press;
    if (!p) return;
    if (!this.base) {
      p.button.style.transition = 'none';
      p.button.style.transform = '';
      this.base = p.button.getBoundingClientRect();
    }
    const bar = this.host.bar.getBoundingClientRect();
    const dx = clampShift(x - p.grabDX - this.base.left, { left: this.base.left, right: this.base.right }, { left: bar.left, right: bar.right });
    p.button.style.transition = 'none';
    p.button.style.transform = `translateX(${dx}px)`;
  }

  /** The tab goes back to its slot (the pointer left the bar, or the drag ended). */
  private unfollow(): void {
    const p = this.press;
    if (!p) return;
    this.base = undefined;
    settle(p.button);
  }

  private readonly onUp = (ev: PointerEvent): void => {
    const p = this.press;
    if (!p) return;
    if (!this.dragging) {
      this.release();
      return;
    }
    const now = { x: ev.clientX, y: ev.clientY };
    const near = this.nearBar(now);
    const screen = { x: ev.screenX, y: ev.screenY };
    const item = p.item;
    if (near) {
      const to = this.host.items().indexOf(item);
      this.release();
      this.host.onReorder(item, to);
      return;
    }
    if (!this.host.detachable(item)) {
      this.cancel();
      return;
    }
    // Away from the bar the tab leaves: into the window of the app under the pointer, or a new one.
    this.release(true);
    void this.host
      .windows()
      .catch(() => [] as WindowBounds[])
      .then((windows) => {
        const target = windowAt(windows, screen.x, screen.y, this.host.windowName);
        if (target) this.host.onMerge(item, target.name, screen);
        else this.host.onDetach(item, detachOrigin(screen.x, screen.y), screen);
        this.dropGhost();
      });
  };

  private readonly onCancel = (): void => {
    if (this.press) this.cancel();
  };

  /** Escape, a lost capture, or a drop that went nowhere: the tab returns to where it started. */
  private cancel(): void {
    const p = this.press;
    if (p && this.dragging) this.putBack(p.item, p.startIndex);
    this.release();
  }

  private putBack(item: T, index: number): void {
    if (this.host.items().indexOf(item) !== index && this.host.items().includes(item)) this.host.onLiveReorder(item, index);
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
    this.unfollow();
    p.button.classList.remove('dragging');
    this.host.bar.classList.remove('drag-active');
    if (this.outside) {
      this.outside = false;
      this.host.ghost?.hide();
    }
    if (!keepGhost) this.dropGhost(false);
    this.press = undefined;
    this.dragging = false;
  }

  private targetIndex(x: number): number {
    const p = this.press;
    const others: Span[] = [];
    for (const item of this.host.items()) {
      if (item === p?.item) continue;
      // Laid-out places: the others may still be sliding (FLIP) from where they were.
      const r = layoutRect(this.host.buttonOf(item));
      others.push({ left: r.left, right: r.right });
    }
    return insertionIndex(others, x);
  }

  private label(button: HTMLElement): string {
    return button.querySelector('.label')?.textContent ?? '';
  }

  private makeGhost(button: HTMLElement): HTMLElement {
    const g = document.createElement('div');
    // Held until the pointer leaves the bar: near it the tab itself is what moves.
    g.className = 'tab-ghost held';
    g.textContent = this.label(button);
    document.body.append(g);
    return g;
  }

  private moveGhost(p: Point): void {
    if (!this.ghost) return;
    this.ghost.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  /** Away from the bar the droplet shows; near it the tab itself is what moves. */
  private setFree(free: boolean): void {
    if (free === this.free || !this.ghost) return;
    this.free = free;
    this.ghost.classList.toggle('free', free);
    this.ghost.classList.toggle('held', !free);
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
}
