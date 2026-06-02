# Dockerfile multi-stage para Railway / Render.
#
# Image base: node:20 sobre Debian con Chromium y FFmpeg preinstalados
# por Puppeteer. Esto garantiza compatibilidad de la build con la
# versión de Chromium que controla Puppeteer.

FROM node:20-bookworm-slim AS base

# Dependencias del sistema: Chromium runtime + FFmpeg + fonts (para que
# los textos del overlay renderen igual que en local). MapLibre canvas
# necesita libgl + libxshmfence + libcairo.
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
    chromium \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Permite que Puppeteer use Chromium del sistema en lugar de descargar
# su propia copia (más ligero, menos riesgo de versiones mismatched).
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Build dependencies stage — instala todo y compila TS.
FROM base AS build
COPY package.json ./
COPY tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
COPY public ./public
RUN npm run build

# Runtime stage — solo lo necesario para correr.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
RUN npm install --omit=dev --no-audit --no-fund

CMD ["node", "dist/index.js"]
