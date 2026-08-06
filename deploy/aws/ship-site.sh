#!/usr/bin/env bash
# Publish the marketing site to the box that already serves the apex domain.
#
# Build metisflow-website first, then run this. It touches nothing but the
# static files: the app, Temporal and the databases keep running.
#
# The one trap, learned the hard way: ~/metis/site is BIND-MOUNTED into the
# Caddy container. Replacing the directory (rm -rf site && mv new site) leaves
# the container mounted on a deleted inode and every request 404s until Caddy
# is recreated. So the contents are synced INTO the existing directory and the
# directory itself is never swapped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/.state"

SITE="${1:-$HERE/../../../metisflow-website/dist}"
test -d "$SITE" || { echo "no built site at $SITE -- run 'npm run build' in metisflow-website"; exit 1; }
test -f "$SITE/index.html" || { echo "$SITE has no index.html; is that a build output?"; exit 1; }

SSHC=(ssh -o StrictHostKeyChecking=accept-new -i "$PEM" "ec2-user@$EIP")

echo "staging the build..."
"${SSHC[@]}" 'rm -rf ~/metis/.site-staging && mkdir -p ~/metis/.site-staging ~/metis/site'
scp -q -o StrictHostKeyChecking=accept-new -i "$PEM" -r "$SITE/." "ec2-user@$EIP:~/metis/.site-staging/"

# Swap the CONTENTS, not the directory. rsync --delete would be tidier but is
# not installed on the box's base image, and this is two commands.
echo "publishing..."
"${SSHC[@]}" 'cd ~/metis && find site -mindepth 1 -delete && cp -a .site-staging/. site/ && rm -rf .site-staging'

echo "checking what the world sees..."
code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 https://metisflow.io/ || true)"
echo "  https://metisflow.io/ -> $code"
[ "$code" = "200" ] || { echo "FAILED: apex is not serving. 'docker compose ... up -d --force-recreate caddy' on the box re-resolves a broken mount."; exit 1; }
echo "done."
