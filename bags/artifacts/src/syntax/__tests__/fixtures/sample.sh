#!/usr/bin/env bash
# =============================================================================
# Barry Preflight Check
# Validates all prerequisites before setup or after system changes.
# =============================================================================

set -euo pipefail

BARRY_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
WARN=0
FAIL=0

green()  { printf "\033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS + 1)); }
yellow() { printf "\033[33m⚠\033[0m %s\n" "$1"; WARN=$((WARN + 1)); }
red()    { printf "\033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL + 1)); }

section() { printf "\n\033[1m── %s ──\033[0m\n" "$1"; }

section "Required Binaries"

check_binary() {
  local name="$1"
  local install_hint="${2:-}"
  if command -v "$name" &>/dev/null; then
    green "$name: $(command -v "$name")"
  else
    red "$name: not found${install_hint:+ ($install_hint)}"
  fi
}

check_binary "node"    "brew install node"
check_binary "pnpm"    "npm install -g pnpm"
check_binary "go"      "brew install go"

section "Environment"

ENV_NAME="${BARRY_ENV:-dev}"
ENV_FILE="$BARRY_DIR/.env.$ENV_NAME"

if [ -f "$ENV_FILE" ]; then
  green ".env.$ENV_NAME file exists"

  required_vars=(
    ANTHROPIC_API_KEY
    CLOUDFLARE_API_TOKEN
  )

  for var in "${required_vars[@]}"; do
    val=$(grep "^${var}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
    if [ -n "$val" ]; then
      green "$var is set"
    else
      yellow "$var is missing or empty in .env.$ENV_NAME"
    fi
  done
else
  red ".env.$ENV_NAME file not found (copy from .env.example)"
fi

echo ""
printf "Results: %d passed, %d warnings, %d failed\n" "$PASS" "$WARN" "$FAIL"
