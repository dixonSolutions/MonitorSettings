#!/usr/bin/env bash
# Run Monitor Settings in a *visible*, isolated nested GNOME Shell.
#
# Why this exists
# ---------------
# GNOME 49 removed `gnome-shell --nested`; upstream now runs a nested, visible
# shell through mutter's devkit viewer:
#
#     dbus-run-session -- gnome-shell --wayland --devkit
#
# The shell side of that (`--devkit`) ships with mutter, but the *viewer*
# window (`mutter-devkit`, package `mutter-devkit`) is not installed on
# Bluefin/Silverblue/ostree hosts and cannot be added without root. This script
# fetches just that one binary into $HOME and runs it against the nested
# shell's own D-Bus session, so you get a real GNOME Shell window on your
# desktop without logging out of your session.
#
# Everything the nested shell sees lives under $WORK (data, cache and an
# isolated dconf profile), so your real extensions and dconf database are not
# touched. The environment must be exported *before* dbus-run-session: the
# bus-activated dconf service inherits the bus's environment, not the client's.
#
# Usage
#   tests/run-nested-visible.sh start      # launch (detached) and wait for it
#   tests/run-nested-visible.sh status     # pids, bus, extension state
#   tests/run-nested-visible.sh logs       # tail the shell log
#   tests/run-nested-visible.sh shot [p]   # screenshot the nested shell -> p
#   tests/run-nested-visible.sh reload     # re-copy the extension + restart
#   tests/run-nested-visible.sh stop       # tear everything down
#
# Options for start/reload/restart:
#   --set KEY=VALUE   set an extension setting inside the nested dconf
#   --unsafe          run the nested shell in unsafe mode. Only needed for the
#                     `eval` and `shot` helpers, which use restricted D-Bus
#                     methods; GNOME then shows its "Unsafe mode" padlock in the
#                     nested panel, which is correct behaviour for anyone
#                     looking at that window. Off by default.
#
# Called from inside the dev container it re-execs itself on the host via
# distrobox-host-exec, so `tests/run-nested-visible.sh start` just works.

set -euo pipefail

UUID=monitor-settings@dixonsolutions.github.io
TEST_UUID=monitor-settings-test@dixonsolutions.github.io
WAYLAND_NAME=ms-nested-1

# --- re-exec on the host when running inside the container -------------------
if [ -e /run/.containerenv ] && [ "${MS_NESTED_ON_HOST:-0}" != 1 ] \
        && command -v distrobox-host-exec >/dev/null 2>&1; then
    exec distrobox-host-exec env MS_NESTED_ON_HOST=1 bash "$0" "$@"
fi

REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${MS_NESTED_WORK:-$HOME/.cache/monitor-settings-nested}
VIEWER=${MS_DEVKIT_VIEWER:-}
DEVKIT_ROOT=$HOME/.local/share/ms-devkit/root

msg() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

find_viewer() {
    [ -n "$VIEWER" ] && { printf '%s' "$VIEWER"; return; }
    for c in "$DEVKIT_ROOT/usr/libexec/mutter-devkit" /usr/libexec/mutter-devkit; do
        [ -x "$c" ] && { printf '%s' "$c"; return; }
    done
}

# Download the one file we need out of the mutter-devkit RPM (no root).
fetch_viewer() {
    local ver arch tmp rpm
    arch=$(uname -m)
    ver=$(gnome-shell --version | awk '{print $NF}')
    [ -n "$ver" ] || die "cannot determine gnome-shell version"
    tmp=$(mktemp -d)
    msg "Fetching mutter-devkit-$ver-$arch ..."
    ( cd "$tmp" && dnf -q download "mutter-devkit-$ver" >/dev/null 2>&1 ) \
        || ( cd "$tmp" && dnf -q download mutter-devkit >/dev/null 2>&1 ) \
        || die "dnf download mutter-devkit failed"
    rpm=$(ls "$tmp"/mutter-devkit-*.rpm | head -1)
    mkdir -p "$DEVKIT_ROOT"
    if command -v rpm2cpio >/dev/null 2>&1 && command -v cpio >/dev/null 2>&1; then
        ( cd "$DEVKIT_ROOT" && rpm2cpio "$rpm" | cpio -idm --quiet )
    elif command -v 7z >/dev/null 2>&1; then
        local x; x=$(mktemp -d)
        7z x -y -o"$x" "$rpm" >/dev/null
        7z x -y -o"$x/x" "$x"/*.cpio >/dev/null 2>&1 || true
        mkdir -p "$DEVKIT_ROOT"
        cp -r "$x"/*/usr "$DEVKIT_ROOT"/ 2>/dev/null || true
        cp -r "$x"/x/usr "$DEVKIT_ROOT"/ 2>/dev/null || true
    else
        die "need rpm2cpio+cpio or 7z to unpack the viewer"
    fi
    glib-compile-schemas "$DEVKIT_ROOT/usr/share/glib-2.0/schemas" \
        || die "could not compile devkit schemas"
    rm -rf "$tmp"
    chmod +x "$DEVKIT_ROOT/usr/libexec/mutter-devkit"
    msg "Viewer installed at $DEVKIT_ROOT/usr/libexec/mutter-devkit"
}

