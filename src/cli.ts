import 'dotenv/config'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadRouteData } from './queue.js'
import { renderFlyover } from './render.js'

/**
 * Renderiza un flyover localmente sin tocar la queue. Útil para iterar
 * sobre la animación. Uso:
 *
 *   tsx src/cli.ts <experience_id> [output_dir]
 *
 * El MP4 queda en ./output/<experience_id>.mp4 por default.
 */

async function main() {
  const experienceId = process.argv[2]
  const outputDir = process.argv[3] ?? './output'
  if (!experienceId) {
    console.error('usage: tsx src/cli.ts <experience_id> [output_dir]')
    process.exit(1)
  }

  console.log(`[cli] loading route for experience ${experienceId}`)
  const route = await loadRouteData(experienceId)
  if (!route) {
    console.error('[cli] experience has no route data')
    process.exit(1)
  }
  console.log(
    `[cli] route loaded: ${route.title} | ${route.geojson.coordinates.length} points | ` +
    `${route.waypoints.length} waypoints`,
  )

  const result = await renderFlyover(route)
  if (!result.success || !result.output_path) {
    console.error('[cli] render failed:', result.error)
    process.exit(1)
  }

  await fs.mkdir(outputDir, { recursive: true })
  const destination = path.join(outputDir, `${experienceId}.mp4`)
  await fs.copyFile(result.output_path, destination)
  console.log(`[cli] done → ${destination}`)
  console.log(
    `[cli] ${result.frames_count} frames in ${result.duration_seconds?.toFixed(1)}s`,
  )
}

main().catch(err => {
  console.error('[cli] fatal', err)
  process.exit(1)
})
