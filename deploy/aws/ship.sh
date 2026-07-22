#!/usr/bin/env bash
#
# Ship the locally-built Metis image and the compose files to the box from
# provision.sh, then bring the stack up behind Caddy. Re-runnable: it just
# re-loads the image and `up`s again, so it doubles as the redeploy step.
#
# Prereqs: ./.state (from provision.sh) and ./.env (copy .env.example, fill in
# METIS_ADMIN_SECRET / METIS_DEMO_* / METIS_DEMO_HOST).
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck disable=SC1091
source "$HERE/.state"
IMAGE="${IMAGE:-metis-metis:latest}"
SSHC=(ssh -o StrictHostKeyChecking=accept-new -i "$PEM" "ec2-user@$EIP")

test -f "$HERE/.env" || { echo "create $HERE/.env (see compose/.env.example)"; exit 1; }

echo "waiting for docker on the box (cloud-init)..."
until "${SSHC[@]}" 'command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1'; do sleep 5; done

echo "copying compose files + env..."
"${SSHC[@]}" 'mkdir -p ~/metis'
scp -o StrictHostKeyChecking=accept-new -i "$PEM" \
  "$REPO/compose/docker-compose.yml" "$REPO/compose/docker-compose.prod.yml" \
  "$REPO/compose/Caddyfile" "$HERE/.env" \
  "ec2-user@$EIP:~/metis/"

echo "shipping the image (~400MB gzipped, one-off)..."
docker save "$IMAGE" | gzip | "${SSHC[@]}" 'gunzip | docker load'
"${SSHC[@]}" "docker tag $IMAGE metis-metis:latest || true"

echo "bringing the stack up..."
"${SSHC[@]}" 'cd ~/metis && docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env up -d'
echo "up -> https://metis.${EIP//./-}.sslip.io"
