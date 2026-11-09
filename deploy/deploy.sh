#!/usr/bin/env bash
# Publish the current git checkout as a new immutable release and switch to it atomically.
#
# Usage: deploy/deploy.sh [--no-restart]
#   --no-restart  build the release + move `current` but do not create/reload the container
#
# Safe to re-run: every run creates a new timestamped release directory.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

RESTART=1
[[ "${1:-}" == "--no-restart" ]] && RESTART=0

command -v docker >/dev/null || sf_die "docker is required"
docker info >/dev/null 2>&1 || sf_die "docker daemon is not reachable by $(id -un)"

REPO="${SF_REPO_ROOT}"
[[ -f "$REPO/index.html" ]] || sf_die "not a Start-First checkout: $REPO"

# --- Release identity -------------------------------------------------------
BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
SHA="$(git -C "$REPO" rev-parse HEAD)"
SHORT="$(git -C "$REPO" rev-parse --short=12 HEAD)"
if [[ -n "$(git -C "$REPO" status --porcelain)" ]]; then
  DIRTY="dirty"
  # Working tree changes are published, so record the content digest too: a dirty
  # release cannot be reproduced from the commit alone.
  WORKTREE_DIGEST="$(git -C "$REPO" status --porcelain | sha256sum | cut -c1-12)"
else
  DIRTY="clean"
  WORKTREE_DIGEST="clean"
fi
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REL_NAME="${TS}-${SHORT}"
REL_DIR="${SF_DEPLOY_ROOT}/releases/${REL_NAME}"

mkdir -p "${SF_DEPLOY_ROOT}/releases" "${SF_DEPLOY_ROOT}/conf" "${SF_DEPLOY_ROOT}/logs" "${SF_DEPLOY_ROOT}/meta"
[[ -e "$REL_DIR" ]] && sf_die "release already exists: $REL_DIR"
mkdir -p "$REL_DIR"

# --- Copy the static artifact via an explicit allowlist ---------------------
sf_log "building release ${REL_NAME} from ${BRANCH}@${SHORT} (${DIRTY})"
tar -cf - -C "$REPO" "${SF_PUBLISH_PATHS[@]}" | tar -xf - -C "$REL_DIR"

# Refuse to publish if the entry point or a runtime module is missing: a
# half-published release must never become `current`.
for required in index.html code/frontend/main.js code/domain/core.js code/algorithm/suggest.js code/persistence/store.js code/persistence/invariants.js code/frontend/styles.css assets/icon.svg; do
  [[ -f "$REL_DIR/$required" ]] || sf_die "release is incomplete, missing $required"
done

# The research API must never be published as part of the static site.
if [[ -e "$REL_DIR/code/backend" ]]; then
  sf_die "code/backend must not be published"
fi

# --- Record provenance (outside the served document root) -------------------
cat > "${SF_DEPLOY_ROOT}/meta/${REL_NAME}.json" <<JSON
{
  "release": "${REL_NAME}",
  "deployedAt": "${TS}",
  "branch": "${BRANCH}",
  "commit": "${SHA}",
  "commitShort": "${SHORT}",
  "workingTree": "${DIRTY}",
  "worktreeDigest": "${WORKTREE_DIGEST}",
  "publishPaths": "${SF_PUBLISH_PATHS[*]}",
  "url": "${SF_URL}"
}
JSON

# --- Install nginx config (read-only mount target) --------------------------
install -m 0644 "${REPO}/deploy/nginx/server.conf" "${SF_DEPLOY_ROOT}/conf/server.conf"
install -m 0644 "${REPO}/deploy/nginx/headers.inc" "${SF_DEPLOY_ROOT}/conf/headers.inc"
install -m 0644 "${REPO}/deploy/nginx/headers-html.conf" "${SF_DEPLOY_ROOT}/conf/headers-html.conf"

