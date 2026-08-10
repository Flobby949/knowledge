#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <api-image> <web-image>" >&2
  exit 2
fi

api_image=$1
web_image=$2

validate_image() {
  local image=$1

  if [[ ! "$image" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "Invalid container image reference: $image" >&2
    exit 2
  fi
}

validate_image "$api_image"
validate_image "$web_image"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required on the deployment host" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required on the deployment host" >&2
  exit 1
fi

deploy_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
compose_file="$deploy_dir/compose.yaml"
override_file="$deploy_dir/compose.production.yaml"
backup_dir="$deploy_dir/backups"

if [[ ! -f "$compose_file" ]]; then
  echo "Missing Compose file: $compose_file" >&2
  exit 1
fi

cd "$deploy_dir"

base_compose=(
  docker compose
  --project-directory "$deploy_dir"
  -f "$compose_file"
)
release_compose=(
  docker compose
  --project-directory "$deploy_dir"
  -f "$compose_file"
  -f "$override_file"
)

write_override() {
  local target_api_image=$1
  local target_web_image=$2
  local temporary_file

  temporary_file=$(mktemp "$deploy_dir/.compose.production.yaml.XXXXXX")
  printf 'services:\n  api:\n    image: "%s"\n  web:\n    image: "%s"\n' \
    "$target_api_image" \
    "$target_web_image" > "$temporary_file"
  mv "$temporary_file" "$override_file"
}

wait_for_postgres() {
  local attempt
  local container_id

  for ((attempt = 1; attempt <= 60; attempt++)); do
    container_id=$("${base_compose[@]}" ps --all -q postgres)
    if [[ -n "$container_id" ]] && \
      docker exec "$container_id" sh -c \
        'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "PostgreSQL did not become ready" >&2
  "${base_compose[@]}" logs --tail=100 postgres >&2 || true
  return 1
}

wait_for_api() {
  local attempt
  local container_id
  local status

  for ((attempt = 1; attempt <= 60; attempt++)); do
    container_id=$("${base_compose[@]}" ps --all -q api)
    if [[ -n "$container_id" ]]; then
      status=$(docker inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$container_id" 2>/dev/null || true)
      if [[ "$status" == "healthy" ]]; then
        return 0
      fi
      if [[ "$status" == "unhealthy" || "$status" == "dead" || "$status" == "exited" ]]; then
        return 1
      fi
    fi
    sleep 2
  done

  return 1
}

wait_for_web() {
  local attempt
  local container_id
  local status

  for ((attempt = 1; attempt <= 30; attempt++)); do
    container_id=$("${base_compose[@]}" ps --all -q web)
    if [[ -n "$container_id" ]]; then
      status=$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)
      if [[ "$status" == "running" ]] && \
        docker exec "$container_id" wget -q --spider http://127.0.0.1/; then
        return 0
      fi
      if [[ "$status" == "dead" || "$status" == "exited" ]]; then
        return 1
      fi
    fi
    sleep 2
  done

  return 1
}

container_image_id() {
  local service=$1
  local container_id

  container_id=$("${base_compose[@]}" ps --all -q "$service")
  if [[ -z "$container_id" ]]; then
    return 1
  fi

  docker inspect --format '{{.Image}}' "$container_id"
}

create_database_backup() {
  local backup_path=$1
  local temporary_path="${backup_path}.partial"

  if "${base_compose[@]}" exec -T postgres sh -ceu \
    'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
    > "$temporary_path"; then
    mv "$temporary_path" "$backup_path"
    return 0
  fi

  rm -f "$temporary_path"
  return 1
}

deploy_release() {
  "${release_compose[@]}" up -d --no-deps --no-build --force-recreate api || return 1
  wait_for_api || return 1
  "${release_compose[@]}" up -d --no-deps --no-build --force-recreate web || return 1
  wait_for_web || return 1
}

rollback_release() {
  if [[ "$rollback_ready" != "true" ]]; then
    echo "No complete previous release is available; stopping the failed application" >&2
    "${release_compose[@]}" stop api web || true
    return 1
  fi

  echo "Rolling back application images" >&2
  write_override "knowledge-api:deployment-rollback" "knowledge-web:deployment-rollback" || return 1

  "${release_compose[@]}" up -d --no-deps --no-build --force-recreate api || return 1
  wait_for_api || return 1
  "${release_compose[@]}" up -d --no-deps --no-build --force-recreate web || return 1
  wait_for_web
}

echo "Starting PostgreSQL"
"${base_compose[@]}" up -d postgres
wait_for_postgres

echo "Pulling application images"
API_IMAGE="$api_image" WEB_IMAGE="$web_image" \
  "${base_compose[@]}" pull api web

old_api_image_id=$(container_image_id api || true)
old_web_image_id=$(container_image_id web || true)
rollback_ready=false

if [[ -n "$old_api_image_id" && -n "$old_web_image_id" ]]; then
  docker image tag "$old_api_image_id" knowledge-api:deployment-rollback
  docker image tag "$old_web_image_id" knowledge-web:deployment-rollback
  rollback_ready=true
fi

mkdir -p "$backup_dir"
backup_path="$backup_dir/knowledge-$(date -u +'%Y%m%dT%H%M%SZ').dump"
echo "Backing up PostgreSQL to $backup_path"
create_database_backup "$backup_path"

write_override "$api_image" "$web_image"

echo "Deploying API, running migrations, and waiting for health"
if ! deploy_release; then
  echo "Deployment failed; recent application logs follow" >&2
  "${release_compose[@]}" logs --tail=100 api web >&2 || true
  if ! rollback_release; then
    echo "Automatic application rollback also failed" >&2
  fi
  echo "Database backup retained at $backup_path" >&2
  exit 1
fi

"${release_compose[@]}" ps
echo "Deployment completed"
echo "Database backup retained at $backup_path"
