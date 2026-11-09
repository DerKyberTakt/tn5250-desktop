/**
 * App themes: a name, a light or dark base, and a value for every colour variable the
 * chrome, the dialogs, the macro editor and the tool pages read. A theme is applied by
 * setting the variables on the document root (inline beats the stylesheet's light and
 * dark blocks); "no theme" clears them and View > Appearance decides light or dark.
 * Themes are .json files in the user's themes folder (and a read-only managed folder).
 */

export type ThemeBase = 'light' | 'dark';

export interface Theme {
  name: string;
  base: ThemeBase;
  vars: Record<string, string>;
  /** Shipped with the app; cannot be changed or deleted, only copied. */
  builtin?: boolean;
  /** From the administrator's folder; read-only. */
  managed?: boolean;
}

export interface ThemeVar {
  key: string;
  label: string;
  group: string;
}

const G_CHROME = 'Window chrome';
const G_TABS = 'Tabs and status';
const G_KEYS = 'Keycap buttons';
const G_EDITOR = 'Macro editor';
const G_PAGES = 'Pages (settings, IFS, SQL)';
const G_CONTROLS = 'Controls';
const G_LISTS = 'Lists and hints';

/** Every variable a theme sets, in the order the editor shows them. */
export const THEME_VARS: ThemeVar[] = [
  { key: '--chrome-bg', label: 'Background', group: G_CHROME },
  { key: '--chrome-fg', label: 'Text', group: G_CHROME },
  { key: '--chrome-border', label: 'Borders', group: G_CHROME },
  { key: '--chrome-hover', label: 'Hover', group: G_CHROME },
  { key: '--menu-bg', label: 'Menu background', group: G_CHROME },
  { key: '--menu-hover', label: 'Menu hover', group: G_CHROME },
  { key: '--side-bg', label: 'Side panel', group: G_CHROME },
  { key: '--tab-bg', label: 'Tab', group: G_TABS },
  { key: '--tab-active-bg', label: 'Active tab', group: G_TABS },
  { key: '--tab-accent', label: 'Accent', group: G_TABS },
  { key: '--status-bg', label: 'Status bar', group: G_TABS },
  { key: '--dot-connected', label: 'Connected dot', group: G_TABS },
  { key: '--dot-connecting', label: 'Connecting dot', group: G_TABS },
  { key: '--dot-disconnected', label: 'Disconnected dot', group: G_TABS },
  { key: '--dot-idle', label: 'Idle dot', group: G_TABS },
  { key: '--key-ink', label: 'Key ink (border, shadow)', group: G_KEYS },
  { key: '--esc-bg', label: 'ESC face', group: G_KEYS },
  { key: '--esc-hot', label: 'ESC lit letters', group: G_KEYS },
  { key: '--grey-bg', label: 'Reset face', group: G_KEYS },
  { key: '--grey-hot', label: 'Reset lit letters', group: G_KEYS },
  { key: '--green-bg', label: 'Run face', group: G_KEYS },
  { key: '--green-hot', label: 'Run lit letters', group: G_KEYS },
  { key: '--blue-bg', label: 'Save face', group: G_KEYS },
  { key: '--blue-hot', label: 'Save lit letters', group: G_KEYS },
  { key: '--ed-bg', label: 'Background', group: G_EDITOR },
  { key: '--ed-fg', label: 'Text', group: G_EDITOR },
  { key: '--ed-muted', label: 'Muted text', group: G_EDITOR },
  { key: '--ed-tile', label: 'Chips', group: G_EDITOR },
  { key: '--ed-tile-border', label: 'Chip borders', group: G_EDITOR },
  { key: '--ed-card', label: 'Cards and menus', group: G_EDITOR },
  { key: '--ed-key', label: 'Key chips', group: G_EDITOR },
  { key: '--ed-accent', label: 'Accent', group: G_EDITOR },
  { key: '--ed-focus', label: 'Focus ring', group: G_EDITOR },
  { key: '--vscode-foreground', label: 'Text', group: G_PAGES },
  { key: '--vscode-editor-background', label: 'Background', group: G_PAGES },
  { key: '--vscode-panel-border', label: 'Panel borders', group: G_PAGES },
  { key: '--vscode-textLink-foreground', label: 'Links', group: G_PAGES },
  { key: '--vscode-badge-background', label: 'Badge', group: G_PAGES },
  { key: '--vscode-badge-foreground', label: 'Badge text', group: G_PAGES },
  { key: '--vscode-input-background', label: 'Input background', group: G_CONTROLS },
  { key: '--vscode-input-foreground', label: 'Input text', group: G_CONTROLS },
  { key: '--vscode-input-border', label: 'Input border', group: G_CONTROLS },
  { key: '--vscode-dropdown-background', label: 'Dropdown background', group: G_CONTROLS },
  { key: '--vscode-dropdown-foreground', label: 'Dropdown text', group: G_CONTROLS },
  { key: '--vscode-button-background', label: 'Button', group: G_CONTROLS },
  { key: '--vscode-button-foreground', label: 'Button text', group: G_CONTROLS },
  { key: '--vscode-button-secondaryBackground', label: 'Secondary button', group: G_CONTROLS },
  { key: '--vscode-button-secondaryForeground', label: 'Secondary button text', group: G_CONTROLS },
  { key: '--vscode-list-hoverBackground', label: 'Row hover', group: G_LISTS },
  { key: '--vscode-list-activeSelectionBackground', label: 'Selected row', group: G_LISTS },
  { key: '--vscode-list-activeSelectionForeground', label: 'Selected row text', group: G_LISTS },
  { key: '--vscode-editorHoverWidget-background', label: 'Hint background', group: G_LISTS },
  { key: '--vscode-editorHoverWidget-foreground', label: 'Hint text', group: G_LISTS },
  { key: '--vscode-editorHoverWidget-border', label: 'Hint border', group: G_LISTS },
  { key: '--vscode-notifications-background', label: 'Notification background', group: G_LISTS },
  { key: '--vscode-notifications-foreground', label: 'Notification text', group: G_LISTS },
  { key: '--vscode-notifications-border', label: 'Notification border', group: G_LISTS },
  { key: '--vscode-inputValidation-warningBackground', label: 'Warning background', group: G_LISTS },
  { key: '--vscode-inputValidation-warningForeground', label: 'Warning text', group: G_LISTS },
  { key: '--vscode-inputValidation-warningBorder', label: 'Warning border', group: G_LISTS },
];

