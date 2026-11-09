#!/usr/bin/env bash
# Offline, disposable deployment failure-injection contracts. No real Docker or
# system configuration touched. CI also runs a separate REAL nginx smoke job.
set -euo pipefail

REAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
export SF_REPO_ROOT="$TMP/repo"
export SF_DEPLOY_ROOT="$TMP/root"
export SF_BIND=127.0.0.1 SF_PORT=8081 SF_CONTAINER=start-first-web
export SF_IMAGE=nginx:1.27-alpine SF_URL=http://127.0.0.1:8081
export PATH="$TMP/bin:$PATH"
mkdir -p "$TMP/bin" "$SF_REPO_ROOT/deploy/nginx" "$SF_DEPLOY_ROOT/conf"

cat > "$TMP/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
case "$1" in
  info) exit 0 ;;
  inspect)
    if [[ "$2" == "-f" ]]; then
      case "$3" in
        '{{.State.Running}}') echo true ;;
        '{{.Config.Image}}') echo nginx:1.27-alpine ;;
        *) echo "$SF_DEPLOY_ROOT:/srv/start-first:ro" ;;
      esac
    fi
    exit 0 ;;
  port)
    if [[ "$MOCK_PORT_DRIFT" == 1 ]]; then echo '0.0.0.0:8081'
    else echo '127.0.0.1:8081'; fi ;;

  run) [[ "$MOCK_PREFLIGHT_FAIL" != 1 ]] ;;
  exec) exit 0 ;;
  rm) [[ -z "$MOCK_RM_MARKER" ]] || touch "$MOCK_RM_MARKER"; exit 0 ;;

  *) echo "unexpected fake docker call: $*" >&2; exit 50 ;;
esac
DOCKER
cat > "$TMP/bin/git" <<'GIT'
#!/usr/bin/env bash
case "$*" in
  *'rev-parse --abbrev-ref HEAD'*) echo mock ;;
  *'rev-parse HEAD'*) echo 0000000000000000000000000000000000000000 ;;
  *'rev-parse --short=12 HEAD'*) echo 000000000000 ;;
  *'status --porcelain'*) ;;
  *) echo "unexpected fake git call: $*" >&2; exit 50 ;;
esac
GIT
chmod +x "$TMP/bin/docker" "$TMP/bin/git"

cat > "$SF_REPO_ROOT/deploy/healthcheck.sh" <<'HEALTH'
#!/usr/bin/env bash
[[ "$MOCK_HEALTH_FAIL" != 1 ]]
HEALTH
chmod +x "$SF_REPO_ROOT/deploy/healthcheck.sh"
mkdir -p "$SF_REPO_ROOT/assets" "$SF_REPO_ROOT/code/frontend" \
  "$SF_REPO_ROOT/code/domain" "$SF_REPO_ROOT/code/algorithm" \
  "$SF_REPO_ROOT/code/persistence"
for f in index.html assets/icon.svg code/frontend/main.js \
  code/frontend/styles.css code/domain/core.js code/algorithm/suggest.js \
  code/persistence/store.js code/persistence/invariants.js; do
  echo mock > "$SF_REPO_ROOT/$f"
done
for f in server.conf headers.inc headers-html.conf; do
  echo "new-$f" > "$SF_REPO_ROOT/deploy/nginx/$f"
done

R1=20261109T010000Z-aaaa
R2=20261109T020000Z-bbbb
R3=20261109T030000Z-cccc
for r in "$R1" "$R2" "$R3"; do
  mkdir -p "$SF_DEPLOY_ROOT/releases/$r" "$SF_DEPLOY_ROOT/config-releases/$r"
  echo "$r" > "$SF_DEPLOY_ROOT/releases/$r/index.html"
  for f in server.conf headers.inc headers-html.conf; do
    echo "$r:$f" > "$SF_DEPLOY_ROOT/config-releases/$r/$f"
  done
