#!/usr/bin/env sh
# droingring installer — clones, builds, and wires up the CLI + Claude Code skill.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/amazedsaint/droingring/main/install.sh | sh
#
# Environment overrides:
#   DROINGRING_INSTALL=/path   where to clone (default ~/.local/share/droingring)
#   DROINGRING_BIN=/path       where to symlink bins (default ~/.local/bin)
#   DROINGRING_BRANCH=main     branch/tag/commit to check out (default main)
#   DROINGRING_SKIP_SKILL=1    don't install the Claude Code skill file
#   DROINGRING_SKIP_MCP=1      don't register with Claude Code via `claude mcp add`
#   DROINGRING_NICKNAME=alice  pre-seed display name (skips the prompt)
#   DROINGRING_BIO="..."       pre-seed bio (skips the prompt)
#   DROINGRING_OPEN_BROWSER=0  skip the "open the web UI" prompt (headless mode)
#   DROINGRING_ELECTRON=1|0    force-install or skip the native desktop shell

set -eu

REPO="amazedsaint/droingring"
INSTALL_DIR="${DROINGRING_INSTALL:-$HOME/.local/share/droingring}"
BIN_DIR="${DROINGRING_BIN:-$HOME/.local/bin}"
BRANCH="${DROINGRING_BRANCH:-main}"
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

# ---------- detect + remove any previous install ----------
# A fresh install wipes everything in the install dir, symlinks, and the
# skill. Runtime data in ~/.droingring (identity, sqlite, web-token) is
# preserved — otherwise users would lose their rooms on every update.
prior_found=0
[ -e "$INSTALL_DIR" ] && prior_found=1
[ -e "$BIN_DIR/droingring" ] || [ -L "$BIN_DIR/droingring" ] && prior_found=1
[ -e "$BIN_DIR/droingring-mcp" ] || [ -L "$BIN_DIR/droingring-mcp" ] && prior_found=1
[ -f "$SKILL_DIR/SKILL.md" ] && prior_found=1

if [ "$prior_found" -eq 1 ]; then
  log "Existing install detected — removing before fresh install"
  [ "${DROINGRING_KEEP_DATA:-1}" = "1" ] && \
    log "  (runtime data at ~/.droingring is preserved — set DROINGRING_KEEP_DATA=0 to wipe)"

  # Unregister from Claude Code first so stale bin paths don't linger.
  if [ "${DROINGRING_SKIP_MCP:-0}" != "1" ] && command -v claude >/dev/null 2>&1; then
    if claude mcp list 2>/dev/null | grep -q '^droingring'; then
      log "  unregistering from Claude Code"
      claude mcp remove droingring >/dev/null 2>&1 || \
        warn "  claude mcp remove failed — you may need to run it manually"
    fi
  fi

  rm -rf "$INSTALL_DIR" \
         "$BIN_DIR/droingring" "$BIN_DIR/droingring-mcp" \
         "$SKILL_DIR/SKILL.md"
  # Remove an empty skill dir so re-runs don't leave it behind.
  [ -d "$SKILL_DIR" ] && rmdir "$SKILL_DIR" 2>/dev/null || true

  if [ "${DROINGRING_KEEP_DATA:-1}" = "0" ]; then
    # Respect DROINGRING_HOME override, fall back to default location.
    AC_DATA="${DROINGRING_HOME:-$HOME/.droingring}"
    warn "wiping $AC_DATA (identity, sqlite, token) per DROINGRING_KEEP_DATA=0"
    rm -rf "$AC_DATA"
  fi
fi

# ---------- fresh clone ----------
mkdir -p "$INSTALL_DIR"
log "Cloning $REPO into $INSTALL_DIR"
git clone --quiet --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR"

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

# ---------- optional: install Electron shell ----------
# Opt-in. Electron is ~200 MB; most users are fine with the default
# browser shell, so we don't install it automatically.
if [ "${DROINGRING_ELECTRON:-0}" = "1" ]; then
  log "Installing Electron (opt-in — ~200 MB)"
  if [ "$PM" = pnpm ]; then
    pnpm add --silent electron >/dev/null 2>&1 \
      || warn "Electron install failed — the MCP will fall back to opening a browser"
  else
    npm install --silent --no-audit --no-fund electron >/dev/null 2>&1 \
      || warn "Electron install failed — the MCP will fall back to opening a browser"
  fi
