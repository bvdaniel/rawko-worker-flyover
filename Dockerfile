# rawko-worker-flyover — worker de videos 3D (v0.3: Chrome + MapLibre GL JS)
#
# Chrome headless corre sin GPU vía SwiftShader (WebGL por software), por
# eso el flag `--enable-unsafe-swiftshader` en src/render.ts. Espera
# renders ~3-5x más lentos que en una Mac con Metal (~5-10 min vs 2 min).

FROM node:22-bookworm-slim

# ── System deps: Chrome headless + ffmpeg + libGL (WebGL fallback) ──
# La lista de libs de Chrome sale de la doc oficial de Puppeteer para Debian.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libgl1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    unzip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Dependencias Node (usa package-lock para builds reproducibles) ──
COPY package.json package-lock.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=1 npm ci

# ── Chrome para Puppeteer (~150 MB, cache de Puppeteer) ──
# Se instala acá (y no en runtime) para que Railway cachee la capa y el
# cold start no tenga que bajar Chrome cada deploy.
RUN npx puppeteer browsers install chrome

# ── Código ──
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# ── Build TypeScript ──
RUN npm run build

# ── Run: loop que pollea la cola ──
CMD ["node", "dist/index.js"]
