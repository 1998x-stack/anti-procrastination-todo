#!/usr/bin/env bash
# Verify that the deployed site is actually healthy and correctly configured.
# Read-only: it never mutates data or restarts anything.
#
# Exit code 0 = all checks passed. Any failure prints CHECK FAIL and exits 1.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

FAILURES=0
check() { # check <name> <expected> <actual>
  if [[ "$2" == "$3" ]]; then printf '  ok   %-46s %s\n' "$1" "$3"
  else printf '  FAIL %-46s expected=%s actual=%s\n' "$1" "$2" "$3"; FAILURES=$((FAILURES+1)); fi
}
status_of() { curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$SF_URL$1" 2>/dev/null || echo "000"; }
# content type without parameters, lower-cased ("text/html; charset=utf-8" -> "text/html")
ctype_of()  { curl -sS -o /dev/null -w '%{content_type}' --max-time 10 "$SF_URL$1" 2>/dev/null | cut -d';' -f1 | tr 'A-Z' 'a-z' || echo "none"; }
header_of() { curl -sSI --max-time 10 "$SF_URL$1" 2>/dev/null | tr -d '\r' | awk -F': ' -v h="$2" 'tolower($1)==tolower(h){print $2; exit}'; }
# WHATWG MIME Sniffing: every value below is a valid JavaScript MIME type.
is_js_type() { case "$1" in text/javascript|application/javascript|application/ecmascript|application/x-ecmascript|text/ecmascript) echo yes ;; *) echo "no ($1)" ;; esac; }

echo "Health check: $SF_URL"

# --- Container state --------------------------------------------------------
if docker inspect -f '{{.State.Running}}' "$SF_CONTAINER" 2>/dev/null | grep -q true; then
  echo "  ok   container running                              $SF_CONTAINER"
else
  echo "  FAIL container not running                          $SF_CONTAINER"; FAILURES=$((FAILURES+1))
fi
# Every configured bind address must actually be published (SF_BIND may be a list).
for addr in $SF_BIND; do
  if docker port "$SF_CONTAINER" 80/tcp 2>/dev/null | grep -qxF "${addr}:${SF_PORT}"; then
    echo "  ok   published on                                  ${addr}:${SF_PORT}"
  else
    echo "  FAIL publish missing                                ${addr}:${SF_PORT}"; FAILURES=$((FAILURES+1))
  fi
done
# Checking only that expected binds exist is insufficient: a container could
# additionally publish 0.0.0.0 while the requested policy is loopback-only.
EXPECTED_PORTS=""
for addr in $SF_BIND; do EXPECTED_PORTS+="$addr:$SF_PORT"
for addr in $SF_BIND; do
  case "$addr" in
    127.0.0.1|::1) : ;;
    *) echo "  warn ${addr}:${SF_PORT} reachable from the local network over plain HTTP (no TLS)" ;;
  esac
done

# --- HTTP surface ----------------------------------------------------------
check "GET /healthz"                 "200" "$(status_of /healthz)"
check "GET / (entry point)"          "200" "$(status_of /)"
check "GET /index.html"              "200" "$(status_of /index.html)"
check "GET /code/frontend/main.js"   "200" "$(status_of /code/frontend/main.js)"
check "GET /code/frontend/styles.css" "200" "$(status_of /code/frontend/styles.css)"
check "GET /code/domain/core.js"     "200" "$(status_of /code/domain/core.js)"
check "GET /code/algorithm/suggest.js" "200" "$(status_of /code/algorithm/suggest.js)"
check "GET /code/persistence/store.js" "200" "$(status_of /code/persistence/store.js)"
check "GET /assets/icon.svg"         "200" "$(status_of /assets/icon.svg)"
check "GET /code/frontend/main.js is JS" "yes" "$(is_js_type "$(ctype_of /code/frontend/main.js)")"
check "GET / content-type is text/html" "text/html" "$(ctype_of /)"
check "GET /index.html content-type"   "text/html" "$(ctype_of /index.html)"
check "GET /assets/icon.svg type"    "image/svg+xml" "$(ctype_of /assets/icon.svg)"
check "missing asset is a real 404"  "404" "$(status_of /code/frontend/does-not-exist.js)"

# --- Security / cache headers ----------------------------------------------
check "CSP present on /"             "yes" "$([[ -n "$(header_of / Content-Security-Policy)" ]] && echo yes || echo no)"
check "nosniff present on /"         "yes" "$([[ "$(header_of / X-Content-Type-Options)" == "nosniff" ]] && echo yes || echo no)"
check "Cache-Control no-store on /"  "yes" "$([[ "$(header_of / Cache-Control)" == *no-store* ]] && echo yes || echo no)"
check "Cache-Control no-cache on js" "yes" "$([[ "$(header_of /code/frontend/main.js Cache-Control)" == *no-cache* ]] && echo yes || echo no)"
check "server_tokens off"            "yes" "$([[ -z "$(header_of / Server | grep -o '[0-9]' || true)" ]] && echo yes || echo no)"

# --- Unpublished surfaces --------------------------------------------------
check "research API source not served"  "404" "$(status_of /code/backend/dev-server.js)"
check "telemetry schema not served"     "404" "$(status_of /code/backend/schema.sql)"
check "tests not served"                "404" "$(status_of /tests/domain.test.js)"
check "no directory listing"            "no-list" "$(s=$(status_of /code/frontend/); [[ "$s" == "403" || "$s" == "404" ]] && echo no-list || echo "$s")"
check "dotfiles denied"                 "no-list" "$(s=$(status_of /../meta); [[ "$s" == "400" || "$s" == "403" || "$s" == "404" ]] && echo no-list || echo "$s")"

