// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { play, settle, snapshot } from '../../src/desktop/flip';

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
