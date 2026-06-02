import 'dotenv/config'
import { claimJob, loadRouteData, markDone, markFailed } from './queue.js'
import { renderFlyover, cleanupTmp } from './render.js'
import { uploadFlyover } from './upload.js'

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000)

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function processOne(): Promise<boolean> {
  const job = await claimJob()
  if (!job) return false

  console.log(`[worker] claimed job ${job.id} for experience ${job.experience_id}`)
  const t0 = Date.now()

  try {
    const route = await loadRouteData(job.experience_id)
    if (!route) {
      await markFailed(job.id, 'experience has no route or geojson')
      return true
    }

    const result = await renderFlyover(route)
    if (!result.success || !result.output_path) {
      await markFailed(job.id, result.error ?? 'render failed')
      return true
    }

    const publicUrl = await uploadFlyover(job.experience_id, job.id, result.output_path)
    await markDone(
      job.id,
      publicUrl,
      result.frames_count ?? 0,
      result.duration_seconds ?? (Date.now() - t0) / 1000,
    )

    await cleanupTmp(result.output_path)
    console.log(
      `[worker] job ${job.id} done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${publicUrl}`,
    )
  } catch (error: any) {
    console.error(`[worker] job ${job.id} failed`, error)
    await markFailed(job.id, error?.message ?? String(error))
  }

  return true
}

async function main() {
  console.log(`[worker] starting (poll every ${POLL_INTERVAL_MS}ms)`)
  let consecutiveErrors = 0
  while (true) {
    try {
      const processed = await processOne()
      consecutiveErrors = 0
      if (!processed) {
        // Sin trabajo, esperar el polling interval.
        await sleep(POLL_INTERVAL_MS)
      } else {
        // Si proceso uno, intentar inmediatamente otro sin esperar.
        await sleep(500)
      }
    } catch (error) {
      consecutiveErrors++
      console.error('[worker] loop error', error)
      // Backoff exponencial si los errores siguen viniendo.
      const wait = Math.min(60_000, 1000 * Math.pow(2, consecutiveErrors))
      await sleep(wait)
    }
  }
}

main().catch(err => {
  console.error('[worker] fatal', err)
  process.exit(1)
})

// Graceful shutdown — Railway envía SIGTERM cuando hace deploy nuevo.
process.on('SIGTERM', () => {
  console.log('[worker] SIGTERM received, exiting')
  process.exit(0)
})
