// CLI de test: renderea una experience específica end-to-end sin
// requerir queue de Supabase. Útil para iterar el design del video.
//
// Uso:
//   npm run cli -- "Trilogía Punta Vera"
//   tsx src/cli.ts "Cerro Negro"

import 'dotenv/config'
import { supabase } from './supabase.js'
import { renderFlyover } from './render.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RouteData } from './types.js'

async function loadByTitle(title: string): Promise<RouteData | null> {
  const { data: exp } = await supabase
    .from('experiences')
    .select('id, title, date, location')
    .ilike('title', `%${title}%`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!exp) return null

  const { data: routes } = await supabase
    .from('routes')
    .select(
      'id, source, route_geojson, route_distance_km, route_elevation_gain_m, ' +
        'duration_seconds, max_altitude_m',
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

const title = process.argv[2] ?? 'Trilogía Punta Vera'
console.log(`[cli] cargando "${title}"…`)
const route = await loadByTitle(title)
if (!route) {
  console.error(`[cli] no encontré la experience "${title}"`)
  process.exit(1)
}
console.log(`[cli] ${route.title}: ${route.geojson.coordinates.length} coords, ${route.waypoints.length} waypoints`)

const result = await renderFlyover(route)
if (!result.success) {
  console.error(`[cli] FAIL: ${result.error}`)
  process.exit(1)
}

const dest = path.join(process.env.HOME ?? '/tmp', `Desktop/flyover-${title.replace(/\s+/g, '-')}.mp4`)
await fs.copyFile(result.output_path!, dest)
console.log(`[cli] DONE → ${dest}`)
