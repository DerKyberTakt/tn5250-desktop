/**
 * FLIP animations: remember where elements are, change the layout, then slide each one from
 * its old place to its new one. Keyed by whatever identifies an element across a redraw (the
 * element itself when it is kept, a model object when it is rebuilt).
 */

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Where every element is now, by key. */
export function snapshot<K>(pairs: Iterable<readonly [K, Element]>): Map<K, DOMRect> {
  const out = new Map<K, DOMRect>();
  for (const [k, e] of pairs) out.set(k, e.getBoundingClientRect());
  return out;
}

/**
 * Slides every element whose place changed since `before` from there to where it is now;
 * `skip` (the one under the pointer) is left alone. Does nothing under reduced motion.
 */
export function play<K>(pairs: Iterable<readonly [K, HTMLElement]>, before: Map<K, DOMRect>, skip?: K, ms = 180): void {
  if (!before.size || reducedMotion()) return;
  for (const [k, el] of pairs) {
    if (k === skip) continue;
    const from = before.get(k);
    if (!from) continue;
    const now = el.getBoundingClientRect();
    const dx = from.left - now.left;
    const dy = from.top - now.top;
    if (!dx && !dy) continue;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = `transform ${ms}ms ease`;
      el.style.transform = '';
      el.addEventListener('transitionend', () => (el.style.transition = ''), { once: true });
    });
  }
}

/** Lets an element that was moved by hand (a transform) slide back into its laid-out place. */
export function settle(el: HTMLElement, ms = 150): void {
  if (!el.style.transform || reducedMotion()) {
    el.style.transition = '';
    el.style.transform = '';
    return;
  }
  el.style.transition = `transform ${ms}ms ease`;
  el.style.transform = '';
  el.addEventListener('transitionend', () => (el.style.transition = ''), { once: true });
}
