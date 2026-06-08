import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

// Node < 22 no trae WebSocket nativo y supabase-js lo exige al construir el
// RealtimeClient (aunque este worker no usa realtime). Sin esto crashea al
// arrancar en Macs con Node 21. Shim global con `ws` — no-op si ya existe
// (Node 22+ / Railway).
if (typeof (globalThis as any).WebSocket === 'undefined') {
  ;(globalThis as any).WebSocket = ws as unknown as typeof WebSocket
}

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})
