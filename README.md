# TN5250 Terminal (desktop)

[![Release](https://img.shields.io/github/v/release/DerKyberTakt/tn5250-desktop?label=release)](https://github.com/DerKyberTakt/tn5250-desktop/releases/latest) [![Downloads](https://img.shields.io/github/downloads/DerKyberTakt/tn5250-desktop/total)](https://github.com/DerKyberTakt/tn5250-desktop/releases) [![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-0078d4)](https://github.com/DerKyberTakt/tn5250-desktop/releases/latest) [![CI](https://github.com/DerKyberTakt/tn5250-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/DerKyberTakt/tn5250-desktop/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A free, open-source 5250 terminal emulator for IBM i, as a native desktop app for
Windows, Linux and macOS. Nothing else to install: no Java, no .NET, no browser runtime.

It shares its TN5250 engine and terminal UI with the
[TN5250 Terminal VS Code extension](https://github.com/DerKyberTakt/tn5250-terminal).

## Features

- 24x80 and 27x132 sessions over telnet or TLS, auto-fit, ACS-style keyboard map,
  bypass sign-on, reconnect with a visible connection status.
- Session tabs, quick connect, saved sessions, ACS-style menus and toolbar.
- **Enhanced 5250 interface**: GUI windows with titles, scroll bars you can click and drag
  (DDS `SFLEND(*SCRBAR)`), menu bars, pull-downs, radio buttons, check boxes, selection
  lists and push buttons, continued entry fields, word wrap, cursor progression,
  highlighted entry fields and programmable mouse buttons, as in ACS; an optional scroll
  bar beside every subfile (More... / Bottom). The Enhanced style draws the widgets, the
  Classic style shows the characters a character display shows.
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
`%APPDATA%\tn5250-terminal` and survive updates and uninstalls.

**Linux (x86_64, GTK 3 + WebKitGTK 4.1)**

- `tn5250-terminal-x86_64.AppImage`: `chmod +x` and run; updates itself in place.
- `tn5250-terminal_<version>_amd64.deb`: Debian 12+, Ubuntu 22.04+ and derivatives
  (`sudo apt install ./tn5250-terminal_<version>_amd64.deb`).
- `tn5250-terminal-linux-amd64.tar.gz`: the binary with a desktop file and icon;
  `./install.sh` puts them under `~/.local` for the current user. Needs the distribution's
  `libgtk-3` and `libwebkit2gtk-4.1` packages (Arch: `webkit2gtk-4.1`, Fedora:
  `webkit2gtk4.1`).

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

## Building

Requirements: Node.js 20+, Go 1.27+, and the Wails CLI
(`go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.0`).

```
npm ci
npm run check                  # typecheck, lint, tests
go test . ./internal/...
wails build -trimpath          # build/bin/tn5250-terminal.exe (Windows)
wails build -trimpath -platform linux/amd64 -tags webkit2_41    # needs libgtk-3-dev libwebkit2gtk-4.1-dev
wails build -trimpath -platform darwin/universal                # needs Xcode command line tools
```

The release workflow (`.github/workflows/release.yml`) builds all of the above on a tag
and smoke-tests each package; a push to a `dry-run/*` branch does the same without
publishing.

`go run ./cmd/fakeifs` starts a local in-memory file server for trying the IFS browser
without an IBM i.

## License

MIT
