/**
 * The ghost window's page: a droplet with the dragged tab's name, drawn in a transparent,
 * click-through window that Go moves under the pointer while a tab is dragged outside its
 * window (app_ghost.go). The label arrives as the "ghost:label" event; the page also asks
 * for it once loaded, in case the event came before the page did.
 */
import { goApp, wailsRuntime } from './bridge';

const ghost = document.getElementById('ghost');

function setLabel(label: string): void {
  if (!ghost) return;
  ghost.textContent = label;
  // A fresh wobble each time the droplet appears.
  ghost.classList.remove('snap');
  void ghost.offsetWidth;
  ghost.classList.add('snap');
}

wailsRuntime().EventsOn('ghost:label', (data) => setLabel(String(data ?? '')));
void goApp()
  .GhostLabel()
  .then((label) => label && setLabel(label))
  .catch(() => undefined);