prepare() {
    rm -rf "$WORK"
    mkdir -p "$WORK/data/gnome-shell/extensions" "$WORK/config" "$WORK/cache"
    cp -r "$REPO/$UUID" "$WORK/data/gnome-shell/extensions/"
    [ -d "$REPO/tests/harness/$TEST_UUID" ] && \
        cp -r "$REPO/tests/harness/$TEST_UUID" "$WORK/data/gnome-shell/extensions/" || true
    glib-compile-schemas "$WORK/data/gnome-shell/extensions/$UUID/schemas"
    printf 'user-db:msnestdev\n' > "$WORK/dconf-profile"

    cat > "$WORK/launch.sh" <<EOF
#!/usr/bin/env bash
set -e
WORK=$WORK
export XDG_DATA_HOME=\$WORK/data XDG_CONFIG_HOME=\$WORK/config XDG_CACHE_HOME=\$WORK/cache
export XDG_RUNTIME_DIR=/run/user/\$(id -u)
export XDG_DATA_DIRS=/usr/local/share:/usr/share
export DCONF_PROFILE=\$WORK/dconf-profile
export WAYLAND_DISPLAY=\${MS_PARENT_WAYLAND:-wayland-0}
export DISPLAY=\${MS_PARENT_X11:-\${DISPLAY:-:0}}
export MS_VIEWER=$VIEWER
exec dbus-run-session -- bash "\$WORK/inner.sh"
EOF

    cat > "$WORK/inner.sh" <<EOF
#!/usr/bin/env bash
WORK=$WORK
VIEWER=\$MS_VIEWER
UUID=$UUID
TEST_UUID=$TEST_UUID
WAYLAND_NAME=$WAYLAND_NAME
DEVKIT_SCHEMA=$DEVKIT_ROOT/usr/share/glib-2.0/schemas
SCHEMAS=\$WORK/data/gnome-shell/extensions/\$UUID/schemas
exec >> "\$WORK/session.log" 2>&1
echo "=== nested session \$(date -Is) ==="
echo "BUS=\$DBUS_SESSION_BUS_ADDRESS"
export GSETTINGS_SCHEMA_DIR=\$SCHEMAS
gsettings set org.gnome.shell disable-user-extensions false
EXTENSIONS="['\$UUID']"
[ -n "\${MS_NESTED_HARNESS:-}" ] && EXTENSIONS="['\$UUID', '\$TEST_UUID']"
gsettings set org.gnome.shell enabled-extensions "\$EXTENSIONS"
gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
gsettings set org.gnome.shell.extensions.monitor-settings show-osd true 2>/dev/null || true
echo "enabled: \$(gsettings get org.gnome.shell enabled-extensions)"
for kv in $SETTINGS; do
    gsettings set org.gnome.shell.extensions.monitor-settings "\${kv%%=*}" "\${kv#*=}"
done
[ -n "$SETTINGS" ] && gsettings list-recursively org.gnome.shell.extensions.monitor-settings | grep -E 'debug|brightness|show-osd' || true
gnome-shell --wayland --devkit $UNSAFE_FLAG --wayland-display=\$WAYLAND_NAME &
SH=\$!
echo \$SH > "\$WORK/shell.pid"
sleep 8
GSETTINGS_SCHEMA_DIR=\$DEVKIT_SCHEMA XDG_DATA_DIRS=\$DEVKIT_ROOT/usr/share:\$XDG_DATA_DIRS \
    "\$VIEWER" &
echo \$! > "\$WORK/viewer.pid"
wait
EOF
    chmod +x "$WORK/launch.sh" "$WORK/inner.sh"
}

