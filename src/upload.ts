import { promises as fs } from 'node:fs'
import { supabase } from './supabase.js'

/**
 * Sube el MP4 al bucket flyovers. El path es por experience_id para
 * facilitar limpieza si la experience se borra (no usamos triggers de
 * DB para borrar el archivo porque storage no tiene FK).
 */
export async function uploadFlyover(
  experienceId: string,
  jobId: string,
  localPath: string,
): Promise<string> {
  const buf = await fs.readFile(localPath)
  const remotePath = `${experienceId}/${jobId}.mp4`
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
