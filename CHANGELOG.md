# Changelog

## Unreleased

- IFS browser: a folder tree on the left (lazy, expand with the arrow, click a folder to open it, right-click for Open / Refresh / Copy path, drag the splitter, Folders button hides it), the path as clickable segments (the pencil or Ctrl+L types a path), and drag and drop: drop rows on a folder row, a tree folder or a path segment to move them there (asks first). Dropping files from the desktop still uploads.
- Linux and macOS builds: AppImage, .deb and tar.gz for x86_64 Linux (GTK 3 + WebKitGTK 4.1), a universal .dmg/.zip for macOS 11+ (Intel and Apple silicon, ad-hoc signed). The release workflow builds and smoke-tests every package on its own platform and publishes one SHA256SUMS; CI builds the app on all three.
- Windows: a per-machine MSI (`tn5250-terminal-x64.msi`) for IT deployment next to the per-user setup and the portable zip. Check for Updates recognises an MSI copy and points at the release page instead of trying to update in place.

## 0.1.6 - 2026-11-03

- Keyboard settings page: a visual keyboard (main block, navigation keys, keypad) above the search - live key feedback, a dot on bound keys with the list on hover, click to list a key's functions. While Assign is active, typing assigns at once; clicking the keys builds the combination in the key bar underneath (Save keybind / Cancel), text keys without Ctrl or Alt are refused, and the bar reports what just happened with Undo. The picture wraps and shrinks with the window. The "No key for ..." warning uses the function's primary ACS key (shared from tn5250-terminal). The connected-first session list and the History view of the extension are not in the desktop app yet.

## 0.1.5 - 2026-11-03

- Keyboard settings page: Assign takes Ctrl combinations and a bare modifier on release (Esc cancels); a key taken from another function says so with Undo; a function whose ACS key is gone is flagged with Restore; Import and Reset at the top with explanations; the .kmp picker opens in Documents\IBM\iAccessClient\Emulator and the import lands in the form until saved (shared from tn5250-terminal).
- A bare Alt press is the terminal's (no menu focus on release); unmapped Ctrl/Alt chords are consumed in the desktop app so the browser engine's own shortcuts never fire; the key overlay names bare modifiers by their key.
- Double-click on a word inside an input field selects the word; a blank inside a field selects the field; a blank elsewhere nothing.
- Save & Reload dialog lists the tabs it reloads; the second button is Apply & Continue; the settings page warns above Save which open tabs a connection change will not reach.
- Colours the Enhanced screen style does not use (Screen background, Active field, OIA background) are greyed out while that style is on, the reason printed beside the row; the Enhanced UI colours while it is Classic. Keyboard page: search, Import and Reset on one line; "No key for ..." warnings can be ignored (keyWarningsIgnored), back when the function gets a key and loses it again or a .kmp is imported.
- Keyboard: the ACS cursor and edit functions that were missing - Fast Cursor Up/Down/Left/Right (3 rows or columns, Ctrl+arrows), Tab Word / Backtab Word (Alt+Right / Alt+Left), Beginning of Field, Delete Word (Ctrl+Delete), Erase Field, Test Request (Ctrl+F12), Rule line on/off (Ctrl+Home). Copy and Paste are keymap actions now, so Dup can be assigned to any key (unassigned by default, as in ACS). The .kmp import knows the standard ACS/HOD function names (shared from tn5250-terminal).
- Settings that only take effect on a new connection are marked on the settings page; saving one while a tab that uses it is open asks Save & Reload (the tab reconnects with the new values) or Save & Close. Before, a screen-size change needed a new tab.

## 0.1.4 - 2026-11-02

- Right Ctrl = Enter and Left Ctrl = Reset work (default ACS layout), and a Control key assigned on the Keyboard page fires; a bare modifier press was dropped before the keymap was consulted (shared from tn5250-terminal). View > Key Overlay shows what each key does.
- Enhanced 5250 interface (as ACS): GUI windows drawn by the terminal and restored when the program removes them; prompt windows no longer stay behind on PUTOVR screens (shared from tn5250-terminal).
- Back on a menu after F3/F12, the cursor is in the option field again (a format rewritten after Restore Screen homes to its first input field), as in ACS.
- Shared emulator fixes from tn5250-terminal 0.1.3: command attention keys (DDS CA03, CA12 ...) send no field data, as in ACS; cursor lands in the first input field after a window closes; a full field-exit-required field keeps its last character; End = End of Field (keyboard and keypad), Alt+End = Erase Input, Ctrl+End = Erase EOF; keyboard settings search; Copy connection; watermark preview follows the picked profile; host underline kept in Enhanced UI.
- Saved passwords (Windows Credential Manager) shared by bypass signon, IFS, Run SQL Scripts and the Console; Tools menu entries for Run SQL Scripts and the CL / QSH Console (the host-server clients behind them are not finished yet; the tabs say so).
- Switching tabs (click, Window > Next Tab), closing a tab or hiding the connections panel puts keyboard focus in the terminal, so typing works at once; before, Tab moved between the window's buttons until the screen was clicked.

## 0.1.0

- Demo sessions: tilted watermark, coloured frame, [DEMO] tab prefix and status pill; Duplicate Connection.
- Enhanced UI text highlight mode (gradient boxes with contrasting text) and a glow strength slider.

- Enhanced UI mode: gradient background, field outlines, active-field glow, text glow, function keys as buttons, scanlines, padding; all configurable.
- ACS appearance parity: OIA and other colours with import/export, rule line, blinking-text modes, crisp/smooth text, bold font, image watermark with padding, hotspots (PF/FP/F/number/URL, 3-D buttons, Enter at click), paste tab handling and copy options, window title composition with session letters, New Tab (same session), Disconnect All.
- Settings page reorganized into Connection, Screen, Appearance, Edit, Hotspots, Tabs, Keyboard, Preferences with live previews.

- Terminal tab with canvas renderer, auto-fit and zoom, OIA status line.
- TN5250 engine: telnet negotiation (BINARY, EOR, TERMINAL-TYPE, NEW-ENVIRON),
  GDS records, EBCDIC code pages 37/273/500/1140-1149, Write To Display with all
  orders, Clear Unit / Alternate, Read commands, Roll, Write Error Code,
  Save/Restore Screen, Query reply.
- Keyboard: typing with shift/edit validation, insert mode, Field Exit / + / -,
  Dup, Erase EOF / Input, Tab / Backtab, cursor keys, AID keys F1-F24, Attn,
  SysReq, Reset, operator error codes.
- Commands: New Session, Disconnect, Reconnect, Demo Screen, Key Debug Overlay.
- Settings page modeled on ACS: profiles (defaults + saved sessions), connection, TLS, screen, font, preferences, colour mapping, keyboard assignment.
- Side bar with saved sessions, Add Tab, status bar item, session trace export.
- Rectangle selection and copy, hotspots, mouse wheel paging, watermark, cursor styles, auto-reconnect, inactivity timeout.
