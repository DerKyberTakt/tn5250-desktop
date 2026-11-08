/**
 * Toolbar icons as inline SVG (no external files, so the strict CSP stays as it is).
 * 24x24 view box, drawn for 18 px; colours follow the ACS toolbar loosely.
 */

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  /** Show / hide the connections panel (quick connect). */
  connections: svg(
    '<rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor"/><path d="M9 4v16" stroke="currentColor"/><path d="M5 8h2M5 11h2M5 14h2" stroke="#2e9b48"/>',
  ),
  /** New 5250 session. */
  newSession: svg(
    '<rect x="2.5" y="4" width="15" height="11" rx="1.5" stroke="currentColor"/><path d="M7 19h6M10 15v4" stroke="currentColor"/><path d="M5.5 8h3M5.5 11h6" stroke="#2e9b48"/><path d="M19 13v8M15 17h8" stroke="#2e9b48" stroke-width="2.2"/>',
  ),
  copy: svg('<rect x="8" y="8" width="12" height="13" rx="1.5" stroke="currentColor"/><path d="M16 8V5a1.5 1.5 0 0 0-1.5-1.5h-9A1.5 1.5 0 0 0 4 5v11a1.5 1.5 0 0 0 1.5 1.5H8" stroke="currentColor"/>'),
  paste: svg(
    '<path d="M9 4h6v3H9z" stroke="currentColor"/><path d="M15 5h2.5A1.5 1.5 0 0 1 19 6.5V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V6.5A1.5 1.5 0 0 1 6.5 5H9" stroke="currentColor"/><path d="M9 12h6M9 16h4" stroke="#1f5fa8"/>',
  ),
  print: svg(
    '<path d="M7 9V3.5h10V9" stroke="currentColor"/><rect x="3" y="9" width="18" height="8" rx="1.5" stroke="currentColor"/><path d="M7 14h10v6.5H7z" stroke="currentColor"/><circle cx="17.5" cy="12" r=".8" fill="#2e9b48" stroke="none"/>',
  ),
  /** Record a macro; the dot blinks while recording (CSS on .dot). */
  record: svg('<circle cx="12" cy="12" r="8" stroke="currentColor"/><circle class="dot" cx="12" cy="12" r="4.5" fill="#c4372c" stroke="none"/>'),
  /** Macros: a green play button in a ring. */
  macro: svg('<circle cx="12" cy="12" r="9.5" stroke="currentColor"/><path d="M9.5 7.5v9l7.5-4.5z" fill="#2e9b48" stroke="none"/>'),
  connect: svg('<path d="M12 3v8" stroke="#2e9b48" stroke-width="2.2"/><path d="M7.5 6.5a7 7 0 1 0 9 0" stroke="#2e9b48" stroke-width="2.2"/>'),
  disconnect: svg('<path d="M12 3v8" stroke="#c4372c" stroke-width="2.2"/><path d="M7.5 6.5a7 7 0 1 0 9 0" stroke="#c4372c" stroke-width="2.2"/><path d="M4 20 20 4" stroke="#c4372c" stroke-width="2"/>'),
  attn: svg('<rect x="2.5" y="6" width="19" height="12" rx="2.5" stroke="currentColor"/><text x="12" y="15.2" text-anchor="middle" font-size="7.5" font-weight="700" font-family="Segoe UI, sans-serif" fill="#c4372c" stroke="none">ATTN</text>'),
  sysreq: svg('<rect x="2.5" y="6" width="19" height="12" rx="2.5" stroke="currentColor"/><text x="12" y="15.2" text-anchor="middle" font-size="7.5" font-weight="700" font-family="Segoe UI, sans-serif" fill="#1f5fa8" stroke="none">SYS</text>'),
  reset: svg('<rect x="2.5" y="6" width="19" height="12" rx="2.5" stroke="currentColor"/><text x="12" y="15.2" text-anchor="middle" font-size="7.5" font-weight="700" font-family="Segoe UI, sans-serif" fill="#2e9b48" stroke="none">RST</text>'),
  ifs: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="#b8891f" fill="#f2c95e"/><path d="M8 14h8" stroke="#7a5a10"/>'),
  /** Run SQL Scripts: a table with a lightning stroke. */
  sql: svg('<rect x="3" y="5" width="18" height="14" rx="1.5" stroke="#1f5fa8"/><path d="M3 10h18M9 10v9" stroke="#1f5fa8"/><path d="m15 7-2.5 4.5h3L13 16" stroke="#e0a21b" stroke-width="2" fill="none"/>'),
  /** Console (CL / QSH): a prompt. */
  console: svg('<rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor"/><path d="m7 9 3 3-3 3" stroke="#2e9b48" stroke-width="2"/><path d="M12 15h5" stroke="currentColor" stroke-width="2"/>'),
  settings: svg(
    '<circle cx="12" cy="12" r="3" stroke="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor"/>',
  ),
  /** Check for updates: glows green when a newer release exists. */
  update: svg('<path d="M12 3.5v11" stroke="currentColor" stroke-width="2"/><path d="m7.5 10 4.5 4.5 4.5-4.5" stroke="currentColor" stroke-width="2"/><path d="M4.5 16v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V16" stroke="currentColor"/>'),
  help: svg('<circle cx="12" cy="12" r="9" stroke="#1f5fa8"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1.1.9-1.1 1.6v.5" stroke="#1f5fa8"/><circle cx="12" cy="17" r=".9" fill="#1f5fa8" stroke="none"/>'),
} as const;

