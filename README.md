# TN5250 Terminal for IBM i

A 5250 terminal emulator that lives in a **VS Code editor tab**. Connect to IBM i (AS/400, iSeries) systems next to your RPG, CL and SQL sources, with the keyboard and look of IBM i Access Client Solutions and nothing else to install.

## Highlights

- **Zero installs.** A pure TypeScript TN5250 client running inside VS Code. No Java, no Node runtime, no packages on the IBM i.
- **Fits the tab.** The screen scales to the editor area; zoom with Ctrl+wheel. 24x80 and 27x132, switching automatically as the host does.
- **ACS keyboard.** F1–F24, Field Exit, Field+/−, Attn, SysReq, Reset, Dup, Erase Input, insert mode and the 5250 operator error codes. Assign any key to any function, or import an ACS `.kmp` keyboard map.
- **Classic or Enhanced look.** The familiar green screen, or a modern mode with a gradient background, outlined input fields, glowing text and function keys drawn as buttons. Every colour is yours to change, with import and export of colour schemes.
- **Connections side bar.** Saved connections, one-click tabs, session letters in the tab title, Connect to Previous (Ctrl+Alt+5), Duplicate, demo sessions with a tilted watermark and a coloured frame.
- **Settings page** modelled on ACS: Connection, Advanced, TLS/SSL, Display, Font, Watermark, Colors, Enhanced UI, Paste, Copy, Hotspots, Window Title, Tab Setup, Keyboard, Sound, Behavior. Searchable, with an information bubble on every setting and live previews.
- **Productivity.** Rectangle selection (mouse, Shift+Arrows, double-click a word or field) and copy, field-aware paste with tab handling, hotspots for function keys, menu numbers and URLs, rule line, print screen (Ctrl+Alt+P), bypass sign-on with the password kept in the VS Code secret store.
- **Connectivity.** Telnet on port 23 or telnet over TLS (port 992) with certificate validation, optional client certificates, keep-alive, auto-reconnect, inactivity timeout, workstation ID templates (`&COMPN`, `&USERN`, `*`, `=`) with automatic retry when a name is in use.

## Getting started

1. Install the extension and open the **TN5250** view in the Activity Bar.
2. Click **New Connection**, enter the host name (port 23 is the default), and adjust anything else on the Settings page that opens.
3. Click the connection. A tab opens, connects and shows the Sign On screen. Sign on as usual.

Useful commands (Command Palette, prefix **TN5250:**): Settings, New Tab (same session), Connect to Previous IBM i, Disconnect, Disconnect All, Print Screen, Import ACS Keyboard Map, Save Session Trace.

## Keyboard

| Key | 5250 function |
|---|---|
| Enter, Right Ctrl | Enter |
| Left Ctrl | Reset |
| Keypad Enter, Shift+Enter, Ctrl+Enter | Field Exit |
| Keypad +, Keypad − | Field+, Field− |
| F1–F12, Shift+F1–F12 | F1–F24 |
| Escape, Shift+Escape | Attn, SysReq |
| Page Up / Page Down, mouse wheel | Roll |
| Home, End | First field, Erase to end of field |
| Insert, Delete, Backspace | Insert mode, Delete, Backspace |
| Shift+Insert, Alt+End | Dup, Erase Input |
| Pause, Alt+F1 | Clear, Help |
| Shift+Arrows, drag, double-click | Select; Ctrl+C or Ctrl+Insert copies |

Keys that keep their VS Code meaning while a terminal tab is focused: Ctrl+Shift+P, Ctrl+P, Ctrl+Tab, Ctrl+B, Ctrl+J, Ctrl+`, Ctrl+W, Ctrl+1–9, Ctrl+PageUp/PageDown. Everything else is remappable on the Keyboard page.

## Settings

All options are available on the Settings page and as ordinary VS Code settings under `tn5250.*`. "Defaults" apply to every tab; each saved connection stores only what differs from the defaults.

## Security and privacy

- Passwords and certificate passphrases are stored in the VS Code secret store, never in settings files.
- TLS connections validate the host certificate by default; self-signed hosts can be allowed per connection.
- Imported fonts are copied into the extension's own storage and loaded only for the terminal. No telemetry, no network access other than the host you connect to.
- **Save Session Trace** writes the raw bytes of a session for troubleshooting. The file contains screen contents; share it only with people allowed to see them.

## Status

Version 0.1.0. Tested against IBM i 7.3 and 7.5 with text-mode screens, windows, subfiles and menus. Not yet implemented: ENPTUI graphical windows and controls (text windows render correctly), printer sessions, file transfer. Client certificate authentication is implemented to specification but has not been verified against a host that requires it.

## Building from source

```
npm install
npm run check      # typecheck, lint, tests
npm run package    # builds the .vsix
```

## License

MIT. See [LICENSE](LICENSE).
