#!/usr/bin/env bash
# Switch `current` to an earlier release and reload nginx. Does not delete releases.
#
# Usage:
#   deploy/rollback.sh              # roll back to the previous release
#   deploy/rollback.sh <release>    # switch to a specific release directory name
#   deploy/rollback.sh --list       # list available releases (newest first)
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

mapfile -t RELEASES < <(ls -1 "${SF_DEPLOY_ROOT}/releases" 2>/dev/null | sort -r)
[[ "${#RELEASES[@]}" -eq 0 ]] && sf_die "no releases under ${SF_DEPLOY_ROOT}/releases"

if [[ "${1:-}" == "--list" ]]; then
  for r in "${RELEASES[@]}"; do
    marker=" "
    [[ "$(basename "$(readlink -f "${SF_DEPLOY_ROOT}/current" 2>/dev/null || true)")" == "$r" ]] && marker="*"
    printf '%s %s\n' "$marker" "$r"
  done
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  TARGET="$(basename "$1")"
  [[ -d "${SF_DEPLOY_ROOT}/releases/${TARGET}" ]] || sf_die "unknown release: $TARGET"
else
  CURRENT_NAME="$(basename "$(readlink -f "${SF_DEPLOY_ROOT}/current" 2>/dev/null || echo '')")"
  TARGET=""
  for r in "${RELEASES[@]}"; do
    if [[ "$r" != "$CURRENT_NAME" ]]; then TARGET="$r"; break; fi
  done
  [[ -n "$TARGET" ]] || sf_die "no earlier release to roll back to"
fi

sf_log "rolling back: ${CURRENT_NAME:-<none>} -> ${TARGET}"
ln -sfn "releases/${TARGET}" "${SF_DEPLOY_ROOT}/current.new"
mv -T "${SF_DEPLOY_ROOT}/current.new" "${SF_DEPLOY_ROOT}/current"
docker exec "$SF_CONTAINER" nginx -t
docker exec "$SF_CONTAINER" nginx -s reload
"${SF_REPO_ROOT}/deploy/healthcheck.sh"
sf_log "rolled back to ${TARGET}"