export type IconName = keyof typeof ICONS;

/**
 * Icons for the buttons of the macros dialog, 24x24 drawn for 22 px. The ring is drawn on
 * hover (CSS animates its dash offset); the trash lid is a group of its own so it can open.
 */
const action = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle class="ring" cx="12" cy="12" r="11" pathLength="100"/>${body}</svg>`;

export const ACTION_ICONS = {
  /** Run: a play triangle. */
  play: action('<path class="shape" d="M9.3 7.2v9.6l7.9-4.8z" fill="currentColor" stroke="none"/>'),
  /** Edit: a pencil. */
  pencil: action('<g class="shape"><path d="m14.6 6.4 3 3L9.4 17.6 6 18l.4-3.4z"/><path d="m13.2 7.8 3 3"/></g>'),
  /** Delete: a trash can; the lid is its own group and swings open on hover. */
  trash: action('<g class="lid"><path d="M6.5 8h11"/><path d="M9.8 8V6.6a1 1 0 0 1 1-1h2.4a1 1 0 0 1 1 1V8"/></g><g class="shape"><path d="M7.6 8.2 8.3 17a1.6 1.6 0 0 0 1.6 1.5h4.2A1.6 1.6 0 0 0 15.7 17l.7-8.8"/><path d="M10.4 11v5M13.6 11v5"/></g>'),
  /** New: a page with a folded corner and a plus. */
  newPage: action('<g class="shape"><path d="M7 4.5h6.5L17 8v11.5H7z"/><path d="M13.5 4.5V8H17"/><path d="M12 11v5M9.5 13.5h5"/></g>'),
  /** Record: a dot in a ring. */
  record: action('<circle class="shape" cx="12" cy="12" r="4.6" fill="currentColor" stroke="none"/>'),
  /** Import: an arrow down into a tray. */
  importFile: action('<g class="shape"><path d="M12 5v9"/><path d="m8.5 10.5 3.5 3.5 3.5-3.5"/><path d="M6 15v2.5a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V15"/></g>'),
  /** Export: an arrow up out of a tray. */
  exportFile: action('<g class="shape"><path d="M12 14V5"/><path d="M8.5 8.5 12 5l3.5 3.5"/><path d="M6 15v2.5a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V15"/></g>'),
} as const;

export type ActionIconName = keyof typeof ACTION_ICONS;
