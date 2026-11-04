import { describe, expect, it } from 'vitest';
import { captureScroll, preserveScroll, restoreScroll, type ScrollTargets } from '../../src/settings/scroll';

describe('settings scroll helper', () => {
  it('captures the scrollTop of the areas that exist and skips missing ones', () => {
    expect(captureScroll({ main: { scrollTop: 420 }, nav: { scrollTop: 7 }, gone: null, none: undefined })).toEqual({ main: 420, nav: 7 });
  });

  it('restores positions onto new elements, only where they differ and exist', () => {
    const main = { scrollTop: 0 };
    restoreScroll({ main, nav: undefined }, { main: 300, nav: 5 });
    expect(main.scrollTop).toBe(300);
  });

  it('restores only the named areas', () => {
    const main = { scrollTop: 0 };
    const nav = { scrollTop: 0 };
    restoreScroll({ main, nav }, { main: 300, nav: 50 }, ['nav']);
    expect(main.scrollTop).toBe(0);
    expect(nav.scrollTop).toBe(50);
  });

  it('keeps the position over a rebuild that replaces the elements', () => {
    let targets: ScrollTargets = { main: { scrollTop: 640 }, nav: { scrollTop: 90 } };
    preserveScroll(
      () => targets,
      () => {
        targets = { main: { scrollTop: 0 }, nav: { scrollTop: 0 } }; // fresh elements start at the top
      },
    );
    expect(targets.main?.scrollTop).toBe(640);
    expect(targets.nav?.scrollTop).toBe(90);
  });

  it('restores again after layout when the first restore was clamped', () => {
    const deferred: Array<() => void> = [];
    let main = { scrollTop: 500 };
    preserveScroll(
      () => ({ main }),
      () => {
        main = { scrollTop: 0 };
      },
      { defer: (fn) => deferred.push(fn) },
    );
    expect(main.scrollTop).toBe(500);
    main.scrollTop = 120; // layout shrank the content and the browser clamped it
    expect(deferred).toHaveLength(1);
    deferred[0]!();
    expect(main.scrollTop).toBe(500);
  });

  it('lets an area start at the top when it is not in the restore list (page switch)', () => {
    let main = { scrollTop: 800 };
    let nav = { scrollTop: 30 };
    preserveScroll(
      () => ({ main, nav }),
      () => {
        main = { scrollTop: 0 };
        nav = { scrollTop: 0 };
      },
      { restore: ['nav'] },
    );
    expect(main.scrollTop).toBe(0);
    expect(nav.scrollTop).toBe(30);
  });

  it('still rebuilds when there is nothing to scroll', () => {
    let built = 0;
    preserveScroll(
      () => ({}),
      () => {
        built++;
      },
    );
    expect(built).toBe(1);
  });
});
