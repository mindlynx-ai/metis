#!/usr/bin/env bash
# cloud-init for the Metis demo box: install Docker + the compose plugin so the
# stack can be brought up with `docker compose`. Runs once at first boot.
set -euxo pipefail

dnf update -y
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user

# The compose v2 plugin (not in the AL2023 repos): drop the official binary in,
# matching the box's architecture (x86_64 or aarch64).
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL \
  "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

mkdir -p /home/ec2-user/metis
chown -R ec2-user:ec2-user /home/ec2-user/metis
