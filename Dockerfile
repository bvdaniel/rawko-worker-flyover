# Dockerfile para Railway.
#
# Usamos @sparticuz/chromium — un Chromium pre-compilado optimizado
# para entornos serverless con SwiftShader funcional. Lo usan Vercel,
# AWS Lambda y workloads similares.
#
# Las libs runtime de Chromium ya las trae el package, pero seguimos
# necesitando FFmpeg, fonts y un par de libs del sistema.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-liberation \
    fonts-noto \
    fonts-noto-color-emoji \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# IMPORTANTE: instalar deps con NODE_ENV unset (sino npm omite
# devDependencies como typescript y npm run build falla con
# "tsc: not found"). Recién después del build seteamos NODE_ENV=production
# para el runtime.
COPY package.json ./
COPY tsconfig.json ./
RUN npm install --no-audit --no-fund

COPY src ./src
COPY public ./public
RUN npm run build

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
