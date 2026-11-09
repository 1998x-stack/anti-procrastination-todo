#!/usr/bin/env bash
# Shared configuration for the Start-First Linux deployment.
# Source this file; do not execute it directly.
#
# Everything is overridable from the environment so the same scripts can be
# reused for a local loopback deployment or a staged public deployment.

# Repository root (this file lives in <repo>/deploy/).
SF_REPO_ROOT="${SF_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Deployment root: releases/, current symlink, nginx conf, logs and meta live here.
SF_DEPLOY_ROOT="${SF_DEPLOY_ROOT:-/home/ubuntu/apps/start-first}"

# These helpers must exist BEFORE reading server-local deploy.env.
sf_log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
sf_die() { printf '[deploy %s] ERROR: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; exit 1; }

# Server-local topology overrides (recorded so a plain re-run reproduces exactly
# the same bindings instead of silently reverting to loopback-only).
# Precedence: explicit environment > deploy.env > built-in defaults.
if [[ -f "$SF_DEPLOY_ROOT/deploy.env" ]]; then
  # This is NOT a shell script. Allow only the three documented topology keys;
  # an unrestricted printf -v key could override PATH/BASH_ENV or other internals.
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ ! "$line" =~ ^(SF_BIND|SF_PORT|SF_URL)=(.*)$ ]]; then
      sf_die "unknown/invalid key in deploy.env (allowed: SF_BIND, SF_PORT, SF_URL)"
    fi
    sf_key="${BASH_REMATCH[1]}"
    sf_value="${BASH_REMATCH[2]}"
    # Trim a matching pair of quotes without eval/source.
    if [[ "$sf_value" == \"*\" || "$sf_value" == \'*\' ]]; then
      sf_value="${sf_value:1:${#sf_value}-2}"
    fi
    if [[ -z "${!sf_key:-}" ]]; then printf -v "$sf_key" '%s' "$sf_value"; fi
  done < "$SF_DEPLOY_ROOT/deploy.env"
fi

# Publish addresses. SPACE-SEPARATED LIST is allowed, e.g.
#   SF_BIND="127.0.0.1 192.168.169.223"   # loopback + one specific LAN address
# Deliberately NOT 0.0.0.0 by default: that would also expose the site on every
# Docker bridge (172.x) interface. Never widen this without explicit
# authorization, and never publish TLS-less HTTP beyond a trusted network.
SF_BIND="${SF_BIND:-127.0.0.1}"
SF_PORT="${SF_PORT:-8081}"

# Container identity.
SF_CONTAINER="${SF_CONTAINER:-start-first-web}"
SF_IMAGE="${SF_IMAGE:-nginx:1.27-alpine}"

# Public URL used by healthcheck/verification. Defaults to the first bind
# address, which is loopback unless overridden.
SF_PRIMARY_BIND="${SF_BIND%% *}"
SF_URL="${SF_URL:-http://${SF_PRIMARY_BIND}:${SF_PORT}}"

# Human-readable list of the published URLs (loopback first).
sf_urls() {
  local addr
  for addr in $SF_BIND; do printf 'http://%s:%s ' "$addr" "$SF_PORT"; done
}

# Files copied into a release. THIS IS AN ALLOWLIST ON PURPOSE:
# code/backend (research API reference), tests, scripts, docs, .github, deploy,
# node_modules and package.json are deliberately NOT published.
SF_PUBLISH_PATHS=(index.html assets code/frontend code/domain code/algorithm code/persistence)

