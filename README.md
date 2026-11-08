# TN5250 Terminal (desktop)

[![Release](https://img.shields.io/github/v/release/DerKyberTakt/tn5250-desktop?label=release)](https://github.com/DerKyberTakt/tn5250-desktop/releases/latest) [![Downloads](https://img.shields.io/github/downloads/DerKyberTakt/tn5250-desktop/total)](https://github.com/DerKyberTakt/tn5250-desktop/releases) [![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-0078d4)](https://github.com/DerKyberTakt/tn5250-desktop/releases/latest) [![CI](https://github.com/DerKyberTakt/tn5250-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/DerKyberTakt/tn5250-desktop/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A free, open-source 5250 terminal emulator for IBM i, as a native desktop app for
Windows, Linux and macOS. Nothing else to install: no Java, no .NET, no browser runtime.

It shares its TN5250 engine and terminal UI with the
[TN5250 Terminal VS Code extension](https://github.com/DerKyberTakt/tn5250-terminal).

## Features

- 24x80 and 27x132 sessions over telnet or TLS, auto-fit, ACS-style keyboard map,
  bypass sign-on, reconnect with a visible connection status.
- Session tabs, quick connect, saved sessions, ACS-style menus and toolbar. **Import Connections**
  (File menu) brings your ACS 5250 session profiles (`.hod`) over: connection, screen size, code
  page, workstation name, user profile, display, paste, hotspot and keyboard options, field
  colours. A connection already saved is updated from the profile or left alone, your
  choice, with Undo afterwards; passwords are never read.
- **Several windows**, as in ACS: drag a tab out of the window to give the session a window
  of its own, drag it onto another window of the app to merge it there, drag within the
  bar to reorder (also Window > Move Tab to New Window / Merge Tab into Main Window). The
  session keeps running while it moves; closing a window hands its sessions to the main
  window. The Connections panel lists every open tab under its saved session, whichever
  window shows it, and the status bar opens the session log. View > Appearance picks
  System, Light or Dark.
- **Enhanced 5250 interface**: GUI windows with titles, scroll bars you can click and drag
  (DDS `SFLEND(*SCRBAR)`), menu bars, pull-downs, radio buttons, check boxes, selection
  lists and push buttons, continued entry fields, word wrap, cursor progression,
  highlighted entry fields and programmable mouse buttons, as in ACS; an optional scroll
  bar beside every subfile (More... / Bottom). The Enhanced style draws the widgets, the
  Classic style shows the characters a character display shows.
- **Macros**: record what you type and press, or build a macro in the editor (type text,
  press a key, wait for the host, wait for a text, ask for a value), name it, give it a
  key, run it in any session. Actions > Macros.
- **Host PC commands**: `STRPCCMD` from a host program opens http(s) links in your
  browser; other commands ask first (or never run, by setting).
- SEU syntax colouring for RPG/RPGLE, CL, DDS and DB2 SQL.
- **Integrated File System browser** (Tools menu): browse, upload, download, rename,
  delete. It talks to the IBM i file server directly, like IBM i Access Client
  Solutions does, so the host needs only its standard host servers (STRHOSTSVR).
- **Run SQL Scripts** and a **CL / QSH Console** (Tools menu). They use the remote
  command server and the file server, nothing else: a query is materialised in QTEMP,
  copied to a UTF-8 CSV stream file in /tmp and read back, other statements run through
  RUNSQL, Qshell output is captured the same way. Because of that, a statement is at most
  5000 characters, update counts are not reported, NULL shows as an empty field, and the
  first 10,000 rows of a query are kept for paging. A result's column types come from
  QSYS2.SYSCOLUMNS.
- No telemetry. Connections go only to the hosts you enter. Passwords are kept in the
  operating system credential store.
- Updates from GitHub: the ↓ toolbar button glows green when a new release is out, and
  updates in place after checking the download against the release's `SHA256SUMS`. The
  only other connection the app makes is that check, to github.com, at startup and once
  a day (Help > Check for Updates at Startup turns it off). Behind a proxy, set
  `HTTPS_PROXY`.

## Download

Get the latest release from
[Releases](https://github.com/DerKyberTakt/tn5250-desktop/releases/latest):

**Windows 10 / 11**

- `tn5250-terminal-setup-x64.exe`: installs for the current user only, no administrator
  rights needed (`%LOCALAPPDATA%\Programs\TN5250 Terminal`, Start menu and desktop
  shortcuts, uninstall from Settings > Apps). Silent install: `/S`. Updates itself.
- `tn5250-terminal-x64.msi`: per-machine installer for IT (Program Files, all users;
  `msiexec /i tn5250-terminal-x64.msi /qn` for a silent install, `/x` to remove). A copy
  installed this way does not update itself; roll out the next MSI.
- `tn5250-terminal-portable-x64.zip`: one exe to run from any folder. Updates itself.

Builds are not code-signed yet, so Windows SmartScreen may say "Windows protected your
PC" the first time: choose **More info > Run anyway**. Settings are kept in
`%APPDATA%\tn5250-terminal` and survive updates and uninstalls. For a rollout, put a `settings.json`
with the sessions and defaults everyone should start with in `%ProgramData%\tn5250-terminal`
(or a `settings.default.json` next to the exe): users who have no settings yet start from it.

**Linux (x86_64, GTK 4 + WebKitGTK 6.0)**

- `tn5250-terminal-x86_64.AppImage`: `chmod +x` and run; updates itself in place.
- `tn5250-terminal_<version>_amd64.deb`: Debian 13+, Ubuntu 24.04+ and derivatives
  (`sudo apt install ./tn5250-terminal_<version>_amd64.deb`).
- `tn5250-terminal-linux-amd64.tar.gz`: the binary with a desktop file and icon;
  `./install.sh` puts them under `~/.local` for the current user. Needs the distribution's
  `libgtk-4` and `libwebkitgtk-6.0` packages (Ubuntu 24.04+, Debian 13+; Arch:
  `webkitgtk-6.0`, Fedora: `webkitgtk6.0`).

Settings are kept in `~/.config/tn5250-terminal`; passwords in the desktop's secret
service (GNOME Keyring, KDE Wallet) through libsecret.

**macOS 11+ (Intel and Apple silicon, one universal build)**

- `tn5250-terminal-macos-universal.dmg`: open and drag TN5250 Terminal to Applications.
- `tn5250-terminal-macos-universal.zip`: the same app, zipped.

The app is signed ad hoc, not notarized, so the first start needs **right-click > Open**
(or `xattr -dr com.apple.quarantine "/Applications/TN5250 Terminal.app"`). Updates: download
the next .dmg. Settings are kept in `~/Library/Application Support/tn5250-terminal`;
passwords in the Keychain.

`SHA256SUMS` lists the checksums of every file (`sha256sum -c SHA256SUMS`, or
`Get-FileHash <file>` in PowerShell).

## Troubleshooting

### Sign-on fails with CPF1120, but the user ID and password are right

The password probably contains a character that is not the same in every EBCDIC code page: `! @ # $ [ ] { } | \\ ^ ~` and the accented letters. The emulator sends the byte of the character in the session's code page; the host reads that byte with the CCSID of the sign-on job (`QCCSID`, or the user profile's CCSID), and at password level 2 or 3 it checks the password as those characters. When the two code pages differ, `!` typed under 037 arrives as:

| Host CCSID | `!` arrives as |
|---|---|
| 037, 1140 | `!` |
| 273, 1141 (Germany/Austria) | `Ü` |
| 500, 1148 (International) | `]` |
| 1142 (Denmark/Norway) | `€` (and `#` as `Æ`) |
| 1144 (Italy) | `é` (and `#` as `£`) |

It works the other way round too: a password set from a 037 session fails from a 273 session. Nothing on the screen shows it, because the password field does not display, and from IBM i 7.5 the host answers CPF1120 ("user does not exist or password not correct") for both cases. Each failed attempt counts toward `QMAXSIGN`, so do not keep guessing.

- Set **Host Code Page** (Settings > Connection) to the host's CCSID and connect again. Use the value your ACS session has for that host, or ask for `QCCSID`.
- After a failed sign-on with such a password, the app shows a one-time hint that names the characters and the code page in use.
- The workstation is announced with the keyboard type and character set that belong to the code page (`KBDTYPE` AGB for 273, INB for 500, and so on; the Keyboard type setting overrides it), so the virtual device matches the code page.
- A password made of letters, digits and `.`, `-`, `_` is the same in every code page and avoids the problem when you sign on from several systems.

## Building

Requirements: Node.js 22+, Go 1.27+, and the Wails v3 CLI
(`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`; `wails3 doctor` checks the rest).

```
npm ci
npm run check                  # typecheck, lint, tests
go test . ./internal/...
wails3 build                                   # build/bin/tn5250-terminal.exe (Windows), or the Linux/macOS binary
wails3 task windows:package INSTALL_SCOPE=user # per-user NSIS installer
wails3 task linux:build                        # needs libgtk-4-dev libwebkitgtk-6.0-dev
wails3 task darwin:package:universal           # needs Xcode command line tools; .app bundle
```

The release workflow (`.github/workflows/release.yml`) builds all of the above on a tag
and smoke-tests each package; a push to a `dry-run/*` branch does the same without
publishing.

`go run ./cmd/fakeifs` starts a local in-memory file server for trying the IFS browser
without an IBM i.

## License

MIT
