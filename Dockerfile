# Dockerfile para Railway.
#
# Single-stage: usamos el Chromium que Puppeteer descarga
# automáticamente (viene con SwiftShader correctamente configurado para
# WebGL en containers sin GPU). El chromium de Debian (apt) tiene
# SwiftShader desactivado y MapLibre falla con
# "Could not create a WebGL context".

FROM node:22-bookworm-slim

# Runtime deps de Chromium + FFmpeg + fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-liberation \
    fonts-noto \
    fonts-noto-color-emoji \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libasound2 \
    libgl1 \
    libegl1 \
    libgles2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

# El install de puppeteer (no puppeteer-core) descarga Chromium con
# SwiftShader al cache, /root/.cache/puppeteer.
COPY package.json ./
COPY tsconfig.json ./
RUN npm install --no-audit --no-fund

COPY src ./src
COPY public ./public
RUN npm run build

CMD ["node", "dist/index.js"]
