#!/usr/bin/env bash
# Deploys the published images of the stack and goes back to the previous ones when a service does not become healthy.
#
#   deploy/deploy.sh                 # the newest images (the `latest` tag), every service
#   deploy/deploy.sh sha-1a2b3c4     # a given tag: also how you roll back by hand
#   deploy/deploy.sh latest everythingapp-web       # only some services
#
# Run it as a user that may use Docker. The compose file and .env are read from the repository root. The sandbox image
# (the one code sandboxes run in) is pulled too and tagged as SANDBOX_IMAGE, so the supervisor finds it by its old name.
# Each deployment prints what it replaced. Data lives in volumes and is never touched.
set -euo pipefail

cd "$(dirname "$0")/.."

tag="${1:-latest}"
shift || true
if (($# > 0)); then
  services=("$@")
else
  services=(sandbox-supervisor sandbox-mcp playwright-mcp git-proxy everythingapp-web)
fi
wait_seconds="${DEPLOY_WAIT_SECONDS:-120}"
registry="ghcr.io/prod-explore"

export EVERYTHINGAPP_IMAGE_TAG="$tag"

# Every service has a fixed container name (everythingapp-<service>); the web service is already called that.
container_of() { echo "everythingapp-${1#everythingapp-}"; }

healthy() {
  local container="$1" deadline=$((SECONDS + wait_seconds)) state
  while ((SECONDS < deadline)); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    case "$state" in
      healthy) return 0 ;;
      unhealthy | exited | dead) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

# What runs now, so it can be restored: "service image-id".
declare -A previous=()
for service in "${services[@]}"; do
  container="$(container_of "$service")"
  docker inspect "$container" >/dev/null 2>&1 || continue
  previous["$service"]="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
  echo "${service} now runs $(docker inspect --format '{{.Config.Image}}' "$container") (${previous[$service]#sha256:})"
done

echo "Pulling ${tag}"
docker compose pull "${services[@]}"
sandbox_image="$(grep -E '^SANDBOX_IMAGE=' .env 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
sandbox_image="${sandbox_image:-everything-sandbox:latest}"
if docker pull "${registry}/everythingapp-sandbox:${tag}"; then
  docker tag "${registry}/everythingapp-sandbox:${tag}" "$sandbox_image"
else
  echo "The sandbox image ${tag} could not be pulled; keeping ${sandbox_image} as it is" >&2
fi

echo "Starting"
docker compose up -d --no-deps "${services[@]}"

failed=()
for service in "${services[@]}"; do
  container="$(container_of "$service")"
  if healthy "$container"; then
    echo "${service} is healthy"
  else
    echo "${service} did not become healthy within ${wait_seconds}s" >&2
    docker logs --tail 20 "$container" >&2 || true
    failed+=("$service")
  fi
done

((${#failed[@]} == 0)) && exit 0

# Go back, service by service, to the image each one ran before.
for service in "${failed[@]}"; do
  id="${previous[$service]:-}"
  [[ -n "$id" ]] || { echo "No previous image of ${service} to go back to" >&2; continue; }
  image="${registry}/everythingapp-${service#everythingapp-}"
  echo "Going back to the previous image of ${service} (${id#sha256:})" >&2
  docker tag "$id" "${image}:rollback"
  EVERYTHINGAPP_IMAGE_TAG=rollback docker compose up -d --no-deps "$service"
  if healthy "$(container_of "$service")"; then echo "Rolled back; ${service} is healthy again" >&2; else echo "The rollback of ${service} is not healthy either" >&2; fi
done
exit 1
