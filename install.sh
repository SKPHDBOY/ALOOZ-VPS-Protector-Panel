#!/usr/bin/env bash
set -e
if [ "$EUID" -ne 0 ]; then echo "Run with sudo"; exit 1; fi
apt-get update
apt-get install -y ca-certificates curl nodejs npm docker.io
systemctl enable --now docker
mkdir -p /opt/alooz-panel
cp -r . /opt/alooz-panel/
cd /opt/alooz-panel
[ -f .env ] || cp .env.example .env
npm install --omit=dev
echo
echo "ALOOZ Hosting Panel installed."
echo "Edit /opt/alooz-panel/.env and set a strong ADMIN_PASSWORD and SESSION_SECRET."
echo "Start: cd /opt/alooz-panel && npm start"
