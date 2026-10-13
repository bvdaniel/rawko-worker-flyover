// CLI de test: renderea una experience específica end-to-end sin
// requerir queue de Supabase. Útil para iterar el design del video.
//
// Uso:
//   npm run cli -- "Trilogía Punta Vera"     # busca por título de experience
//   npm run cli -- <route_uuid>              # ruta standalone por id
//   tsx src/cli.ts "Cerro Negro"

import 'dotenv/config'
import { supabase } from './supabase.js'
import { renderFlyover } from './render.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { OwnerData, RouteData } from './types.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function fetchOwner(userId: string | null): Promise<OwnerData | null> {
  if (!userId) return null
  const { data } = await supabase
    .from('users')
    .select('id, full_name, avatar_url')
    .eq('id', userId)
    .maybeSingle()
  return (data as OwnerData | null) ?? null
}

async function loadByTitle(title: string): Promise<RouteData | null> {
  const { data: exp } = await supabase
    .from('experiences')
    .select('id, title, date, location, activity_family, organizer_id')
    .ilike('title', `%${title}%`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!exp) return null

  const { data: routes } = await supabase
    .from('routes')
    .select(
      'id, source, route_geojson, route_distance_km, route_elevation_gain_m, ' +
        'duration_seconds, max_altitude_m, activity_family, owner_id',
    )
    .eq('experience_id', (exp as any).id)
  if (!routes || routes.length === 0) return null

  const route =
    (routes.find((r: any) => r.source === 'recorded') as any) ??
    (routes.find((r: any) => r.source === 'planned') as any)
  if (!route?.route_geojson) return null

  const { data: waypointRows } = await supabase
    .from('route_waypoints')
    .select('id, kind, lat, lon, altitude_m, title, photo_url, taken_at')
    .eq('route_id', route.id)
    .order('taken_at', { ascending: true })

  // Preferir owner_id de la ruta (autor real del recorrido) sobre
  // organizer_id de la experience (puede ser un guía distinto).
  const ownerId = (route as any).owner_id ?? (exp as any).organizer_id ?? null
  const owner = await fetchOwner(ownerId)

  return {
    route_id: route.id,
    experience_id: (exp as any).id,
    title: (exp as any).title,
    date: (exp as any).date,
    location: (exp as any).location,
    geojson: route.route_geojson,
    distance_km: route.route_distance_km,
    elevation_gain_m: route.route_elevation_gain_m,
    duration_seconds: route.duration_seconds,
    max_altitude_m: route.max_altitude_m,
    activity_family: (route as any).activity_family ?? (exp as any).activity_family ?? null,
    owner,
    waypoints: (waypointRows ?? []).map((w: any) => ({
      id: w.id,
      kind: w.kind,
      lat: Number(w.lat),
      lon: Number(w.lon),
      altitude_m: w.altitude_m,
      title: w.title,
      photo_url: w.photo_url,
      taken_at: w.taken_at,
    })),
  }
}

async function loadByRouteId(routeId: string): Promise<RouteData | null> {
  const { data: r } = await supabase
    .from('routes')
    .select(
      'id, experience_id, title, location, recorded_at, route_geojson, ' +
        'route_distance_km, route_elevation_gain_m, duration_seconds, ' +
        'max_altitude_m, activity_family, owner_id',
    )
    .eq('id', routeId)
    .maybeSingle()
  if (!(r as any)?.route_geojson) return null

  const { data: waypointRows } = await supabase
    .from('route_waypoints')
    .select('id, kind, lat, lon, altitude_m, title, photo_url, taken_at')
    .eq('route_id', routeId)
    .order('taken_at', { ascending: true })

  const owner = await fetchOwner((r as any).owner_id ?? null)

  return {
    route_id: (r as any).id,
    experience_id: (r as any).experience_id ?? null,
    title: (r as any).title ?? 'Ruta sin título',
    date: (r as any).recorded_at,
    location: (r as any).location,
    geojson: (r as any).route_geojson,
    distance_km: (r as any).route_distance_km,
    elevation_gain_m: (r as any).route_elevation_gain_m,
    duration_seconds: (r as any).duration_seconds,
    max_altitude_m: (r as any).max_altitude_m,
    activity_family: (r as any).activity_family ?? null,
    owner,
    waypoints: (waypointRows ?? []).map((w: any) => ({
      id: w.id,
      kind: w.kind,
      lat: Number(w.lat),
      lon: Number(w.lon),
      altitude_m: w.altitude_m,
      title: w.title,
      photo_url: w.photo_url,
      taken_at: w.taken_at,
    })),
  }
}

const arg = process.argv[2] ?? 'Trilogía Punta Vera'
const isUuid = UUID_RE.test(arg)
console.log(`[cli] cargando ${isUuid ? `route ${arg}` : `experience "${arg}"`}…`)
const route = isUuid ? await loadByRouteId(arg) : await loadByTitle(arg)
if (!route) {
  console.error(`[cli] no encontré ${isUuid ? 'la ruta' : 'la experience'} "${arg}"`)
  process.exit(1)
}
const label = isUuid ? route.route_id.slice(0, 8) : route.title.replace(/\s+/g, '-')
console.log(
  `[cli] ${route.title}: ${route.geojson.coordinates.length} coords, ${route.waypoints.length} waypoints, ` +
  `owner=${route.owner?.full_name ?? 'sin dueño'}`,
)

const result = await renderFlyover(route)
if (!result.success) {
  console.error(`[cli] FAIL: ${result.error}`)
  process.exit(1)
}

const dest = path.join(process.env.HOME ?? '/tmp', `Desktop/flyover-${label}.mp4`)
await fs.copyFile(result.output_path!, dest)
console.log(`[cli] DONE → ${dest}`)
