#!/usr/bin/env bash
# Service control for the Start-First static site.
#
# Usage: deploy/serve.sh {start|stop|restart|reload|status|logs|container-config}
#
# The site is a static artifact served by nginx in a Docker container bound to
# 127.0.0.1 only. There is no application server process and no database.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

case "${1:-status}" in
  start)
    docker inspect "$SF_CONTAINER" >/dev/null 2>&1 || sf_die "container does not exist; run deploy/deploy.sh first"
    docker start "$SF_CONTAINER" >/dev/null && sf_log "started ${SF_CONTAINER}"
    "${SF_REPO_ROOT}/deploy/healthcheck.sh"
    ;;
  stop)
    docker stop "$SF_CONTAINER" >/dev/null && sf_log "stopped ${SF_CONTAINER}"
    sf_log 'note: current, releases/ and logs/ are untouched; start restores the same release'
    ;;
  restart)
    docker restart "$SF_CONTAINER" >/dev/null && sf_log "restarted ${SF_CONTAINER}"
    "${SF_REPO_ROOT}/deploy/healthcheck.sh"
    ;;
  reload)
    docker exec "$SF_CONTAINER" nginx -t
    docker exec "$SF_CONTAINER" nginx -s reload && sf_log "nginx reloaded (no downtime, no container restart)"
    ;;
  status)
    docker ps -a --filter "name=^/${SF_CONTAINER}$" --format 'name={{.Names}} status={{.Status}} image={{.Image}} ports={{.Ports}}'
    echo "url:     ${SF_URL}"
    echo "current: $(readlink -f "${SF_DEPLOY_ROOT}/current" 2>/dev/null || echo '<none>')"
    echo "releases: $(ls -1 "${SF_DEPLOY_ROOT}/releases" 2>/dev/null | wc -l)"
    ;;
  logs)
    shift
    docker logs --tail "${1:-100}" "${SF_CONTAINER}"
    ;;
  container-config)
    docker inspect -f '{{json .HostConfig.Binds}}' "$SF_CONTAINER" | tr ',' '\n' | sed 's/^/  /'
    ;;
  *)
    sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
