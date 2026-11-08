# Deploying TN5250 Terminal to many PCs

For administrators who roll the app out with a deployment tool and want every user to
start with the company's connections. Nothing here is needed for a single PC.

## 1. Install

| Package | Scope | Command |
|---|---|---|
| `tn5250-terminal-x64.msi` | per machine, `C:\Program Files\TN5250 Terminal`, all users | `msiexec /i tn5250-terminal-x64.msi /qn` (remove: `/x`) |
| `tn5250-terminal-setup-x64.exe` | per user, `%LOCALAPPDATA%\Programs\TN5250 Terminal`, no admin rights | `tn5250-terminal-setup-x64.exe /S` |
| `tn5250-terminal-portable-x64.zip` | any folder | unzip and run |
| `tn5250-terminal_<version>_amd64.deb` | Linux, all users | `apt install ./tn5250-terminal_<version>_amd64.deb` |

The MSI copy does not update itself: roll out the next MSI. The per-user and portable
copies offer updates from GitHub at startup unless the managed file turns that off (below).

## 2. Three settings files

| File | Who writes it | When it is read |
|---|---|---|
| `%APPDATA%\tn5250-terminal\settings.json` (Linux `~/.config/tn5250-terminal/settings.json`) | the app, for each Windows or Linux user | always; the user's own connections, defaults, macros, theme |
| `%ProgramData%\tn5250-terminal\settings.json` (Linux `/etc/tn5250-terminal/settings.json`, macOS `/Library/Application Support/tn5250-terminal/settings.json`) | you | at every start, layered under the user's file; the app never writes it |
| `settings.default.json` next to the exe | you | once, the first time a user starts the app without a file of their own; the first save turns it into that user's own file |

`TN5250_MANAGED_SETTINGS=<path>` points the managed file somewhere else, for example a
read-only network share, for every user whose environment has the variable.

Help > Settings File Location in the app shows all three paths and whether the managed
file is present and readable.

## 3. What the managed file does

The same JSON shape as a user's file. Four parts are honoured:

- `defaults`: company defaults (code page, screen size, colours, keyboard, fonts). They sit
  under the user's own defaults: a value the user never changed follows your file.
- `sessions`: company connections. Users see them under **Company connections** in the
  Connections panel with a lock, can connect to them and open them in any number of tabs,
  but cannot edit or delete them. Right-click offers **Copy to my connections**: the copy is
  the user's own, and because it has the same name it takes the managed one's place in that
  user's list. Rename a managed session and it reappears next to the copy.
- `macros`: company macros. They run (by key too) but cannot be changed or deleted; the
  Macros list marks them `(company)` and offers a copy. Give each macro a stable `id`
  (any string unique in your file) so a later change replaces it instead of adding a second.
- `checkForUpdates: false`: no startup update check on this machine (MSI rollouts). The
  menu item is greyed out for the user.

Everything else in the file is ignored. Passwords never belong in it: the app keeps them in
the Windows Credential Manager or the Linux secret service, per user.

## 4. Example

`deploy/settings.managed.example.json` in the repository is this file:

```json
{
  "version": 1,
  "checkForUpdates": false,
  "defaults": {
    "codePage": 37,
    "screenSize": "27x132"
  },
  "sessions": [
    { "name": "Production", "host": "ibmi.example.com", "port": 992, "tls": true },
    { "name": "Test", "host": "ibmi-test.example.com", "port": 23, "tls": false, "screenSize": "24x80" }
  ],
  "macros": [
    {
      "id": "company-wrkactjob",
      "name": "Active jobs",
      "key": "Ctrl+Alt+1",
      "steps": [
        { "type": "text", "text": "wrkactjob" },
        { "type": "key", "action": "enter" },
        { "type": "waitInput" }
      ]
    }
  ]
}
```

Field names are the ones a user's `settings.json` uses; the quickest way to author the
file is to configure one PC the way everyone should have it, open Help > Settings File
Location, and copy the `defaults`, `sessions` and `macros` parts out of that user's file.
Export from Actions > Macros gives the macros part on its own.

## 5. Shared PCs

Each Windows account has its own `%APPDATA%` file, credentials and theme. The managed file
is the only thing the accounts share, and it is read-only for all of them. A change you make
to it is picked up by every account at its next start of the app; nothing needs to be
re-deployed to the user profiles. Uninstalling leaves the user files in place.

## 6. Check it

1. Put the example file in `%ProgramData%\tn5250-terminal\settings.json` and start the app
   as a user who already has settings: their connections are unchanged, **Company
   connections** appears under them, Help > Check for Updates at Startup is greyed out.
2. Help > Settings File Location shows the managed path as present.
3. Make the JSON invalid on purpose: the app starts on the user's settings, the log
   (View > Log) and Help > Settings File Location say why the company file was not used.
