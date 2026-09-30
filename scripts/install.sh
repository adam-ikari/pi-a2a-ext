#!/usr/bin/env bash
# Install the A2A bridge extension into the omp agent extensions directory.
#
#   ./scripts/install.sh            install or refresh (default)
#   ./scripts/install.sh --status   report state, change nothing
#   ./scripts/install.sh --uninstall remove the symlink (config/logs kept)
#
# Why a script instead of a one-liner: the documented `ln -s "$PWD/..."` only
# works when run from the repo root. Run from anywhere else and $PWD is the
# wrong directory, so the symlink points at a path that does not exist and the
# bridge silently never starts. This script derives the repo root from its own
# location, refuses to continue if the target is missing, and verifies the link
# afterwards so a broken install is loud instead of silent.
set -euo pipefail

# Repo root = parent of scripts/. Resolved from BASH_SOURCE, not $PWD.
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENTRY="$REPO_ROOT/extensions/a2a-bridge.ts"

# The extension imports ../src/*.ts, so the link must point at the real entry
# file and Bun must resolve it through to the repo (it does: realpath first).
AGENT_DIR="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
EXT_DIR="$AGENT_DIR/extensions"
LINK="$EXT_DIR/a2a-bridge.ts"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }

# The entry is NOT required for --uninstall or --status: those must still work
# when the repo is gone, which is exactly when you need them to report that.

# --- --uninstall -------------------------------------------------------------
if [ "${1:-}" = "--uninstall" ]; then
	if [ -L "$LINK" ]; then
		rm -f "$LINK"
		printf 'removed %s\n' "$LINK"
		printf 'note: ~/.omp/agent/a2a-bridge.json and the audit log were kept.\n'
		printf '      delete them by hand to also drop the token and history.\n'
	elif [ -e "$LINK" ]; then
		die "$LINK exists and is not a symlink; remove it by hand (refusing to touch a real file)"
	else
		printf 'not installed: %s does not exist\n' "$LINK"
	fi
	exit 0
fi

# --- --status ---------------------------------------------------------------
if [ "${1:-}" = "--status" ]; then
	printf 'repo:   %s\n' "$REPO_ROOT"
	if [ -L "$LINK" ]; then
		# Compare the *raw* link target, not `readlink -f`: for a broken link
		# readlink -f prints nothing and exits non-zero, which used to make a
		# dangling install look healthy.
		raw="$(readlink "$LINK")"
		if [ ! -e "$LINK" ]; then
			printf 'status: DANGLING -> %s (target missing; repo moved or deleted)\n' "$raw"
			printf '        re-run install from the new repo location, or --uninstall\n'
			exit 1
		fi
		if [ -f "$ENTRY" ] && [ "$raw" = "$ENTRY" ]; then
			printf 'status: installed -> %s\n' "$raw"
			exit 0
		fi
		printf 'status: installed -> %s\n' "$raw"
		printf '        note: points at a different checkout than this repo (%s)\n' "$REPO_ROOT"
		exit 0
	elif [ -e "$LINK" ]; then
		printf 'status: %s exists but is NOT a symlink; move it aside, then re-run install\n' "$LINK"
		exit 1
	else
		printf 'status: not installed\n'
		exit 1
	fi
fi

# --- install ----------------------------------------------------------------
[ -f "$ENTRY" ] || die "extension entry not found: $ENTRY (run this from a checkout of the repo)"
mkdir -p "$EXT_DIR"

if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
	die "$LINK exists and is a real file; move it aside first (refusing to overwrite)"
fi

ln -sfn "$ENTRY" "$LINK"

# Verify: the link must resolve to our entry, and the entry's own relative
# imports must resolve too. A link that exists but cannot load is the exact
# failure this script exists to make loud.
[ -e "$LINK" ] || die "install failed: $LINK does not resolve (dangling symlink)"
resolved="$(readlink -f "$LINK")"
[ "$resolved" = "$(readlink -f "$ENTRY")" ] ||
	die "install failed: $LINK resolves to '$resolved', expected '$ENTRY'"

for dep in src/server.ts src/bridge.ts src/filetools.ts src/fileguard.ts src/config.ts src/audit.ts src/auth.ts; do
	[ -f "$REPO_ROOT/$dep" ] || die "install failed: $REPO_ROOT/$dep is missing (incomplete checkout?)"
done

printf 'installed: %s\n' "$LINK"
printf '  -> %s\n' "$resolved"
info "restart omp to pick it up; the notification bar will show the listen URL and token."
info "check state any time with: $0 --status"