# --- Served content matches the release on disk ----------------------------
CURRENT="$SF_DEPLOY_ROOT/current"
if [[ -L "$CURRENT" ]]; then
  LOCAL_HASH="$(sha256sum "$(readlink -f "$CURRENT")/index.html" | cut -d' ' -f1)"
  SERVED_HASH="$(curl -sS --max-time 10 "$SF_URL/" | sha256sum | cut -d' ' -f1)"
  check "served index.html matches release on disk" "$LOCAL_HASH" "$SERVED_HASH"
  echo "  info current -> $(readlink -f "$CURRENT")"
else
  echo "  FAIL $CURRENT is not a symlink"; FAILURES=$((FAILURES+1))
fi

if [[ "$FAILURES" -eq 0 ]]; then echo "All health checks passed."; exit 0
else echo "$FAILURES health check(s) failed."; exit 1; fi
\n'; done
EXPECTED_PORTS="$(printf '%s' "$EXPECTED_PORTS" | LC_ALL=C sort)"
ACTUAL_PORTS="$(docker port "$SF_CONTAINER" 80/tcp 2>/dev/null | LC_ALL=C sort)"
check "no additional publicly bound ports" "$EXPECTED_PORTS" "$ACTUAL_PORTS"

# Make an intentional LAN exposure visible instead of silently normalising it.
for addr in $SF_BIND; do
  case "$addr" in
    127.0.0.1|::1) : ;;
    *) echo "  warn ${addr}:${SF_PORT} reachable from the local network over plain HTTP (no TLS)" ;;
  esac
done

# --- HTTP surface ----------------------------------------------------------
check "GET /healthz"                 "200" "$(status_of /healthz)"
check "GET / (entry point)"          "200" "$(status_of /)"
check "GET /index.html"              "200" "$(status_of /index.html)"
check "GET /code/frontend/main.js"   "200" "$(status_of /code/frontend/main.js)"
check "GET /code/frontend/styles.css" "200" "$(status_of /code/frontend/styles.css)"
check "GET /code/domain/core.js"     "200" "$(status_of /code/domain/core.js)"
check "GET /code/algorithm/suggest.js" "200" "$(status_of /code/algorithm/suggest.js)"
check "GET /code/persistence/store.js" "200" "$(status_of /code/persistence/store.js)"
check "GET /assets/icon.svg"         "200" "$(status_of /assets/icon.svg)"
check "GET /code/frontend/main.js is JS" "yes" "$(is_js_type "$(ctype_of /code/frontend/main.js)")"
check "GET / content-type is text/html" "text/html" "$(ctype_of /)"
check "GET /index.html content-type"   "text/html" "$(ctype_of /index.html)"
check "GET /assets/icon.svg type"    "image/svg+xml" "$(ctype_of /assets/icon.svg)"
check "missing asset is a real 404"  "404" "$(status_of /code/frontend/does-not-exist.js)"

# --- Security / cache headers ----------------------------------------------
check "CSP present on /"             "yes" "$([[ -n "$(header_of / Content-Security-Policy)" ]] && echo yes || echo no)"
check "nosniff present on /"         "yes" "$([[ "$(header_of / X-Content-Type-Options)" == "nosniff" ]] && echo yes || echo no)"
check "Cache-Control no-store on /"  "yes" "$([[ "$(header_of / Cache-Control)" == *no-store* ]] && echo yes || echo no)"
check "Cache-Control no-cache on js" "yes" "$([[ "$(header_of /code/frontend/main.js Cache-Control)" == *no-cache* ]] && echo yes || echo no)"
check "server_tokens off"            "yes" "$([[ -z "$(header_of / Server | grep -o '[0-9]' || true)" ]] && echo yes || echo no)"

# --- Unpublished surfaces --------------------------------------------------
check "research API source not served"  "404" "$(status_of /code/backend/dev-server.js)"
check "telemetry schema not served"     "404" "$(status_of /code/backend/schema.sql)"
check "tests not served"                "404" "$(status_of /tests/domain.test.js)"
check "no directory listing"            "no-list" "$(s=$(status_of /code/frontend/); [[ "$s" == "403" || "$s" == "404" ]] && echo no-list || echo "$s")"
check "dotfiles denied"                 "no-list" "$(s=$(status_of /../meta); [[ "$s" == "400" || "$s" == "403" || "$s" == "404" ]] && echo no-list || echo "$s")"

# --- Served content matches the release on disk ----------------------------
CURRENT="$SF_DEPLOY_ROOT/current"
if [[ -L "$CURRENT" ]]; then
  LOCAL_HASH="$(sha256sum "$(readlink -f "$CURRENT")/index.html" | cut -d' ' -f1)"
  SERVED_HASH="$(curl -sS --max-time 10 "$SF_URL/" | sha256sum | cut -d' ' -f1)"
  check "served index.html matches release on disk" "$LOCAL_HASH" "$SERVED_HASH"
  echo "  info current -> $(readlink -f "$CURRENT")"
else
  echo "  FAIL $CURRENT is not a symlink"; FAILURES=$((FAILURES+1))
fi

if [[ "$FAILURES" -eq 0 ]]; then echo "All health checks passed."; exit 0
else echo "$FAILURES health check(s) failed."; exit 1; fi
