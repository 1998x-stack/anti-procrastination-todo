#!/usr/bin/env bash
# REAL-environment deployment fault injection against an ISOLATED staging root.
#
# Difference from tests/deployment/scripts-regression.sh (offline, fake docker):
# this suite runs the real deploy/rollback scripts against a real Docker daemon
# and a real nginx container, so it also validates everything the mocks hide:
#   - the ephemeral `nginx -t` preflight container
#   - real `docker inspect` / `docker port` output parsing
#   - the EXIT-trap restore path with a real container reload
#   - real flock contention and real same-second release naming
#   - real rollback across several archived configs
#
# SAFETY CONTRACT (enforced below, not advisory):
#   * refuses to run against the live deployment root or the live container
#   * refuses if the live URL is not healthy before starting
#   * verifies after EVERY scenario that the live container id, live current
#     symlink, live port binding and live HTTP status are unchanged
#   * never runs docker rm/prune/stop itself; a scenario passes only if the
#     container under test keeps the SAME id (i.e. nothing was recreated)
#   * content injections (missing file, symlink, broken config) are applied to a
#     throwaway COPY of the repository, never to the checkout under review
#
# Usage:
#   SF_DEPLOY_ROOT=/home/ubuntu/apps/start-first-pr2-staging \
#   SF_CONTAINER=start-first-pr2-staging SF_PORT=18081 SF_BIND=127.0.0.1 \
#   SF_URL=http://127.0.0.1:18081 SF_REPO_ROOT=<worktree> \
#   LIVE_URL=http://127.0.0.1:8081 LIVE_CONTAINER=start-first-web \
#   bash tests/deployment/staging-fault-injection.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIVE_URL="${LIVE_URL:-http://127.0.0.1:8081}"
LIVE_CONTAINER="${LIVE_CONTAINER:-start-first-web}"
LIVE_ROOT="${LIVE_ROOT:-/home/ubuntu/apps/start-first}"

# --- Safety preamble --------------------------------------------------------
[[ -n "${SF_DEPLOY_ROOT:-}" && -n "${SF_CONTAINER:-}" ]] || { echo "set SF_DEPLOY_ROOT and SF_CONTAINER" >&2; exit 2; }
[[ -d "$SF_DEPLOY_ROOT" ]] || { echo "staging root missing: $SF_DEPLOY_ROOT" >&2; exit 2; }
[[ -L "$SF_DEPLOY_ROOT/current" ]] || { echo "staging root has no activated current" >&2; exit 2; }
[[ "$SF_DEPLOY_ROOT" != "$LIVE_ROOT" ]] || { echo "REFUSING: staging root equals the live deployment root" >&2; exit 2; }
[[ "$SF_CONTAINER" != "$LIVE_CONTAINER" ]] || { echo "REFUSING: staging container equals the live container" >&2; exit 2; }
[[ "$(readlink -f "$SF_DEPLOY_ROOT")" != "$(readlink -f "$LIVE_ROOT")" ]] || { echo "REFUSING: roots resolve to the same path" >&2; exit 2; }

health() { curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$1/healthz" 2>/dev/null || echo 000; }
[[ "$(health "$LIVE_URL")" == "200" ]] || { echo "REFUSING: live service $LIVE_URL is not healthy before the run" >&2; exit 2; }
[[ "$(health "${SF_URL:-}")" == "200" ]] || { echo "REFUSING: staging service ${SF_URL:-} is not healthy before the run" >&2; exit 2; }

export SF_REPO_ROOT="$REAL_REPO"
TMP="$(mktemp -d /tmp/sf-staging-fi.XXXXXX)"
PASS=0; FAIL=0
say()  { printf '\n=== %s\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$*"; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1 ($3)"; else bad "$1: expected '$2' got '$3'"; fi; }

live_state() {
  printf '%s|%s|%s|%s' \
    "$(docker inspect -f '{{.Id}}' "$LIVE_CONTAINER" 2>/dev/null)" \
    "$(readlink "$LIVE_ROOT/current" 2>/dev/null)" \
    "$(docker port "$LIVE_CONTAINER" 80/tcp 2>/dev/null | tr '\n' ',')" \
    "$(health "$LIVE_URL")"
}
stage_state() {
  printf '%s|%s|%s|%s' \
    "$(docker inspect -f '{{.Id}}' "$SF_CONTAINER" 2>/dev/null)" \
    "$(readlink "$SF_DEPLOY_ROOT/current" 2>/dev/null)" \
    "$(sha256sum "$SF_DEPLOY_ROOT"/conf/* | sha256sum | cut -c1-16)" \
    "$(health "$SF_URL")"
}
LIVE_BASELINE="$(live_state)"
assert_live_intact() { # <label>
  local now; now="$(live_state)"
  if [[ "$now" == "$LIVE_BASELINE" ]]; then ok "$1: live service untouched (id/current/port/HTTP unchanged)"
  else bad "$1: LIVE SERVICE CHANGED: '$LIVE_BASELINE' -> '$now'"; fi
}

# A throwaway repo copy for injections that must not touch the reviewed checkout.
shim_repo() { # <dest>
  local dest="$1"
  mkdir -p "$dest"
  tar -cf - -C "$REAL_REPO" --exclude=./node_modules --exclude=./artifacts --exclude=./test-results . | tar -xf - -C "$dest"
}

# Run a deploy/rollback script from a shim checkout.
# SF_REPO_ROOT MUST be unset here: this suite exports it for the normal scenarios,
# and an inherited value would make the script publish the reviewed checkout
# instead of the shim, silently ignoring the injected fault (observed once).
run_shim() { # <shim> <script> [args...]
  local shim="$1" script="$2"; shift 2
  ( cd "$shim" && env -u SF_REPO_ROOT bash "deploy/$script" "$@" )
}

# ===========================================================================
say "S0 baseline: staging activated, live intact, no extra listeners"
S0_STAGE="$(stage_state)"
S0_HASH="$(grep -o '"publishedContentSha256": *"[^"]*"' "$SF_DEPLOY_ROOT/meta/$(basename "$(readlink "$SF_DEPLOY_ROOT/current")").json" | cut -d'"' -f4)"
check "staging container running" "true" "$(docker inspect -f '{{.State.Running}}' "$SF_CONTAINER")"
check "staging published only on ${SF_BIND}:${SF_PORT}" "${SF_BIND}:${SF_PORT}" "$(docker port "$SF_CONTAINER" 80/tcp)"
check "staging has exactly one publish line" "1" "$(docker port "$SF_CONTAINER" 80/tcp | wc -l | tr -d ' ')"
check "staging is not published on 0.0.0.0" "no" "$(docker port "$SF_CONTAINER" 80/tcp | grep -q '^0.0.0.0:' && echo yes || echo no)"
assert_live_intact "S0"

# ===========================================================================
say "S1 drift: image mismatch is fail-closed and never deletes the container"
# A local alias tag of the SAME image: the ephemeral preflight still finds a
# working nginx binary, so the run reaches the container-image drift check.
IMAGE_ALIAS="start-first-nginx-alias:fi"
docker tag "$SF_IMAGE" "$IMAGE_ALIAS" || bad "could not create the local image alias for the drift test"
before="$(stage_state)"
out="$(cd "$SF_REPO_ROOT" && SF_IMAGE="$IMAGE_ALIAS" bash deploy/deploy.sh 2>&1)"; rc=$?
[[ "$rc" -ne 0 ]] && ok "deploy refused (rc=$rc)" || bad "deploy should have refused image drift"
grep -q "image drift" <<<"$out" && ok "reason reported: image drift" || bad "expected 'image drift', got: $(tail -2 <<<"$out" | tr '\n' ' ')"
check "staging container id unchanged (no docker rm -f)" "$(cut -d'|' -f1 <<<"$before")" "$(cut -d'|' -f1 <<<"$(stage_state)")"
check "staging current unchanged" "$(cut -d'|' -f2 <<<"$before")" "$(cut -d'|' -f2 <<<"$(stage_state)")"
check "staging still serving" "200" "$(health "$SF_URL")"
docker rmi "$IMAGE_ALIAS" >/dev/null 2>&1 || true
assert_live_intact "S1"

# ===========================================================================
say "S2 drift: port binding mismatch is fail-closed"
out="$(cd "$SF_REPO_ROOT" && SF_PORT=18099 bash deploy/deploy.sh 2>&1)"; rc=$?
[[ "$rc" -ne 0 ]] && ok "deploy refused (rc=$rc)" || bad "deploy should have refused port drift"
grep -q "port drift" <<<"$out" && ok "reason reported: port drift" || bad "expected 'port drift', got: $(tail -2 <<<"$out" | tr '\n' ' ')"
check "staging current unchanged" "$(cut -d'|' -f2 <<<"$S0_STAGE")" "$(readlink "$SF_DEPLOY_ROOT/current")"
check "staging still serving" "200" "$(health "$SF_URL")"
assert_live_intact "S2"

# ===========================================================================
say "S3 drift: document-root mount mismatch is fail-closed"
ALT="$TMP/alt-root"; mkdir -p "$ALT"
out="$(cd "$SF_REPO_ROOT" && SF_DEPLOY_ROOT="$ALT" bash deploy/deploy.sh 2>&1)"; rc=$?
[[ "$rc" -ne 0 ]] && ok "deploy refused (rc=$rc)" || bad "deploy should have refused mount drift"
grep -q "mount drift" <<<"$out" && ok "reason reported: mount drift" || bad "expected 'mount drift', got: $(tail -2 <<<"$out" | tr '\n' ' ')"
check "staging current unchanged" "$(cut -d'|' -f2 <<<"$S0_STAGE")" "$(readlink "$SF_DEPLOY_ROOT/current")"
check "staging still serving" "200" "$(health "$SF_URL")"
assert_live_intact "S3"

# ===========================================================================
say "S4 broken candidate nginx config is caught by the REAL ephemeral preflight"
SHIM="$TMP/shim-badcfg"; shim_repo "$SHIM"
printf 'server { listen 80; this_is_not_valid_directive; }\n' > "$SHIM/deploy/nginx/server.conf"
before="$(stage_state)"
out="$(run_shim "$SHIM" deploy.sh 2>&1)"; rc=$?
[[ "$rc" -ne 0 ]] && ok "deploy refused (rc=$rc)" || bad "deploy must refuse an invalid nginx config"
grep -qi "failed validation" <<<"$out" && ok "reason reported: candidate config failed validation" || bad "expected validation failure, got: $(tail -3 <<<"$out" | tr '\n' ' ')"
# GOTCHA-028: the never-activated release must be quarantined out of releases/,
# otherwise it becomes the newest rollback candidate and blocks recovery.
rel_before="$(find "$SF_DEPLOY_ROOT/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
grep -q "quarantining never-activated release" <<<"$out" && ok "never-activated release reported as quarantined" || bad "no quarantine message"
check "quarantined evidence retained in rejected-releases" "yes" "$(ls -1 "$SF_DEPLOY_ROOT/rejected-releases" >/dev/null 2>&1 && echo yes || echo no)"
check "no poisoned config archive left in the rollback path" "0" "$(grep -l 'this_is_not_valid_directive' "$SF_DEPLOY_ROOT"/config-releases/*/server.conf 2>/dev/null | wc -l | tr -d ' ')"
check "live config install did not happen" "$(cut -d'|' -f3 <<<"$before")" "$(cut -d'|' -f3 <<<"$(stage_state)")"
check "staging current unchanged" "$(cut -d'|' -f2 <<<"$before")" "$(cut -d'|' -f2 <<<"$(stage_state)")"
check "staging still serving" "200" "$(health "$SF_URL")"
assert_live_intact "S4"

say "S4b default rollback still reaches older releases after the failed preflight"
cur_4b="$(basename "$(readlink "$SF_DEPLOY_ROOT/current")")"
out="$(cd "$SF_REPO_ROOT" && bash deploy/rollback.sh 2>&1)"; rc=$?
[[ "$rc" -eq 0 ]] && ok "default rollback succeeded (rc=0)" || bad "default rollback blocked after a failed preflight: $(tail -2 <<<"$out" | tr '\n' ' ')"
tgt_4b="$(basename "$(readlink "$SF_DEPLOY_ROOT/current")")"
[[ "$tgt_4b" < "$cur_4b" ]] && ok "still moves strictly older: $cur_4b -> $tgt_4b" || bad "rollback did not move strictly older ($cur_4b -> $tgt_4b)"
check "staging serving after S4b" "200" "$(health "$SF_URL")"
assert_live_intact "S4b"

# ===========================================================================
say "S5 release missing a required runtime file is refused"
SHIM="$TMP/shim-missing"; shim_repo "$SHIM"
rm -f "$SHIM/code/persistence/invariants.js"
before="$(stage_state)"
out="$(run_shim "$SHIM" deploy.sh 2>&1)"; rc=$?
[[ "$rc" -ne 0 ]] && ok "deploy refused (rc=$rc)" || bad "deploy must refuse an incomplete release"
grep -q "release is incomplete" <<<"$out" && ok "reason reported: release is incomplete" || bad "expected incompleteness error, got: $(tail -2 <<<"$out" | tr '\n' ' ')"
check "staging current unchanged" "$(cut -d'|' -f2 <<<"$before")" "$(cut -d'|' -f2 <<<"$(stage_state)")"
check "staging still serving" "200" "$(health "$SF_URL")"
assert_live_intact "S5"

# ===========================================================================
say "S6 release containing a symlink is refused (no path escape into the served root)"
SHIM="$TMP/shim-symlink"; shim_repo "$SHIM"
ln -sfn /etc/passwd "$SHIM/assets/escape.svg"
before="$(stage_state)"
out="$(run_shim "$SHIM" deploy.sh 2>&1)"; rc=$?
[[ "$rc" -ne 0 ]] && ok "deploy refused (rc=$rc)" || bad "deploy must refuse a symlink-bearing release"
grep -q "symlink" <<<"$out" && ok "reason reported: symlink refusal" || bad "expected symlink refusal, got: $(tail -2 <<<"$out" | tr '\n' ' ')"
check "staging current unchanged" "$(cut -d'|' -f2 <<<"$before")" "$(readlink "$SF_DEPLOY_ROOT/current")"
check "served root exposes no escape.svg" "404" "$(curl -sS -o /dev/null -w '%{http_code}' "$SF_URL/assets/escape.svg")"
check "staging still serving" "200" "$(health "$SF_URL")"
assert_live_intact "S6"

# ===========================================================================
say "S7 concurrent deploy is refused by flock"
( exec 9>"$SF_DEPLOY_ROOT/.deploy.lock"; flock -n 9; sleep 6 ) &
HOLDER=$!
sleep 0.6
before="$(stage_state)"
out="$(cd "$SF_REPO_ROOT" && bash deploy/deploy.sh 2>&1)"; rc=$?
[[ "$rc" -ne 0 ]] && ok "deploy refused while locked (rc=$rc)" || bad "deploy must refuse while another command holds the lock"
grep -q "already running" <<<"$out" && ok "reason reported: lock held" || bad "expected lock error, got: $(tail -2 <<<"$out" | tr '\n' ' ')"
check "staging current unchanged" "$(cut -d'|' -f2 <<<"$before")" "$(readlink "$SF_DEPLOY_ROOT/current")"
wait "$HOLDER" 2>/dev/null
assert_live_intact "S7"

# ===========================================================================
say "S8 post-activation health failure restores code AND nginx config (real docker)"
before="$(stage_state)"
# SF_PORT/SF_BIND stay correct (so no drift refusal) while SF_URL points nowhere:
# activation proceeds, the health gate fails, the EXIT trap must restore.
out="$(cd "$SF_REPO_ROOT" && SF_URL=http://127.0.0.1:19999 bash deploy/deploy.sh 2>&1)"; rc=$?
[[ "$rc" -ne 0 ]] && ok "deploy failed as intended (rc=$rc)" || bad "deploy was expected to fail its health gate"
grep -q "restoring previous code AND nginx configuration" <<<"$out" && ok "restore path executed" || bad "restore path did not run: $(tail -3 <<<"$out" | tr '\n' ' ')"
check "staging current restored" "$(cut -d'|' -f2 <<<"$before")" "$(readlink "$SF_DEPLOY_ROOT/current")"
check "staging nginx config restored" "$(cut -d'|' -f3 <<<"$before")" "$(sha256sum "$SF_DEPLOY_ROOT"/conf/* | sha256sum | cut -c1-16)"
check "staging container not recreated" "$(cut -d'|' -f1 <<<"$before")" "$(docker inspect -f '{{.Id}}' "$SF_CONTAINER")"
check "staging serving again after restore" "200" "$(health "$SF_URL")"
check "no leftover activation backup dirs" "0" "$(find "$SF_DEPLOY_ROOT" -maxdepth 1 -name '.activation-backup.*' | wc -l | tr -d ' ')"
assert_live_intact "S8"

# ===========================================================================
say "S9 rollback blocked when the target release has no archived nginx config"
CUR_BEFORE="$(readlink "$SF_DEPLOY_ROOT/current")"
OLDER="$(find "$SF_DEPLOY_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort | tail -1)"
[[ "$OLDER" != "$(basename "$CUR_BEFORE")" ]] || bad "fixture needs at least two releases"
mv "$SF_DEPLOY_ROOT/config-releases/$OLDER" "$TMP/archived-$OLDER"
out="$(cd "$SF_REPO_ROOT" && bash deploy/rollback.sh "$OLDER" 2>&1)"; rc=$?
[[ "$rc" -ne 0 ]] && ok "rollback refused (rc=$rc)" || bad "rollback must be blocked without an archived config"
grep -q "no archived nginx config" <<<"$out" && ok "reason reported: missing archive" || bad "expected missing-archive error, got: $(tail -2 <<<"$out" | tr '\n' ' ')"
check "current unchanged" "$CUR_BEFORE" "$(readlink "$SF_DEPLOY_ROOT/current")"
check "staging still serving" "200" "$(health "$SF_URL")"
mv "$TMP/archived-$OLDER" "$SF_DEPLOY_ROOT/config-releases/$OLDER"
assert_live_intact "S9"

# ===========================================================================
say "S10 consecutive rollback never rolls forward (real docker + real configs)"
mapfile -t RELS < <(find "$SF_DEPLOY_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort)
# The fixture needs `current` to be NEWER than at least one other release, and at
# least three releases overall. A fresh root has current as the oldest release,
# so always deploy a couple of newer releases instead of assuming history exists.
for _ in 1 2; do (cd "$SF_REPO_ROOT" && bash deploy/deploy.sh >/dev/null 2>&1); done
mapfile -t RELS < <(find "$SF_DEPLOY_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort)
CUR="$(basename "$(readlink "$SF_DEPLOY_ROOT/current")")"
IDX=-1
for i in "${!RELS[@]}"; do [[ "${RELS[$i]}" == "$CUR" ]] && IDX=$i; done
if [[ "$IDX" -ge 1 ]]; then
  (cd "$SF_REPO_ROOT" && bash deploy/rollback.sh >/dev/null 2>&1) && ok "first default rollback succeeded" || bad "first default rollback failed"
  FIRST="$(basename "$(readlink "$SF_DEPLOY_ROOT/current")")"
  [[ "$FIRST" < "$CUR" ]] && ok "moved strictly older: $CUR -> $FIRST" || bad "rollback did not move to an older release ($CUR -> $FIRST)"
  cfg_ok=1
  for f in server.conf headers.inc headers-html.conf; do
    cmp -s "$SF_DEPLOY_ROOT/conf/$f" "$SF_DEPLOY_ROOT/config-releases/$FIRST/$f" || cfg_ok=0
  done
  [[ "$cfg_ok" == 1 ]] && ok "active config matches the archived config of $FIRST" || bad "active config does not match the rolled-back release archive"
  check "staging serving after rollback" "200" "$(health "$SF_URL")"
  # Keep rolling back until the OLDEST release is active, then a further default
  # rollback must refuse and must not move anywhere (never roll forward).
  OLDEST="${RELS[0]}"
  n=0
  while [[ "$(basename "$(readlink "$SF_DEPLOY_ROOT/current")")" != "$OLDEST" && "$n" -lt 200 ]]; do
    (cd "$SF_REPO_ROOT" && bash deploy/rollback.sh >/dev/null 2>&1) || break
    n=$((n+1))
  done
  check "reached the oldest release" "$OLDEST" "$(basename "$(readlink "$SF_DEPLOY_ROOT/current")")"
  if (cd "$SF_REPO_ROOT" && bash deploy/rollback.sh >/dev/null 2>&1); then
    bad "a default rollback must fail at the oldest release (got $(readlink "$SF_DEPLOY_ROOT/current"))"
  else ok "default rollback refused at the oldest release (no older release) and did not roll forward"; fi
  check "still on the oldest release" "$OLDEST" "$(basename "$(readlink "$SF_DEPLOY_ROOT/current")")"
  check "staging still serving" "200" "$(health "$SF_URL")"
else
  bad "could not establish a rollback fixture (index=$IDX releases=${#RELS[@]})"
fi
assert_live_intact "S10"

# ===========================================================================
say "S11 two deploys within the same second produce distinct, usable releases"
before_count="$(find "$SF_DEPLOY_ROOT/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
( cd "$SF_REPO_ROOT" && bash deploy/deploy.sh >/dev/null 2>&1 ) &
( sleep 0.1; cd "$SF_REPO_ROOT" && bash deploy/deploy.sh >/dev/null 2>&1 ) &
wait
after_count="$(find "$SF_DEPLOY_ROOT/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
[[ "$after_count" -gt "$before_count" ]] && ok "releases added ($before_count -> $after_count)" || bad "same-second deploys collided ($before_count -> $after_count)"
check "duplicate release dirs" "0" "$(find "$SF_DEPLOY_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | uniq -d | wc -l | tr -d ' ')"
check "staging serving after concurrent deploys" "200" "$(health "$SF_URL")"
check "current is a managed release" "yes" "$(readlink "$SF_DEPLOY_ROOT/current" | grep -q '^releases/' && echo yes || echo no)"
assert_live_intact "S11"

# ===========================================================================
say "S12 dirty worktree provenance is accurate and independently recomputable"
SHIM="$TMP/shim-dirty"; shim_repo "$SHIM"
echo "/* local unreviewed tweak $(date -u +%s) */" >> "$SHIM/code/frontend/styles.css"
out="$(run_shim "$SHIM" deploy.sh 2>&1)"; rc=$?
[[ "$rc" -eq 0 ]] && ok "dirty deploy activated (rc=0)" || bad "dirty deploy failed: $(tail -3 <<<"$out" | tr '\n' ' ')"
NEW="$(basename "$(readlink "$SF_DEPLOY_ROOT/current")")"
check "dirty content really came from the shim (styles.css differs)" "yes" "$(grep -q 'local unreviewed tweak' "$SF_DEPLOY_ROOT/releases/$NEW/code/frontend/styles.css" && echo yes || echo no)"
META="$SF_DEPLOY_ROOT/meta/$NEW.json"
[[ "$(grep -o '"workingTree": *"[^"]*"' "$META" | cut -d'"' -f4)" == "dirty" ]] && ok "meta records workingTree=dirty" || bad "meta did not record dirty worktree"
RECORDED="$(grep -o '"publishedContentSha256": *"[^"]*"' "$META" | cut -d'"' -f4)"
# recompute the digest exactly as deploy.sh does, from the release on disk
RECOMPUTED="$(cd "$SF_DEPLOY_ROOT/releases/$NEW" && find . -type f -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' p; do printf '%s %s\n' "$(sha256sum "$p" | cut -d' ' -f1)" "$p"; done | sha256sum | cut -d' ' -f1)"
check "publishedContentSha256 is reproducible" "$RECORDED" "$RECOMPUTED"
check "dirty release differs from the clean baseline digest" "yes" "$([[ "$RECORDED" != "$S0_HASH" ]] && echo yes || echo no)"
check "staging serving after dirty deploy" "200" "$(health "$SF_URL")"
assert_live_intact "S12"

# ===========================================================================
say "S13 failure scenarios left old releases intact and reachable"
for r in $OLDER "$(basename "$CUR_BEFORE")"; do
  [[ -d "$SF_DEPLOY_ROOT/releases/$r" ]] && ok "old release preserved: $r" || bad "old release missing: $r"
done
check "no stray activation/rollback temp dirs" "0" "$(find "$SF_DEPLOY_ROOT" -maxdepth 1 \( -name '.activation-backup.*' -o -name '.rollback-backup.*' \) | wc -l | tr -d ' ')"
check "staging still serving current release" "200" "$(health "$SF_URL")"
check "live binding still ${LIVE_BIND:-0.0.0.0}:8081" "${LIVE_BIND:-0.0.0.0}:8081" "$(docker port "$LIVE_CONTAINER" 80/tcp)"
assert_live_intact "S13"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || { echo "STAGING FAULT INJECTION FAILED" >&2; exit 1; }
echo "staging fault-injection suite passed"
