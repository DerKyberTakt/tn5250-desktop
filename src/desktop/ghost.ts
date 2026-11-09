/**
 * The ghost window's page: a droplet with the dragged tab's name, drawn in a transparent
 * window that Go moves under the pointer while a tab is dragged outside its window
 * (app_ghost.go). The name and the app's appearance arrive as the "ghost:label" event; the
 * page also asks for them once loaded, in case the event came before the page did.
 */
import { goApp, wailsRuntime, type GhostInfo } from './bridge';

const ghost = document.getElementById('ghost');

function show(info: Partial<GhostInfo> | undefined): void {
  if (!ghost || !info) return;
  // Same scheme as the window the tab came out of (theme.css: data-theme forces one; absent = the system's).
  const root = document.documentElement;
  if (info.theme === 'light' || info.theme === 'dark') root.setAttribute('data-theme', info.theme);
  else root.removeAttribute('data-theme');
  if (info.label === undefined) return;
  ghost.textContent = info.label;
  // A fresh wobble each time the droplet appears.
  ghost.classList.remove('snap');
  void ghost.offsetWidth;
  ghost.classList.add('snap');
}

wailsRuntime().EventsOn('ghost:label', (data) => show(data as Partial<GhostInfo> | undefined));
void goApp()
  .GhostLabel()
  .then((info) => info?.label && show(info))
  .catch(() => undefined);