export const THEME_KEYS = new Set(THEME_VARS.map((v) => v.key));

const LIGHT: Record<string, string> = {
  '--chrome-bg': '#ececec',
  '--chrome-fg': '#1f1f1f',
  '--chrome-border': '#c4c4c4',
  '--chrome-hover': '#dcdcdc',
  '--menu-bg': '#ffffff',
  '--menu-hover': '#cce0f5',
  '--side-bg': '#f6f6f6',
  '--tab-bg': '#dedede',
  '--tab-active-bg': '#ffffff',
  '--tab-accent': '#1f5fa8',
  '--status-bg': '#e4e4e4',
  '--dot-connected': '#2e9b48',
  '--dot-connecting': '#d39b00',
  '--dot-disconnected': '#c4372c',
  '--dot-idle': '#9a9a9a',
  '--key-ink': '#111111',
  '--esc-bg': '#fee6e3',
  '--esc-hot': '#e8242b',
  '--grey-bg': '#ececec',
  '--grey-hot': '#e0861a',
  '--green-bg': '#dff5e6',
  '--green-hot': '#1f9d4a',
  '--blue-bg': '#dfeefc',
  '--blue-hot': '#1f6fe0',
  '--ed-bg': '#f7f7f7',
  '--ed-fg': '#141414',
  '--ed-muted': 'rgb(20 20 20 / 60%)',
  '--ed-tile': '#e3e3e3',
  '--ed-tile-border': '#cfcfcf',
  '--ed-card': '#ffffff',
  '--ed-key': '#8b1e2d',
  '--ed-accent': '#0f8fd6',
  '--ed-focus': '#1f8fe0',
  '--vscode-foreground': '#1f1f1f',
  '--vscode-editor-background': '#f3f3f3',
  '--vscode-panel-border': '#c8c8c8',
  '--vscode-textLink-foreground': '#1f5fa8',
  '--vscode-badge-background': '#1f5fa8',
  '--vscode-badge-foreground': '#ffffff',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#1f1f1f',
  '--vscode-input-border': '#b5b5b5',
  '--vscode-dropdown-background': '#ffffff',
  '--vscode-dropdown-foreground': '#1f1f1f',
  '--vscode-button-background': '#1f5fa8',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-secondaryBackground': '#e1e1e1',
  '--vscode-button-secondaryForeground': '#1f1f1f',
  '--vscode-list-hoverBackground': '#e5eef8',
  '--vscode-list-activeSelectionBackground': '#cce0f5',
  '--vscode-list-activeSelectionForeground': '#000000',
  '--vscode-editorHoverWidget-background': '#ffffe1',
  '--vscode-editorHoverWidget-foreground': '#1f1f1f',
  '--vscode-editorHoverWidget-border': '#a0a0a0',
  '--vscode-notifications-background': '#ffffff',
  '--vscode-notifications-foreground': '#1f1f1f',
  '--vscode-notifications-border': '#c8c8c8',
  '--vscode-inputValidation-warningBackground': '#fff4ce',
  '--vscode-inputValidation-warningForeground': '#1f1f1f',
  '--vscode-inputValidation-warningBorder': '#b89500',
};

