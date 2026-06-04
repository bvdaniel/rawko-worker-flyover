// Render del flyover usando @maplibre/maplibre-gl-native. Sin Chrome,
// sin Xvfb. Renderea cada frame con MapLibre nativo (OpenGL), composita
// los overlays editoriales con sharp y encodea el MP4 con ffmpeg.
//
// Tiempo esperado: ~6 min para 600 frames (intro + route + outro = 20s
// de video) en una CPU moderna. Mucho más rápido que el approach
// Chrome + software WebGL anterior.

import mbgl from '@maplibre/maplibre-gl-native'
import sharp from 'sharp'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  svgTitle,
  svgStats,
  svgWaypoint,
  svgOutro,
  WAYPOINT_PHOTO_RECT,
  fmtDateEs,
  fmtDurationEs,
  kindLabelEs,
  kindTier,
} from './overlays.js'
import type { RouteData, RenderResult, WaypointData } from './types.js'

// ====== Config ======
const VIDEO_WIDTH = 1080
const VIDEO_HEIGHT = 1920
const FPS = 30

// 600 frames @ 30fps = 20s. Fases: intro 2s, route 15s, outro 3s.
const TOTAL_FRAMES = 600
const INTRO_END = 60
const ROUTE_END = 510
const OUTRO_END = TOTAL_FRAMES

// Cámara cursor-follow. Tuneado para zoom 14.5: lookahead más grande
// (40 puntos = mira el promedio de la dirección hacia adelante), EMA
// más lento (0.04), cap más estricto (1.5°/frame) para que pequeños
// zigzags no shakeen la cámara.
const BEARING_LOOKAHEAD = 40
const BEARING_EMA_ALPHA = 0.04
const BEARING_MAX_DELTA_PER_FRAME = 1.5

// Waypoints
const MAX_WAYPOINTS = 6
// 75 frames = 2.5s. Con 6 waypoints * 75 = 450 frames = exactamente
// el route phase. Permite que las 6 cards se vean SIN tanto solapamiento.
const WAYPOINT_CARD_FRAMES = 75
const WAYPOINT_MIN_DIST_KM = 0.8

