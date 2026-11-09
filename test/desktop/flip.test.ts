// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { layoutRect, placeAround, play, settle, snapshot } from '../../src/desktop/flip';

const rect = (left: number, top = 0): DOMRect => ({ left, top, right: left + 50, bottom: top + 20, width: 50, height: 20, x: left, y: top, toJSON: () => undefined });

describe('FLIP helpers', () => {
  it('slides an element from its old place to the new one and leaves the skipped one alone', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    a.getBoundingClientRect = () => rect(0);
    b.getBoundingClientRect = () => rect(100);
    const before = snapshot([
      ['a', a],
      ['b', b],
    ] as const);
    // The layout changed: a is where b was and the other way round.
    a.getBoundingClientRect = () => rect(100);
    b.getBoundingClientRect = () => rect(0);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    play(
      [
        ['a', a],
        ['b', b],
      ] as const,
      before,
      'b',
    );
    // a was inverted to its old place and then released to slide; b (under the pointer) untouched.
    expect(a.style.transition).toBe('transform 180ms ease');
    expect(a.style.transform).toBe('');
    expect(b.style.transform).toBe('');
    raf.mockRestore();
  });

  it('does nothing for elements that did not move or have no earlier place', () => {
    const a = document.createElement('div');
    a.getBoundingClientRect = () => rect(0);
    const before = snapshot([['a', a]] as const);
    play([['a', a]] as const, before);
    expect(a.style.transform).toBe('');
    play([['a', a]] as const, new Map());
    expect(a.style.transform).toBe('');
  });

  it('settle lets a hand-moved element slide back', () => {
    const a = document.createElement('div');
    a.style.transform = 'translateX(40px)';
    settle(a);
    expect(a.style.transform).toBe('');
    expect(a.style.transition).toBe('transform 150ms ease');
    const b = document.createElement('div');
    settle(b);
    expect(b.style.transition).toBe('');
  });
});

describe('live reorder helpers', () => {
  it('layoutRect takes a transform in flight off the measured rectangle', () => {
    const el = document.createElement('div');
    document.body.append(el);
    el.getBoundingClientRect = () => ({ left: 140, right: 240, top: 0, bottom: 30, width: 100, height: 30, x: 140, y: 0, toJSON: () => undefined });
    expect(layoutRect(el)).toEqual({ left: 140, right: 240, top: 0, bottom: 30 });
    el.style.transform = 'matrix(1, 0, 0, 1, 40, 5)';
    expect(layoutRect(el)).toEqual({ left: 100, right: 200, top: -5, bottom: 25 });
    el.remove();
  });

  it('placeAround puts the children in order without ever re-inserting the kept one', () => {
    const bar = document.createElement('div');
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((t) => {
      const e = document.createElement('div');
      e.textContent = t;
      bar.append(e);
      return e;
    }) as unknown as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    const moved: string[] = [];
    const insert = bar.insertBefore.bind(bar);
    bar.insertBefore = ((node: Node, ref: Node | null) => {
      moved.push(node.textContent ?? '');
      return insert(node, ref);
    }) as typeof bar.insertBefore;
    const order = (): string => [...bar.children].map((e) => e.textContent).join('');
    // B dragged to the end.
    placeAround(bar, b, [a, c, d, b]);
    expect(order()).toBe('ACDB');
    // ... then back to the front.
    placeAround(bar, b, [b, a, c, d]);
    expect(order()).toBe('BACD');
    // ... then to the middle.
    placeAround(bar, b, [a, c, b, d]);
    expect(order()).toBe('ACBD');
    expect(moved).not.toContain('B');
    // An element that is not in the bar: nothing happens.
    placeAround(bar, document.createElement('div'), [a, b]);
    expect(order()).toBe('ACBD');
  });
});
