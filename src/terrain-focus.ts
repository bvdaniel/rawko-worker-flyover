import sharp from 'sharp'

// ============================================================
// terrain-focus.ts
//
// Calcula, para cada punto de muestreo del trail, el "relieve de
// interés" cercano (el macizo, la cumbre, la pared) usando el DEM de
// MapTiler (terrain-rgb-v2), el mismo raster que se renderiza en el
// video. Devuelve un perfil que la animación usa para apuntar la cámara.
//
// Sin este perfil, la cámara es un follow-cam rígido (2.6 km de ancho,
// pitch 50°) que en rutas que circundan un macizo solo muestra el valle:
// el macizo queda fuera de cuadro.
// ============================================================

export interface FocusSample {
  km: number       // km acumulado a lo largo del trail
  bearing: number  // rumbo verdadero (grados) desde el trail al relieve
  dist_m: number   // distancia (m) desde el trail al relieve
  elev_m: number   // elevación (m) del relieve
}

type Coord = [number, number, number?]

const Z = 12
const MARGIN_M = 7000
const CELL_M = 150
const SEARCH_RADIUS_M = 8000
const MIN_PROMINENCE_M = 400
const MIN_BBOX_DIAG_M = 8000
const SAMPLE_M = 400
const MAX_SAMPLES = 300
const CONCURRENCY = 6

// ── utilidades geográficas ─────────────────────────────────
function lon2tx(lon: number, z: number) { return ((lon + 180) / 360) * Math.pow(2, z) }
function lat2ty(lat: number, z: number) {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
}
function tileToLon(x: number, z: number) { return (x / Math.pow(2, z)) * 360 - 180 }
function tileToLat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}
const R_EARTH = 6371000
function havMeters(a: Coord, b: Coord): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLon = ((b[0] - a[0]) * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.sqrt(h))
}
function trueBearing(a: Coord, b: Coord): number {
  const lat1 = (a[1] * Math.PI) / 180
  const lat2 = (b[1] * Math.PI) / 180
  const dLon = ((b[0] - a[0]) * Math.PI) / 180
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// ── raster grueso de elevación ─────────────────────────────
interface Raster {
  cols: number
  rows: number
  minLon: number
  minLat: number
  cellLon: number
  cellLat: number
  elev: Float32Array // elevación máxima por celda (-1 = sin dato)
}

async function loadDemRaster(coords: Coord[]): Promise<Raster> {
  let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9
  for (const p of coords) {
    mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0])
    mny = Math.min(mny, p[1]); mxy = Math.max(mxy, p[1])
  }
  const centerLat = (mny + mxy) / 2
  const mLon = MARGIN_M / (111320 * Math.cos((centerLat * Math.PI) / 180))
  const mLat = MARGIN_M / 111320
  const minLon = mnx - mLon, maxLon = mxx + mLon
  const minLat = mny - mLat, maxLat = mxy + mLat

  const x0 = Math.floor(lon2tx(minLon, Z)), x1 = Math.floor(lon2tx(maxLon, Z))
  const y0 = Math.floor(lat2ty(maxLat, Z)), y1 = Math.floor(lat2ty(minLat, Z))

  const cellLat = CELL_M / 111320
  const cellLon = CELL_M / (111320 * Math.cos((centerLat * Math.PI) / 180))
  const cols = Math.max(1, Math.ceil((maxLon - minLon) / cellLon))
  const rows = Math.max(1, Math.ceil((maxLat - minLat) / cellLat))
  const raster: Raster = {
    cols, rows, minLon, minLat, cellLon, cellLat,
    elev: new Float32Array(cols * rows).fill(-1),
  }

  const KEY = process.env.MAPTILER_KEY
  if (!KEY) {
    console.warn('[terrain-focus] MAPTILER_KEY no set — skip focus')
    return raster
  }

  const tiles: Array<{ x: number; y: number; url: string }> = []
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      tiles.push({ x, y, url: `https://api.maptiler.com/tiles/terrain-rgb-v2/${Z}/${x}/${y}?key=${KEY}` })
    }
  }
  if (tiles.length === 0 || tiles.length > 400) return raster // seguridad

  const stride = 4 // muestrear cada 4 px (~48 m) — suficiente para celdas de 150 m
  async function processTile(t: { x: number; y: number; url: string }) {
    let res: Response
    try { res = await fetch(t.url) } catch { return }
    if (!res.ok) return
    const buf = Buffer.from(await res.arrayBuffer())
    let data: Buffer, info: sharp.OutputInfo
    try {
      ;({ data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true }))
    } catch { return }
    const W = info.width, H = info.height, CH = info.channels
    const lon0 = tileToLon(t.x, Z), lon1 = tileToLon(t.x + 1, Z)
    const lat0 = tileToLat(t.y + 1, Z), lat1 = tileToLat(t.y, Z)
    for (let py = 0; py < H; py += stride) {
      const lat = lat1 + ((lat0 - lat1) * (py + 0.5)) / H
      if (lat < minLat || lat > maxLat) continue
      for (let px = 0; px < W; px += stride) {
        const lon = lon0 + ((lon1 - lon0) * (px + 0.5)) / W
        if (lon < minLon || lon > maxLon) continue
        const i = (py * W + px) * CH
        const e = (data[i] * 65536 + data[i + 1] * 256 + data[i + 2]) * 0.1 - 10000
        const col = Math.floor((lon - minLon) / cellLon)
        const row = Math.floor((lat - minLat) / cellLat)
        const idx = row * cols + col
        if (e > raster.elev[idx]) raster.elev[idx] = e
      }
    }
  }

  let cursor = 0
  async function worker() {
    while (cursor < tiles.length) {
      const t = tiles[cursor++]
      await processTile(t)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, worker))

  return raster
}

