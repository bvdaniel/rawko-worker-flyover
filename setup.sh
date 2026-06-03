#!/usr/bin/env bash
# Setup idempotente del worker rawko-worker-flyover en Ubuntu 24.04
# (DigitalOcean droplet). Instala Node 22, deps de Chromium + Mesa
# software WebGL, ffmpeg, Xvfb, clona el repo, hace build y deja un
# systemd service corriendo.
#
# Uso (como root o con sudo):
#   curl -fsSL https://raw.githubusercontent.com/bvdaniel/rawko-worker-flyover/main/setup.sh | bash
#
# o, manualmente:
#   wget https://raw.githubusercontent.com/bvdaniel/rawko-worker-flyover/main/setup.sh
#   chmod +x setup.sh
#   sudo ./setup.sh
#
# Una vez instalado:
#   1) editar /opt/rawko-worker-flyover/.env con las keys reales
#   2) systemctl restart rawko-flyover
#   3) journalctl -u rawko-flyover -f para ver los logs

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

log "1/8 actualizando apt + instalando deps del sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg git build-essential \
  ffmpeg \
  xvfb \
  fonts-liberation fonts-noto fonts-noto-color-emoji \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libasound2t64 \
  libxshmfence1 libx11-xcb1 \
  libgl1-mesa-dri libegl1 libgles2 libosmesa6 mesa-utils \
  libnspr4 libxss1 libdbus-1-3 libglib2.0-0 libexpat1 libuuid1 \
  libxext6 libxi6 libxtst6 libxrender1 libfontconfig1

log "2/8 instalando Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | grep -oE '[0-9]+' | head -1)" != "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
log "   node $(node -v) — npm $(npm -v)"

log "3/8 creando usuario de servicio '${SERVICE_USER}'"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

log "4/8 clonando / actualizando repo en ${INSTALL_DIR}"
if [ -d "${INSTALL_DIR}/.git" ]; then
  git -C "${INSTALL_DIR}" fetch origin main
  git -C "${INSTALL_DIR}" reset --hard origin/main
else
  git clone "${REPO_URL}" "${INSTALL_DIR}"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

log "5/8 instalando deps npm (incluye chromium descargado por puppeteer)"
sudo -u "${SERVICE_USER}" -H bash -c "cd '${INSTALL_DIR}' && npm install --no-audit --no-fund"

log "6/8 compilando TypeScript"
sudo -u "${SERVICE_USER}" -H bash -c "cd '${INSTALL_DIR}' && npm run build"

log "7/8 escribiendo .env si no existe"
if [ ! -f "${INSTALL_DIR}/.env" ]; then
  cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/.env"
  chmod 600 "${INSTALL_DIR}/.env"
  printf "\n\033[1;33m[setup]\033[0m editá %s y completá SUPABASE_SERVICE_ROLE_KEY + MAPTILER_KEY\n" "${INSTALL_DIR}/.env"
fi

log "8/8 instalando systemd service"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Rawko Flyover worker (MapLibre 3D + Puppeteer + FFmpeg)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
# Limpiar locks de Xvfb huérfanos del run anterior antes de arrancar.
# Sin esto, si Chromium crashea y deja /tmp/.X99-lock, el siguiente
# xvfb-run intenta usar el mismo display, conflicto, y Chromium se
# queja con "Missing X server or $DISPLAY".
ExecStartPre=/bin/sh -c 'rm -f /tmp/.X*-lock 2>/dev/null; rm -rf /tmp/.X11-unix/X* 2>/dev/null; rm -rf /tmp/xvfb-run.* 2>/dev/null; true'
# xvfb-run -a (--auto-servernum) busca un display libre dinámicamente
# en cada arranque, evitando colisiones con state stale en /tmp.
ExecStart=/usr/bin/xvfb-run -a --server-args="-screen 0 1080x1920x24 -ac +extension GLX +render -noreset" /usr/bin/node ${INSTALL_DIR}/dist/index.js
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
  systemctl status ${SERVICE_NAME}.service --no-pager || true
else
  printf "\n\033[1;33m[setup]\033[0m servicio NO arrancado todavía — completá %s y luego: systemctl restart %s\n" \
    "${INSTALL_DIR}/.env" "${SERVICE_NAME}"
fi

log "listo. Logs: journalctl -u ${SERVICE_NAME} -f"
