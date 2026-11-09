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
  WORKTREE_DIGEST="see-publishedContentSha256"
else
  DIRTY="clean"
  WORKTREE_DIGEST="clean"
fi
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REL_NAME="${TS}-${SHORT}-$(date -u +%N)"
REL_DIR="${SF_DEPLOY_ROOT}/releases/${REL_NAME}"

mkdir -p "${SF_DEPLOY_ROOT}/releases" "${SF_DEPLOY_ROOT}/conf" "${SF_DEPLOY_ROOT}/logs" "${SF_DEPLOY_ROOT}/meta"
# Concurrent deploy and rollback commands must not interleave their symlink and config changes.
command -v flock >/dev/null || sf_die "flock is required for safe deployment"
exec 9>"$SF_DEPLOY_ROOT/.deploy.lock"
flock -n 9 || sf_die "another deploy/rollback command is already running"
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

[[ -z "$(find "$REL_DIR" -type l -print -quit)" ]] ||
  sf_die "refusing a release containing symlinks"
# Reproducible content hash of the shipped files, rather than git-status names.
PUBLISHED_HASH="$(
  cd "$REL_DIR"
  find . -type f -print0 | LC_ALL=C sort -z |
    while IFS= read -r -d '' path; do
      printf '%s %s\n' "$(sha256sum "$path" | cut -d' ' -f1)" "$path"
    done | sha256sum | cut -d' ' -f1
)"

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
  "publishedContentSha256": "${PUBLISHED_HASH}",
  "publishPaths": "${SF_PUBLISH_PATHS[*]}",
  "url": "${SF_URL}"
}
JSON

# Staged nginx config is archived per-release, separate from the served root.
CONFIG_ARCHIVE="$SF_DEPLOY_ROOT/config-releases/$REL_NAME"
mkdir -p "$CONFIG_ARCHIVE"
for config in server.conf headers.inc headers-html.conf; do
  install -m 0644 "$REPO/deploy/nginx/$config" "$CONFIG_ARCHIVE/$config"
done
# Validate candidate configuration with an ephemeral, network-isolated nginx.
# Never modify the running configuration until this has succeeded.
docker run --rm --network none --entrypoint nginx \
  -v "$SF_DEPLOY_ROOT:/srv/start-first:ro" \
  -v "$CONFIG_ARCHIVE/server.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$CONFIG_ARCHIVE/headers.inc:/etc/nginx/conf.d/headers.inc:ro" \
  -v "$CONFIG_ARCHIVE/headers-html.conf:/etc/nginx/conf.d/headers-html.conf:ro" \
  "$SF_IMAGE" -t >/dev/null || sf_die "candidate nginx configuration failed validation"

# Legacy --no-restart is now stage-only, not an unverified live switch.
if [[ "$RESTART" -eq 0 ]]; then
  sf_log "STAGED ONLY: $REL_NAME; current/nginx unchanged"
  exit 0
fi

# Preserve multi-address support, but do NOT silently destroy/recreate a
# running container when topology drifts. On a shared server that operation
# requires an explicit, separate operator change plan.
PUBLISH_ARGS=()
DESIRED_PORTS=""
for addr in $SF_BIND; do
  PUBLISH_ARGS+=(-p "$addr:$SF_PORT:80")
  DESIRED_PORTS+="$addr:$SF_PORT"$'\n'
done
DESIRED_PORTS="$(printf '%s' "$DESIRED_PORTS" | LC_ALL=C sort)"
EXISTING=0
if docker inspect "$SF_CONTAINER" >/dev/null 2>&1; then
  EXISTING=1
  [[ "$(docker inspect -f '{{.State.Running}}' "$SF_CONTAINER")" == true ]] ||
    sf_die "existing container stopped; investigate before deploying"
  [[ "$(docker inspect -f '{{.Config.Image}}' "$SF_CONTAINER")" == "$SF_IMAGE" ]] ||
    sf_die "container image drift; refusing to recreate automatically"
  ACTUAL_PORTS="$(docker port "$SF_CONTAINER" 80/tcp 2>/dev/null | LC_ALL=C sort)"
  [[ "$ACTUAL_PORTS" == "$DESIRED_PORTS" ]] ||
    sf_die "container port drift; manual topology change required (never docker rm -f automatically)"
  MOUNTS="$(docker inspect -f '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' "$SF_CONTAINER")"
  [[ "$MOUNTS" == *"$SF_DEPLOY_ROOT:/srv/start-first"* ]] ||
    sf_die "container document-root mount drift; manual review required"
fi

PREVIOUS_LINK=""
[[ ! -L "$SF_DEPLOY_ROOT/current" ]] ||
  PREVIOUS_LINK="$(readlink "$SF_DEPLOY_ROOT/current")"
