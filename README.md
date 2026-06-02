# rawko-worker-flyover

Worker async que renderiza videos 3D cinemáticos de rutas de Rawko al estilo
Strava 3D Replay, pero con foco editorial y formato vertical 1080×1920 listo
para Reels, TikTok y Stories.

## Stack

- **MapLibre GL JS** con tiles **MapTiler outdoor-v2** + **terrain RGB** para 3D real.
- **Puppeteer** controlando Chromium headless.
- **CDP `Page.startScreencast`** para capturar frames JPEG a 30 fps.
- **FFmpeg** (vía `fluent-ffmpeg`) para encodear H.264.
- **Supabase JS** con service role key para reclamar jobs y subir el MP4 al
  bucket `flyovers`.

## Layout

```
src/
├── index.ts        ← main loop: claim → render → upload → mark done
├── cli.ts          ← render local sin tocar la queue (debug)
├── queue.ts        ← claim/load/done/failed contra Supabase
├── render.ts       ← Puppeteer + screencast + FFmpeg
├── upload.ts       ← sube MP4 a bucket flyovers
├── supabase.ts     ← cliente service role
└── types.ts        ← shape compartido con la animación

public/
├── flyover.html    ← estructura DOM + overlays (título, stats, waypoints, outro)
└── animation.js    ← coreografía MapLibre (intro fly-in + recorrido + outro)
```

## Variables de entorno

Ver `.env.example`. Requeridas:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MAPTILER_KEY`

## Dev local

```bash
npm install
cp .env.example .env.local
# llenar las keys
npm run dev                              # arranca el loop (poll de la cola)
npm run test:single -- <experience_id>   # renderiza una sola sin tocar cola
```

## Deploy en Railway

1. Crear cuenta en railway.app y conectar el repo de GitHub.
2. New Project → Deploy from GitHub repo → seleccionar `rawko-worker-flyover`.
3. Railway detecta el `Dockerfile` automáticamente.
4. Settings → Variables → agregar:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (mismo valor que en `.env.local` de rawko web)
   - `MAPTILER_KEY`
   - `WEB_URL=https://rawko.io`
5. Deploy. Railway hostea el worker como un proceso de larga duración (no
   web server, no health checks HTTP — es un loop).

Plan Hobby de Railway: USD 5/mes con 500h de cómputo. Cada render toma 30-90s,
así que el worker está idle el 99% del tiempo y consume crédito mínimo.

## Coreografía

Total 30s a 30fps = 900 frames.

| Frames    | Tiempo  | Acción                                                                |
| --------- | ------- | --------------------------------------------------------------------- |
| 0-90      | 0-3s    | Intro fly-in: cámara baja desde lejos al centro de la ruta + título   |
| 90-690    | 3-23s   | Recorrido: polyline progresiva, cámara tercera persona, stats + waypoints |
| 690-900   | 23-30s  | Outro: zoom out + stats finales en grande + branding Rawko            |

## Notas técnicas

- **Por qué CDP screencast y no `page.screenshot()` en loop**: screenshot a
  30 Hz satura el thread y pierde frames cuando el render del frame anterior
  no termina. Screencast hace push asíncrono y el browser respeta la frecuencia.
- **Por qué JPEG y no PNG**: PNG de 1080×1920 es ~5 MB; con 900 frames serían
  4.5 GB en disco temporal. JPEG calidad 92 baja a ~150 KB → 135 MB total.
  Diferencia visual nula en H.264 al codear.
- **Por qué silent audio en el MP4**: Instagram y TikTok detectan "video sin
  audio" y le meten ruido de procesado o piden re-encode. Audio silente AAC
  evita ese flow.
- **Por qué `jumpTo` y no `easeTo`/`flyTo` de MapLibre**: las animaciones
  internas de MapLibre son time-based con clock real; rompen el determinismo
  cuando un frame se demora. Calculamos la cámara nosotros frame por frame
  con easing functions explícitas.
