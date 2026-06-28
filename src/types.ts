// Tipos compartidos entre el worker y la página de animación.

export interface FlyoverJob {
  id: string
  experience_id: string | null
  route_id: string | null
  requested_by: string | null
  status: 'pending' | 'processing' | 'done' | 'failed'
  output_url: string | null
  error_message: string | null
  retries: number
  next_attempt_at: string
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface RouteData {
  route_id: string
  experience_id: string | null
  title: string
  date: string | null
  location: string | null
  // GeoJSON LineString — coords son [lon, lat, alt?]
  geojson: {
    type: string
    coordinates: Array<[number, number, number?]>
  }
  distance_km: number | null
  elevation_gain_m: number | null
  duration_seconds: number | null
  max_altitude_m: number | null
  waypoints: WaypointData[]
}

export interface WaypointData {
  id: string
  kind: string
  lat: number
  lon: number
  altitude_m: number | null
  title: string | null
  photo_url: string | null
  taken_at: string | null
}

export interface RenderResult {
  success: boolean
  output_path?: string
  frames_count?: number
  duration_seconds?: number
  error?: string
}