[[ -z "$PREVIOUS_LINK" || "$PREVIOUS_LINK" == releases/* ]] ||
  sf_die "current points outside managed releases"
[[ -n "$PREVIOUS_LINK" || ! -e "$SF_DEPLOY_ROOT/current" ]] ||
  sf_die "current exists but is not managed symlink"
[[ "$EXISTING" -eq 0 || -n "$PREVIOUS_LINK" ]] ||
  sf_die "existing running container has no managed release"

# Preserve the legacy active config for one-step rollback after upgrading.
if [[ -n "$PREVIOUS_LINK" ]]; then
  OLD_ARCHIVE="$SF_DEPLOY_ROOT/config-releases/$(basename "$PREVIOUS_LINK")"
  if [[ ! -d "$OLD_ARCHIVE" ]]; then
    mkdir -p "$OLD_ARCHIVE"
    for config in server.conf headers.inc headers-html.conf; do
      [[ -f "$SF_DEPLOY_ROOT/conf/$config" ]] || sf_die "active nginx config missing: $config"
      cp -p "$SF_DEPLOY_ROOT/conf/$config" "$OLD_ARCHIVE/$config"
    done
  fi
fi

BACKUP="$(mktemp -d "$SF_DEPLOY_ROOT/.activation-backup.XXXXXXXX")"
for config in server.conf headers.inc headers-html.conf; do
  [[ ! -f "$SF_DEPLOY_ROOT/conf/$config" ]] ||
    cp -p "$SF_DEPLOY_ROOT/conf/$config" "$BACKUP/$config"
done
ACTIVATING=0
CREATED=0
restore_on_failure() {
  local rc="$1"
  trap - EXIT
  if [[ "$rc" -ne 0 && "$ACTIVATING" -eq 1 ]]; then
    sf_log "activation failed; restoring previous code AND nginx configuration"
    set +e
    for config in server.conf headers.inc headers-html.conf; do
      if [[ -f "$BACKUP/$config" ]]; then
        install -m 0644 "$BACKUP/$config" "$SF_DEPLOY_ROOT/conf/$config"
      else
        rm -f "$SF_DEPLOY_ROOT/conf/$config"
      fi
    done
    if [[ -n "$PREVIOUS_LINK" ]]; then
      ln -sfn "$PREVIOUS_LINK" "$SF_DEPLOY_ROOT/current.new"
      mv -Tf "$SF_DEPLOY_ROOT/current.new" "$SF_DEPLOY_ROOT/current"
    else
      rm -f "$SF_DEPLOY_ROOT/current"
    fi
    if [[ "$CREATED" -eq 1 ]]; then
      docker rm -f "$SF_CONTAINER" >/dev/null 2>&1
    elif [[ "$EXISTING" -eq 1 ]]; then
      docker exec "$SF_CONTAINER" nginx -t &&
        docker exec "$SF_CONTAINER" nginx -s reload
    fi
    sf_log "restore attempted; run deploy/healthcheck.sh to confirm recovered service"
  fi
  rm -rf -- "$BACKUP"
  exit "$rc"
}
trap 'restore_on_failure $?' EXIT
ACTIVATING=1

for config in server.conf headers.inc headers-html.conf; do
  install -m 0644 "$CONFIG_ARCHIVE/$config" "$SF_DEPLOY_ROOT/conf/$config"
done
ln -sfn "releases/$REL_NAME" "$SF_DEPLOY_ROOT/current.new"
mv -Tf "$SF_DEPLOY_ROOT/current.new" "$SF_DEPLOY_ROOT/current"

if [[ "$EXISTING" -eq 0 ]]; then
  sf_log "creating container $SF_CONTAINER on configured addresses: $SF_BIND:$SF_PORT"
  docker run -d \
    --name "$SF_CONTAINER" \
    --restart unless-stopped \
    "${PUBLISH_ARGS[@]}" \
    -v "$SF_DEPLOY_ROOT:/srv/start-first:ro" \
    -v "$SF_DEPLOY_ROOT/conf/server.conf:/etc/nginx/conf.d/default.conf:ro" \
    -v "$SF_DEPLOY_ROOT/conf/headers.inc:/etc/nginx/conf.d/headers.inc:ro" \
    -v "$SF_DEPLOY_ROOT/conf/headers-html.conf:/etc/nginx/conf.d/headers-html.conf:ro" \
    --log-opt max-size=10m --log-opt max-file=3 \
    "$SF_IMAGE" >/dev/null
  CREATED=1
  for _ in $(seq 1 25); do
    docker exec "$SF_CONTAINER" nginx -t >/dev/null 2>&1 && break
    sleep 0.2
  done
else
  docker exec "$SF_CONTAINER" nginx -t
  docker exec "$SF_CONTAINER" nginx -s reload
fi

"$REPO/deploy/healthcheck.sh"
ACTIVATING=0
sf_log "ACTIVE: $REL_NAME at $SF_URL; content-sha256=$PUBLISHED_HASH"
