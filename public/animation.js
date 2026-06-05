// Coreografía del flyover renderizada con maplibre-gl-js en headless Chrome.
// Mac local con GPU real → terrain DEM 3D + WebGL hardware accelerated.
//
// El worker (puppeteer) llama a window.__renderFrame(f) para cada frame
// y toma screenshot. La animación NO usa rAF — la controla el worker
// determinísticamente.

(function () {
  const TOTAL_FRAMES = 600
  const FPS = 30
  const INTRO_END = 60   // 2s intro
  const ROUTE_END = 510  // 15s recorrido
  const OUTRO_END = TOTAL_FRAMES // 3s outro

  // Cámara
  const BEARING_LOOKAHEAD = 40
  const BEARING_EMA_ALPHA = 0.04
  const BEARING_MAX_DELTA = 1.5

  // Waypoints
  const MAX_WAYPOINTS = 6
  const WAYPOINT_CARD_FRAMES = 75
  const WP_ANTICIPATE = 20
  const MIN_PREV_VISIBLE = 30

  const PRIORITY_KINDS = ['cumbre', 'camping']
  const MAX_PRIORITY_PER_KIND = 2

  const KIND_LABELS = {
    cumbre: 'Cumbre', camping: 'Camping', cruce_rio: 'Cruce de río',
    agua_potable: 'Agua potable', mirador: 'Mirador', puente: 'Puente',
    peligro: 'Peligro', descanso: 'Descanso', foto: 'Foto', tranquera: 'Tranquera',
  }
  const KIND_TIERS = {
    cumbre: 1, camping: 1, cruce_rio: 1, agua_potable: 1,
    mirador: 2, puente: 2, peligro: 2,
    descanso: 3, foto: 3, tranquera: 3,
  }
  const MONTHS_ES = [
    'enero','febrero','marzo','abril','mayo','junio',
    'julio','agosto','septiembre','octubre','noviembre','diciembre',
  ]

  function deg2rad(d) { return d * Math.PI / 180 }
  function haversineKm(a, b) {
    const R = 6371
    const dLat = deg2rad(b[1] - a[1])
    const dLon = deg2rad(b[0] - a[0])
    const h = Math.sin(dLat/2)**2 + Math.cos(deg2rad(a[1]))*Math.cos(deg2rad(b[1]))*Math.sin(dLon/2)**2
    return 2 * R * Math.asin(Math.sqrt(h))
  }
  function buildCumulative(coords) {
    const out = new Array(coords.length).fill(0)
    for (let i = 1; i < coords.length; i++) out[i] = out[i-1] + haversineKm(coords[i-1], coords[i])
    return out
  }
  function bbox(coords) {
    let mnLon=Infinity, mnLat=Infinity, mxLon=-Infinity, mxLat=-Infinity
    for (const [lon,lat] of coords) {
      if (lon<mnLon) mnLon=lon; if (lat<mnLat) mnLat=lat
      if (lon>mxLon) mxLon=lon; if (lat>mxLat) mxLat=lat
    }
    return [mnLon, mnLat, mxLon, mxLat]
  }
  function easeInOutCubic(t) { return t<0.5 ? 4*t**3 : 1 - Math.pow(-2*t+2, 3)/2 }
  function findIdxForKm(cum, km) {
    let lo=0, hi=cum.length-1
    while (lo < hi) { const m = (lo+hi)>>1; cum[m]<km ? lo=m+1 : hi=m }
    return lo
  }
  function interpolate(coords, cum, idx, km) {
    if (idx===0) return [coords[0][0], coords[0][1]]
    const t = cum[idx]===cum[idx-1] ? 0 : (km-cum[idx-1])/(cum[idx]-cum[idx-1])
    return [coords[idx-1][0] + (coords[idx][0]-coords[idx-1][0])*t,
            coords[idx-1][1] + (coords[idx][1]-coords[idx-1][1])*t]
  }
  function shortestArcDelta(from, to) { return ((to - from + 540) % 360) - 180 }
  function nearestPathIdx(coords, lon, lat) {
    let bi=0, bd=Infinity
    for (let i=0; i<coords.length; i++) {
      const dx=coords[i][0]-lon, dy=coords[i][1]-lat, d=dx*dx+dy*dy
      if (d<bd) { bd=d; bi=i }
    }
    return { idx: bi, distSq: bd }
  }
  function fmtDate(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    return `${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`
  }
  function fmtDuration(s) {
    if (!s || s<=0) return '—'
    const h=Math.floor(s/3600), m=Math.floor((s%3600)/60)
    return h>0 ? `${h}h ${m.toString().padStart(2,'0')}m` : `${m}m`
  }
  function kindLabel(k) { return KIND_LABELS[k] || 'Hito' }
  function importance(k) { return k==='cumbre' ? 0 : (KIND_TIERS[k] || 3) }

  // ====== Waypoint selection (mismo algoritmo que render.ts maplibre) ======
  function selectWaypoints(waypoints, coords) {
    const annotated = waypoints
      .filter(w => w.photo_url)
      .map(w => {
        const n = nearestPathIdx(coords, w.lon, w.lat)
        return { ...w, pathIdx: n.idx, distSq: n.distSq, tier: KIND_TIERS[w.kind] || 3 }
      })
      .filter(w => w.distSq < 0.001)
    if (annotated.length === 0) return []

    const chosen = []
    const clusterGap = Math.floor(coords.length * 0.05)
    for (const kind of PRIORITY_KINDS) {
      const sorted = annotated.filter(w => w.kind === kind).sort((a,b) => a.pathIdx - b.pathIdx)
      const picked = []
      for (const w of sorted) {
        if (picked.length >= MAX_PRIORITY_PER_KIND) break
        if (!picked.some(p => Math.abs(p.pathIdx - w.pathIdx) < clusterGap)) picked.push(w)
      }
      chosen.push(...picked)
    }
    const remaining = Math.max(0, MAX_WAYPOINTS - chosen.length)
    if (remaining > 0) {
      const usedIds = new Set(chosen.map(w => w.id))
      const bucketSize = Math.ceil(coords.length / MAX_WAYPOINTS)
      const usedKinds = new Map()
      for (const w of chosen) usedKinds.set(w.kind, (usedKinds.get(w.kind)||0)+1)
      for (let b = 0; b < MAX_WAYPOINTS && chosen.length < MAX_WAYPOINTS; b++) {
        const lo = b*bucketSize, hi = Math.min(coords.length, (b+1)*bucketSize)
        if (chosen.some(w => w.pathIdx>=lo && w.pathIdx<hi)) continue
        const cands = annotated.filter(w => w.pathIdx>=lo && w.pathIdx<hi && !usedIds.has(w.id))
        if (cands.length === 0) continue
        cands.sort((a,b) => {
          const aP = (usedKinds.get(a.kind)||0)*0.5
          const bP = (usedKinds.get(b.kind)||0)*0.5
          return a.tier+aP - (b.tier+bP)
        })
        chosen.push(cands[0])
        usedIds.add(cands[0].id)
        usedKinds.set(cands[0].kind, (usedKinds.get(cands[0].kind)||0)+1)
      }
    }
    return chosen.sort((a,b) => a.pathIdx - b.pathIdx)
  }

  // ====== Schedule (mismo algoritmo que render.ts) ======
  function buildSchedule(selected, coords, cumulative, totalKm) {
    const raw = selected.map(w => {
      const km = cumulative[w.pathIdx] || 0
      const routeT = Math.max(0, Math.min(1, km/totalKm))
      const wpFrame = INTRO_END + Math.floor(routeT * (ROUTE_END - INTRO_END))
      const startFrame = Math.max(INTRO_END, wpFrame - WP_ANTICIPATE)
      return { wp: w, startFrame, endFrame: startFrame + WAYPOINT_CARD_FRAMES }
    }).sort((a,b) => a.startFrame - b.startFrame)
    const out = []
    for (const cur of raw) {
      const prev = out[out.length-1]
      if (!prev || cur.startFrame >= prev.endFrame) { out.push(cur); continue }
      if (cur.startFrame - prev.startFrame >= MIN_PREV_VISIBLE) {
        prev.endFrame = cur.startFrame
        out.push(cur)
        continue
      }
      if (importance(cur.wp.kind) < importance(prev.wp.kind)) {
        out[out.length-1] = cur
      }
    }
    return out
  }

  // ====== Main ======
  async function main() {
    console.log('[anim] starting')
    const input = window.__flyoverInput
    if (!input) { console.error('[anim] no __flyoverInput'); window.__flyoverError='missing input'; window.__flyoverReady=true; return }
    const { route, maptilerKey } = input

    const coords = route.geojson.coordinates
    if (!coords || coords.length < 2) {
      console.error('[anim] too few coords'); window.__flyoverError='no coords'; window.__flyoverReady=true; return
    }
    const cumulative = buildCumulative(coords)
    const totalKm = cumulative[cumulative.length - 1]
    const [mnLon, mnLat, mxLon, mxLat] = bbox(coords)
    const centerLon = (mnLon+mxLon)/2
    const centerLat = (mnLat+mxLat)/2
    console.log(`[anim] route ${route.title}: ${coords.length} coords, ${totalKm.toFixed(1)} km`)

    const selected = selectWaypoints(route.waypoints, coords)
    const schedule = buildSchedule(selected, coords, cumulative, totalKm)
    console.log(`[anim] schedule: ${schedule.map(s => `${s.wp.kind}@${s.startFrame}-${s.endFrame}`).join(', ')}`)

    // ====== Map setup ======
    // hybrid = satellite (imagen aérea real) + labels. Más vibrante e
    // inmersivo que outdoor-v2 (que es topo pálido).
    const style = `https://api.maptiler.com/maps/hybrid/style.json?key=${maptilerKey}`
    let map
    try {
      map = new maplibregl.Map({
        container: 'map',
        style,
        center: [centerLon, centerLat],
        zoom: 9,
        pitch: 25,
        bearing: -20,
        maxPitch: 80,
        interactive: false,
        attributionControl: false,
        renderWorldCopies: false,
        fadeDuration: 0,
      })
    } catch (e) {
      console.error(`[anim] map ctor failed: ${e.message}`); window.__flyoverError='map ctor'; window.__flyoverReady=true; return
    }
    map.on('error', e => console.error(`[anim] map err: ${e?.error?.message || JSON.stringify(e)}`))

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('map load timeout')), 30000)
      map.once('load', () => { clearTimeout(t); resolve() })
    })

    // ====== Terrain DEM 3D ======
    map.addSource('flyover-terrain-rgb', {
      type: 'raster-dem',
      url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${maptilerKey}`,
      tileSize: 256,
    })
    map.setTerrain({ source: 'flyover-terrain-rgb', exaggeration: 1.5 })

    // ====== Sources & layers para polyline + cursor + waypoint pin ======
    const flatCoords = coords.map(c => [c[0], c[1]])
    map.addSource('route-full', { type: 'geojson', data: { type:'Feature', geometry:{ type:'LineString', coordinates: flatCoords }, properties:{} }})
    map.addSource('route-progress', { type: 'geojson', data: { type:'Feature', geometry:{ type:'LineString', coordinates:[flatCoords[0]] }, properties:{} }})
    map.addSource('cursor', { type: 'geojson', data: { type:'Feature', geometry:{ type:'Point', coordinates: flatCoords[0] }, properties:{} }})
    map.addSource('wp-marker', { type: 'geojson', data: { type:'FeatureCollection', features: [] }})

    map.addLayer({
      id:'route-full-line', type:'line', source:'route-full',
      layout:{ 'line-cap':'round', 'line-join':'round' },
      paint:{ 'line-color':'#fff', 'line-opacity':0.22, 'line-width':4 },
    })
    map.addLayer({
      id:'route-progress-glow', type:'line', source:'route-progress',
      layout:{ 'line-cap':'round', 'line-join':'round' },
      paint:{ 'line-color':'#fbbf24', 'line-opacity':0.5, 'line-width':18, 'line-blur':10 },
    })
    map.addLayer({
      id:'route-progress-line', type:'line', source:'route-progress',
      layout:{ 'line-cap':'round', 'line-join':'round' },
      paint:{ 'line-color':'#fbbf24', 'line-width':7 },
    })
    map.addLayer({
      id:'wp-marker-glow', type:'circle', source:'wp-marker',
      paint:{ 'circle-radius':56, 'circle-color':'#06b6d4', 'circle-opacity':0.35, 'circle-blur':1.1 },
    })
    map.addLayer({
      id:'wp-marker-ring', type:'circle', source:'wp-marker',
      paint:{ 'circle-radius':28, 'circle-color':'rgba(0,0,0,0)', 'circle-stroke-color':'#06b6d4', 'circle-stroke-width':6 },
    })
    map.addLayer({
      id:'wp-marker-dot', type:'circle', source:'wp-marker',
      paint:{ 'circle-radius':12, 'circle-color':'#fff', 'circle-stroke-color':'#06b6d4', 'circle-stroke-width':3 },
    })
    map.addLayer({
      id:'cursor-glow', type:'circle', source:'cursor',
      paint:{ 'circle-radius':32, 'circle-color':'#fbbf24', 'circle-opacity':0.4, 'circle-blur':1 },
    })
    map.addLayer({
      id:'cursor-dot', type:'circle', source:'cursor',
      paint:{ 'circle-radius':12, 'circle-color':'#fff', 'circle-stroke-color':'#f59e0b', 'circle-stroke-width':3 },
    })

    // ====== Overlays static content ======
    const introEyebrow = document.getElementById('introEyebrow')
    introEyebrow.textContent = (route.location || 'Patagonia').toUpperCase()
    document.getElementById('introTitle').textContent = route.title
    document.getElementById('introDate').textContent = fmtDate(route.date)
    document.getElementById('outroLocation').textContent = (route.location || 'Patagonia').toUpperCase()
    document.getElementById('outroTitle').textContent = route.title
    document.getElementById('outroDate').textContent = fmtDate(route.date)
    // Outro stats con auto-fit per columna (column width = ~360px)
    function setOutroStat(id, text) {
      const el = document.getElementById(id)
      el.textContent = text
      const col = 340 // ancho útil por columna
      const ideal = col / (text.length * 0.6)
      el.style.fontSize = `${Math.min(86, ideal).toFixed(0)}px`
    }
    setOutroStat('outroKm', totalKm.toFixed(1))
    setOutroStat('outroDPlus', String(Math.round(route.elevation_gain_m || 0)))
    setOutroStat('outroTime', fmtDuration(route.duration_seconds))
    setOutroStat('outroWps', String(route.waypoints.length))

    // Auto-fit title basado en char-width real para italic Helvetica Black.
    // Para "Trilogía Punta Vera" (19 chars) en 132px italic bold el ancho
    // real es ~132 × 19 × 0.6 = 1505 px. Más ancho que el padding (900 px).
    function fitTitleSize(text, maxWidth, maxSize) {
      const charRatio = 0.6
      const ideal = maxWidth / (text.length * charRatio)
      return Math.min(maxSize, ideal)
    }
    const titleEl = document.getElementById('introTitle')
    titleEl.style.fontSize = `${fitTitleSize(route.title, 900, 132).toFixed(0)}px`
    const outroTitleEl = document.getElementById('outroTitle')
    outroTitleEl.style.fontSize = `${fitTitleSize(route.title, 900, 110).toFixed(0)}px`

    // Esperar tiles y terrain
    console.log('[anim] waiting for terrain + tiles…')
    await new Promise(resolve => setTimeout(resolve, 1500))
    if (!map.isStyleLoaded()) {
      await new Promise(resolve => map.once('idle', resolve))
    }
    await new Promise(resolve => setTimeout(resolve, 500))

    // ====== Estado ======
    let smoothedBearing = null

    function bearingFromLookahead(idx) {
      const ahead = Math.min(coords.length-1, idx + BEARING_LOOKAHEAD)
      if (ahead <= idx) return smoothedBearing || 0
      let dx=0, dy=0
      for (let i=idx; i<ahead; i++) { dx += coords[i+1][0]-coords[i][0]; dy += coords[i+1][1]-coords[i][1] }
      if (dx===0 && dy===0) return smoothedBearing || 0
      return Math.atan2(dx, dy) * 180 / Math.PI
    }

    // Pre-cargar fotos waypoints (URLs ya en route.waypoints[].photo_url)
    const photoCache = new Map()

    function setOverlayVisible(id, visible) {
      const el = document.getElementById(id)
      if (visible) el.classList.add('visible')
      else el.classList.remove('visible')
    }

    function showWaypoint(s, idx, total) {
      const wp = s.wp
      const el = document.getElementById('waypoint')
      el.style.display = 'flex'
      document.getElementById('wpEyebrow').textContent = (wp.title ? kindLabel(wp.kind) : '').toUpperCase()
      const headline = wp.title || kindLabel(wp.kind)
      const titleEl = document.getElementById('wpTitle')
      titleEl.textContent = headline
      // Card body width = 1080 - 80*2 - 18 - 144 - 22 - 18 = 720
      // body padding right = 80 (para badge), texto util = 640
      const targetW = 640
      const ideal = targetW / (headline.length * 0.6)
      titleEl.style.fontSize = `${Math.min(40, ideal).toFixed(0)}px`
      document.getElementById('wpMeta').textContent = wp.altitude_m != null ? `${Math.round(wp.altitude_m)} m` : ''
      document.getElementById('wpBadge').textContent = `${String(idx).padStart(2,'0')} / ${String(total).padStart(2,'0')}`
      const photoEl = document.getElementById('wpPhoto')
      if (wp.photo_url) {
        photoEl.src = wp.photo_url
        photoEl.style.display = 'block'
      } else {
        photoEl.style.display = 'none'
      }
      el.classList.add('visible')
    }
    function hideWaypoint() {
      const el = document.getElementById('waypoint')
      el.classList.remove('visible')
      el.style.display = 'none'
    }

    // Bearing inicial del recorrido (donde apunta al km 0).
    // Pre-cálculo para sincronizar intro→route sin salto de cámara.
    const initialRouteBearing = (function() {
      const ahead = Math.min(coords.length-1, BEARING_LOOKAHEAD)
      if (ahead <= 0) return 0
      let dx=0, dy=0
      for (let i=0; i<ahead; i++) { dx += coords[i+1][0]-coords[i][0]; dy += coords[i+1][1]-coords[i][1] }
      return Math.atan2(dx, dy) * 180 / Math.PI
    })()

    function renderFrame(f) {
      let waypointMarkerCoord = null

      if (f < INTRO_END) {
        const t = easeInOutCubic(f / INTRO_END)
        // Intro: arranca con overview del bbox y termina EXACTAMENTE en
        // los mismos valores con los que arranca el route phase (mismo
        // center, zoom 13.5, pitch 50, bearing initial). Sin salto.
        const startLon = coords[0][0], startLat = coords[0][1]
        map.jumpTo({
          center: [
            centerLon + (startLon - centerLon) * t,
            centerLat + (startLat - centerLat) * t,
          ],
          zoom: 9 + (13.5 - 9) * t,
          pitch: 25 + (50 - 25) * t,
          bearing: -30 + (initialRouteBearing - (-30)) * t,
        })
        setOverlayVisible('intro', f < INTRO_END - 8 ? true : false)
        setOverlayVisible('stats', false)
        hideWaypoint()
        setOverlayVisible('outro', false)
      } else if (f < ROUTE_END) {
        const routeT = (f - INTRO_END) / (ROUTE_END - INTRO_END)
        const km = totalKm * routeT
        const idx = findIdxForKm(cumulative, km)
        const here = interpolate(coords, cumulative, idx, km)

        const target = bearingFromLookahead(idx)
        if (smoothedBearing == null) smoothedBearing = target
        else {
          const delta = shortestArcDelta(smoothedBearing, target)
          const step = delta * BEARING_EMA_ALPHA
          const cap = Math.sign(step) * Math.min(Math.abs(step), BEARING_MAX_DELTA)
          smoothedBearing = (smoothedBearing + cap + 360) % 360
        }

        // Zoom 13.5 + pitch 50: cámara más alta, menos oclusión cuando
        // la ruta pasa detrás de un cerro. Ve más adelante el terreno.
        map.jumpTo({ center: here, zoom: 13.5, pitch: 50, bearing: smoothedBearing })

        // Update polyline progresiva
        const seg = coords.slice(0, idx+1).map(c => [c[0], c[1]])
        seg.push(here)
        map.getSource('route-progress').setData({ type:'Feature', geometry:{ type:'LineString', coordinates: seg }, properties:{} })
        map.getSource('cursor').setData({ type:'Feature', geometry:{ type:'Point', coordinates: here }, properties:{} })

        // Stats
        document.getElementById('statKm').textContent = km.toFixed(1)
        document.getElementById('statAlt').textContent = String(Math.round(coords[idx][2] || 0))
        document.getElementById('statDPlus').textContent = String(Math.round((route.elevation_gain_m || 0) * routeT))

        setOverlayVisible('intro', false)
        setOverlayVisible('stats', true)
        setOverlayVisible('outro', false)

        // Waypoint card schedule
        const active = schedule.find(s => f >= s.startFrame && f < s.endFrame)
        if (active) {
          waypointMarkerCoord = [active.wp.lon, active.wp.lat]
          const idxInSel = selected.findIndex(w => w.id === active.wp.id) + 1
          showWaypoint(active, idxInSel, selected.length)
        } else {
          hideWaypoint()
        }
      } else {
        const t = easeInOutCubic((f - ROUTE_END) / (OUTRO_END - ROUTE_END))
        map.jumpTo({
          center: [centerLon, centerLat],
          zoom: 12 - 2*t,
          pitch: 55 - 30*t,
          bearing: 0,
        })
        map.getSource('route-progress').setData({ type:'Feature', geometry:{ type:'LineString', coordinates: flatCoords }, properties:{} })

        setOverlayVisible('intro', false)
        setOverlayVisible('stats', false)
        hideWaypoint()
        setOverlayVisible('outro', f >= ROUTE_END + 4)
        // Ocultar watermark en outro — el outro ya tiene Rawko grande
        const wm = document.querySelector('.watermark')
        if (wm) wm.style.display = 'none'
      }

      // Marker del waypoint activo
      if (waypointMarkerCoord) {
        map.getSource('wp-marker').setData({
          type:'FeatureCollection',
          features:[{ type:'Feature', geometry:{ type:'Point', coordinates: waypointMarkerCoord }, properties:{} }],
        })
      } else {
        map.getSource('wp-marker').setData({ type:'FeatureCollection', features:[] })
      }
    }

    // Exponer al worker
    window.__totalFrames = TOTAL_FRAMES
    window.__renderFrame = async function(f) {
      renderFrame(f)
      // Esperar a que MapLibre quede idle (terrain + tiles ok)
      await Promise.race([
        new Promise(resolve => map.once('idle', resolve)),
        new Promise(resolve => setTimeout(resolve, 800)),
      ])
      await new Promise(resolve => requestAnimationFrame(() => resolve()))
      if (f >= TOTAL_FRAMES - 1) window.__flyoverComplete = true
    }
    console.log('[anim] ready')
    window.__flyoverReady = true
  }

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(main)
  } else {
    setTimeout(main, 100)
  }
})()
