#!/bin/sh
# Installs TN5250 Terminal for the current user from the tar.gz (no root needed):
# the binary goes to ~/.local/bin, the menu entry and icon to ~/.local/share.
# Run with "uninstall" to remove them again. Settings stay in ~/.config/tn5250-terminal.
set -e
here=$(cd "$(dirname "$0")" && pwd)
bin="$HOME/.local/bin"
share="${XDG_DATA_HOME:-$HOME/.local/share}"
if [ "$1" = "uninstall" ]; then
  rm -f "$bin/tn5250-terminal" "$share/applications/tn5250-terminal.desktop" "$share/icons/hicolor/512x512/apps/tn5250-terminal.png"
  echo "removed"
  exit 0
fi
mkdir -p "$bin" "$share/applications" "$share/icons/hicolor/512x512/apps"
install -m 755 "$here/tn5250-terminal" "$bin/tn5250-terminal"
install -m 644 "$here/tn5250-terminal.png" "$share/icons/hicolor/512x512/apps/tn5250-terminal.png"
sed "s|^Exec=.*|Exec=$bin/tn5250-terminal|" "$here/tn5250-terminal.desktop" > "$share/applications/tn5250-terminal.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$share/applications" || true
echo "installed to $bin/tn5250-terminal (needs libgtk-3 and libwebkit2gtk-4.1 from your distribution)"
case ":$PATH:" in *":$bin:"*) ;; *) echo "note: $bin is not on your PATH";; esac
