import { supabase } from './supabase.js'
import type { FlyoverJob, RouteData } from './types.js'

/**
 * Reclama un job pending con SKIP LOCKED. Devuelve null si no hay
 * trabajo. El job queda marcado como processing hasta que llamemos
 * a markDone() o markFailed().
 */
export async function claimJob(): Promise<FlyoverJob | null> {
  const { data, error } = await supabase.rpc('claim_flyover_jobs', {
    batch_size: 1,
  })
  if (error) {
    console.error('[queue] claim_flyover_jobs error', error)
    return null
  }
  const rows = data as FlyoverJob[] | null
  if (!rows || rows.length === 0) return null
  return rows[0]
}

/**
 * Carga la data necesaria para renderear el video: geojson de la ruta,
 * waypoints (ordenados cronológicamente), metadata de la experience.
 */
export async function loadRouteData(experienceId: string): Promise<RouteData | null> {
  const { data: exp, error: expErr } = await supabase
    .from('experiences')
    .select('id, title, date, location')
    .eq('id', experienceId)
    .maybeSingle()
  if (expErr || !exp) return null

  // Preferimos la route recorded sobre la planned.
  const { data: routes, error: routesErr } = await supabase
    .from('routes')
    .select(
      'id, source, route_geojson, route_distance_km, route_elevation_gain_m, ' +
      'duration_seconds, max_altitude_m',
    )
    .eq('experience_id', experienceId)
  if (routesErr || !routes || routes.length === 0) return null
  const route =
    (routes.find(r => (r as any).source === 'recorded') as any) ??
    (routes.find(r => (r as any).source === 'planned') as any)
  if (!route?.route_geojson) return null

  const { data: waypointRows } = await supabase
    .from('route_waypoints')
    .select('id, kind, lat, lon, altitude_m, title, photo_url, taken_at')
    .eq('route_id', route.id)
    .order('taken_at', { ascending: true })

  return {
    route_id: route.id,
    experience_id: experienceId,
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

/**
 * Marca el job como done con la URL pública del MP4 + metricas.
 */
export async function markDone(
  jobId: string,
  outputUrl: string,
  framesCount: number,
  durationSeconds: number,
): Promise<void> {
  const { error } = await supabase.rpc('complete_flyover_job', {
    job_id: jobId,
    success: true,
    out_url: outputUrl,
    frames: framesCount,
    duration_sec: durationSeconds,
  })
  if (error) {
    console.error('[queue] complete (success) error', error)
  }
}

/**
 * Marca el job como failed. Si quedan retries, la RPC reagenda
 * automáticamente con backoff exponencial.
 */
export async function markFailed(jobId: string, errorMessage: string): Promise<void> {
  const { error } = await supabase.rpc('complete_flyover_job', {
    job_id: jobId,
    success: false,
    error_msg: errorMessage.slice(0, 500), // truncamos para no llenar la DB con stack traces
  })
  if (error) {
    console.error('[queue] complete (failed) error', error)
  }
}