const MAPTILER_KEY = process.env.MAPTILER_KEY
const STYLE_URL = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`
  : 'https://tiles.openfreemap.org/styles/liberty'

// ====== Utils geo ======
function deg2rad(d: number): number {
  return (d * Math.PI) / 180
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371
  const dLat = deg2rad(b[1] - a[1])
  const dLon = deg2rad(b[0] - a[0])
  const lat1 = deg2rad(a[1])
  const lat2 = deg2rad(b[1])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function buildCumulative(coords: number[][]): number[] {
  const out = new Array(coords.length).fill(0)
  for (let i = 1; i < coords.length; i++) {
    out[i] =
      out[i - 1] +
      haversineKm(
        [coords[i - 1][0], coords[i - 1][1]],
        [coords[i][0], coords[i][1]],
      )
  }
  return out
}

function bbox(coords: number[][]): [number, number, number, number] {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon
    if (lat < minLat) minLat = lat
    if (lon > maxLon) maxLon = lon
    if (lat > maxLat) maxLat = lat
  }
  return [minLon, minLat, maxLon, maxLat]
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t ** 3 : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function findIndexForKm(cumulative: number[], km: number): number {
  let lo = 0, hi = cumulative.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cumulative[mid] < km) lo = mid + 1
    else hi = mid
  }
  return lo
}

function interpolate(
  coords: number[][],
  cumulative: number[],
  idx: number,
  km: number,
): [number, number] {
  if (idx === 0) return [coords[0][0], coords[0][1]]
  const before = cumulative[idx - 1]
  const after = cumulative[idx]
  const t = after === before ? 0 : (km - before) / (after - before)
  const a = coords[idx - 1]
  const b = coords[idx]
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

function shortestArcDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180
}

function nearestPathIdx(coords: number[][], lon: number, lat: number): { idx: number; distSq: number } {
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < coords.length; i++) {
    const dlon = coords[i][0] - lon
    const dlat = coords[i][1] - lat
    const d = dlon * dlon + dlat * dlat
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return { idx: bestIdx, distSq: bestDist }
}

// ====== Cache de tiles + style ======
// Cache persistente en disco para no re-fetchear tiles entre jobs. Usa
// SHA1 de la URL como nombre de archivo. tmpdir limpia entre reboots
// del worker pero un mismo proceso de larga vida acumula cache.
const CACHE_DIR = path.join(os.tmpdir(), 'flyover-tilecache')

function cachePath(url: string): string {
  const hash = createHash('sha1').update(url).digest('hex')
  return path.join(CACHE_DIR, hash)
}

async function cachedFetch(url: string): Promise<Buffer> {
  const p = cachePath(url)
  try {
    return await readFile(p)
  } catch {
    // miss
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url)
    if (r.status === 429) {
      const wait = 2000 * Math.pow(2, attempt)
      console.warn(`[tile-cache] 429 on ${url.slice(0, 80)}…, waiting ${wait}ms`)
      await new Promise((res) => setTimeout(res, wait))
      continue
    }
    if (!r.ok) {
      if (r.status === 404 || r.status === 403) return Buffer.alloc(0)
      throw new Error(`HTTP ${r.status} on ${url}`)
    }
    const buf = Buffer.from(await r.arrayBuffer())
    await writeFile(p, buf)
    return buf
  }
  throw new Error(`tile-cache: max retries on ${url}`)
}

async function fetchStyleJson(): Promise<any> {
  const buf = await cachedFetch(STYLE_URL)
  return JSON.parse(buf.toString('utf8'))
}

// ====== Waypoint selection ======
interface AnnotatedWaypoint extends WaypointData {
  pathIdx: number
  distSq: number
  tier: number
}

// Kinds "imprescindibles": si existen en la ruta, siempre se muestran
// en el video (hasta MAX_PRIORITY por kind). Una cumbre, un camping,
// son momentos clave del recorrido que el usuario va a querer ver.
const PRIORITY_KINDS = ['cumbre', 'camping']
const MAX_PRIORITY_PER_KIND = 2

function selectWaypoints(waypoints: WaypointData[], coords: number[][]): AnnotatedWaypoint[] {
  const annotated = waypoints
    .filter((w) => w.photo_url)
    .map((w): AnnotatedWaypoint => {
      const near = nearestPathIdx(coords, w.lon, w.lat)
      return { ...w, pathIdx: near.idx, distSq: near.distSq, tier: kindTier(w.kind) }
    })
    .filter((w) => w.distSq < 0.001)

  if (annotated.length === 0) return []

  const chosen: AnnotatedWaypoint[] = []

  // Pasada 1: forzar prioridades (cumbre, camping). Si hay varios del
  // mismo kind clusterados (ej. trilogía de 3 cumbres seguidas),
  // mostramos solo uno por cluster — los demás producirían cards
  // pisadas (cumbre@f274 + cumbre@f275 en Cerro Negro), confunde más
  // que ayuda. Cluster = waypoints dentro de 5% del largo del path.
  const clusterGap = Math.floor(coords.length * 0.05)
  for (const kind of PRIORITY_KINDS) {
    const sorted = annotated
      .filter((w) => w.kind === kind)
      .sort((a, b) => a.pathIdx - b.pathIdx)
    const picked: AnnotatedWaypoint[] = []
    for (const w of sorted) {
      if (picked.length >= MAX_PRIORITY_PER_KIND) break
      const tooClose = picked.some((p) => Math.abs(p.pathIdx - w.pathIdx) < clusterGap)
      if (!tooClose) picked.push(w)
    }
    chosen.push(...picked)
  }

  // Pasada 2: llenar slots restantes distribuyendo por buckets, pero
  // ya respetando los slots ocupados por las prioridades de pasada 1.
  const remainingSlots = Math.max(0, MAX_WAYPOINTS - chosen.length)
  if (remainingSlots > 0) {
    const usedIds = new Set(chosen.map((w) => w.id))
    const totalCoords = coords.length
    const bucketSize = Math.ceil(totalCoords / MAX_WAYPOINTS)
    const usedKinds = new Map<string, number>()
    for (const w of chosen) usedKinds.set(w.kind, (usedKinds.get(w.kind) ?? 0) + 1)

    for (let b = 0; b < MAX_WAYPOINTS && chosen.length < MAX_WAYPOINTS; b++) {
      const lo = b * bucketSize
      const hi = Math.min(totalCoords, (b + 1) * bucketSize)
      // Skip bucket si ya tiene un waypoint prioritario
      if (chosen.some((w) => w.pathIdx >= lo && w.pathIdx < hi)) continue
      const candidates = annotated.filter(
        (w) => w.pathIdx >= lo && w.pathIdx < hi && !usedIds.has(w.id),
      )
      if (candidates.length === 0) continue
      candidates.sort((a, b) => {
        const aPen = (usedKinds.get(a.kind) ?? 0) * 0.5
        const bPen = (usedKinds.get(b.kind) ?? 0) * 0.5
        return a.tier + aPen - (b.tier + bPen)
      })
      const best = candidates[0]
      chosen.push(best)
      usedIds.add(best.id)
      usedKinds.set(best.kind, (usedKinds.get(best.kind) ?? 0) + 1)
    }
  }

  return chosen.sort((a, b) => a.pathIdx - b.pathIdx)
}

// ====== Waypoint photo prefetch ======
async function prefetchWaypointPhotos(waypoints: WaypointData[]): Promise<Map<string, Buffer>> {
  const start = Date.now()
  const byId = new Map<string, Buffer>()
  await Promise.all(
    waypoints
      .filter((w) => w.photo_url)
      .map(async (w) => {
        try {
          const r = await fetch(w.photo_url!)
          if (!r.ok) return
          const raw = Buffer.from(await r.arrayBuffer())
          const thumb = await sharp(raw)
            .resize(WAYPOINT_PHOTO_RECT.w, WAYPOINT_PHOTO_RECT.h, { fit: 'cover' })
            .composite([
              {
                input: Buffer.from(
                  `<svg width="${WAYPOINT_PHOTO_RECT.w}" height="${WAYPOINT_PHOTO_RECT.h}"><rect width="${WAYPOINT_PHOTO_RECT.w}" height="${WAYPOINT_PHOTO_RECT.h}" rx="20" ry="20" fill="white"/></svg>`,
                ),
                blend: 'dest-in',
              },
            ])
            .png()
            .toBuffer()
          byId.set(w.id, thumb)
        } catch (e: any) {
          console.warn(`[photos] waypoint ${w.id} failed: ${e?.message ?? e}`)
        }
      }),
  )
  console.log(`[render] ${byId.size} fotos cargadas en ${((Date.now() - start) / 1000).toFixed(1)}s`)
  return byId
}

// ====== Style builder per frame ======
function buildStyleWithLayers(
  baseStyle: any,
  coordsFull: [number, number][],
  progressSegment: [number, number][],
  cursorPos: [number, number] | null,
  waypointPin: { lon: number; lat: number } | null,
): any {
  const s = JSON.parse(JSON.stringify(baseStyle))
  s.sources['route-full'] = {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coordsFull }, properties: {} },
  }
  s.sources['route-progress'] = {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: progressSegment }, properties: {} },
  }
  if (cursorPos) {
    s.sources['cursor'] = {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'Point', coordinates: cursorPos }, properties: {} },
    }
  }
  if (waypointPin) {
    s.sources['wp-marker'] = {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [waypointPin.lon, waypointPin.lat] },
        properties: {},
      },
    }
  }
  s.layers.push(
    {
      id: 'route-full-line',
      type: 'line',
      source: 'route-full',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fff', 'line-opacity': 0.22, 'line-width': 4 },
    },
    {
      id: 'route-progress-glow',
      type: 'line',
      source: 'route-progress',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fbbf24', 'line-opacity': 0.5, 'line-width': 18, 'line-blur': 10 },
    },
    {
      id: 'route-progress-line',
      type: 'line',
      source: 'route-progress',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fbbf24', 'line-width': 7 },
    },
  )
  if (waypointPin) {
    s.layers.push(
      {
        id: 'wp-marker-glow',
        type: 'circle',
        source: 'wp-marker',
        paint: { 'circle-radius': 56, 'circle-color': '#06b6d4', 'circle-opacity': 0.35, 'circle-blur': 1.1 },
      },
      {
        id: 'wp-marker-ring',
        type: 'circle',
        source: 'wp-marker',
        paint: { 'circle-radius': 28, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#06b6d4', 'circle-stroke-width': 6 },
      },
      {
        id: 'wp-marker-dot',
        type: 'circle',
        source: 'wp-marker',
        paint: { 'circle-radius': 12, 'circle-color': '#fff', 'circle-stroke-color': '#06b6d4', 'circle-stroke-width': 3 },
      },
    )
  }
  if (cursorPos) {
    s.layers.push(
      {
        id: 'cursor-glow',
        type: 'circle',
        source: 'cursor',
        paint: { 'circle-radius': 32, 'circle-color': '#fbbf24', 'circle-opacity': 0.4, 'circle-blur': 1 },
      },
      {
        id: 'cursor-dot',
        type: 'circle',
        source: 'cursor',
        paint: { 'circle-radius': 12, 'circle-color': '#fff', 'circle-stroke-color': '#f59e0b', 'circle-stroke-width': 3 },
      },
    )
  }
  return s
}

// ====== FFmpeg encode ======
function encodeMp4(framesDir: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-framerate', String(FPS),
      '-i', path.join(framesDir, 'frame-%04d.jpg'),
      '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=stereo',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-movflags', '+faststart',
      '-c:a', 'aac',
      '-shortest',
      // CRF 25: balance peso/calidad para Reels/TikTok/Stories. Con 22
      // los MP4 quedaban en 50+ MB (pegaba el límite default 50 MB de
      // Supabase storage). CRF 25 produce ~30-35 MB con calidad
      // visualmente equivalente para mobile vertical.
      '-crf', '25',
      '-preset', 'medium',
      outputPath,
    ])
    ff.stderr.on('data', () => {})
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))))
  })
}

// ====== Main entry ======
export async function renderFlyover(route: RouteData): Promise<RenderResult> {
  const t0 = performance.now()
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flyover-'))
  const framesDir = path.join(tmpRoot, 'frames')
  await mkdir(framesDir, { recursive: true })
  await mkdir(CACHE_DIR, { recursive: true })
  const outputPath = path.join(tmpRoot, 'flyover.mp4')

  try {
    const coords = route.geojson.coordinates.map((c) => [c[0], c[1], c[2]] as number[])
    if (coords.length < 2) {
      return { success: false, error: 'route has too few points' }
    }
    const flatCoords: [number, number][] = coords.map((c) => [c[0], c[1]])
    const cumulative = buildCumulative(coords)
    const totalKm = cumulative[cumulative.length - 1]
    const [minLon, minLat, maxLon, maxLat] = bbox(coords)
    const centerLon = (minLon + maxLon) / 2
    const centerLat = (minLat + maxLat) / 2

    console.log(`[render] ${route.title}: ${coords.length} coords, ${totalKm.toFixed(1)} km`)
    console.log(`[render] pre-fetch fotos waypoints…`)
    const waypointPhotos = await prefetchWaypointPhotos(route.waypoints)
    const selectedWaypoints = selectWaypoints(route.waypoints, coords)
    console.log(
      `[render] ${selectedWaypoints.length}/${route.waypoints.length} waypoints seleccionados: ` +
        selectedWaypoints.map((w) => w.kind).join(', '),
    )

    console.log(`[render] cargando style…`)
    const baseStyle = await fetchStyleJson()

    const memCache = new Map<string, Buffer>()
    const map = new (mbgl as any).Map({
      request: (req: any, callback: any) => {
        const inMem = memCache.get(req.url)
        if (inMem) return callback(null, { data: inMem })
        cachedFetch(req.url)
          .then((buf) => {
            memCache.set(req.url, buf)
            callback(null, { data: buf })
          })
          .catch((err) => callback(err))
      },
      ratio: 1,
    })

    // ====== Pre-cálculo de waypoint schedule ======
    //
    // Approach proactivo: para cada selectedWaypoint, calcular en qué
    // frame el cursor pasa por su posición, y agendar el show de la
    // card desde ese frame por WAYPOINT_CARD_FRAMES. Si dos cards se
    // solapan, pusheamos la segunda con un gap mínimo.
    //
    // Esto garantiza que TODOS los selectedWaypoints (incluyendo
    // cumbres prioritarias) se muestren — el approach reactivo
    // anterior podía saltarse cards si el cursor pasaba mientras otra
    // card ya estaba activa.
    interface WpScheduleEntry {
      wp: AnnotatedWaypoint
      startFrame: number
      endFrame: number
    }
    // Anticipar la card 20 frames antes de que el cursor llegue al
    // waypoint, y armar el schedule final con resolución inteligente
    // de overlaps:
    //   - Si dos cards estarían dentro de MIN_GAP, la más importante
    //     (cumbre > tier 1 > tier 2 > tier 3) gana — la otra se dropea.
    //   - Cumbre siempre gana sobre todo lo demás.
    const WP_ANTICIPATE_FRAMES = 20
    const MIN_PREV_VISIBLE = 30
    function importance(kind: string): number {
      if (kind === 'cumbre') return 0
      return kindTier(kind)
    }
    const rawSchedule: WpScheduleEntry[] = selectedWaypoints
      .map((w): WpScheduleEntry => {
        const km = cumulative[w.pathIdx] ?? 0
        const routeT = Math.min(1, Math.max(0, km / totalKm))
        const wpFrame = INTRO_END + Math.floor(routeT * (ROUTE_END - INTRO_END))
        const startFrame = Math.max(INTRO_END, wpFrame - WP_ANTICIPATE_FRAMES)
        return { wp: w, startFrame, endFrame: startFrame + WAYPOINT_CARD_FRAMES }
      })
      .sort((a, b) => a.startFrame - b.startFrame)

    const wpSchedule: WpScheduleEntry[] = []
    for (const cur of rawSchedule) {
      const prev = wpSchedule[wpSchedule.length - 1]
      if (!prev || cur.startFrame >= prev.endFrame) {
        wpSchedule.push(cur)
        continue
      }
      if (cur.startFrame - prev.startFrame >= MIN_PREV_VISIBLE) {
        prev.endFrame = cur.startFrame
        wpSchedule.push(cur)
        continue
      }
      if (importance(cur.wp.kind) < importance(prev.wp.kind)) {
        wpSchedule[wpSchedule.length - 1] = cur
      }
    }
    console.log(
      `[render] waypoint schedule: ${wpSchedule.map((s) => `${s.wp.kind}@f${s.startFrame}`).join(', ')}`,
    )

    // ====== Loop de frames ======
    console.log(`[render] capturing ${TOTAL_FRAMES} frames…`)
    const tCaptureStart = performance.now()
    let smoothedBearing: number | null = null

    function bearingFromLookahead(idxNow: number): number {
      const ahead = Math.min(coords.length - 1, idxNow + BEARING_LOOKAHEAD)
      if (ahead <= idxNow) return smoothedBearing ?? 0
      let dx = 0, dy = 0
      for (let i = idxNow; i < ahead; i++) {
        dx += coords[i + 1][0] - coords[i][0]
        dy += coords[i + 1][1] - coords[i][1]
      }
      if (dx === 0 && dy === 0) return smoothedBearing ?? 0
      return (Math.atan2(dx, dy) * 180) / Math.PI
    }

    for (let f = 0; f < TOTAL_FRAMES; f++) {
      let camera: { center: [number, number]; zoom: number; pitch: number; bearing: number }
      let progressSegment: [number, number][]
      let cursorPos: [number, number] | null = null
      let overlaySvg: string | null = null
      let currentWp: { wp: AnnotatedWaypoint; hideAtFrame: number } | null = null

      if (f < INTRO_END) {
        const t = easeInOutCubic(f / INTRO_END)
        camera = {
          center: [centerLon, centerLat],
          // Intro: arranca con overview de todo el área (zoom 9) y
          // termina cerca del primer punto (zoom 13). Pitch sube de
          // 25 a 55 (overview a inmersivo).
          zoom: 9 + (13 - 9) * t,
          pitch: 25 + (55 - 25) * t,
          bearing: -20 + 15 * t,
        }
        progressSegment = [[coords[0][0], coords[0][1]]]
        const fade = f < INTRO_END - 8 ? 1 : Math.max(0, 1 - (f - (INTRO_END - 8)) / 8)
        overlaySvg = svgTitle({
          eyebrow: route.location ?? 'Patagonia',
          title: route.title,
          sub: fmtDateEs(route.date),
          opacity: fade,
        })
      } else if (f < ROUTE_END) {
        const routeT = (f - INTRO_END) / (ROUTE_END - INTRO_END)
        const km = totalKm * routeT
        const idx = findIndexForKm(cumulative, km)
        const here = interpolate(coords, cumulative, idx, km)

        const target = bearingFromLookahead(idx)
        if (smoothedBearing == null) {
          smoothedBearing = target
        } else {
          const delta = shortestArcDelta(smoothedBearing, target)
          const emaStep = delta * BEARING_EMA_ALPHA
          const capped = Math.sign(emaStep) * Math.min(Math.abs(emaStep), BEARING_MAX_DELTA_PER_FRAME)
          smoothedBearing = (smoothedBearing + capped + 360) % 360
        }

        // Zoom 14.5 + pitch 55: cursor protagónico (3-4 km visibles
        // adelante en lugar de 10+ km), aprovecha más el frame
        // vertical. Pitch 55 mantiene la perspectiva inmersiva.
        camera = { center: here, zoom: 14.5, pitch: 55, bearing: smoothedBearing }
        progressSegment = coords.slice(0, idx + 1).map((c) => [c[0], c[1]])
        progressSegment.push(here)
        cursorPos = here

        const alt = coords[idx][2] ?? 0
        const dPlus = (route.elevation_gain_m ?? 0) * routeT

        // Mirar el schedule precalculado: ¿hay alguna card activa en
        // este frame?
        const activeSchedule = wpSchedule.find(
          (s) => f >= s.startFrame && f < s.endFrame,
        )
        currentWp = activeSchedule ? { wp: activeSchedule.wp, hideAtFrame: activeSchedule.endFrame } : null

        const statsSvg = svgStats({ km, alt, dPlus })
        if (currentWp) {
          const wp = currentWp.wp
          const hasPhoto = waypointPhotos.has(wp.id)
          const wpIndex = selectedWaypoints.findIndex((w) => w.id === wp.id) + 1
          overlaySvg = stackSvg([
            statsSvg,
            svgWaypoint({
              kindLabel: kindLabelEs(wp.kind),
              customTitle: wp.title || null,
              meta: wp.altitude_m != null ? `${Math.round(wp.altitude_m)} m` : '',
              hasPhoto,
              index: wpIndex,
              total: selectedWaypoints.length,
            }),
          ])
        } else {
          overlaySvg = statsSvg
        }
      } else {
        // Outro — currentWp queda null por scope per-frame.
        const t = easeInOutCubic((f - ROUTE_END) / (OUTRO_END - ROUTE_END))
        camera = {
          center: [centerLon, centerLat],
          zoom: 12 - 2 * t,
          pitch: 55 - 30 * t,
          bearing: 0,
        }
        progressSegment = flatCoords
        const fade = Math.min(1, t * 2)
        overlaySvg = svgOutro({
          title: route.title,
          location: route.location,
          date: fmtDateEs(route.date),
          km: totalKm,
          dPlus: route.elevation_gain_m ?? 0,
          time: fmtDurationEs(route.duration_seconds),
          wps: route.waypoints.length,
          opacity: fade,
        })
      }

      const waypointPin = currentWp ? { lon: currentWp.wp.lon, lat: currentWp.wp.lat } : null
      const style = buildStyleWithLayers(baseStyle, flatCoords, progressSegment, cursorPos, waypointPin)
      ;(map as any).load(style)

      const rgba = await new Promise<Buffer>((resolve, reject) => {
        ;(map as any).render(
          { ...camera, width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
          (err: Error | null, buf: Buffer) => (err ? reject(err) : resolve(buf)),
        )
      })

      const mapPng = await sharp(rgba, { raw: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, channels: 4 } })
        .png()
        .toBuffer()
      const layers: sharp.OverlayOptions[] = []
      if (overlaySvg) layers.push({ input: Buffer.from(overlaySvg), top: 0, left: 0 })
      if (currentWp && waypointPhotos.has(currentWp.wp.id)) {
        layers.push({
          input: waypointPhotos.get(currentWp.wp.id)!,
          top: WAYPOINT_PHOTO_RECT.y,
          left: WAYPOINT_PHOTO_RECT.x,
        })
      }
      const composed =
        layers.length > 0
          ? await sharp(mapPng).composite(layers).jpeg({ quality: 88 }).toBuffer()
          : await sharp(mapPng).jpeg({ quality: 88 }).toBuffer()

      await writeFile(path.join(framesDir, `frame-${String(f).padStart(4, '0')}.jpg`), composed)

      if (f > 0 && f % 100 === 0) {
        const elapsed = (performance.now() - tCaptureStart) / 1000
        const fps = (f + 1) / elapsed
        console.log(`[render] frame ${f}/${TOTAL_FRAMES} (${fps.toFixed(1)}fps)`)
      }
    }

    ;(map as any).release()
    console.log(`[render] capture done in ${((performance.now() - tCaptureStart) / 1000).toFixed(1)}s`)

    console.log(`[render] encoding mp4…`)
    await encodeMp4(framesDir, outputPath)
    const durationSeconds = (performance.now() - t0) / 1000
    console.log(`[render] DONE in ${durationSeconds.toFixed(1)}s → ${outputPath}`)

    return {
      success: true,
      output_path: outputPath,
      frames_count: TOTAL_FRAMES,
      duration_seconds: durationSeconds,
    }
  } catch (error: any) {
    console.error('[render] failed', error)
    return { success: false, error: error?.message ?? String(error) }
  }
}

// Stack 2 SVG strings en uno (mismo viewbox)
function stackSvg(svgs: string[]): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
  ${svgs
    .map((s) =>
      s.replace(/<\?xml[^>]*\?>/, '').replace(/<svg[^>]*>/, '<g>').replace(/<\/svg>/, '</g>'),
    )
    .join('\n')}
</svg>
`
}

export async function cleanupTmp(outputPath: string): Promise<void> {
  try {
    const dir = path.dirname(outputPath)
    await fs.rm(dir, { recursive: true, force: true })
  } catch (e) {
    console.warn('[render] cleanup failed', e)
  }
}
