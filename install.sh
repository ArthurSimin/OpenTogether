#!/usr/bin/env bash
# OpenTogether — one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ArthurSimin/OpenTogether/main/install.sh | bash
#
# What it does, in order:
#   1. checks Node >= 18
#   2. clones (or updates) OpenTogether into ~/.opentogether
#   3. runs `opentogether install` — puts the CLI on PATH (~/.local/bin), wires
#      the fish PATH, and registers the OpenCode plugin (comments preserved)
#   4. optionally grabs cloudflared so `opentogether up --tunnel` just works
#
# No sudo. No npm. Re-running is safe.
set -euo pipefail

REPO_URL="${OPENTOGETHER_REPO:-https://github.com/ArthurSimin/OpenTogether.git}"
DEST="${OPENTOGETHER_HOME:-$HOME/.opentogether}"
BRANCH="${OPENTOGETHER_BRANCH:-main}"

say()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1. Node ----------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js is required. Install it from https://nodejs.org (or your package manager), then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ is required (found $(node -v))."
ok "node $(node -v)"

# ---- 2. Get the code --------------------------------------------------------
if [ -d "$DEST/.git" ]; then
  say "updating existing checkout in $DEST"
  git -C "$DEST" fetch --quiet origin || true
  git -C "$DEST" reset --hard "origin/$BRANCH" --quiet || git -C "$DEST" pull --quiet --ff-only || warn "could not update; using what's there"
else
  command -v git >/dev/null 2>&1 || die "git is required to download OpenTogether."
  say "downloading OpenTogether into $DEST"
  rm -rf "$DEST"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$DEST" --quiet
fi
ok "code ready at $DEST"

# ---- 3. Install (launcher + fish PATH + OpenCode plugin) --------------------
say "installing CLI, fish PATH, and the OpenCode plugin…"
node "$DEST/bin/opentogether.mjs" install

# ---- 4. cloudflared (optional, for the one-button public URL) --------------
if command -v cloudflared >/dev/null 2>&1; then
  ok "cloudflared present"
else
  say "fetching cloudflared so 'opentogether up --tunnel' works out of the box…"
  node --input-type=module -e '
    import { downloadCloudflared } from "'"$DEST"'/src/tunnel.mjs";
    try { await downloadCloudflared({ log: (m)=>console.log("  "+m) }); }
    catch (e) { console.error("  could not auto-install cloudflared: "+e.message); }
  ' || warn "cloudflared not installed — you can still use the LAN relay"
fi

echo
ok "done!"
echo
echo "  Next:"
echo "    \033[36mopentogether up --tunnel --gui\033[0m     # start relay + public URL + dashboard"
echo
echo "  (Restart OpenCode Desktop so it loads the plugin + tools.)"
