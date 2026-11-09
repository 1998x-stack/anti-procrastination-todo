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

# Loopback-only publication by default. NEVER change SF_BIND to 0.0.0.0 without
# explicit authorization: a public HTTP origin changes the IndexedDB origin and
# is not a secure context for crypto.randomUUID.
SF_BIND="${SF_BIND:-127.0.0.1}"
SF_PORT="${SF_PORT:-8081}"

# Container identity.
SF_CONTAINER="${SF_CONTAINER:-start-first-web}"
SF_IMAGE="${SF_IMAGE:-nginx:1.27-alpine}"

# Public URL used by healthcheck/verification.
SF_URL="${SF_URL:-http://${SF_BIND}:${SF_PORT}}"

# Files copied into a release. THIS IS AN ALLOWLIST ON PURPOSE:
# code/backend (research API reference), tests, scripts, docs, .github, deploy,
# node_modules and package.json are deliberately NOT published.
SF_PUBLISH_PATHS=(index.html assets code/frontend code/domain code/algorithm code/persistence)

sf_log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
sf_die() { printf '[deploy %s] ERROR: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; exit 1; }