fi

# ---------- symlink the bins ----------
mkdir -p "$BIN_DIR"
chmod +x "$INSTALL_DIR/dist/bin/droingring.js" "$INSTALL_DIR/dist/bin/droingring-mcp.js"
ln -sf "$INSTALL_DIR/dist/bin/droingring.js"     "$BIN_DIR/droingring"
ln -sf "$INSTALL_DIR/dist/bin/droingring-mcp.js" "$BIN_DIR/droingring-mcp"
log "Linked $BIN_DIR/droingring"
log "Linked $BIN_DIR/droingring-mcp"

# ---------- install the skill (so /chat works in Claude Code) ----------
if [ "${DROINGRING_SKIP_SKILL:-0}" != "1" ]; then
  mkdir -p "$SKILL_DIR"
  cp "$INSTALL_DIR/src/skill/chat/SKILL.md" "$SKILL_DIR/SKILL.md"
  log "Installed skill at $SKILL_DIR/SKILL.md"
fi

# ---------- register with Claude Code if `claude` is on PATH ----------
if [ "${DROINGRING_SKIP_MCP:-0}" != "1" ] && command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q '^droingring'; then
    log "Claude Code MCP registration already present (skipping)"
  else
    log "Registering with Claude Code: claude mcp add droingring"
    claude mcp add droingring -s user -- "$BIN_DIR/droingring-mcp" \
      || warn "Could not register; run this manually: claude mcp add droingring -s user -- $BIN_DIR/droingring-mcp"
  fi
fi

# ---------- PATH hint ----------
on_path=1
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) on_path=0 ;;
esac

