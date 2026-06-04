#!/usr/bin/env bash
# Setup del worker rawko-worker-flyover (v0.2 — maplibre-native + sharp + ffmpeg)
# en Ubuntu 24.04. Mucho más simple que la versión Chrome: no necesita
# Xvfb, X11, Mesa, ni libs de browser. Solo Node, libGL para maplibre,
# libvips para sharp y ffmpeg.
#
# Uso (como root):
#   curl -fsSL https://raw.githubusercontent.com/bvdaniel/rawko-worker-flyover/main/setup.sh | sudo bash
#
# Idempotente. Reinicia el servicio al final.

set -euo pipefail

REPO_URL="https://github.com/bvdaniel/rawko-worker-flyover.git"
INSTALL_DIR="/opt/rawko-worker-flyover"
SERVICE_USER="flyover"
SERVICE_NAME="rawko-flyover"
NODE_MAJOR=22

log() { printf "\n\033[1;32m[setup]\033[0m %s\n" "$*"; }
fail() { printf "\n\033[1;31m[setup:error]\033[0m %s\n" "$*"; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  fail "este script tiene que correr como root (usa sudo)"
fi

log "1/6 system deps (ffmpeg + libGL para maplibre + libvips para sharp)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg git build-essential \
  ffmpeg \
  libgl1 libegl1 libgles2 \
  libuv1 libcurl4 \
  libpng16-16t64 libjpeg-turbo8 libwebp7 libtiff6 libgif7 \
  libstdc++6 zlib1g

log "2/6 Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | grep -oE '[0-9]+' | head -1)" != "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
log "   node $(node -v) — npm $(npm -v)"

log "3/6 user '${SERVICE_USER}'"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

log "4/6 clone/pull repo en ${INSTALL_DIR}"
if [ -d "${INSTALL_DIR}/.git" ]; then
  git -C "${INSTALL_DIR}" fetch origin main
  git -C "${INSTALL_DIR}" reset --hard origin/main
else
  git clone "${REPO_URL}" "${INSTALL_DIR}"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

log "5/6 npm install + build"
sudo -u "${SERVICE_USER}" -H bash -c "cd '${INSTALL_DIR}' && npm install --no-audit --no-fund"
sudo -u "${SERVICE_USER}" -H bash -c "cd '${INSTALL_DIR}' && npm run build"

if [ ! -f "${INSTALL_DIR}/.env" ]; then
  cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/.env"
  chmod 600 "${INSTALL_DIR}/.env"
  printf "\n\033[1;33m[setup]\033[0m editá %s y completá SUPABASE_SERVICE_ROLE_KEY + MAPTILER_KEY\n" "${INSTALL_DIR}/.env"
fi

log "6/6 systemd service"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Rawko Flyover worker (maplibre-native + sharp + ffmpeg)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=/usr/bin/node ${INSTALL_DIR}/dist/index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}.service

if [ -f "${INSTALL_DIR}/.env" ] && grep -q "SUPABASE_SERVICE_ROLE_KEY=." "${INSTALL_DIR}/.env"; then
  log "arrancando ${SERVICE_NAME}.service"
  systemctl restart ${SERVICE_NAME}.service
  sleep 2
  systemctl status ${SERVICE_NAME}.service --no-pager | head -10 || true
else
  printf "\n\033[1;33m[setup]\033[0m servicio no arrancado todavía — completá %s y después: systemctl restart %s\n" \
    "${INSTALL_DIR}/.env" "${SERVICE_NAME}"
fi

log "listo. Logs: journalctl -u ${SERVICE_NAME} -f"
