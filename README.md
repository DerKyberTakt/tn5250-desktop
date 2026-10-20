# TN5250 Terminal (desktop)

A free, open-source 5250 terminal emulator for IBM i, as a native desktop app for
Windows (Linux next). Nothing else to install: no Java, no .NET, no browser runtime.

It shares its TN5250 engine and terminal UI with the
[TN5250 Terminal VS Code extension](https://github.com/DerKyberTakt/tn5250-terminal).

## Features

- 24x80 and 27x132 sessions over telnet or TLS, auto-fit, ACS-style keyboard map,
  bypass sign-on, reconnect with a visible connection status.
- Session tabs, quick connect, saved sessions, ACS-style menus and toolbar.
- SEU syntax colouring for RPG/RPGLE, CL, DDS and DB2 SQL.
- **Integrated File System browser** (Tools menu): browse, upload, download, rename,
  delete. It talks to the IBM i file server directly, like IBM i Access Client
  Solutions does, so the host needs only its standard host servers (STRHOSTSVR).
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

- `tn5250-terminal-setup-x64.exe`: installs for the current user only, no administrator
  rights needed (`%LOCALAPPDATA%\Programs\TN5250 Terminal`, Start menu and desktop
  shortcuts, uninstall from Settings > Apps). Silent install: `/S`.
- `tn5250-terminal-portable-x64.zip`: one exe to run from any folder.
- `SHA256SUMS`: checksums of both (`Get-FileHash <file>` in PowerShell).

Builds are not code-signed yet, so Windows SmartScreen may say "Windows protected your
PC" the first time: choose **More info > Run anyway**. Settings are kept in
`%APPDATA%\tn5250-terminal` and survive updates and uninstalls.

## Building

Requirements: Node.js 20+, Go 1.27+, and the Wails CLI
(`go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.0`).

```
npm ci
npm run check                  # typecheck, lint, tests
go test . ./internal/...
wails build -trimpath          # build/bin/tn5250-terminal.exe
```

`go run ./cmd/fakeifs` starts a local in-memory file server for trying the IFS browser
without an IBM i.

## License

MIT