# --- Atomic switch of `current` --------------------------------------------
# MUST be a RELATIVE symlink: the deployment root is bind-mounted into the
# nginx container at /srv/start-first, so an absolute host path such as
# /home/ubuntu/... would not resolve inside the container (every request 404s).
ln -sfn "releases/${REL_NAME}" "${SF_DEPLOY_ROOT}/current.new"
mv -T "${SF_DEPLOY_ROOT}/current.new" "${SF_DEPLOY_ROOT}/current"
sf_log "current -> releases/${REL_NAME}"

if [[ "$RESTART" == "0" ]]; then
  sf_log "skipping container restart (--no-restart)"
  exit 0
fi

# --- Ensure the container exists with the right topology, then reload ---------
# A stale container would silently keep the OLD port bindings, so drift is
# detected and the container is recreated instead of "successfully" doing nothing.
PUBLISH_ARGS=()
DESIRED_PORTS=""
for addr in $SF_BIND; do
  PUBLISH_ARGS+=(-p "${addr}:${SF_PORT}:80")
  DESIRED_PORTS+="${addr}:${SF_PORT}"$'\n'
done
DESIRED_PORTS="$(printf '%s' "$DESIRED_PORTS" | sort)"

RECREATE=0
if ! docker inspect "$SF_CONTAINER" >/dev/null 2>&1; then
  RECREATE=1
  sf_log "container does not exist; creating"
else
  ACTUAL_PORTS="$(docker port "$SF_CONTAINER" 80/tcp 2>/dev/null | sort)"
  ACTUAL_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$SF_CONTAINER" 2>/dev/null)"
  if [[ "$ACTUAL_PORTS" != "$DESIRED_PORTS" ]]; then
    RECREATE=1; sf_log "port bindings differ (have: $(printf '%s' "$ACTUAL_PORTS" | tr '\n' ' ')) -> recreating"
  elif [[ "$ACTUAL_IMAGE" != "$SF_IMAGE" ]]; then
    RECREATE=1; sf_log "image differs ($ACTUAL_IMAGE != $SF_IMAGE) -> recreating"
  elif ! docker inspect -f '{{json .HostConfig.Binds}}' "$SF_CONTAINER" | grep -qF "${SF_DEPLOY_ROOT}:/srv/start-first:ro"; then
    RECREATE=1; sf_log "document root mount differs -> recreating"
  fi
fi

if [[ "$RECREATE" == "1" ]]; then
  docker rm -f "$SF_CONTAINER" >/dev/null 2>&1 || true
  sf_log "creating container ${SF_CONTAINER} on ${SF_BIND}:${SF_PORT}"
  docker run -d \
    --name "$SF_CONTAINER" \
    --restart unless-stopped \
    "${PUBLISH_ARGS[@]}" \
    -v "${SF_DEPLOY_ROOT}:/srv/start-first:ro" \
    -v "${SF_DEPLOY_ROOT}/conf/server.conf:/etc/nginx/conf.d/default.conf:ro" \
    -v "${SF_DEPLOY_ROOT}/conf/headers.inc:/etc/nginx/conf.d/headers.inc:ro" \
    -v "${SF_DEPLOY_ROOT}/conf/headers-html.conf:/etc/nginx/conf.d/headers-html.conf:ro" \
    --log-opt max-size=10m --log-opt max-file=3 \
    "$SF_IMAGE" >/dev/null
  # nginx needs a moment to bind inside the freshly created container.
  for _ in $(seq 1 25); do docker exec "$SF_CONTAINER" nginx -t >/dev/null 2>&1 && break; sleep 0.2; done
else
  sf_log "container topology unchanged; testing config and reloading"
  docker exec "$SF_CONTAINER" nginx -t
  docker exec "$SF_CONTAINER" nginx -s reload
fi

# --- Health check ----------------------------------------------------------
"${REPO}/deploy/healthcheck.sh" || sf_die "health check failed after deploy of ${REL_NAME}"
sf_log "release ${REL_NAME} is live at: $(sf_urls)"
for addr in $SF_BIND; do
  case "$addr" in
    127.0.0.1|::1) : ;;
    *) sf_log "NOTE: ${addr}:${SF_PORT} is reachable from the local network over plain HTTP (no TLS). Do not expose this beyond a trusted LAN." ;;
  esac
done
