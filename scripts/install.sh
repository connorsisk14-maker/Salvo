#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
#  SALVO — one-command macOS installer
#  Usage: curl -fsSL https://raw.githubusercontent.com/connorsusk14-maker/Salvo/main/scripts/install.sh | bash
# ─────────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/connorsusk14-maker/Salvo.git"
INSTALL_DIR="$HOME/salvo"
WORKSPACE_DIR="$HOME/salvo-workspace"
LOG_FILE="/tmp/salvo-install.log"
DB_NAME="salvo_dev"

# ── Helpers ───────────────────────────────────────────────────────────
log()  { echo "[salvo] $*" | tee -a "$LOG_FILE"; }
warn() { echo "[salvo] WARN: $*" | tee -a "$LOG_FILE"; }
die()  { echo "[salvo] ERROR: $*" | tee -a "$LOG_FILE" >&2; exit 1; }
step() { echo "" | tee -a "$LOG_FILE"; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG_FILE"; log "▶ $*"; }

# Set a key=value in the .env file only when either the key is absent
# entirely or the existing line has an empty value (key=).
# Idempotent: a key that already has a non-empty value is left untouched.
set_env() {
  local key="$1" val="$2" env_file="$3"
  if grep -q "^${key}=.\+" "$env_file" 2>/dev/null; then
    log "  $key already set, skipping"
    return 0
  fi
  # Remove any blank/placeholder line for this key, then append
  sed -i.bak "/^${key}=$/d" "$env_file" 2>/dev/null || true
  sed -i.bak "/^${key}=$/d" "$env_file" 2>/dev/null || true  # cover both sed variants
  echo "${key}=${val}" >> "$env_file"
  log "  Set $key"
}

# ── OS check ──────────────────────────────────────────────────────────
[[ "$(uname)" == "Darwin" ]] || die "This installer supports macOS only."
ARCH="$(uname -m)"
log "macOS detected (arch: $ARCH)"

mkdir -p "$WORKSPACE_DIR"
# Reset (or create) the log for this run
> "$LOG_FILE"

# ── Step 1: Homebrew ──────────────────────────────────────────────────
step "Homebrew"
if ! command -v brew &>/dev/null; then
  log "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ "$ARCH" == "arm64" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    # Persist for future shells only when the line is not already there
    grep -qF 'brew shellenv' "$HOME/.zprofile" 2>/dev/null \
      || echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
  fi
else
  log "Homebrew already installed: $(brew --version | head -1)"
fi

# Ensure brew is on PATH for the rest of this script
if [[ "$ARCH" == "arm64" ]] && [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

# ── Step 2: Node 20 ───────────────────────────────────────────────────
step "Node.js 20"
if ! node --version 2>/dev/null | grep -q "^v20"; then
  log "Installing node@20..."
  brew install node@20
  brew link node@20 --force --overwrite 2>/dev/null || true
  NODE_PREFIX="$(brew --prefix node@20)/bin"
  export PATH="$NODE_PREFIX:$PATH"
else
  log "Node already at $(node --version)"
fi

# ── Step 3: pnpm ──────────────────────────────────────────────────────
step "pnpm"
if ! command -v pnpm &>/dev/null; then
  log "Installing pnpm via npm..."
  npm install -g pnpm@9
else
  log "pnpm already installed: $(pnpm --version)"
fi

# ── Step 4: PostgreSQL 16 ─────────────────────────────────────────────
step "PostgreSQL 16"
if ! brew list postgresql@16 &>/dev/null; then
  log "Installing postgresql@16..."
  brew install postgresql@16
fi

# Add psql/createdb/pg_isready to PATH for this script
PG_BIN="$(brew --prefix postgresql@16)/bin"
export PATH="$PG_BIN:$PATH"

if brew services list | grep "postgresql@16" | grep -q "started"; then
  log "PostgreSQL already running"
else
  log "Starting PostgreSQL..."
  brew services start postgresql@16
  # Wait up to 15 s for the server to be ready
  for i in $(seq 1 15); do
    pg_isready -q 2>/dev/null && break || true
    sleep 1
  done
fi
pg_isready -q || die "PostgreSQL did not start in time. Check: brew services list"

# ── Step 5: Clone or update repo ──────────────────────────────────────
step "Repository"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "Updating existing repo at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null \
    || warn "Could not pull latest (local changes or network issue?)"
else
  log "Cloning SALVO into $INSTALL_DIR..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ── Step 6: Install dependencies ──────────────────────────────────────
step "Dependencies (pnpm install)"
pnpm install --frozen-lockfile

# ── Step 7: Create database ───────────────────────────────────────────
step "Database"
DB_USER="$(whoami)"
if psql -U "$DB_USER" -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB_NAME"; then
  log "Database '$DB_NAME' already exists"
else
  createdb -U "$DB_USER" "$DB_NAME"
  log "Created database '$DB_NAME'"
fi

# ── Step 8: Configure .env ────────────────────────────────────────────
step ".env configuration"
ENV_FILE="$INSTALL_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
  log "Created .env from .env.example"
fi

# Core runtime vars required by prod-preflight / prod-up
set_env "SALVO_SECRETS_BACKEND"  "env"                                               "$ENV_FILE"
set_env "SALVO_LOCAL_DB_MODE"    "external"                                           "$ENV_FILE"
set_env "SALVO_DATABASE_URL"     "postgresql://${DB_USER}@localhost:5432/${DB_NAME}"  "$ENV_FILE"
set_env "SALVO_WORKSPACE_ROOT"   "$WORKSPACE_DIR"                                    "$ENV_FILE"
set_env "SALVO_BACKUP_DIR"       "$WORKSPACE_DIR/backups"                            "$ENV_FILE"
set_env "SALVO_API_PORT"         "8787"                                               "$ENV_FILE"
set_env "SALVO_LOG_LEVEL"        "info"                                               "$ENV_FILE"
set_env "SALVO_LOG_TARGET"       "split"                                              "$ENV_FILE"
set_env "VITE_SALVO_API_URL"     "http://localhost:8787"                             "$ENV_FILE"

# Generate a random API token if not already set
if ! grep -q "^SALVO_API_TOKEN=.\+" "$ENV_FILE" 2>/dev/null; then
  GENERATED_TOKEN="$(openssl rand -hex 24)"
  sed -i.bak "/^SALVO_API_TOKEN=$/d" "$ENV_FILE" 2>/dev/null || true
  echo "SALVO_API_TOKEN=${GENERATED_TOKEN}" >> "$ENV_FILE"
  log "  Generated SALVO_API_TOKEN"
else
  log "  SALVO_API_TOKEN already set, skipping"
fi

# Prompt for LLM API key (interactive terminals only; skip in piped installs)
if ! grep -q "^SALVO_LLM_API_KEY=.\+" "$ENV_FILE" 2>/dev/null; then
  if [[ -t 0 ]]; then
    echo ""
    echo "  ┌──────────────────────────────────────────────────────────┐"
    echo "  │  LLM API Key (optional — configure later via Integrations)│"
    echo "  └──────────────────────────────────────────────────────────┘"
    read -rp "  Enter Anthropic or OpenAI API key (or press Enter to skip): " llm_key </dev/tty || llm_key=""
  else
    llm_key=""
    log "  Non-interactive install — skipping LLM key prompt"
  fi

  if [[ -n "$llm_key" ]]; then
    sed -i.bak "/^SALVO_LLM_API_KEY=$/d" "$ENV_FILE" 2>/dev/null || true
    echo "SALVO_LLM_API_KEY=${llm_key}" >> "$ENV_FILE"
    log "  Set SALVO_LLM_API_KEY"
    # Auto-detect provider from key prefix
    if [[ "$llm_key" == sk-ant-* ]]; then
      set_env "SALVO_LLM_PROVIDER" "anthropic" "$ENV_FILE"
    else
      set_env "SALVO_LLM_PROVIDER" "openai" "$ENV_FILE"
    fi
  else
    log "  Skipping LLM key — configure later in the Integrations page"
  fi
fi

# ── Step 9: Build ─────────────────────────────────────────────────────
# prod-up.mjs requires built artifacts to exist before launching services.
step "Build"
pnpm build

# ── Step 10: Launch (production mode via launchd) ─────────────────────
# prod-up.mjs runs pnpm db:migrate internally before registering services,
# so no separate migration step is needed here.
step "Starting SALVO via prod-up"
# Source .env so prod-up inherits all SALVO_ vars
set -o allexport
# shellcheck source=/dev/null
source "$ENV_FILE"
set +o allexport
node "$INSTALL_DIR/scripts/prod-up.mjs"

# ── Done ─────────────────────────────────────────────────────────────
API_TOKEN="$(grep "^SALVO_API_TOKEN=" "$ENV_FILE" | cut -d= -f2-)"
echo ""
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║                  SALVO is running                       ║"
echo "  ╠══════════════════════════════════════════════════════════╣"
echo "  ║  Dashboard  →  http://localhost:5173                    ║"
echo "  ║  API        →  http://localhost:8787                    ║"
echo "  ╠══════════════════════════════════════════════════════════╣"
echo "  ║  API Token (save this):                                 ║"
echo "  ║    ${API_TOKEN}"
echo "  ╠══════════════════════════════════════════════════════════╣"
echo "  ║  Stop:    cd ~/salvo && node scripts/prod-down.mjs      ║"
echo "  ║  Update:  cd ~/salvo && git pull && pnpm install        ║"
echo "  ║           && pnpm build && node scripts/prod-up.mjs     ║"
echo "  ║  Logs:    ls ~/salvo-workspace/logs/prod/               ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo ""
log "Install complete. Full log at $LOG_FILE"
