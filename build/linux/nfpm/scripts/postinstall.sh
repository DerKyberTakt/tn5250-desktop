#!/bin/sh
# Runs after the .deb / .rpm / Arch package installs (nfpm scripts.postinstall): refreshes
# the desktop database and icon cache so the launcher shows TN5250 Terminal right away.
# Every command is optional: a minimal system without these tools installs fine.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
fi
exit 0
