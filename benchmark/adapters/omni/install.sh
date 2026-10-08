#!/bin/bash
set -euo pipefail
# This adapter currently supports Debian/Ubuntu amd64 task images.
test "$(uname -m)" = x86_64
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils git python3 make g++ pkg-config libsecret-1-dev dbus gnome-keyring ripgrep util-linux coreutils procps
mkdir /opt/omni-node /opt/omni
curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz -o /installed-agent/node.tar.xz
printf '%s\n' 'c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2  /installed-agent/node.tar.xz' | sha256sum --check -
tar -xJf /installed-agent/node.tar.xz --strip-components=1 -C /opt/omni-node
tar -xf /installed-agent/omni-source.tar -C /opt/omni
# Installation PATH is scoped to this subshell. Task tools retain the original PATH.
(
  export PATH="/opt/omni-node/bin:$PATH"
  npm install --global pnpm@11.5.1
  cd /opt/omni
  HUSKY=0 pnpm install --frozen-lockfile
)
chmod -R go-w /opt/omni /opt/omni-node
rm /installed-agent/node.tar.xz /installed-agent/omni-source.tar
