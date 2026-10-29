# Changelog

## Unreleased

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
