#!/usr/bin/env bash
# Monitor Settings — install.
#
#   ./setup.sh                     install for the current user and enable
#   ./setup.sh --live              ...and activate it in the running session now
#   ./setup.sh --tag v1.0.0        install a specific tag/ref of this checkout
#
# What --live can and cannot do
# -----------------------------
# A running GNOME Shell cannot load changed extension JavaScript. GNOME imports
# an extension module exactly once per shell process ("Extensions can only be
# imported once", js/ui/extensionSystem.js), so a disable/enable cycle, and even
# the deprecated ReloadExtension D-Bus method, re-run the *already loaded* code.
# A Wayland shell also cannot restart itself: there is no reexec path and no
# systemd unit for it, so a shell restart means a logout.
#
# --live therefore applies everything a running session *can* accept: the files,
# the compiled schemas, the settings, and a fresh monitor scan from re-running
# enable(). It then reports exactly what still needs a login, instead of
# pretending to do more.
set -euo pipefail

UUID=monitor-settings@dixonsolutions.github.io
SRC_NAME=$UUID

# Run on the host when invoked from inside the dev container.
if [ -e /run/.containerenv ] && [ "${MS_ON_HOST:-0}" != 1 ] \
        && command -v distrobox-host-exec >/dev/null 2>&1; then
    exec distrobox-host-exec env MS_ON_HOST=1 bash "$0" "$@"
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$ROOT/$SRC_NAME

LIVE=0
REF=

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
say()   { printf '%s\n' "$*"; }
note()  { printf '  %s\n' "$*"; }
die()   { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case $1 in
    --live) LIVE=1; shift ;;
    --tag|--ref)
        REF=${2:-}
        [ -n "$REF" ] || die "$1 needs a value"
        shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: '$1' (try --help)" ;;
    esac
done

[ -f "$SRC/metadata.json" ] || die "cannot find $SRC_NAME next to $(basename "$0")"

# --- prerequisites ----------------------------------------------------------
for cmd in make glib-compile-schemas gnome-extensions; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd not found in PATH"
done

shell_version=$(gnome-shell --version 2>/dev/null | awk '{print $NF}' || true)
supported=$(sed -n '/"shell-version"/,/]/p' "$SRC/metadata.json" \
    | grep -o '"[0-9]\+"' | tr -d '"' | tr '\n' ' ')
say "GNOME Shell ${shell_version:-unknown}  (extension supports: ${supported:-unknown})"
case " ${supported} " in
*" ${shell_version%%.*} "*) ;;
*) note "warning: this extension does not list GNOME Shell ${shell_version%%.*}" ;;
esac

if command -v ddcutil >/dev/null 2>&1; then
    say "ddcutil $(ddcutil --version 2>/dev/null | awk '/^ddcutil/ {print $NF; exit}')"
    ddcutil detect >/dev/null 2>&1 \
        || note "warning: 'ddcutil detect' failed — check I²C permissions (i2c group) and DDC/CI in the monitor's own menu"
else
    note "warning: ddcutil not found. Fedora/Bluefin: sudo dnf install ddcutil (or rpm-ostree install ddcutil)"
fi

# --- optional: install a specific ref --------------------------------------
if [ -n "$REF" ]; then
    command -v git >/dev/null 2>&1 || die "git not found (needed for --tag)"
    git -C "$ROOT" rev-parse --verify --quiet "$REF^{commit}" >/dev/null \
        || die "no such tag or ref: $REF"
    say "Checking out $REF"
    git -C "$ROOT" checkout --quiet "$REF"
fi

# --- install ----------------------------------------------------------------
say "Installing $UUID"
if ! out=$(make -C "$ROOT" install 2>&1); then
    printf '%s\n' "$out" >&2
    die "make install failed"
fi

if gnome-extensions info "$UUID" 2>/dev/null | grep -q 'Enabled: Yes'; then
    say "Enabled: already"
else
    gnome-extensions enable "$UUID" && say "Enabled"
fi

# --- apply now --------------------------------------------------------------
if [ "$LIVE" != 1 ]; then
    say
    say "Installed. Log out and back in to load it, or re-run with --live."
    exit 0
fi

say
say "Applying live (no logout)…"
gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
sleep 1
gnome-extensions enable "$UUID" >/dev/null 2>&1 || true
sleep 2
gnome-extensions info "$UUID" 2>&1 | grep -E '^\s*(Enabled|State)' | sed 's/^/  /' || true
say
say "Live now: files, compiled schemas, settings, and a fresh monitor scan"
say "          (enable() has re-run in the running shell)."
say "Needs a login: changed JavaScript. GNOME Shell imports an extension"
say "          module once per shell process, and a Wayland shell cannot"
say "          restart itself, so a code change only loads at next login."
