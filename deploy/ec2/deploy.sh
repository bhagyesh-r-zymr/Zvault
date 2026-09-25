#!/usr/bin/env bash
# Runs on the EC2 host as the forced command of the GitHub Actions deploy key
# (see .github/workflows/deploy-demo.yml). Reads a .tar.gz on stdin holding
# api-image.tar, share/ and the files in this folder, then updates the stack.
set -euo pipefail
: "${HOST:?set HOST in the authorized_keys command}"
cd "$(dirname "$0")"

# Not /tmp: it is a small tmpfs on this box.
work=$(mktemp -d -p .)
trap 'rm -rf "$work"' EXIT
tar -xz -C "$work"

# install writes a new file, so replacing this script while it runs is safe.
install -m 755 "$work"/setup.sh "$work"/deploy.sh .
install -m 644 "$work"/compose.yml "$work"/nginx-zvault.conf .

old=$(docker image inspect -f '{{.Id}}' zvault-api:demo 2>/dev/null || true)
docker load -i "$work/api-image.tar"
sudo mkdir -p /usr/share/nginx/zvault-share
sudo rsync -a --delete "$work/share/" /usr/share/nginx/zvault-share/

# Idempotent: refreshes nginx, then `docker compose up -d`, which re-runs the migrate service.
HOST=$HOST ./setup.sh
# Drop only the image this deploy replaced; other apps share this Docker.
new=$(docker image inspect -f '{{.Id}}' zvault-api:demo)
[ -n "$old" ] && [ "$old" != "$new" ] && docker rmi "$old" >/dev/null || true

for _ in $(seq 30); do
  curl -fsS http://127.0.0.1:3000/v1/health && exit 0
  sleep 2
done
echo 'API did not become healthy' >&2
docker compose logs --tail 50 migrate api >&2
exit 1