nested_bus() {
    # The nested shell runs its own D-Bus; grab the address from the log.
    sed -n 's/^BUS=//p' "$WORK/session.log" 2>/dev/null | head -1
}

nested_call() {
    local bus; bus=$(nested_bus)
    [ -n "$bus" ] || { echo "(no nested bus yet)"; return 1; }
    DBUS_SESSION_BUS_ADDRESS="$bus" gdbus call --address "$bus" "$@"
}

CMD=${1:-start}
shift || true
SETTINGS=""
UNSAFE_FLAG=""
case "$CMD" in
start|reload|restart)
    while [ $# -gt 0 ]; do
        case $1 in
        --set) SETTINGS="$SETTINGS ${2:-}"; shift 2 ;;
        --unsafe) UNSAFE_FLAG=--unsafe-mode; shift ;;
        *) shift ;;
        esac
    done
    case "$CMD" in
    reload|restart) "$0" stop >/dev/null 2>&1 || true ;;
    esac
    [ -n "$(find_viewer)" ] || fetch_viewer
    VIEWER=$(find_viewer) || die "no mutter-devkit viewer"
    prepare
    setsid nohup bash "$WORK/launch.sh" </dev/null >"$WORK/outer.log" 2>&1 &
    for _ in $(seq 1 40); do
        [ -s "$WORK/session.log" ] && grep -q '^BUS=' "$WORK/session.log" && break
        sleep 0.5
    done
    sleep 4
    msg "nested shell: $(cat "$WORK/shell.pid" 2>/dev/null || echo '?')  viewer: $(cat "$WORK/viewer.pid" 2>/dev/null || echo '?')"
    msg "bus: $(nested_bus)"
    msg "work: $WORK"
    grep -iE 'Failed to setup|JS ERROR' "$WORK/session.log" | head -5 || true
    ;;
stop)
    for f in viewer.pid shell.pid; do
        [ -f "$WORK/$f" ] && kill "$(cat "$WORK/$f")" 2>/dev/null || true
    done
    # Catch instances whose pid files were overwritten by a later start.
    pkill -f "wayland-display=$WAYLAND_NAME" 2>/dev/null || true
    pkill -f "ms-devkit/root/usr/libexec/mutter-devkit" 2>/dev/null || true
    sleep 1
    msg "stopped"
    ;;
status)
    for f in shell viewer; do
        p=; [ -f "$WORK/$f.pid" ] && p=$(cat "$WORK/$f.pid")
        if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then msg "$f: $p alive"; else msg "$f: dead"; fi
    done
    msg "bus: $(nested_bus)"
    ;;
logs)
    tail -n "${1:-60}" "$WORK/session.log" 2>/dev/null || echo "no log"
    ;;
shot)
    out=${1:-$WORK/shot.png}
    res=$(nested_call --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot true false "$out" 2>&1) || true
    case "$res" in
    *AccessDenied*|*"not allowed"*)
        msg "screenshot needs unsafe mode: $0 reload --unsafe" ;;
    *) msg "wrote $out" ;;
    esac
    ;;
eval)
    # Run JS inside the nested shell. Needs --unsafe. Usage: eval 'expr'
    res=$(nested_call --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$*" 2>&1) || true
    case "$res" in
    *AccessDenied*|*"not allowed"*|*"not implemented"*)
        msg "eval needs unsafe mode: $0 reload --unsafe" ;;
    *) msg "$res" ;;
    esac
    ;;
gget)
    bus=$(nested_bus)
    DBUS_SESSION_BUS_ADDRESS="$bus" DCONF_PROFILE="$WORK/dconf-profile" \
        GSETTINGS_SCHEMA_DIR="$WORK/data/gnome-shell/extensions/$UUID/schemas" \
        gsettings get "$@"
    ;;
*)
    sed -n '2,30p' "$0"
    ;;
esac