const DARK: Record<string, string> = {
  ...LIGHT,
  '--chrome-bg': '#2b2b2b',
  '--chrome-fg': '#e0e0e0',
  '--chrome-border': '#3d3d3d',
  '--chrome-hover': '#3a3a3a',
  '--menu-bg': '#252526',
  '--menu-hover': '#094771',
  '--side-bg': '#232323',
  '--tab-bg': '#2f2f2f',
  '--tab-active-bg': '#1e1e1e',
  '--tab-accent': '#4d8fd8',
  '--status-bg': '#262626',
  '--key-ink': '#f2f2f2',
  '--esc-bg': '#3a1c1a',
  '--esc-hot': '#ff4d3d',
  '--grey-bg': '#262626',
  '--grey-hot': '#ffa030',
  '--green-bg': '#15301f',
  '--green-hot': '#3ad26f',
  '--blue-bg': '#14263a',
  '--blue-hot': '#4da3ff',
  '--ed-bg': '#0c0c0c',
  '--ed-fg': '#f2f2f2',
  '--ed-muted': 'rgb(242 242 242 / 60%)',
  '--ed-tile': '#1f1f1f',
  '--ed-tile-border': '#333333',
  '--ed-card': '#181818',
  '--ed-key': '#7a1f2b',
  '--ed-accent': '#12a3ec',
  '--vscode-foreground': '#d4d4d4',
  '--vscode-editor-background': '#1e1e1e',
  '--vscode-panel-border': '#3c3c3c',
  '--vscode-textLink-foreground': '#6aa7e8',
  '--vscode-badge-background': '#2f6fb8',
  '--vscode-input-background': '#2a2a2a',
  '--vscode-input-foreground': '#e0e0e0',
  '--vscode-input-border': '#4a4a4a',
  '--vscode-dropdown-background': '#2a2a2a',
  '--vscode-dropdown-foreground': '#e0e0e0',
  '--vscode-button-background': '#2f6fb8',
  '--vscode-button-secondaryBackground': '#3a3a3a',
  '--vscode-button-secondaryForeground': '#e0e0e0',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-list-activeSelectionBackground': '#094771',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-editorHoverWidget-background': '#252526',
  '--vscode-editorHoverWidget-foreground': '#d4d4d4',
  '--vscode-editorHoverWidget-border': '#454545',
  '--vscode-notifications-background': '#252526',
  '--vscode-notifications-foreground': '#e0e0e0',
  '--vscode-notifications-border': '#454545',
  '--vscode-inputValidation-warningBackground': '#3a3000',
  '--vscode-inputValidation-warningForeground': '#e0e0e0',
};

/** Midnight: deep blue-greys with a violet accent (the Discord feel). */
const MIDNIGHT: Record<string, string> = {
  ...DARK,
  '--chrome-bg': '#1e1f22',
  '--chrome-fg': '#dbdee1',
  '--chrome-border': '#2b2d31',
  '--chrome-hover': '#35373c',
  '--menu-bg': '#111214',
  '--menu-hover': '#404249',
  '--side-bg': '#2b2d31',
  '--tab-bg': '#2b2d31',
  '--tab-active-bg': '#313338',
  '--tab-accent': '#5865f2',
  '--status-bg': '#1e1f22',
  '--dot-connected': '#23a559',
  '--dot-disconnected': '#f23f43',
  '--blue-hot': '#7983f5',
  '--ed-bg': '#111214',
  '--ed-tile': '#2b2d31',
  '--ed-tile-border': '#3f4147',
  '--ed-card': '#1e1f22',
  '--ed-accent': '#5865f2',
  '--vscode-foreground': '#dbdee1',
  '--vscode-editor-background': '#313338',
  '--vscode-panel-border': '#3f4147',
  '--vscode-textLink-foreground': '#00a8fc',
  '--vscode-badge-background': '#5865f2',
  '--vscode-input-background': '#1e1f22',
  '--vscode-input-border': '#3f4147',
  '--vscode-dropdown-background': '#1e1f22',
  '--vscode-button-background': '#5865f2',
  '--vscode-button-secondaryBackground': '#4e5058',
  '--vscode-list-hoverBackground': '#35373c',
  '--vscode-list-activeSelectionBackground': '#404249',
  '--vscode-editorHoverWidget-background': '#111214',
  '--vscode-notifications-background': '#111214',
};

