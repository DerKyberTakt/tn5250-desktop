import { keyName } from '../shared/keymap';
import type { KeyEventInfo } from '../shared/protocol';

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/**
 * Turns the key events of an "Assign" capture into one key name.
 *
 * A chord is taken on the keydown of its non-modifier key (Ctrl+Shift+E), so held
 * modifiers never end the capture early. A modifier on its own is taken on its keyup,
 * provided nothing else was pressed while it was down (Right Ctrl = Enter, Left Ctrl =
 * Reset). Two modifiers pressed and released together assign nothing.
 */
export class KeyCapture {
  private pendingName: string | undefined;
  private pendingCode: string | undefined;
  private chorded = false;

  /** The name to assign, or undefined to keep waiting. */
  keydown(k: KeyEventInfo): string | undefined {
    if (MODIFIERS.has(k.key)) {
      if (this.pendingCode === undefined) {
        this.pendingName = keyName(k);
        this.pendingCode = k.code;
      } else if (k.code !== this.pendingCode) {
        this.chorded = true;
      }
      return undefined;
    }
    this.reset();
    return keyName(k);
  }

  /** The bare modifier to assign when its own keyup ends a clean press, else undefined. */
  keyup(k: KeyEventInfo): string | undefined {
    if (k.code !== this.pendingCode) return undefined;
    const name = this.chorded ? undefined : this.pendingName;
    this.reset();
    return name;
  }

  reset(): void {
    this.pendingName = undefined;
    this.pendingCode = undefined;
    this.chorded = false;
  }
}
