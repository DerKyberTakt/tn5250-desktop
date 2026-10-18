# TN5250 Terminal for IBM i

A 5250 terminal emulator for IBM i (AS/400) that opens as a **VS Code editor tab**.

- Pure TypeScript TN5250 client running inside VS Code. Nothing else to install: no Java, no Node, no PASE packages.
- Resizable and zoomable: the screen scales to the tab. 24x80 and 27x132.
- Telnet on port 23 by default; TLS (port 992) is a setting.
- Keyboard modeled on IBM i Access Client Solutions: F1-F24, Field Exit, Field+/-, Attn, SysReq, Reset, Dup, Erase Input, insert mode, operator error codes.


## Use

1. Open the **TN5250** view in the Activity Bar and click **New Connection**
   (enter the host; everything else is set in Settings). Click a connection to
   open a tab; **Connect to Previous IBM i** (Ctrl+Alt+5) reopens the last one.
   Connections live in the `tn5250.sessions` setting.
2. Sign on. The tab title shows the host; the status line at the bottom shows
   connection state, `X SYSTEM` / `X II`, insert mode, message waiting and the
   cursor position.
3. Zoom with Ctrl+wheel, Ctrl+= and Ctrl+-; Ctrl+0 returns to fit.

| Key | 5250 function |
|---|---|
| Enter, Right Ctrl | Enter |
| Left Ctrl | Reset |
| Keypad Enter, Shift+Enter, Ctrl+Enter | Field Exit |
| Keypad +, Keypad - | Field+, Field- |
| F1-F12, Shift+F1-F12 | F1-F24 |
| Escape, Shift+Escape | Attn, SysReq |
| Page Up / Page Down | Roll |
| Home, End | First field, Erase to end of field |
| Insert, Delete, Backspace | Insert mode, Delete, Backspace |
| Shift+Insert, Alt+End | Dup, Erase Input |
| Pause, Alt+F1 | Clear, Help |

Keys that stay with VS Code while the terminal is focused: Ctrl+Shift+P,
Ctrl+P, Ctrl+Tab, Ctrl+B, Ctrl+J, Ctrl+`, Ctrl+W, Ctrl+1..9, Ctrl+PageUp/Down.

## Settings

The gear in the TN5250 side bar (or **TN5250: Settings**) opens a settings
page modeled on ACS: Connection, Advanced, TLS/SSL, Screen, Font, Preferences,
Appearance (colour mapping) and Keyboard (assign any key to any 5250 function).
"Defaults" apply to every tab; each saved session stores only what differs.
Everything is also plain VS Code settings under `tn5250.*`.

| Setting | Default | Meaning |
|---|---|---|
| `tn5250.connection.defaultPort` | 23 | Port when none is given |
| `tn5250.connection.tls` | false | Connect with TLS |
| `tn5250.connection.trustAnyCertificate` | false | Accept self-signed certificates |
| `tn5250.connection.defaultScreenSize` | 24x80 | 24x80 (IBM-3179-2) or 27x132 (IBM-3477-FC) |
| `tn5250.connection.defaultCodePage` | 37 | EBCDIC code page |
| `tn5250.connection.deviceName` | | Requested device name |
| `tn5250.appearance.autoFit` | true | Scale the screen to the tab |
| `tn5250.appearance.fontFamily` | | Monospace font (empty = editor font) |
| `tn5250.appearance.columnSeparators` | dot | Column separator attribute: dot, line or none |
| `tn5250.sessions` | [] | Saved sessions for the side bar |
| `tn5250.debug.keyOverlay` | false | Show key events in the tab |

For protocol problems, **TN5250: Save Session Trace** writes the raw bytes of
the focused session to a JSON file that `npm run dump` can render. The file
contains screen contents.

## Building from source

```
npm install
npm run check      # typecheck, lint, tests
npm run package    # builds the .vsix
```

## License

MIT. See [LICENSE](LICENSE).