# ---------- interactive onboarding ----------
# Read prompts from /dev/tty so `curl ... | sh` (where stdin is the pipe) can
# still ask the user questions. If /dev/tty isn't available (CI, no terminal)
# we silently fall back to defaults — the user can run the setup later via the
# web UI onboarding modal or `droingring-mcp` + `/chat nick`, `/chat bio`.
if [ -r /dev/tty ] && [ "${DROINGRING_NONINTERACTIVE:-0}" != "1" ]; then
  CONFIG_DIR="$HOME/.droingring"
  CONFIG_FILE="$CONFIG_DIR/config.json"
  mkdir -p "$CONFIG_DIR"

  default_nick="${DROINGRING_NICKNAME:-${USER:-agent}}"
  default_bio="${DROINGRING_BIO:-}"

  printf '\n\033[1;36m==> Quick profile setup\033[0m\n'
  printf 'Other room members will see this. You can change it anytime.\n\n'

  if [ -n "${DROINGRING_NICKNAME:-}" ]; then
    nickname="$DROINGRING_NICKNAME"
    printf '  Display name : %s  (from DROINGRING_NICKNAME)\n' "$nickname"
  else
    printf '  Display name [%s]: ' "$default_nick"
    read -r nickname < /dev/tty || nickname=""
    [ -z "$nickname" ] && nickname="$default_nick"
  fi

  if [ -n "${DROINGRING_BIO:-}" ]; then
    bio="$DROINGRING_BIO"
    printf '  Bio          : %s  (from DROINGRING_BIO)\n' "$bio"
  else
    printf '  Short bio (optional, visible in rooms): '
    read -r bio < /dev/tty || bio=""
  fi

  # Write minimal config.json. Strip " and \ from inputs — we're not invoking
  # a JSON library from shell, just emitting a known-safe subset.
  safe_nick=$(printf '%s' "$nickname" | tr -d '"\\')
  safe_bio=$(printf '%s' "$bio" | tr -d '"\\')
  if [ -n "$safe_bio" ]; then
    printf '{\n  "nickname": "%s",\n  "bio": "%s"\n}\n' "$safe_nick" "$safe_bio" > "$CONFIG_FILE"
  else
    printf '{\n  "nickname": "%s"\n}\n' "$safe_nick" > "$CONFIG_FILE"
  fi
  chmod 600 "$CONFIG_FILE"
  printf '  \033[32m✓\033[0m Saved to %s\n\n' "$CONFIG_FILE"

  # ---- Electron native desktop shell (optional, ~130 MB) ----
  INSTALL_ELECTRON=0
  if [ "${DROINGRING_ELECTRON:-}" = "0" ]; then
    :
  elif [ "${DROINGRING_ELECTRON:-}" = "1" ]; then
    INSTALL_ELECTRON=1
  else
    # Don't offer on headless / SSH — the shell can't show a window anyway.
    if [ -z "${SSH_CLIENT:-}${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then
      if [ "$(uname)" = "Darwin" ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] \
         || [ "$(uname | tr '[:upper:]' '[:lower:]')" = "linux" ]; then
        printf '  Install the native desktop app? (~130 MB; adds a polished\n'
        printf '  Electron window, native notifications, dock badge for unread) [y/N] '
        read -r want_electron < /dev/tty || want_electron=""
        case "${want_electron:-n}" in
          y|Y|yes|YES) INSTALL_ELECTRON=1 ;;
          *)           INSTALL_ELECTRON=0 ;;
        esac
      fi
    fi
  fi
  if [ "$INSTALL_ELECTRON" = "1" ]; then
    (
      cd "$INSTALL_DIR" && \
      if command -v pnpm >/dev/null 2>&1; then
        pnpm add electron >/dev/null 2>&1
      else
        npm install electron --no-save >/dev/null 2>&1
      fi
    )
    if [ $? -eq 0 ]; then
      printf '  \033[32m✓\033[0m Electron installed — droingring web will open as a native app\n\n'
    else
      printf '  \033[33m!\033[0m Electron install failed — droingring web will use your browser\n\n'
      INSTALL_ELECTRON=0
    fi
  fi

  # ---- Open the web UI now? ----
  if [ "${DROINGRING_OPEN_BROWSER:-}" = "0" ]; then
    open_browser=n
  elif [ "${DROINGRING_OPEN_BROWSER:-}" = "1" ]; then
    open_browser=y
  else
    if [ "$INSTALL_ELECTRON" = "1" ]; then
      printf '  Launch droingring now? [Y/n] '
    else
      printf '  Open the web UI in your browser now? [Y/n] '
    fi
    read -r open_browser < /dev/tty || open_browser=""
  fi
  case "${open_browser:-y}" in
    n|N|no|NO) OPEN_BROWSER_NOW=0 ;;
    *)         OPEN_BROWSER_NOW=1 ;;
  esac
else
  OPEN_BROWSER_NOW=0
fi

# ---------- post-install banner ----------
printf '\n'
printf '\033[1;32m  ✓ droingring is installed.\033[0m\n'
printf '\n'
printf '  \033[1mTry it in 30 seconds\033[0m\n'
printf '    \033[36m%s\033[0m          open the web UI in your browser\n' "droingring web"
printf '    then click \033[1mCreate a room\033[0m — copy the invite ticket that appears,\n'
printf '    and share it with another human or agent to start chatting.\n'
printf '\n'
printf '  \033[1mUsing with Claude Code\033[0m\n'
if command -v claude >/dev/null 2>&1; then
  printf '    droingring is registered as an MCP server. Start a new\n'
  printf '    Claude Code session — type \033[36m/chat help\033[0m to see the commands.\n'
else
  printf '    Install Claude Code (https://claude.com/claude-code), then:\n'
  printf '      \033[36mclaude mcp add droingring -s user -- %s/droingring-mcp\033[0m\n' "$BIN_DIR"
