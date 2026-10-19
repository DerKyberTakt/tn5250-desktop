import type { ConnectionInfo, ConnectionStatus } from '../shared/protocol';

export interface OverlayActions {
  reconnect(): void;
  cancel(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * A card over the dimmed screen while the session is connecting or the
 * connection is gone: what is happening, why, the reconnect countdown, and
 * buttons for Reconnect now / Stop. Enter reconnects, Escape stops.
 */
export class ConnectionOverlay {
  private readonly root: HTMLDivElement;
  private status: ConnectionStatus = 'idle';
  private detail = '';
  private info: ConnectionInfo = { attempt: 0 };
  private timer: ReturnType<typeof setInterval> | undefined;
  private countdownEl: HTMLElement | undefined;

  constructor(
    parent: HTMLElement,
    private readonly actions: OverlayActions,
  ) {
    this.root = el('div');
    this.root.id = 'connection-overlay';
    this.root.hidden = true;
    this.root.setAttribute('role', 'alertdialog');
    this.root.setAttribute('aria-live', 'assertive');
    // Clicks on the card must not reach the screen underneath (cursor moves, selections).
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    parent.append(this.root);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  update(status: ConnectionStatus, detail: string, info: ConnectionInfo | undefined): void {
    this.status = status;
    this.detail = detail;
    this.info = info ?? { attempt: 0 };
    this.render();
  }

  /** Keys while the card is up. Returns true when the key was used. */
  handleKey(key: string): boolean {
    if (!this.visible) return false;
    if (key === 'Enter') {
      if (this.status === 'disconnected') this.actions.reconnect();
      return true;
    }
    if (key === 'Escape') {
      if (this.status === 'connecting' || this.info.retryAt) this.actions.cancel();
      return true;
    }
    this.root.classList.remove('nudge');
    void this.root.offsetWidth; // restart the animation
    this.root.classList.add('nudge');
    return true;
  }

  private button(text: string, primary: boolean, run: () => void): HTMLButtonElement {
    const b = el('button', primary ? 'primary' : undefined, text);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  private render(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.countdownEl = undefined;
    if (this.status === 'connected' || this.status === 'idle') {
      this.root.hidden = true;
      this.root.replaceChildren();
      return;
    }
    const card = el('div', 'card');
    const buttons = el('div', 'buttons');
    const { attempt, retryAt, manual } = this.info;

    if (this.status === 'connecting') {
      card.classList.add('connecting');
      card.append(el('div', 'spinner'), el('h2', undefined, 'Connecting…'), el('p', 'detail', this.detail));
      if (attempt > 1) card.append(el('p', 'muted', `Attempt ${attempt}`));
      buttons.append(this.button('Cancel', false, () => this.actions.cancel()));
      card.append(buttons, el('p', 'hint', 'Esc = cancel'));
    } else if (manual) {
      card.append(el('h2', undefined, 'Disconnected'));
      buttons.append(this.button('Reconnect', true, () => this.actions.reconnect()));
      card.append(buttons, el('p', 'hint', 'Enter = reconnect'));
    } else {
      card.classList.add('lost');
      card.append(el('h2', undefined, 'Connection lost'), el('p', 'detail', this.detail || 'The connection to the host was closed.'));
      if (retryAt) {
        this.countdownEl = el('p', 'countdown');
        card.append(this.countdownEl);
        buttons.append(this.button('Reconnect now', true, () => this.actions.reconnect()), this.button('Stop', false, () => this.actions.cancel()));
        card.append(buttons, el('p', 'hint', 'Enter = reconnect now · Esc = stop'));
        this.tick();
        this.timer = setInterval(() => this.tick(), 250);
      } else {
        buttons.append(this.button('Reconnect', true, () => this.actions.reconnect()));
        card.append(buttons, el('p', 'hint', 'Enter = reconnect'));
      }
    }
    this.root.replaceChildren(card);
    this.root.hidden = false;
  }

  private tick(): void {
    const at = this.info.retryAt;
    if (!this.countdownEl || !at) return;
    const seconds = Math.max(0, Math.ceil((at - Date.now()) / 1000));
    this.countdownEl.textContent = seconds > 0 ? `Reconnecting in ${seconds} s (attempt ${this.info.attempt + 1})` : 'Reconnecting…';
  }
}
