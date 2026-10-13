// Coreografía del flyover renderizada con maplibre-gl-js en headless Chrome.
// Mac local con GPU real → terrain DEM 3D + WebGL hardware accelerated.
//
// El worker (puppeteer) llama a window.__renderFrame(f) para cada frame
// y toma screenshot. La animación NO usa rAF — la controla el worker
// determinísticamente.

(function () {
  const TOTAL_FRAMES = 630
  const FPS = 30
  const INTRO_END = 90   // 3s intro (caída desde órbita más pausada)
  const ROUTE_END = 540  // 15s recorrido
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
  const MONTHS_ES_SHORT = [
    'ene','feb','mar','abr','may','jun',
    'jul','ago','sep','oct','nov','dic',
  ]

  // Cursor guía por familia de actividad (prototipo emoji).
  // Cada emoji tiene una orientación natural distinta (Apple). La
  // dirección se resuelve con flip horizontal (scaleX) según el lado
  // del track, no con rotación — así el emoji nunca queda "cabeza abajo".
  const ACTIVITY_EMOJI = {
    pie: '',          // pie usa el círculo ámbar, no emoji
    bici: '',         // bici usa el círculo ámbar
    nieve: '',        // nieve usa el círculo ámbar
    agua: '🚣',
    cuerda: '',       // cuerda usa el círculo ámbar
    cabalgata: '',    // cabalgata usa el círculo ámbar
    parapente: '🪂',
    '4x4': '',        // 4x4 usa el círculo ámbar
  }
  // Orientación natural de cada emoji: 1 = "mira" a la derecha, -1 = mira
  // a la izquierda. Se multiplica por el flip del track para que siempre
  // apunte en la dirección de viaje.
  const ACTIVITY_EMOJI_BASE_FLIP = {
    pie: 1,
    bici: 1,
    nieve: 1,
    agua: 1,
    cuerda: 1,
    cabalgata: 1,
    parapente: 1,
    '4x4': 1,
  }
  // Zoom de la fase route por familia (el río necesita acercarse, la
  // cuerda/nieve son verticales y lentas, el vuelo y el camino más contexto).
  const ZOOM_BY_FAMILY = {
    agua: 14.5,
    parapente: 14.5,
    cuerda: 15,
    nieve: 14,
    bici: 13.5,
    cabalgata: 13,
    pie: 13,
    '4x4': 13.5,
  }

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
  // Easing "Google Earth": arranca rápido (whoosh) y decelera suave al
  // llegar. Da el efecto de "fly to" desde órbita.
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3) }
  // Un poco más agresivo que easeOutCubic: vuela más rápido al inicio y
  // se asienta con cushioning extra (más parecido a Google Earth real).
  function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4) }
  // Para el outro: arranca lento (lingera sobre la ruta) y acelera al
  // salir a órbita.
  function easeInCubic(t) { return t ** 3 }
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
    return `${d.getUTCDate()} ${MONTHS_ES_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`
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
      .filter(w => w.photo_url || (KIND_TIERS[w.kind] || 3) <= 2)
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

    // Preset de cámara por familia de actividad. El río necesita
    // acercarse (estrecho); el vehículo y el vuelo, más contexto.
    const ROUTE_FAMILY = route.activity_family || ''
    const IS_WATER = ROUTE_FAMILY === 'agua'
    const ROUTE_PHASE_ZOOM = ZOOM_BY_FAMILY[ROUTE_FAMILY] ?? (IS_WATER ? 14.5 : 13.5)
    const ROUTE_PHASE_PITCH = IS_WATER ? 55 : 50

    // Formato "cinta de agua": para rutas de agua dibujamos el trazo
    // completo como una banda azul (el río) en vez de una línea blanca
    // fina. El progreso se dibuja encima como espuma/blanca. Así el agua
    // se lee aunque el río real sea angosto en el satélite.
    const ROUTE_FULL_COLOR = IS_WATER ? '#0ea5e9' : '#ffffff'
    const ROUTE_FULL_OPACITY = IS_WATER ? 0.55 : 0.22
    const ROUTE_FULL_WIDTH = IS_WATER ? 16 : 4
    const PROGRESS_COLOR = IS_WATER ? '#f0f9ff' : '#fbbf24'
    const PROGRESS_GLOW_COLOR = IS_WATER ? '#38bdf8' : '#fbbf24'

    // Cursor guía por disciplina: emoji (dirección vía flip en renderFrame).
    // `emoji_override` fuerza un emoji en tests. Si la familia no tiene
    // emoji (pie), el cursor vuelve al círculo ámbar.
    const CURSOR_EMOJI = route.emoji_override || ACTIVITY_EMOJI[ROUTE_FAMILY] || ''
    const USE_EMOJI = CURSOR_EMOJI.length > 0
    const BASE_FLIP = ACTIVITY_EMOJI_BASE_FLIP[ROUTE_FAMILY] ?? 1
    const cursorEl = document.getElementById('cursorEmoji')
    if (cursorEl) cursorEl.textContent = CURSOR_EMOJI

    console.log(`[anim] route ${route.title}: ${coords.length} coords, ${totalKm.toFixed(1)} km, family=${ROUTE_FAMILY || '(none)'}, zoom=${ROUTE_PHASE_ZOOM}, pitch=${ROUTE_PHASE_PITCH}`)

    // ====== Map setup ======
    // hybrid = satellite (imagen aérea real) + labels. Más vibrante e
    // inmersivo que outdoor-v2 (que es topo pálido). Si el style falla
    // en cargar (algún recurso 404ea en ciertas zonas), caemos a
    // outdoor-v2 que es más liviano, antes de rendir el job.
    const baseStyle = `https://api.maptiler.com/maps`
    const styles = [
      { name: 'hybrid', url: `${baseStyle}/hybrid/style.json?key=${maptilerKey}` },
      { name: 'outdoor-v2', url: `${baseStyle}/outdoor-v2/style.json?key=${maptilerKey}` },
    ]
    const STYLE_LOAD_TIMEOUT_MS = 25000

    let map = null
    let activeStyle = null
    for (const s of styles) {
      console.log(`[anim] loading style ${s.name}…`)
      let attempt
      try {
        attempt = new maplibregl.Map({
          container: 'map',
          style: s.url,
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
        console.error(`[anim] map ctor failed (${s.name}): ${e.message}`)
        continue
      }
      attempt.on('error', e => console.error(`[anim] map err (${s.name}): ${e?.error?.message || JSON.stringify(e)}`))

      let ok = false
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`${s.name} map load timeout`)), STYLE_LOAD_TIMEOUT_MS)
          attempt.once('load', () => { clearTimeout(t); resolve() })
        })
        ok = true
      } catch {
        ok = false
      }

      if (ok) {
        map = attempt
        activeStyle = s.name
        console.log(`[anim] style ${s.name} loaded`)
        break
      }
      attempt.remove()
    }

    if (!map) {
      console.error('[anim] all styles failed to load')
      window.__flyoverError = 'map load timeout'
      window.__flyoverReady = true
      return
    }
    void activeStyle

    // ====== Apagar labels del mapa ======
    // El spec pide que el terreno se vea pero los nombres no. Ocultamos
    // toda capa `symbol` (texto + íconos de POI/places) del style base.
    // Nuestras capas (polylines + cursor) se agregan después, no se tocan.
    let hiddenLabels = 0
    for (const layer of map.getStyle().layers) {
      if (layer.type === 'symbol') {
        try {
          map.setLayoutProperty(layer.id, 'visibility', 'none')
          hiddenLabels++
        } catch (e) {
          console.error(`[anim] hide label ${layer.id} failed: ${e.message}`)
        }
      }
    }
    console.log(`[anim] hidden ${hiddenLabels} label layers`)

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
    map.addSource('wp-marker', { type: 'geojson', data: { type:'FeatureCollection', features: [] }})

    map.addLayer({
      id:'route-full-line', type:'line', source:'route-full',
      layout:{ 'line-cap':'round', 'line-join':'round' },
      paint:{ 'line-color':ROUTE_FULL_COLOR, 'line-opacity':ROUTE_FULL_OPACITY, 'line-width':ROUTE_FULL_WIDTH },
    })
    map.addLayer({
      id:'route-progress-glow', type:'line', source:'route-progress',
      layout:{ 'line-cap':'round', 'line-join':'round' },
      paint:{ 'line-color':PROGRESS_GLOW_COLOR, 'line-opacity':0.5, 'line-width':18, 'line-blur':10 },
    })
    map.addLayer({
      id:'route-progress-line', type:'line', source:'route-progress',
      layout:{ 'line-cap':'round', 'line-join':'round' },
      paint:{ 'line-color':PROGRESS_COLOR, 'line-width':7 },
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

    // Cursor ámbar (usado cuando NO hay emoji, p.ej. familia 'pie').
    map.addSource('cursor', { type: 'geojson', data: { type:'Feature', geometry:{ type:'Point', coordinates: flatCoords[0] }, properties:{} }})
    map.addLayer({
      id:'cursor-glow', type:'circle', source:'cursor',
      layout:{ visibility: USE_EMOJI ? 'none' : 'visible' },
      paint:{ 'circle-radius':32, 'circle-color':'#fbbf24', 'circle-opacity':0.4, 'circle-blur':1 },
    })
    map.addLayer({
      id:'cursor-dot', type:'circle', source:'cursor',
      layout:{ visibility: USE_EMOJI ? 'none' : 'visible' },
      paint:{ 'circle-radius':12, 'circle-color':'#fff', 'circle-stroke-color':'#f59e0b', 'circle-stroke-width':3 },
    })

    // ====== Overlays static content ======
    const locationLabel = (route.location || 'Patagonia').toUpperCase()
    document.getElementById('introEyebrow').textContent = locationLabel
    document.getElementById('introTitle').textContent = route.title
    document.getElementById('introDate').textContent = fmtDate(route.date)
    document.getElementById('outroEyebrow').textContent = locationLabel
    document.getElementById('outroTitle').textContent = route.title
    document.getElementById('outroDate').textContent = fmtDate(route.date)

    // ====== Atribución (dueño de la ruta) ======
    // Pill flotante debajo del bloque de stats (top-left) durante el
    // recorrido + card centrada en el outro. Si el dueño no tiene
    // avatar, solo omitimos la foto pero mantenemos nombre + @rawko.
    const statsOwnerEl = document.getElementById('statsOwner')
    const outroOwnerEl = document.getElementById('outroOwnerCard')
    const ownerName = route.owner?.full_name ?? 'Aventurero Rawko'

    if (route.owner) {
      const statsAvatar = document.getElementById('statsOwnerAvatar')
      if (route.owner.avatar_url) {
        statsAvatar.src = route.owner.avatar_url
        statsAvatar.style.display = ''
      } else {
        statsAvatar.style.display = 'none'
      }
      document.getElementById('statsOwnerName').textContent = ownerName

      // Outro card: centrado, avatar solo si existe.
      const outroAvatar = document.getElementById('outroOwnerAvatar')
      if (route.owner.avatar_url) {
        outroAvatar.src = route.owner.avatar_url
        outroAvatar.style.display = ''
      } else {
        outroAvatar.style.display = 'none'
      }
      document.getElementById('outroOwnerName').textContent = ownerName
    } else {
      // Sin dueño (ruta huérfana): sin pill ni card outro.
      if (statsOwnerEl) statsOwnerEl.remove()
      if (outroOwnerEl) outroOwnerEl.remove()
    }

    // Outro stats con auto-fit por celda. Números siempre en blanco.
    function setOutroStat(id, text) {
      const el = document.getElementById(id)
      el.textContent = text
      const col = 800 // ancho útil por celda
      const ideal = col / (text.length * 0.58)
      el.style.fontSize = `${Math.min(80, ideal).toFixed(0)}px`
    }
    setOutroStat('outroKm', totalKm.toFixed(1))
    setOutroStat('outroDPlus', '+' + Math.round(route.elevation_gain_m || 0))
    setOutroStat('outroTime', fmtDuration(route.duration_seconds))

    // Cuarto valor: hitos; si 0 → altitud máxima; si tampoco hay, ocultar.
    const wpCount = route.waypoints.length
    const maxAlt = route.max_altitude_m
    const wpsCell = document.getElementById('outroWpsCell')
    if (wpCount > 0) {
      setOutroStat('outroWps', String(wpCount))
      document.getElementById('outroWpsLabel').textContent = 'hitos'
    } else if (maxAlt != null) {
      setOutroStat('outroWps', String(Math.round(maxAlt)))
      document.getElementById('outroWpsLabel').textContent = 'm máx'
    } else {
      wpsCell.style.display = 'none'
    }

    // ====== Selección + schedule de waypoints (hitos) ======
    const selected = selectWaypoints(route.waypoints, coords)
    const schedule = buildSchedule(selected, coords, cumulative, totalKm)
    console.log(`[anim] schedule: ${schedule.map(s => `${s.wp.kind}@${s.startFrame}-${s.endFrame}`).join(', ')}`)

    // Pre-cargar fotos de los waypoints seleccionados. Al crear un
    // `new Image()` con el mismo src que después usa el <img> del card,
    // el browser cachea el bitmap y la foto aparece al instante cuando
    // showWaypoint() la asigna. Sin esto, hay 1-3 frames de delay
    // mientras el fetch compite con el render del frame.
    for (const s of schedule) {
      if (s.wp.photo_url) new Image().src = s.wp.photo_url
    }

    // Esperar tiles y terrain
    console.log('[anim] waiting for terrain + tiles…')
    await new Promise(resolve => setTimeout(resolve, 1500))
    if (!map.isStyleLoaded()) {
      await new Promise(resolve => map.once('idle', resolve))
    }
    await new Promise(resolve => setTimeout(resolve, 500))

    // ====== Estado ======
    let smoothedBearing = null
    let cursorSide = 'right'

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
      if (!el) return
      if (visible) el.classList.add('visible')
      else el.classList.remove('visible')
    }

    function showWaypoint(s, idx, total) {
      const wp = s.wp
      const el = document.getElementById('waypoint')
      if (!el) return
      el.style.display = 'flex'
      document.getElementById('wpEyebrow').textContent = (wp.title ? kindLabel(wp.kind) : '').toUpperCase()
      const headline = wp.title || kindLabel(wp.kind)
      const titleEl = document.getElementById('wpTitle')
      titleEl.textContent = headline
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
      if (!el) return
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
        const t = easeOutQuart(f / INTRO_END)
        // Intro estilo Google Earth: arranca desde órbita (zoom 3.5,
        // pitch 0, vista cenital de toda la región) y "vuela" hasta el
        // inicio de la ruta inclinando la cámara. Termina EXACTAMENTE en
        // los valores del route phase para no saltar.
        const startLon = coords[0][0], startLat = coords[0][1]
        map.jumpTo({
          center: [
            centerLon + (startLon - centerLon) * t,
            centerLat + (startLat - centerLat) * t,
          ],
          zoom: 3.5 + (ROUTE_PHASE_ZOOM - 3.5) * t,
          pitch: 0 + (ROUTE_PHASE_PITCH - 0) * t,
          bearing: -30 + (initialRouteBearing - (-30)) * t,
        })
        // Círculo de inicio de ruta: aparece cuando la cámara se asienta.
        const dot = document.getElementById('startDot')
        if (f >= INTRO_END - 40) {
          const p = map.project([startLon, startLat])
          dot.style.left = `${p.x}px`
          dot.style.top = `${p.y}px`
          dot.classList.add('visible')
        } else {
          dot.classList.remove('visible')
        }
        setOverlayVisible('intro', f < INTRO_END - 8 ? true : false)
        setOverlayVisible('stats', false)
        setOverlayVisible('statsOwner', false)
        setOverlayVisible('outro', false)
        if (cursorEl) cursorEl.classList.remove('visible')
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

        // Zoom/pitch según familia de actividad. Cámara más alta para
        // tierra (menos oclusión detrás de cerros), más cerca para agua.
        map.jumpTo({ center: here, zoom: ROUTE_PHASE_ZOOM, pitch: ROUTE_PHASE_PITCH, bearing: smoothedBearing })

        // Update polyline progresiva
        const seg = coords.slice(0, idx+1).map(c => [c[0], c[1]])
        seg.push(here)
        map.getSource('route-progress').setData({ type:'Feature', geometry:{ type:'LineString', coordinates: seg }, properties:{} })

        // Cursor guía: emoji con flip horizontal según el lado del track,
        // o círculo ámbar (MapLibre) cuando no hay emoji (familia 'pie').
        // Histeresis con umbral 2px para evitar jitter en cruces verticales.
        map.getSource('cursor').setData({ type:'Feature', geometry:{ type:'Point', coordinates: here }, properties:{} })
        if (USE_EMOJI && cursorEl) {
          const cp = map.project(here)
          cursorEl.style.left = `${cp.x}px`
          cursorEl.style.top = `${cp.y}px`
          const aheadIdx = Math.min(idx + 8, coords.length - 1)
          const ap = map.project([coords[aheadIdx][0], coords[aheadIdx][1]])
          const goingLeft = (ap.x - cp.x) < -2
          if (goingLeft && cursorSide === 'right') cursorSide = 'left'
          else if (!goingLeft && cursorSide === 'left') cursorSide = 'right'
          const flip = (cursorSide === 'left' ? -1 : 1) * BASE_FLIP
          cursorEl.style.transform = `scaleX(${flip})`
          cursorEl.classList.add('visible')
        } else if (cursorEl) {
          cursorEl.classList.remove('visible')
        }

        // Stats (barra inferior) + regla de progreso
        document.getElementById('statKm').textContent = km.toFixed(1)
        document.getElementById('statAlt').textContent = String(Math.round(coords[idx][2] || 0))
        document.getElementById('statDPlus').textContent = '+' + Math.round((route.elevation_gain_m || 0) * routeT)
        document.getElementById('statsProgress').style.width = `${(routeT * 100).toFixed(1)}%`

        document.getElementById('startDot').classList.remove('visible')
        setOverlayVisible('intro', false)
        setOverlayVisible('stats', true)
        setOverlayVisible('statsOwner', true)
        setOverlayVisible('outro', false)

        // Waypoint card schedule: mostrar la card + pin cuando la cámara
        // pasa por un hito seleccionado.
        const active = schedule.find(s => f >= s.startFrame && f < s.endFrame)
        if (active) {
          waypointMarkerCoord = [active.wp.lon, active.wp.lat]
          const idxInSel = selected.findIndex(w => w.id === active.wp.id) + 1
          showWaypoint(active, idxInSel, selected.length)
        } else {
          hideWaypoint()
        }
      } else {
        const t = easeInCubic((f - ROUTE_END) / (OUTRO_END - ROUTE_END))
        // Outro estilo Google Earth: lingera un instante y sale de vuelta
        // a órbita (zoom 3.5, pitch 0) como bookend del intro.
        map.jumpTo({
          center: [centerLon, centerLat],
          zoom: ROUTE_PHASE_ZOOM - (ROUTE_PHASE_ZOOM - 3.5) * t,
          pitch: ROUTE_PHASE_PITCH - (ROUTE_PHASE_PITCH - 0) * t,
          bearing: 0,
        })
        map.getSource('route-progress').setData({ type:'Feature', geometry:{ type:'LineString', coordinates: flatCoords }, properties:{} })

        document.getElementById('startDot').classList.remove('visible')
        setOverlayVisible('intro', false)
        setOverlayVisible('stats', false)
        setOverlayVisible('statsOwner', false)
        setOverlayVisible('outro', f >= ROUTE_END + 4)
        if (cursorEl) cursorEl.classList.remove('visible')
        hideWaypoint()
      }

      // Marker del waypoint activo (pin pulsante en el mapa).
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
