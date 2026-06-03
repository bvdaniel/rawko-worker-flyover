// Coreografía del flyover. Espera que la página haya recibido sus
// parámetros (mediante window.__flyoverInput) y devuelve un Promise que
// resuelve cuando termina la animación, dejando window.__flyoverComplete
// = true para que Puppeteer sepa cuándo parar la captura.
//
// Línea de tiempo total: 30 segundos a 30 fps = 900 frames.
//   0-3s   (frame 0-90):    intro fly-in con título
//   3-23s  (frame 90-690):  recorrido con polyline 3D animada + stats
//                            + waypoints como cards flotantes
//   23-30s (frame 690-900): outro con stats finales en grande

(function () {
  const TOTAL_FRAMES = 900
  const FPS = 30
  const INTRO_END = 90
  const ROUTE_END = 690
  const OUTRO_END = TOTAL_FRAMES

  function deg2rad(d) {
    return (d * Math.PI) / 180
  }
  function haversineKm(a, b) {
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

  function buildCumulative(coords) {
    // [km0, km1, ...] mismas length que coords
    const out = new Array(coords.length).fill(0)
    for (let i = 1; i < coords.length; i++) {
      out[i] = out[i - 1] + haversineKm(coords[i - 1], coords[i])
    }
    return out
  }

  function bbox(coords) {
    let minLon = Infinity,
      minLat = Infinity,
      maxLon = -Infinity,
      maxLat = -Infinity
    for (const [lon, lat] of coords) {
      if (lon < minLon) minLon = lon
      if (lat < minLat) minLat = lat
      if (lon > maxLon) maxLon = lon
      if (lat > maxLat) maxLat = lat
    }
    return [minLon, minLat, maxLon, maxLat]
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  }

  function fmtDate(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    const months = [
      'enero',
      'febrero',
      'marzo',
      'abril',
      'mayo',
      'junio',
      'julio',
      'agosto',
      'septiembre',
      'octubre',
      'noviembre',
      'diciembre',
    ]
    return `${d.getUTCDate()} de ${months[d.getUTCMonth()]} de ${d.getUTCFullYear()}`
  }

  function fmtDuration(seconds) {
    if (!seconds || seconds <= 0) return '—'
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}`
    return `${m}m`
  }

  function emojiFor(kind) {
    const map = {
      summit: '🏔️',
      photo: '📷',
      rest: '🪨',
      food: '🍫',
      water: '💧',
      camp: '⛺',
      hazard: '⚠️',
      poi: '📍',
    }
    return map[kind] || '📍'
  }

  async function main() {
    console.log('[anim] starting')
    const input = window.__flyoverInput
    if (!input) {
      console.error('[anim] No __flyoverInput provided')
      window.__flyoverError = 'missing input'
      window.__flyoverComplete = true
      return
    }

    const { route, maptilerKey } = input
    console.log(`[anim] route loaded: ${route?.title || '?'}`)
    if (!maptilerKey) {
      console.error('[anim] maptilerKey missing')
    }
    const coords = route.geojson.coordinates
    if (!coords || coords.length < 2) {
      console.error('[anim] route has too few points', coords?.length)
      window.__flyoverError = 'route has too few points'
      window.__flyoverComplete = true
      return
    }
    console.log(`[anim] coords: ${coords.length} points`)

    // Diagnóstico de WebGL — si no hay contexto, MapLibre va a fallar.
    try {
      const testCanvas = document.createElement('canvas')
      const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl')
      console.log(`[anim] WebGL: ${gl ? 'OK' : 'MISSING'}`)
    } catch (e) {
      console.log(`[anim] WebGL probe failed: ${e}`)
    }

    const cumulative = buildCumulative(coords)
    const totalKm = cumulative[cumulative.length - 1]
    const [minLon, minLat, maxLon, maxLat] = bbox(coords)
    const centerLon = (minLon + maxLon) / 2
    const centerLat = (minLat + maxLat) / 2

    // Estilo MapTiler outdoor con terrain DEM RGB. Pitched 3D.
    const style = `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${maptilerKey}`

    console.log(`[anim] creating map with style ${style.substring(0, 80)}...`)
    let map
    try {
      map = new maplibregl.Map({
        container: 'map',
        style,
        center: [centerLon, centerLat],
        zoom: 8,
        pitch: 0,
        bearing: 0,
        maxPitch: 80,
        interactive: false,
        attributionControl: false,
        renderWorldCopies: false,
        fadeDuration: 0,
      })
    } catch (e) {
      console.error(`[anim] MapLibre constructor threw: ${e?.message || e}`)
      window.__flyoverError = 'maplibre constructor failed'
      window.__flyoverComplete = true
      return
    }

    map.on('error', e => {
      console.error(`[anim] MapLibre error: ${e?.error?.message || JSON.stringify(e)}`)
    })

    console.log('[anim] waiting for map load…')
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('map load timeout 25s')), 25_000)
      map.once('load', () => {
        clearTimeout(timeout)
        resolve(undefined)
      })
    }).catch(e => {
      console.error(`[anim] map load failed: ${e.message}`)
      window.__flyoverError = 'map load failed'
      window.__flyoverComplete = true
      throw e
    })
    console.log('[anim] map loaded')

    // Agregar terrain DEM RGB para 3D real.
    map.addSource('terrain-rgb', {
      type: 'raster-dem',
      url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${maptilerKey}`,
      tileSize: 256,
    })
    map.setTerrain({ source: 'terrain-rgb', exaggeration: 1.6 })

    // Polyline completa (sombra) — opacidad baja para que se vea por
    // delante del cursor el camino que falta.
    map.addSource('route-full', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords.map(c => [c[0], c[1]]) },
        properties: {},
      },
    })
    map.addLayer({
      id: 'route-full-line',
      type: 'line',
      source: 'route-full',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#fff',
        'line-opacity': 0.18,
        'line-width': 4,
      },
    })

    // Polyline progresiva — la que se dibuja a medida que avanza el
    // cursor. Inicia vacía.
    map.addSource('route-progress', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [coords[0].slice(0, 2)] },
        properties: {},
      },
    })
    map.addLayer({
      id: 'route-progress-glow',
      type: 'line',
      source: 'route-progress',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#fbbf24', // ambar Rawko
        'line-opacity': 0.55,
        'line-width': 16,
        'line-blur': 8,
      },
    })
    map.addLayer({
      id: 'route-progress-line',
      type: 'line',
      source: 'route-progress',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#fff',
        'line-width': 6,
      },
    })

    // Cursor (punto al final de la polyline progresiva).
    map.addSource('cursor', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords[0].slice(0, 2) },
        properties: {},
      },
    })
    map.addLayer({
      id: 'cursor-outer',
      type: 'circle',
      source: 'cursor',
      paint: {
        'circle-radius': 22,
        'circle-color': '#fbbf24',
        'circle-opacity': 0.45,
        'circle-blur': 1.2,
      },
    })
    map.addLayer({
      id: 'cursor-inner',
      type: 'circle',
      source: 'cursor',
      paint: {
        'circle-radius': 10,
        'circle-color': '#fff',
        'circle-stroke-color': '#fbbf24',
        'circle-stroke-width': 3,
      },
    })

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

    // Esperar a que el terrain esté listo + un par de frames extras
    // para evitar pop-in al empezar a capturar.
    console.log('[anim] waiting for tiles…')
    await new Promise(resolve => setTimeout(resolve, 800))
    if (!map.isStyleLoaded()) {
      await new Promise(resolve => map.once('idle', resolve))
    }
    await new Promise(resolve => setTimeout(resolve, 300))

    // ---------- Inicio de la captura: marcamos ready ----------
    console.log('[anim] ready')
    window.__flyoverReady = true

    // Cámara inicial — alta y lejos para el fly-in épico.
    const initialCamera = {
      center: [centerLon, centerLat],
      zoom: 8.5,
      pitch: 30,
      bearing: -20,
    }
    map.jumpTo(initialCamera)

    // Mostrar título de intro.
    document.getElementById('title').classList.add('visible')

    // Estado del frame actual. El worker (Puppeteer) llama
    // window.__renderFrame(f) para cada uno — no usamos rAF acá porque
    // en headless con software WebGL el wall clock corre demasiado
    // rápido y el screencast pierde frames. Captura determinística.
    let frame = 0

    function findIndexForKm(km) {
      // binary search en el cumulative array
      let lo = 0,
        hi = cumulative.length - 1
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
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }

    function renderFrame(f) {
      frame = f
      if (f < INTRO_END) {
        // Intro: zoom de 8.5 → 13 con pitch hacia 65, bearing girando 10°.
        const t = easeInOutCubic(f / INTRO_END)
        map.jumpTo({
          center: [centerLon, centerLat],
          zoom: 8.5 + (13 - 8.5) * t,
          pitch: 30 + (65 - 30) * t,
          bearing: -20 + 10 * t,
        })
        if (f > INTRO_END - 12) {
          // Fade out título cerca del final.
          const alpha = 1 - (f - (INTRO_END - 12)) / 12
          document.getElementById('title').style.opacity = String(Math.max(0, alpha))
        }
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

        // Actualizar polyline progresiva.
        const segment = coords.slice(0, idx + 1).map(c => [c[0], c[1]])
        segment.push(here)
        map.getSource('route-progress').setData({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: segment },
          properties: {},
        })
        map.getSource('cursor').setData({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: here },
          properties: {},
        })

        // Cámara sigue al cursor — tercera persona detrás y arriba.
        // Bearing: dirección del último segmento.
        const lookBack = Math.max(0, idx - 2)
        const prev = coords[lookBack]
        const dx = here[0] - prev[0]
        const dy = here[1] - prev[1]
        const bearing = (Math.atan2(dx, dy) * 180) / Math.PI
        map.jumpTo({
          center: here,
          zoom: 13.5,
          pitch: 70,
          bearing,
        })

        // Stats overlay.
        document.getElementById('statKm').textContent = km.toFixed(1)
        // Altitud actual interpolada (si el coord tiene 3ra dimensión)
        const alt = coords[idx][2]
        if (alt != null) {
          document.getElementById('statAlt').textContent = String(Math.round(alt))
        }
        // D+ acumulado — aproximación lineal según routeT * elevation_gain.
        const dPlus = (route.elevation_gain_m ?? 0) * eased
        document.getElementById('statGain').textContent = String(Math.round(dPlus))

        // Waypoints: si pasamos cerca de uno con foto, mostrar card por 60 frames.
        showWaypointIfHit(km, here, idx)
      } else {
        // Outro: zoom out + fade in del overlay.
        if (f === ROUTE_END) {
          document.getElementById('stats').classList.remove('visible')
          hideWaypoint()
          document.getElementById('outro').classList.add('visible')
        }
        const t = easeInOutCubic((f - ROUTE_END) / (OUTRO_END - ROUTE_END))
        const finalZoom = Math.max(
          9,
          12 - 3 * t,
        )
        map.jumpTo({
          center: [centerLon, centerLat],
          zoom: finalZoom,
          pitch: 65 - 35 * t,
          bearing: -20 - 20 * t,
        })
      }
    }

    // Waypoint display state.
    const wpShown = new Set()
    let wpHideAt = -1
    function showWaypointIfHit(currentKm, here, currentIdx) {
      const card = document.getElementById('waypointCard')
      if (wpHideAt > 0 && frame >= wpHideAt) {
        card.style.display = 'none'
        card.classList.remove('visible')
        wpHideAt = -1
      }
      // Encontrar el waypoint mas cercano al cursor actual no mostrado todavía.
      let candidate = null
      let bestDist = Infinity
      for (const w of route.waypoints) {
        if (!w.photo_url) continue
        if (wpShown.has(w.id)) continue
        const d = haversineKm([w.lon, w.lat], here)
        if (d < bestDist) {
          bestDist = d
          candidate = w
        }
      }
      // Si está a menos de 80m del cursor → mostrar por 50 frames.
      if (candidate && bestDist < 0.08) {
        wpShown.add(candidate.id)
        card.style.display = 'flex'
        // Forzar reflow para que la transición pegue.
        void card.offsetWidth
        card.classList.add('visible')
        document.getElementById('waypointEmoji').textContent = emojiFor(candidate.kind)
        document.getElementById('waypointTitle').textContent =
          candidate.title || (candidate.kind === 'summit' ? 'Cumbre' : 'Hito')
        document.getElementById('waypointMeta').textContent =
          candidate.altitude_m != null ? `${Math.round(candidate.altitude_m)} m` : ''
        document.getElementById('waypointPhoto').src = candidate.photo_url
        wpHideAt = frame + 50
      }
    }
    function hideWaypoint() {
      const card = document.getElementById('waypointCard')
      card.classList.remove('visible')
      card.style.display = 'none'
    }

    // Exponemos el contrato que el worker espera: __totalFrames para
    // saber cuántos screenshots tomar, __renderFrame(f) para avanzar a
    // un frame específico y esperar a que MapLibre haya terminado de
    // pintar antes de devolver. Sin este await los tiles del nuevo
    // center/zoom no alcanzan a cargar y el screenshot sale a medias.
    window.__totalFrames = TOTAL_FRAMES
    window.__renderFrame = async function (f) {
      renderFrame(f)
      // Esperar a que MapLibre quede idle (tiles cargadas, no hay
      // animaciones pendientes) o caemos a un timeout corto para no
      // colgarnos si una tile remota se atrasa.
      await Promise.race([
        new Promise(resolve => map.once('idle', resolve)),
        new Promise(resolve => setTimeout(resolve, 800)),
      ])
      // Un rAF más para asegurar que el browser pintó el frame.
      await new Promise(resolve => requestAnimationFrame(() => resolve()))
      if (f >= TOTAL_FRAMES - 1) {
        window.__flyoverComplete = true
      }
    }
  }

  // Esperar a que las fuentes se carguen para que el primer frame ya
  // tenga texto bien dibujado.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(main)
  } else {
    setTimeout(main, 100)
  }
})()