fi
printf '    The web UI auto-opens at \033[36mhttp://127.0.0.1:7879\033[0m when\n'
printf '    a session starts. Your sign-in token is injected into the URL.\n'
printf '\n'
printf '  \033[1mUsing standalone\033[0m\n'
printf '    \033[36m%s\033[0m              start the web UI manually\n' "droingring web"
printf '    \033[36m%s\033[0m              print the sign-in URL (with token)\n' "droingring url"
printf '    \033[36m%s\033[0m           health check + URL\n' "droingring doctor"
printf '    \033[36m%s\033[0m           full command list\n' "droingring --help"
printf '\n'
printf '  \033[1mSign-in token\033[0m\n'
printf '    Generated on first run and stored at \033[36m~/.droingring/web-token\033[0m\n'
printf '    (mode 0600). If the auto-opened browser doesn'"'"'t show up or you\n'
printf '    close the tab, run \033[36mdroingring url\033[0m for the full sign-in URL.\n'
printf '\n'
printf '  \033[1mUninstall\033[0m\n'
printf '    rm -rf %s \\\n' "$INSTALL_DIR"
printf '           %s/droingring %s/droingring-mcp \\\n' "$BIN_DIR" "$BIN_DIR"
printf '           ~/.claude/skills/chat\n'
if command -v claude >/dev/null 2>&1; then
  printf '    claude mcp remove droingring\n'
fi
printf '    # (optional, removes identity + sqlite + token)\n'
printf '    # rm -rf ~/.droingring\n'
printf '\n'

if [ "$on_path" -eq 0 ]; then
  printf '  \033[1;33m⚠  %s is not on your PATH.\033[0m\n' "$BIN_DIR"
  printf '     Add this to your ~/.bashrc or ~/.zshrc:\n\n'
  printf '       export PATH="%s:$PATH"\n\n' "$BIN_DIR"
fi

# ---------- optionally launch the web UI ----------
if [ "${OPEN_BROWSER_NOW:-0}" = "1" ]; then
  if [ "$on_path" -eq 1 ] || [ -x "$BIN_DIR/droingring" ]; then
    printf '\033[1;36m==> Starting droingring web…\033[0m\n'
    mkdir -p "$HOME/.droingring"
    WEB_URL_FILE="$HOME/.droingring/web-url"
    WEB_LOG="$HOME/.droingring/web.log"
    # Clear any stale URL so we only open once the NEW server has written it.
    rm -f "$WEB_URL_FILE"
    # Background so the install script can exit. Server writes the URL to
    # ~/.droingring/web-url once it's listening.
    nohup "$BIN_DIR/droingring" web >"$WEB_LOG" 2>&1 &
    SRV_PID=$!
    # Poll up to ~10 s — first-run bootstrap (identity gen, sqlite migration,
    # Hyperswarm DHT) can take several seconds. Earlier versions only slept
    # 1 s and silently skipped the browser-open when the URL file wasn't there.
    # Exit the poll early if the child dies (misconfigured port etc.).
    printf '   (waiting for server to start…)\n'
    i=0
    while [ "$i" -lt 40 ]; do
      [ -r "$WEB_URL_FILE" ] && break
      kill -0 "$SRV_PID" 2>/dev/null || break
      sleep 0.25
      i=$((i + 1))
    done
    if [ -r "$WEB_URL_FILE" ]; then
      url=$(cat "$WEB_URL_FILE" 2>/dev/null | head -1)
      if [ -n "$url" ]; then
        if command -v open >/dev/null 2>&1; then
          open "$url" >/dev/null 2>&1 || printf '   %s\n' "$url"
        elif command -v xdg-open >/dev/null 2>&1; then
          xdg-open "$url" >/dev/null 2>&1 || printf '   %s\n' "$url"
        else
          printf '   Open in your browser: %s\n' "$url"
        fi
      fi
    else
      printf '   \033[1;33m!\033[0m server did not write %s within 10 s\n' "$WEB_URL_FILE"
      printf '     tail of log (%s):\n' "$WEB_LOG"
      tail -n 10 "$WEB_LOG" 2>/dev/null | sed 's/^/       /'
      printf '     Retry with \033[36mdroingring web\033[0m and check the banner it prints.\n'
    fi
  else
    printf '   (skipped — %s not on PATH, run \033[36mdroingring web\033[0m yourself)\n' "$BIN_DIR"
  fi
fi
