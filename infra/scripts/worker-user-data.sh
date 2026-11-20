#!/usr/bin/env bash
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git nginx certbot python3-certbot-nginx

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker nginx
usermod -aG docker ubuntu

mkdir -p /server
chown ubuntu:ubuntu /server

sudo -u ubuntu bash <<'KEY'
set -euo pipefail
mkdir -p ~/.ssh && chmod 700 ~/.ssh
[ -f ~/.ssh/praxis_deploy ] || ssh-keygen -t ed25519 -N "" -C "zavi-worker-deploy" -f ~/.ssh/praxis_deploy
cat > ~/.ssh/config <<'CFG'
Host github.com-praxis
  HostName github.com
  User git
  IdentityFile ~/.ssh/praxis_deploy
  IdentitiesOnly yes
CFG
chmod 600 ~/.ssh/config
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
KEY

{
  echo "=== ZAVI-WORKER-DEPLOY-KEY (add on GitHub as a READ-ONLY deploy key) ==="
  cat /home/ubuntu/.ssh/praxis_deploy.pub
  echo "=== ZAVI-WORKER-HOST-KEYS (full public keys for WORKER_EC2_KNOWN_HOSTS) ==="
  cat /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub
  echo "=== ZAVI-WORKER-END ==="
} > /dev/console
