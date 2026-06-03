// Coreografía del flyover con Leaflet (2D, Canvas — sin WebGL).
//
// Total 30s a 30fps = 900 frames.
//   0-3s   (frame 0-90):    intro: zoom out épico al centro de la ruta + título
//   3-23s  (frame 90-690):  recorrido: polyline progresiva dorada con cursor
//                            brillante, panning suave que sigue al cursor,
//                            stats encadenados, cards de waypoints con foto
//   23-30s (frame 690-900): outro: zoom out completo + stats finales en grande

(function () {
  const TOTAL_FRAMES = 900
  const FPS = 30
  const INTRO_END = 90
  const ROUTE_END = 690
  const OUTRO_END = TOTAL_FRAMES

  function deg2rad(d) { return (d * Math.PI) / 180 }
  function haversineKm(a, b) {
    const R = 6371
    const dLat = deg2rad(b[1] - a[1])
    const dLon = deg2rad(b[0] - a[0])
    const lat1 = deg2rad(a[1])
    const lat2 = deg2rad(b[1])
    const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2
    return 2 * R * Math.asin(Math.sqrt(h))
  }
  function buildCumulative(coords) {
    const out = new Array(coords.length).fill(0)
    for (let i = 1; i < coords.length; i++) {
      out[i] = out[i-1] + haversineKm(coords[i-1], coords[i])
    }
    return out
  }
  function bbox(coords) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
    for (const [lon, lat] of coords) {
      if (lon < minLon) minLon = lon
      if (lat < minLat) minLat = lat
      if (lon > maxLon) maxLon = lon
      if (lat > maxLat) maxLat = lat
    }
    return { minLon, minLat, maxLon, maxLat }
  }
  function easeInOutCubic(t) {
    return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2
  }
  function fmtDate(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']
    return `${d.getUTCDate()} de ${months[d.getUTCMonth()]} de ${d.getUTCFullYear()}`
  }
  function fmtDuration(seconds) {
    if (!seconds || seconds <= 0) return '—'
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return h > 0 ? `${h}h ${m.toString().padStart(2,'0')}` : `${m}m`
  }
  function emojiFor(kind) {
    return ({ summit:'🏔️', photo:'📷', rest:'🪨', food:'🍫', water:'💧', camp:'⛺', hazard:'⚠️', poi:'📍' })[kind] || '📍'
  }

  async function main() {
    console.log('[anim] starting (Leaflet 2D)')
    const input = window.__flyoverInput
    if (!input) {
      console.error('[anim] no input')
      window.__flyoverError = 'missing input'
      window.__flyoverComplete = true
      return
    }
    const { route, maptilerKey } = input
    console.log(`[anim] route: ${route?.title}`)
    const coords = route.geojson.coordinates
    if (!coords || coords.length < 2) {
      window.__flyoverError = 'too few points'
      window.__flyoverComplete = true
      return
    }
    console.log(`[anim] coords: ${coords.length}`)

    const cumulative = buildCumulative(coords)
    const totalKm = cumulative[cumulative.length - 1]
    const box = bbox(coords)
    const centerLat = (box.minLat + box.maxLat) / 2
    const centerLon = (box.minLon + box.maxLon) / 2

    // Leaflet map. Tile MapTiler outdoor raster (no vector, no WebGL).
    const map = L.map('map', {
      center: [centerLat, centerLon],
      zoom: 12,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
      zoomSnap: 0,
      zoomDelta: 0,
      fadeAnimation: false,
      zoomAnimation: false,
      markerZoomAnimation: false,
    })

    L.tileLayer(
      `https://api.maptiler.com/maps/outdoor-v2/256/{z}/{x}/{y}.png?key=${maptilerKey}`,
      { maxZoom: 18, tileSize: 256 },
    ).addTo(map)

    // Ajustar bounds al fitBounds para encuadrar la ruta entera.
    const latlngs = coords.map(c => [c[1], c[0]])
    map.fitBounds(latlngs, { padding: [80, 80], animate: false })
    const overviewZoom = map.getZoom()
    const overviewCenter = map.getCenter()

    // Esperar a que las tiles carguen. Como la camara queda fija
    // durante todo el video, una carga inicial buena evita reflows.
    console.log('[anim] waiting for tiles…')
    await new Promise(resolve => {
      let resolved = false
      const done = () => {
        if (!resolved) {
          resolved = true
          resolve()
        }
      }
      // load dispara cuando todas las tiles visibles cargaron.
      map.once('load', done)
      // Fallback por si load nunca dispara: 6 segundos.
      setTimeout(done, 6000)
    })
    // Margen extra para que los tiles se pinten completos.
    await new Promise(resolve => setTimeout(resolve, 1200))
    console.log('[anim] tiles ready')

    // Setup canvas overlay para polyline + cursor + glow.
    const canvas = document.getElementById('fxCanvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      console.error('[anim] canvas 2d unavailable')
      window.__flyoverError = 'no canvas'
      window.__flyoverComplete = true
      return
    }

    // Setup textos overlay.
    document.getElementById('titleEyebrow').textContent =
      (route.location || 'Patagonia').toUpperCase()
    document.getElementById('titleMain').textContent = route.title
    document.getElementById('titleSub').textContent = fmtDate(route.date)
    document.getElementById('outroTitle').textContent = route.title
    document.getElementById('outroKm').textContent = (route.distance_km ?? totalKm).toFixed(1)
    document.getElementById('outroGain').textContent =
      route.elevation_gain_m != null ? `${Math.round(route.elevation_gain_m)}` : '—'
    document.getElementById('outroTime').textContent = fmtDuration(route.duration_seconds)
    document.getElementById('outroWps').textContent = String(route.waypoints.length)

    // Diferir un poco mas para asegurar que las tiles pintaron.
    await new Promise(resolve => setTimeout(resolve, 600))

    console.log('[anim] ready')
    document.getElementById('title').classList.add('visible')

    // Estado del loop.
    const wpShown = new Set()
    let wpHideAt = -1

    function findIndexForKm(km) {
      let lo = 0, hi = cumulative.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (cumulative[mid] < km) lo = mid + 1
        else hi = mid
      }
      return lo
    }
    function interpolate(idx, km) {
      if (idx === 0) return coords[0]
      const before = cumulative[idx - 1]
      const after = cumulative[idx]
      const t = after === before ? 0 : (km - before) / (after - before)
      const a = coords[idx - 1]
      const b = coords[idx]
      return [a[0] + (b[0]-a[0]) * t, a[1] + (b[1]-a[1]) * t, (a[2]||0) + ((b[2]||0)-(a[2]||0)) * t]
    }
    function lerp(a, b, t) { return a + (b - a) * t }

    function drawProgressiveLine(progressKm, currentCoord) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Convertir coords de lat/lon a pixel del canvas.
      const points = []
      const maxIdx = findIndexForKm(progressKm)
      for (let i = 0; i <= maxIdx; i++) {
        const p = map.latLngToContainerPoint([coords[i][1], coords[i][0]])
        points.push([p.x, p.y])
      }
      if (currentCoord) {
        const p = map.latLngToContainerPoint([currentCoord[1], currentCoord[0]])
        points.push([p.x, p.y])
      }
      if (points.length < 2) return

      // Polyline completa (sombra fina).
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.lineWidth = 4
      ctx.beginPath()
      const all = coords.map(c => map.latLngToContainerPoint([c[1], c[0]]))
      ctx.moveTo(all[0].x, all[0].y)
      for (let i = 1; i < all.length; i++) ctx.lineTo(all[i].x, all[i].y)
      ctx.stroke()

      // Glow ambar de la línea progresiva.
      ctx.strokeStyle = 'rgba(251,191,36,0.55)'
      ctx.lineWidth = 22
      ctx.shadowColor = 'rgba(251,191,36,0.8)'
      ctx.shadowBlur = 25
      ctx.beginPath()
      ctx.moveTo(points[0][0], points[0][1])
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1])
      ctx.stroke()
      ctx.shadowBlur = 0

      // Línea blanca encima.
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 7
      ctx.beginPath()
      ctx.moveTo(points[0][0], points[0][1])
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1])
      ctx.stroke()

      // Cursor en el frente.
      const last = points[points.length - 1]
      // halo externo
      ctx.fillStyle = 'rgba(251,191,36,0.5)'
      ctx.beginPath()
      ctx.arc(last[0], last[1], 26, 0, Math.PI * 2)
      ctx.fill()
      // núcleo blanco con borde ambar
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = '#fbbf24'
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.arc(last[0], last[1], 11, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }

    // En lugar de un loop con rAF dependiente del wall clock (que en
    // headless sin GPU corre demasiado rapido y el screencast pierde
    // frames), exponemos una funcion que el worker llama frame por
    // frame. Cada call renderiza ese frame exacto, el worker hace
    // screenshot, repeat. 100% deterministic.
    window.__renderFrame = async function (f) {
      renderFrame(f)
      // Yield al browser para que el render se aplique antes del screenshot.
      await new Promise(resolve => requestAnimationFrame(() => resolve()))
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    window.__totalFrames = TOTAL_FRAMES

    // Marcamos ready DESPUES de exponer __renderFrame.
    window.__flyoverReady = true

    function renderFrame(f) {
      // Cámara FIJA en overview durante todo el video — toda la ruta
      // visible siempre. Esto evita que Leaflet recargue tiles entre
      // frames (causaba "tambaleo" y flashes en el video anterior). El
      // protagonismo lo lleva la polyline dorada que se dibuja progre-
      // sivamente sobre el mapa, look Strava classic 2D.
      if (f === 0) {
        map.setView(overviewCenter, overviewZoom, { animate: false })
      }

      if (f < INTRO_END) {
        // Intro: solo título visible.
        if (f > INTRO_END - 12) {
          const alpha = 1 - (f - (INTRO_END - 12)) / 12
          document.getElementById('title').style.opacity = String(Math.max(0, alpha))
        }
        // Canvas limpio durante la intro (sin línea todavía).
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      } else if (f < ROUTE_END) {
        if (f === INTRO_END) {
          document.getElementById('title').classList.remove('visible')
          document.getElementById('stats').classList.add('visible')
        }
        const routeT = (f - INTRO_END) / (ROUTE_END - INTRO_END)
        const eased = easeInOutCubic(routeT)
        const km = totalKm * eased
        const idx = findIndexForKm(km)
        const here = interpolate(idx, km)

        drawProgressiveLine(km, here)

        document.getElementById('statKm').textContent = km.toFixed(1)
        if (here[2] != null) {
          document.getElementById('statAlt').textContent = String(Math.round(here[2]))
        }
        const dPlus = (route.elevation_gain_m ?? 0) * eased
        document.getElementById('statGain').textContent = String(Math.round(dPlus))

        showWaypointIfHit(km, here, f)
      } else {
        if (f === ROUTE_END) {
          document.getElementById('stats').classList.remove('visible')
          hideWaypoint()
          document.getElementById('outro').classList.add('visible')
        }
        // Recorrido completo dibujado, queda en pantalla detrás del outro.
        drawProgressiveLine(totalKm, null)
      }
    }

    // El waypoint display sigue siendo state-ful (acumula los ya mostrados)
    // pero pasamos el frame actual desde renderFrame.
    function showWaypointIfHit(currentKm, here, currentFrame) {
      const card = document.getElementById('waypointCard')
      if (wpHideAt > 0 && currentFrame >= wpHideAt) {
        card.style.display = 'none'
        card.classList.remove('visible')
        wpHideAt = -1
      }
      let candidate = null
      let bestDist = Infinity
      for (const w of route.waypoints) {
        if (!w.photo_url) continue
        if (wpShown.has(w.id)) continue
        const d = haversineKm([w.lon, w.lat], here)
        if (d < bestDist) { bestDist = d; candidate = w }
      }
      if (candidate && bestDist < 0.08) {
        wpShown.add(candidate.id)
        card.style.display = 'flex'
        void card.offsetWidth
        card.classList.add('visible')
        document.getElementById('waypointEmoji').textContent = emojiFor(candidate.kind)
        document.getElementById('waypointTitle').textContent =
          candidate.title || (candidate.kind === 'summit' ? 'Cumbre' : 'Hito')
        document.getElementById('waypointMeta').textContent =
          candidate.altitude_m != null ? `${Math.round(candidate.altitude_m)} m` : ''
        document.getElementById('waypointPhoto').src = candidate.photo_url
        wpHideAt = currentFrame + 50
      }
    }
    function hideWaypoint() {
      const card = document.getElementById('waypointCard')
      card.classList.remove('visible')
      card.style.display = 'none'
    }

    // No iniciamos loop automaticamente — el worker controla.
  }

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(main).catch(e => {
      console.error('[anim] fonts ready failed', e)
      main()
    })
  } else {
    setTimeout(main, 100)
  }
})()