/** Graphite: neutral dark greys with a soft purple accent (the Teams feel). */
const GRAPHITE: Record<string, string> = {
  ...DARK,
  '--chrome-bg': '#292929',
  '--chrome-fg': '#ffffff',
  '--chrome-border': '#3d3d3d',
  '--chrome-hover': '#3a3a3a',
  '--menu-bg': '#1f1f1f',
  '--menu-hover': '#3d3d3d',
  '--side-bg': '#1f1f1f',
  '--tab-bg': '#2f2f2f',
  '--tab-active-bg': '#1f1f1f',
  '--tab-accent': '#7f85f5',
  '--status-bg': '#292929',
  '--blue-hot': '#9ea2ff',
  '--ed-bg': '#141414',
  '--ed-accent': '#7f85f5',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-textLink-foreground': '#a6a7dc',
  '--vscode-badge-background': '#5b5fc7',
  '--vscode-button-background': '#5b5fc7',
  '--vscode-list-activeSelectionBackground': '#3d3e66',
};

export const BUILT_IN: Theme[] = [
  { name: 'Light', base: 'light', vars: LIGHT, builtin: true },
  { name: 'Dark', base: 'dark', vars: DARK, builtin: true },
  { name: 'Midnight', base: 'dark', vars: MIDNIGHT, builtin: true },
  { name: 'Graphite', base: 'dark', vars: GRAPHITE, builtin: true },
];

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|transparent)$/i;

export function isColor(value: string): boolean {
  return COLOR.test(value.trim());
}

/**
 * A complete theme from a possibly partial one: missing or bad values come from the base
 * (Light or Dark), unknown keys are dropped. `problems` lists what was fixed.
 */
export function resolveTheme(input: Partial<Theme> & { vars?: Record<string, unknown> }): { theme: Theme; problems: string[] } {
  const problems: string[] = [];
  const base: ThemeBase = input.base === 'light' ? 'light' : 'dark';
  if (input.base !== 'light' && input.base !== 'dark') problems.push(`base "${String(input.base)}" is not light or dark; dark used`);
  const fill = base === 'light' ? LIGHT : DARK;
  const vars: Record<string, string> = {};
  for (const key of THEME_KEYS) {
    const v = input.vars?.[key];
    if (typeof v === 'string' && isColor(v)) vars[key] = v.trim();
    else {
      if (v !== undefined) problems.push(`${key}: "${String(v)}" is not a colour`);
      vars[key] = fill[key] as string;
    }
  }
  for (const key of Object.keys(input.vars ?? {})) if (!THEME_KEYS.has(key)) problems.push(`${key} is not a theme variable`);
  const name = (input.name ?? '').trim().slice(0, 60) || 'Untitled';
  return { theme: { name, base, vars, managed: input.managed }, problems };
}

/** Reads a theme file; undefined when it is not a theme at all. */
export function parseTheme(json: string): { theme: Theme; problems: string[] } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json); // a BOM from Notepad
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || typeof (raw as { vars?: unknown }).vars !== 'object') return undefined;
  return resolveTheme(raw as Partial<Theme> & { vars?: Record<string, unknown> });
}

export function themeToJson(t: Theme): string {
  return JSON.stringify({ name: t.name, base: t.base, vars: t.vars }, null, 2) + '\n';
}

/** Puts a theme on a document (inline variables beat the stylesheet); undefined takes it off. */
export function applyThemeVars(root: HTMLElement, theme: Theme | undefined): void {
  for (const key of THEME_KEYS) {
    if (theme) root.style.setProperty(key, theme.vars[key] ?? '');
    else root.style.removeProperty(key);
  }
  if (theme) root.setAttribute('data-theme', theme.base);
}

/** The theme by name among the built-ins and the user's, or undefined (no theme). */
export function findTheme(name: string | undefined, themes: Theme[]): Theme | undefined {
  if (!name) return undefined;
  return [...themes, ...BUILT_IN].find((t) => t.name === name);
}
