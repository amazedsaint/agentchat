#!/usr/bin/env sh
# agentchat installer — clones, builds, and wires up the CLI + Claude Code skill.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/amazedsaint/agentchat/main/install.sh | sh
#
# Environment overrides:
#   AGENTCHAT_INSTALL=/path   where to clone (default ~/.local/share/agentchat)
#   AGENTCHAT_BIN=/path       where to symlink bins (default ~/.local/bin)
#   AGENTCHAT_BRANCH=main     branch/tag/commit to check out (default main)
#   AGENTCHAT_SKIP_SKILL=1    don't install the Claude Code skill file
#   AGENTCHAT_SKIP_MCP=1      don't register with Claude Code via `claude mcp add`

set -eu

REPO="amazedsaint/agentchat"
INSTALL_DIR="${AGENTCHAT_INSTALL:-$HOME/.local/share/agentchat}"
BIN_DIR="${AGENTCHAT_BIN:-$HOME/.local/bin}"
BRANCH="${AGENTCHAT_BRANCH:-main}"
SKILL_DIR="$HOME/.claude/skills/chat"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- prereq checks ----------
command -v git  >/dev/null 2>&1 || err "git not found on PATH"
command -v node >/dev/null 2>&1 || err "node not found on PATH (need >= 20)"

NODE_MAJOR=$(node -v | sed 's/^v//;s/\..*//')
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "node >= 20 required (you have $(node -v))"
fi

if command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
elif command -v npm >/dev/null 2>&1; then
  PM=npm
else
  err "neither pnpm nor npm found on PATH"
fi
log "Using $PM ($(command -v "$PM"))"

# ---------- clone or update ----------
mkdir -p "$INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard --quiet "origin/$BRANCH"
else
  log "Cloning $REPO into $INSTALL_DIR"
  git clone --quiet --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ---------- install deps + build ----------
log "Installing dependencies"
if [ "$PM" = pnpm ]; then
  pnpm install --silent
  # pnpm 10+ blocks post-install scripts by default; `rebuild` forces the
  # better-sqlite3 native binding to build. Silent-skip if already built.
  pnpm rebuild better-sqlite3 >/dev/null 2>&1 || true
else
  # npm runs post-install scripts by default, so better-sqlite3 builds normally.
  npm install --silent --no-audit --no-fund
fi

log "Building"
$PM run build --silent

# ---------- symlink the bins ----------
mkdir -p "$BIN_DIR"
chmod +x "$INSTALL_DIR/dist/bin/agentchat.js" "$INSTALL_DIR/dist/bin/agentchat-mcp.js"
ln -sf "$INSTALL_DIR/dist/bin/agentchat.js"     "$BIN_DIR/agentchat"
ln -sf "$INSTALL_DIR/dist/bin/agentchat-mcp.js" "$BIN_DIR/agentchat-mcp"
log "Linked $BIN_DIR/agentchat"
log "Linked $BIN_DIR/agentchat-mcp"

# ---------- install the skill (so /chat works in Claude Code) ----------
if [ "${AGENTCHAT_SKIP_SKILL:-0}" != "1" ]; then
  mkdir -p "$SKILL_DIR"
  cp "$INSTALL_DIR/src/skill/chat/SKILL.md" "$SKILL_DIR/SKILL.md"
  log "Installed skill at $SKILL_DIR/SKILL.md"
fi

# ---------- register with Claude Code if `claude` is on PATH ----------
if [ "${AGENTCHAT_SKIP_MCP:-0}" != "1" ] && command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q '^agentchat'; then
    log "Claude Code MCP registration already present (skipping)"
  else
    log "Registering with Claude Code: claude mcp add agentchat"
    claude mcp add agentchat -s user -- "$BIN_DIR/agentchat-mcp" \
      || warn "Could not register; run this manually: claude mcp add agentchat -s user -- $BIN_DIR/agentchat-mcp"
  fi
fi

# ---------- PATH hint ----------
on_path=1
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) on_path=0 ;;
esac

# ---------- post-install banner ----------
printf '\n'
printf '\033[1;32m  ✓ agentchat is installed.\033[0m\n'
printf '\n'
printf '  \033[1mUsing with Claude Code\033[0m\n'
if command -v claude >/dev/null 2>&1; then
  printf '    agentchat is registered as an MCP server. Start a new\n'
  printf '    Claude Code session — type \033[36m/chat help\033[0m to see the commands.\n'
else
  printf '    Install Claude Code (https://claude.com/claude-code), then:\n'
  printf '      \033[36mclaude mcp add agentchat -s user -- %s/agentchat-mcp\033[0m\n' "$BIN_DIR"
fi
printf '    The web UI auto-opens at \033[36mhttp://127.0.0.1:7879\033[0m when\n'
printf '    a session starts. Your sign-in token is injected into the URL.\n'
printf '\n'
printf '  \033[1mUsing standalone\033[0m\n'
printf '    \033[36m%s\033[0m              start the web UI manually\n' "agentchat web"
printf '    \033[36m%s\033[0m              print the sign-in URL (with token)\n' "agentchat url"
printf '    \033[36m%s\033[0m           health check + URL\n' "agentchat doctor"
printf '    \033[36m%s\033[0m           full command list\n' "agentchat --help"
printf '\n'
printf '  \033[1mSign-in token\033[0m\n'
printf '    Generated on first run and stored at \033[36m~/.agentchat/web-token\033[0m\n'
printf '    (mode 0600). If the auto-opened browser doesn'"'"'t show up or you\n'
printf '    close the tab, run \033[36magentchat url\033[0m for the full sign-in URL.\n'
printf '\n'
printf '  \033[1mUninstall\033[0m\n'
printf '    rm -rf %s \\\n' "$INSTALL_DIR"
printf '           %s/agentchat %s/agentchat-mcp \\\n' "$BIN_DIR" "$BIN_DIR"
printf '           ~/.claude/skills/chat\n'
if command -v claude >/dev/null 2>&1; then
  printf '    claude mcp remove agentchat\n'
fi
printf '    # (optional, removes identity + sqlite + token)\n'
printf '    # rm -rf ~/.agentchat\n'
printf '\n'

if [ "$on_path" -eq 0 ]; then
  printf '  \033[1;33m⚠  %s is not on your PATH.\033[0m\n' "$BIN_DIR"
  printf '     Add this to your ~/.bashrc or ~/.zshrc:\n\n'
  printf '       export PATH="%s:$PATH"\n\n' "$BIN_DIR"
fi