// ── perfil de relieve ──────────────────────────────────────
export async function computeFocusProfile(coords: Coord[]): Promise<FocusSample[] | null> {
  if (!coords || coords.length < 2) return null

  let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9
  for (const p of coords) {
    mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0])
    mny = Math.min(mny, p[1]); mxy = Math.max(mxy, p[1])
  }
  const centerLat = (mny + mxy) / 2
  const diag = Math.hypot((mxx - mnx) * 111320 * Math.cos((centerLat * Math.PI) / 180), (mxy - mny) * 111320)
  if (diag < MIN_BBOX_DIAG_M) return null // ruta corta → sin relieve que encuadrar

  const raster = await loadDemRaster(coords)

  const cum = new Float64Array(coords.length)
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + havMeters(coords[i - 1], coords[i])
  const totalM = cum[cum.length - 1]
  if (totalM < 1) return null

  const nSamples = Math.min(MAX_SAMPLES, Math.max(8, Math.floor(totalM / SAMPLE_M)))
  const radiusCells = Math.ceil(SEARCH_RADIUS_M / CELL_M)
  const samples: FocusSample[] = []

  for (let s = 0; s <= nSamples; s++) {
    const target = (totalM * s) / nSamples
    let lo = 0, hi = coords.length - 1
    while (lo < hi) { const m = (lo + hi) >> 1; cum[m] < target ? (lo = m + 1) : (hi = m) }
    const idx = lo
    const c = coords[idx]
    const trailElev = typeof c[2] === 'number' && isFinite(c[2]) ? c[2] : 0
    const col = Math.floor((c[0] - raster.minLon) / raster.cellLon)
    const row = Math.floor((c[1] - raster.minLat) / raster.cellLat)

    let bestScore = -1, bestLon = c[0], bestLat = c[1], bestElev = trailElev
    const r0 = Math.max(0, row - radiusCells), r1 = Math.min(raster.rows - 1, row + radiusCells)
    const c0 = Math.max(0, col - radiusCells), c1 = Math.min(raster.cols - 1, col + radiusCells)
    for (let r = r0; r <= r1; r++) {
      const base = r * raster.cols
      for (let cc = c0; cc <= c1; cc++) {
        const e = raster.elev[base + cc]
        if (e < 0) continue
        const lon = raster.minLon + (cc + 0.5) * raster.cellLon
        const lat = raster.minLat + (r + 0.5) * raster.cellLat
        const d = havMeters(c, [lon, lat])
        if (d > SEARCH_RADIUS_M) continue
        const prom = e - trailElev
        if (prom < MIN_PROMINENCE_M) continue
        // Favorece picos altos (las torres) por sobre colinas cercanas:
        // la distancia se penaliza suavemente (potencia 0.4). Un pico de
        // 2300 m a 6 km gana a una loma de 1100 m a 3 km.
        const score = prom * Math.pow(1 - d / SEARCH_RADIUS_M, 0.4)
        if (score > bestScore) { bestScore = score; bestLon = lon; bestLat = lat; bestElev = e }
      }
    }
    if (bestScore < 0) continue
    samples.push({
      km: target / 1000,
      bearing: trueBearing(c, [bestLon, bestLat]),
      dist_m: havMeters(c, [bestLon, bestLat]),
      elev_m: bestElev,
    })
  }

  if (samples.length < 2) return null
  return samples
}