done
reset_fixture() {
  rm -f "$SF_DEPLOY_ROOT/current"
  ln -s "releases/$R3" "$SF_DEPLOY_ROOT/current"
  for f in server.conf headers.inc headers-html.conf; do
    cp "$SF_DEPLOY_ROOT/config-releases/$R3/$f" "$SF_DEPLOY_ROOT/conf/$f"
  done
  export MOCK_PREFLIGHT_FAIL=0 MOCK_HEALTH_FAIL=0 MOCK_PORT_DRIFT=0
  export MOCK_RM_MARKER="$TMP/mock-container-remove"
  rm -f "$MOCK_RM_MARKER"
}
run_script() { bash "$REAL_ROOT/deploy/$1" "${@:2}"; }
expect_current() {
  [[ "$(readlink "$SF_DEPLOY_ROOT/current")" == "releases/$1" ]] ||
    { echo "wrong current: expected $1" >&2; exit 1; }
}
expect_config() {
  grep -q "^$1:server.conf$" "$SF_DEPLOY_ROOT/conf/server.conf" ||
    { echo "wrong active config for $1" >&2; exit 1; }
}

reset_fixture
run_script rollback.sh >/dev/null
expect_current "$R2"
expect_config "$R2"
run_script rollback.sh >/dev/null
expect_current "$R1"
expect_config "$R1"
if run_script rollback.sh >/dev/null 2>&1; then echo "rollback must not roll forward" >&2; exit 1; fi
expect_current "$R1"
echo "ok 1: default rollback chooses only strictly older releases"

reset_fixture
export MOCK_HEALTH_FAIL=1
if run_script rollback.sh >/dev/null 2>&1; then echo "rollback should fail health gate" >&2; exit 1; fi
expect_current "$R3"
expect_config "$R3"
echo "ok 2: failed rollback restores link and nginx config"

reset_fixture
mv "$SF_DEPLOY_ROOT/config-releases/$R2/server.conf" "$TMP/archived-config"
if run_script rollback.sh >/dev/null 2>&1; then echo "missing archive must block rollback" >&2; exit 1; fi
expect_current "$R3"
mv "$TMP/archived-config" "$SF_DEPLOY_ROOT/config-releases/$R2/server.conf"
echo "ok 3: config mismatch blocks rollback"

reset_fixture
if run_script rollback.sh "../$R1" >/dev/null 2>&1; then echo "release traversal must fail" >&2; exit 1; fi
expect_current "$R3"
echo "ok 4: rollback refuses traversal names"

reset_fixture
run_script deploy.sh --no-restart >/dev/null
expect_current "$R3"
expect_config "$R3"
echo "ok 5: stage-only never silently activates new release"

reset_fixture
export MOCK_PREFLIGHT_FAIL=1
if run_script deploy.sh >/dev/null 2>&1; then echo "bad candidate nginx config must fail" >&2; exit 1; fi
expect_current "$R3"
expect_config "$R3"
echo "ok 6: preflight failure leaves live site untouched"

reset_fixture
export MOCK_HEALTH_FAIL=1
if run_script deploy.sh >/dev/null 2>&1; then echo "bad post-deploy health must fail" >&2; exit 1; fi
expect_current "$R3"
expect_config "$R3"
echo "ok 7: failed activation restores prior code and config"

reset_fixture
export MOCK_PORT_DRIFT=1
if run_script deploy.sh >/dev/null 2>&1; then echo "unexpected port drift must stop deploy" >&2; exit 1; fi
expect_current "$R3"
expect_config "$R3"
[[ ! -f "$MOCK_RM_MARKER" ]] || { echo "deploy must never delete container automatically" >&2; exit 1; }
echo "ok 8: topology drift is fail-closed (no docker rm -f)"

reset_fixture
echo "PATH=/tmp/attacker-path" > "$SF_DEPLOY_ROOT/deploy.env"
if run_script rollback.sh --list >/dev/null 2>&1; then
  echo "deploy.env must reject unknown variable assignment" >&2; exit 1
fi
rm -f "$SF_DEPLOY_ROOT/deploy.env"
expect_current "$R3"
echo "ok 9: deploy.env parser rejects arbitrary variable injection"

echo "9/9 isolated deployment/rollback fault-injection contracts passed"
