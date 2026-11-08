// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { escButton, iconListDialog, keyButton, type IconAction } from '../../src/desktop/dialogs';

// jsdom has no showModal(): the dialogs only need open/close and the close event.
beforeEach(() => {
  document.body.replaceChildren();
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const dialog = (): HTMLDialogElement => document.querySelector('dialog.icon-list') as HTMLDialogElement;
const ROW: IconAction[] = [
  { id: 'run', label: 'Run', icon: 'play', tone: 'green' },
  { id: 'edit', label: 'Edit', icon: 'pencil', tone: 'yellow' },
  { id: 'delete', label: 'Delete', icon: 'trash', tone: 'red' },
];
const TOP: IconAction[] = [
  { id: 'new', label: 'New macro', icon: 'newPage', tone: 'blue' },
  { id: 'record', label: 'Record', icon: 'record', tone: 'red' },
];

describe('keycap buttons', () => {
  it('ESC spells its letters one per span, 100 ms apart, and runs the handler', () => {
    let clicks = 0;
    const b = escButton(() => clicks++);
    expect(b.className).toBe('keycap esc esc');
    expect(b.textContent).toBe('ESC');
    const spans = [...b.querySelectorAll('span')];
    expect(spans.map((s) => s.textContent)).toEqual(['E', 'S', 'C']);
    expect(spans.map((s) => s.style.transitionDelay)).toEqual(['', '100ms', '200ms']);
    expect(b.getAttribute('aria-label')).toBe('Cancel');
    expect(b.title).toContain('Esc');
    b.click();
    expect(clicks).toBe(1);
  });

  it('a long label lights up within about 300 ms (letters closer together)', () => {
    const b = keyButton('Save and run', 'green', () => undefined, 'run');
    expect(b.className).toBe('keycap green run');
    expect(b.textContent).toBe('Save and run');
    const spans = [...b.querySelectorAll('span')];
    expect(spans).toHaveLength(12);
    expect(spans[11]?.style.transitionDelay).toBe('300ms');
    expect(spans[1]?.style.transitionDelay).toBe('27ms');
  });
});

describe('iconListDialog (Macros)', () => {
  it('draws the title, the tools under it and an icon button per action on each row', () => {
    void iconListDialog('Macros', ['Shipping   [Ctrl+R]   4 steps', 'Sign off   2 steps'], ROW, TOP, 'None');
    const d = dialog();
    expect(d.querySelector('.head h2')?.textContent).toBe('Macros');
    expect(d.querySelector('.head button.esc')?.textContent).toBe('ESC');
    expect([...d.querySelectorAll('.top-actions button')].map((b) => b.getAttribute('aria-label'))).toEqual(['New macro', 'Record']);
    const rows = [...d.querySelectorAll('.list-rows li')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.text')?.textContent).toBe('Shipping   [Ctrl+R]   4 steps');
    const acts = [...(rows[0]?.querySelectorAll('button.act') ?? [])];
    expect(acts.map((b) => b.className)).toEqual(['act play green', 'act pencil yellow', 'act trash red']);
    // Every icon carries the hover ring; the trash can has a lid of its own.
    expect(acts.every((b) => b.querySelector('svg .ring'))).toBe(true);
    expect(acts[2]?.querySelector('svg .lid')).not.toBeNull();
    // No bottom Close button any more: ESC does that.
    expect([...d.querySelectorAll('button')].some((b) => b.textContent === 'Close')).toBe(false);
    expect(d.querySelector('p.note')).toBeNull();
    // Nothing is focused on open (a script-focused button would show its hover ring); the form holds focus.
    expect(document.activeElement).toBe(d.querySelector('form'));
  });

  it('resolves with the row and action id, { row: -1 } for a top button, undefined for ESC', async () => {
    let p = iconListDialog('Macros', ['A', 'B'], ROW, TOP);
    (dialog().querySelectorAll('.list-rows li')[1]?.querySelector('button.trash') as HTMLButtonElement).click();
    expect(await p).toEqual({ row: 1, action: 'delete' });
    expect(document.querySelector('dialog')).toBeNull();

    p = iconListDialog('Macros', ['A'], ROW, TOP);
    (dialog().querySelector('.top-actions button.record') as HTMLButtonElement).click();
    expect(await p).toEqual({ row: -1, action: 'record' });

    p = iconListDialog('Macros', [], ROW, TOP, 'No macros yet.');
    expect(dialog().querySelector('.list-rows li.empty')?.textContent).toBe('No macros yet.');
    (dialog().querySelector('button.esc') as HTMLButtonElement).click();
    expect(await p).toBeUndefined();
  });
});
