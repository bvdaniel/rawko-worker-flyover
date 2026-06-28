import { promises as fs } from 'node:fs'
import { supabase } from './supabase.js'
import type { FlyoverJob } from './types.js'

/**
 * Sube el MP4 al bucket flyovers. El path es por experience_id o
 * route_id para facilitar limpieza si la entidad padre se borra.
 */
export async function uploadFlyover(
  job: FlyoverJob,
  localPath: string,
): Promise<string> {
  const buf = await fs.readFile(localPath)
  const entityId = job.experience_id ?? job.route_id
  const remotePath = `${entityId}/${job.id}.mp4`
  const { error } = await supabase.storage
    .from('flyovers')
    .upload(remotePath, buf, {
      contentType: 'video/mp4',
      upsert: true,
      cacheControl: '3600',
    })
  if (error) throw error
  const { data } = supabase.storage.from('flyovers').getPublicUrl(remotePath)
  return data.publicUrl
}
