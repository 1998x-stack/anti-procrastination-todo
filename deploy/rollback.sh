#!/usr/bin/env bash
# Restore a prior release AND its archived nginx configuration.
# Usage: deploy/rollback.sh [--list | <exact-release-name>]
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

ROOT="$SF_DEPLOY_ROOT"
command -v flock >/dev/null || sf_die "flock is required for safe rollback"
exec 9>"$ROOT/.deploy.lock"
flock -n 9 || sf_die "another deploy/rollback is running"
[[ -d "$ROOT/releases" ]] || sf_die "no release directory"
mapfile -t RELEASES < <(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort -r)
[[ "${#RELEASES[@]}" -gt 0 ]] || sf_die "no releases available"
CURRENT_LINK=""
[[ ! -L "$ROOT/current" ]] || CURRENT_LINK="$(readlink "$ROOT/current")"
[[ "$CURRENT_LINK" == releases/* ]] || sf_die "no managed current symlink"
CURRENT_NAME="$(basename "$CURRENT_LINK")"

if [[ "${1:-}" == "--list" ]]; then
  for item in "${RELEASES[@]}"; do
    marker=" "
    [[ "$item" != "$CURRENT_NAME" ]] || marker="*"
    printf '%s %s\n' "$marker" "$item"
  done
  exit 0
fi

[[ $# -le 1 ]] || sf_die "usage: deploy/rollback.sh [--list | <exact-release-name>]"
if [[ -n "${1:-}" ]]; then
  TARGET="$1"
  [[ "$TARGET" =~ ^[A-Za-z0-9._-]+$ ]] || sf_die "invalid release name"
  [[ "$TARGET" != "$CURRENT_NAME" ]] || sf_die "already using target release"
else
  # The previous script picked newest != current. After rolling r3 back to r2
  # that accidentally reactivated r3. Default must choose only OLDER releases.
  TARGET=""
  for item in "${RELEASES[@]}"; do
    if [[ "$item" < "$CURRENT_NAME" ]]; then TARGET="$item"; break; fi
  done
  [[ -n "$TARGET" ]] || sf_die "no older release exists; specify a newer target explicitly"
fi

[[ -d "$ROOT/releases/$TARGET" ]] || sf_die "target release missing: $TARGET"
TARGET_CONFIG="$ROOT/config-releases/$TARGET"
for config in server.conf headers.inc headers-html.conf; do
  [[ -f "$TARGET_CONFIG/$config" ]] ||
    sf_die "no archived nginx config for $TARGET ($config); rollback blocked"
done
command -v docker >/dev/null || sf_die "docker missing"
docker info >/dev/null 2>&1 || sf_die "docker daemon unavailable"
[[ "$(docker inspect -f '{{.State.Running}}' "$SF_CONTAINER")" == true ]] ||
  sf_die "container is not running"
[[ "$(docker inspect -f '{{.Config.Image}}' "$SF_CONTAINER")" == "$SF_IMAGE" ]] ||
  sf_die "container image drift"
EXPECTED_PORTS=""
for addr in $SF_BIND; do EXPECTED_PORTS+="$addr:$SF_PORT"$'\n'; done
EXPECTED_PORTS="$(printf '%s' "$EXPECTED_PORTS" | LC_ALL=C sort)"
[[ "$(docker port "$SF_CONTAINER" 80/tcp | LC_ALL=C sort)" == "$EXPECTED_PORTS" ]] ||
  sf_die "container port drift"
MOUNTS="$(docker inspect -f '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' "$SF_CONTAINER")"
[[ "$MOUNTS" == *"$ROOT:/srv/start-first"* ]] ||
  sf_die "container document-root mount drift"

# Preflight without changing the running container.
docker run --rm --network none --entrypoint nginx \
  -v "$ROOT:/srv/start-first:ro" \
  -v "$TARGET_CONFIG/server.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$TARGET_CONFIG/headers.inc:/etc/nginx/conf.d/headers.inc:ro" \
  -v "$TARGET_CONFIG/headers-html.conf:/etc/nginx/conf.d/headers-html.conf:ro" \
  "$SF_IMAGE" -t >/dev/null || sf_die "target nginx config failed validation"

BACKUP="$(mktemp -d "$ROOT/.rollback-backup.XXXXXXXX")"
for config in server.conf headers.inc headers-html.conf; do
  [[ -f "$ROOT/conf/$config" ]] || sf_die "current config missing: $config"
  cp -p "$ROOT/conf/$config" "$BACKUP/$config"
done
SWITCHING=0
restore_on_failure() {
  local rc="$1"
  trap - EXIT
  if [[ "$rc" -ne 0 && "$SWITCHING" -eq 1 ]]; then
    sf_log "rollback verification failed; returning to $CURRENT_NAME"
    set +e
    for config in server.conf headers.inc headers-html.conf; do
      install -m 0644 "$BACKUP/$config" "$ROOT/conf/$config"
    done
    ln -sfn "$CURRENT_LINK" "$ROOT/current.new"
    mv -Tf "$ROOT/current.new" "$ROOT/current"
    docker exec "$SF_CONTAINER" nginx -t &&
      docker exec "$SF_CONTAINER" nginx -s reload
  fi
  rm -rf -- "$BACKUP"
  exit "$rc"
}
trap 'restore_on_failure $?' EXIT
SWITCHING=1
for config in server.conf headers.inc headers-html.conf; do
  install -m 0644 "$TARGET_CONFIG/$config" "$ROOT/conf/$config"
done
ln -sfn "releases/$TARGET" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"
docker exec "$SF_CONTAINER" nginx -t
docker exec "$SF_CONTAINER" nginx -s reload
"$SF_REPO_ROOT/deploy/healthcheck.sh"
SWITCHING=0
sf_log "rolled back from $CURRENT_NAME to $TARGET (including nginx config)"
