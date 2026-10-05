#!/usr/bin/env bash
# Runs the extension inside an isolated headless GNOME Shell and drives its UI
# with the harness extension. Your real session, settings and extensions are
# untouched (separate D-Bus, dconf, data and cache dirs).
set -euo pipefail
# Use the system GLib tools (Homebrew's gsettings uses a keyfile backend, not dconf)
export PATH=/usr/bin:$PATH
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=monitor-settings@dixonsolutions.github.io
TEST_UUID=monitor-settings-test@dixonsolutions.github.io
WORK=${MS_WORK:-$(mktemp -d)}
export MS_TEST_DIR=$WORK/out
mkdir -p "$MS_TEST_DIR" "$WORK/data/gnome-shell/extensions" "$WORK/config" "$WORK/cache"
cp -r "$ROOT/$UUID" "$WORK/data/gnome-shell/extensions/"
cp -r "$ROOT/tests/harness/$TEST_UUID" "$WORK/data/gnome-shell/extensions/"
glib-compile-schemas "$WORK/data/gnome-shell/extensions/$UUID/schemas"

export XDG_DATA_HOME=$WORK/data XDG_CONFIG_HOME=$WORK/config XDG_CACHE_HOME=$WORK/cache
export XDG_DATA_DIRS=${XDG_DATA_DIRS:-/usr/local/share:/usr/share}
export GSETTINGS_SCHEMA_DIR=$WORK/data/gnome-shell/extensions/$UUID/schemas
unset DISPLAY WAYLAND_DISPLAY

dbus-run-session -- bash -c "
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions \"['$UUID', '$TEST_UUID']\"
  gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
  gnome-shell --headless --wayland --no-x11 --wayland-display=ms-test-0 --virtual-monitor 1600x1000 > '$WORK/shell.log' 2>&1 &
  PID=\$!
  for i in \$(seq 1 120); do grep -q '^DONE' '$MS_TEST_DIR/results.txt' 2>/dev/null && break; sleep 1; done
  WAYLAND_DISPLAY=ms-test-0 GI_TYPELIB_PATH=/usr/lib64/gnome-shell/girepository-1.0 LD_LIBRARY_PATH=/usr/lib64/gnome-shell MS_EXT_DIR='$WORK/data/gnome-shell/extensions/$UUID' timeout 30 gjs -m '$ROOT/tests/prefs-test.js' >> '$MS_TEST_DIR/results.txt' 2>&1 || echo 'FAIL prefs test exited non-zero' >> '$MS_TEST_DIR/results.txt'
  kill \$PID 2>/dev/null; wait \$PID 2>/dev/null || true
"
cat "$MS_TEST_DIR/results.txt" 2>/dev/null || { echo "no results; shell log:"; tail -50 "$WORK/shell.log"; exit 1; }
echo "--- shell log errors (monitor-settings):"
grep -iE "monitor-settings|JS ERROR|TypeError|ReferenceError" "$WORK/shell.log" | grep -v "^$" | head -40 || true
echo "artifacts: $WORK"
! grep -q '^FAIL' "$MS_TEST_DIR/results.txt"
