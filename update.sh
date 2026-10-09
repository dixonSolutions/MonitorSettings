#!/usr/bin/env bash
# Monitor Settings — update to the latest, or to a tagged release.
#
#   ./update.sh                    fetch and install the latest of this branch
#   ./update.sh --live             ...and apply everything a running session can
#   ./update.sh --tag v1.0.0       install a tagged release instead
#   ./update.sh --check            report what an update would change, install nothing
#
# Fetching and checking out happen here; the install itself is delegated to
# ./setup.sh so there is one implementation. See setup.sh for what --live can
# and cannot do (short version: no extension JavaScript can be loaded into a
# running GNOME Shell, so code changes need a login).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ -e /run/.containerenv ] && [ "${MS_ON_HOST:-0}" != 1 ] \
        && command -v distrobox-host-exec >/dev/null 2>&1; then
    exec distrobox-host-exec env MS_ON_HOST=1 bash "$0" "$@"
fi

LIVE=0
CHECK=0
REF=

usage() { sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
say()   { printf '%s\n' "$*"; }
die()   { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case $1 in
    --live) LIVE=1; shift ;;
    --check|--dry-run) CHECK=1; shift ;;
    --tag|--ref)
        REF=${2:-}
        [ -n "$REF" ] || die "$1 needs a value"
        shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: '$1' (try --help)" ;;
    esac
done

command -v git >/dev/null 2>&1 || die "git not found in PATH"
git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "$ROOT is not a git checkout"

before=$(git -C "$ROOT" rev-parse --short HEAD)
before_full=$(git -C "$ROOT" rev-parse HEAD)

say "Fetching from origin…"
git -C "$ROOT" fetch --tags --prune --quiet origin \
    || die "could not fetch from origin (offline?)"

if [ -n "$REF" ]; then
    git -C "$ROOT" rev-parse --verify --quiet "$REF^{commit}" >/dev/null \
        || die "no such tag or ref: $REF"
    target=$REF
else
    branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)
    [ "$branch" != "HEAD" ] || die "checkout is detached; pass --tag <ref>"
    upstream=$(git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
    [ -n "$upstream" ] || die "branch '$branch' has no upstream; pass --tag <ref>"
    target=$upstream
fi

target_full=$(git -C "$ROOT" rev-parse "$target^{commit}")

if [ "$before_full" = "$target_full" ]; then
    say "Already up to date ($before)."
    [ "$CHECK" = 1 ] && exit 0
    [ "$LIVE" = 1 ] && exec "$ROOT/setup.sh" --live
    exec "$ROOT/setup.sh"
fi

ahead=$(git -C "$ROOT" rev-list --count "$before_full..$target_full")
log() { git -C "$ROOT" --no-pager log --oneline --no-decorate "$1" | sed 's/^/  /'; }
if [ "$ahead" -gt 0 ]; then
    say "Update available ($ahead commit(s)):"
    log "$before_full..$target_full"
else
    back=$(git -C "$ROOT" rev-list --count "$target_full..$before_full")
    say "$target is $back commit(s) behind the current checkout:"
    log "$target_full..$before_full"
fi

if [ "$CHECK" = 1 ]; then
    say
    say "Nothing installed (--check). Re-run without --check to apply."
    exit 0
fi

if [ "$target" = "$REF" ]; then
    git -C "$ROOT" checkout --quiet "$REF"
else
    git -C "$ROOT" merge --ff-only --quiet "$target" \
        || die "cannot fast-forward $branch to $target; pull by hand"
fi
after=$(git -C "$ROOT" rev-parse --short HEAD)
say "Now at $after"

if [ "$LIVE" = 1 ]; then
    exec "$ROOT/setup.sh" --live
fi
exec "$ROOT/setup.sh"
