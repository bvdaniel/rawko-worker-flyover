import 'dotenv/config'
import { claimJob, loadRouteData, markDone, markFailed } from './queue.js'
import { renderFlyover, cleanupTmp, InfraChromeMissingError } from './render.js'
import { uploadFlyover } from './upload.js'

// Forzar line-buffered stdout para que los logs aparezcan en journald
// inmediatamente. Sin esto, Node bufferea por bloque cuando stdout no
// es TTY y los logs no llegan al journal hasta que el buffer se llena
// o el proceso muere.
if ((process.stdout as any)._handle?.setBlocking) {
  ;(process.stdout as any)._handle.setBlocking(true)
}
if ((process.stderr as any)._handle?.setBlocking) {
  ;(process.stderr as any)._handle.setBlocking(true)
}

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000)

// Backoff progresivo para errores de infraestructura (Chrome faltante,
// red a Supabase caída). No queremos quemar los 3 reintentos del job ni
// loopear a 30s: 10min → 30min → 1h → 2h → 4h (cap).
const INFRA_BACKOFF_MS = [
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  120 * 60_000,
  240 * 60_000,
]

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Estado de backoff de infra a nivel worker. Se resetea en cuanto
// cualquier cosa (claim o render) tiene éxito.
let infraBackoffIdx = 0

async function processOne(): Promise<boolean> {
  const job = await claimJob()
  if (!job) return false

  const targetId = job.experience_id ?? job.route_id
  console.log(`[worker] claimed job ${job.id} for ${job.experience_id ? 'experience' : 'route'} ${targetId}`)
  const t0 = Date.now()

  try {
    const route = await loadRouteData(job)
    if (!route) {
      await markFailed(job.id, 'experience has no route or geojson')
      return true
    }

    const result = await renderFlyover(route)
    if (!result.success || !result.output_path) {
      await markFailed(job.id, result.error ?? 'render failed')
      return true
    }

    // Chrome levantó y renderizó → infra sana, resetear backoff.
    infraBackoffIdx = 0

    const publicUrl = await uploadFlyover(job, result.output_path)
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
    if (error instanceof InfraChromeMissingError) {
      // Infra local rota, no culpa de la ruta. NO consumir reintentos:
      // dejamos el job en 'processing', hacemos backoff progresivo y el
      // próximo poll lo vuelve a intentar con Chrome ya arreglado.
      const wait = INFRA_BACKOFF_MS[Math.min(infraBackoffIdx, INFRA_BACKOFF_MS.length - 1)]
      console.error(
        `[worker] chrome missing for job ${job.id} — backoff ${Math.round(wait / 60_000)}min (infra attempt ${infraBackoffIdx + 1}). Job queda en processing.`,
      )
      infraBackoffIdx++
      await sleep(wait)
      return true
    }
    // Cualquier otro error (de la ruta o lógica) consume un reintento
    // normal vía complete_flyover_job.
    infraBackoffIdx = 0
    console.error(`[worker] job ${job.id} failed`, error)
    await markFailed(job.id, error?.message ?? String(error))
  }

  return true
}

async function main() {
  console.log(`[worker] starting (poll every ${POLL_INTERVAL_MS}ms)`)
  let consecutiveErrors = 0
  let idleTicks = 0
  while (true) {
    try {
      const processed = await processOne()
      consecutiveErrors = 0
      if (!processed) {
        // Loguear cada 10 polls cuando está idle, así sabemos que el
        // worker está vivo y polleando aunque no haya trabajo.
        idleTicks++
        if (idleTicks % 10 === 1) {
          console.log(`[worker] no jobs available (${idleTicks} consecutive idle polls)`)
        }
        await sleep(POLL_INTERVAL_MS)
      } else {
        idleTicks = 0
        // Si proceso uno, intentar inmediatamente otro sin esperar.
        await sleep(500)
      }
    } catch (error) {
      consecutiveErrors++
      console.error('[worker] loop error', error)
      // Backoff exponencial si los errores siguen viniendo (errores de
      // red en claimJob() ahora sí llegan acá vía re-throw).
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
