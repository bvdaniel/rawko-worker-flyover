// Render con Chrome + puppeteer + MapLibre GL JS (browser).
//
// Razón del cambio vs maplibre-native: el binding Node de maplibre
// no expone setTerrain en su API (verificado en index.d.ts). MapLibre
// GL JS (browser) SÍ soporta terrain DEM 3D real. Mac con GPU dedicada
// puede correr Chrome headless con WebGL hardware acelerado.
//
// Trade-off: requiere Mac con GPU (no funciona en droplets sin GPU).
// Para producción: Mac local o GPU cloud.

import puppeteer, { type Browser, type Page } from 'puppeteer'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { RouteData, RenderResult } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const VIDEO_WIDTH = 1080
const VIDEO_HEIGHT = 1920
const FPS = 30
const TOTAL_FRAMES = 600
const READY_TIMEOUT_MS = 60_000

const MAPTILER_KEY = process.env.MAPTILER_KEY
if (!MAPTILER_KEY) {
  console.warn('[render] MAPTILER_KEY no set — tiles van a fallar')
}

// Servidor local HTTP para que Chrome cargue los assets via http://
// (file:// rompe algunos security policies)
function startStaticServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const publicDir = path.resolve(__dirname, '../public')
    const server = http.createServer(async (req, res) => {
      try {
        const url = req.url ?? '/'
        const filePath = path.join(
          publicDir,
          url === '/' ? 'flyover.html' : url.replace(/^\/+/, ''),
        )
        if (!filePath.startsWith(publicDir)) {
          res.writeHead(403).end()
          return
        }
        const data = await fs.readFile(filePath)
        const ext = path.extname(filePath).toLowerCase()
        const contentType =
          ext === '.html' ? 'text/html; charset=utf-8' :
          ext === '.js' ? 'application/javascript' :
          ext === '.css' ? 'text/css' :
          'application/octet-stream'
        res.writeHead(200, { 'Content-Type': contentType }).end(data)
      } catch {
        res.writeHead(404).end()
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, close: () => server.close() })
    })
  })
}

async function captureFrames(page: Page, framesDir: string): Promise<number> {
  const totalFrames = await page.evaluate(
    () => (globalThis as unknown as { __totalFrames?: number }).__totalFrames,
  )
  if (!totalFrames) throw new Error('window.__totalFrames not exposed')
  console.log(`[render] capturing ${totalFrames} frames…`)
  const t0 = Date.now()

  for (let f = 0; f < totalFrames; f++) {
    await page.evaluate(
      (frame: number) =>
        (globalThis as unknown as { __renderFrame: (f: number) => Promise<void> }).__renderFrame(frame),
      f,
    )
    const filePath = path.join(framesDir, `frame-${f.toString().padStart(5, '0')}.jpg`)
    await page.screenshot({
      path: filePath as `${string}.jpg`,
      type: 'jpeg',
      quality: 88,
    })
    if (f > 0 && f % 50 === 0) {
      const elapsed = (Date.now() - t0) / 1000
      const fps = f / elapsed
      console.log(`[render] frame ${f}/${totalFrames} (${fps.toFixed(1)}fps)`)
    }
  }
  console.log(`[render] all ${totalFrames} frames in ${((Date.now() - t0)/1000).toFixed(1)}s`)
  return totalFrames
}

function encodeMp4(framesDir: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-framerate', String(FPS),
      '-i', path.join(framesDir, 'frame-%05d.jpg'),
      '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=stereo',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-movflags', '+faststart',
      '-c:a', 'aac',
      '-shortest',
      '-crf', '25',
      '-preset', 'medium',
      outputPath,
    ])
    ff.stderr.on('data', () => {})
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))))
  })
}

export async function renderFlyover(route: RouteData): Promise<RenderResult> {
  const t0 = performance.now()
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flyover-'))
  const framesDir = path.join(tmpRoot, 'frames')
  await fs.mkdir(framesDir, { recursive: true })
  const outputPath = path.join(tmpRoot, 'flyover.mp4')

  const { port, close: closeServer } = await startStaticServer()
  let browser: Browser | null = null

  try {
    console.log(`[render] launching chrome…`)
    browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, deviceScaleFactor: 1 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--window-size=${VIDEO_WIDTH},${VIDEO_HEIGHT}`,
        '--ignore-gpu-blocklist',
        '--enable-webgl',
        '--font-render-hinting=none',
      ],
      protocolTimeout: 600_000,
    })
    const page = await browser.newPage()
    await page.setViewport({ width: VIDEO_WIDTH, height: VIDEO_HEIGHT, deviceScaleFactor: 1 })

    page.on('console', (msg) => {
      const t = msg.type()
      const text = msg.text()
      if (t === 'error' || t === 'warn') console.log(`[browser:${t}] ${text}`)
      else if (text.startsWith('[anim]')) console.log(`[browser] ${text}`)
    })
    page.on('pageerror', (err: unknown) => {
      const m = err instanceof Error ? err.message : String(err)
      console.log(`[browser:pageerror] ${m}`)
    })

    await page.evaluateOnNewDocument(
      (input: unknown) => {
        ;(globalThis as unknown as { __flyoverInput: unknown }).__flyoverInput = input
      },
      { route, maptilerKey: MAPTILER_KEY },
    )

    const url = `http://127.0.0.1:${port}/flyover.html`
    console.log(`[render] navigating to ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    try {
      await page.waitForFunction(
        () => (globalThis as unknown as { __flyoverReady?: boolean }).__flyoverReady === true,
        { timeout: READY_TIMEOUT_MS, polling: 250 },
      )
    } catch (waitErr) {
      const state = await page.evaluate(() => ({
        ready: (globalThis as unknown as { __flyoverReady?: boolean }).__flyoverReady,
        error: (globalThis as unknown as { __flyoverError?: string }).__flyoverError,
      }))
      console.log('[render] state at timeout:', JSON.stringify(state))
      throw waitErr
    }
    console.log('[render] anim ready')

    const framesCount = await captureFrames(page, framesDir)
    if (framesCount < TOTAL_FRAMES * 0.85) {
      throw new Error(`only ${framesCount}/${TOTAL_FRAMES} frames captured`)
    }

    console.log('[render] closing chrome…')
    await browser.close()
    browser = null

    console.log('[render] encoding mp4…')
    await encodeMp4(framesDir, outputPath)
    const durationSeconds = (performance.now() - t0) / 1000
    console.log(`[render] DONE in ${durationSeconds.toFixed(1)}s → ${outputPath}`)

    return {
      success: true,
      output_path: outputPath,
      frames_count: framesCount,
      duration_seconds: durationSeconds,
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[render] failed', error)
    return { success: false, error: msg }
  } finally {
    if (browser) await browser.close().catch(() => {})
    closeServer()
  }
}

export async function cleanupTmp(outputPath: string): Promise<void> {
  try {
    await fs.rm(path.dirname(outputPath), { recursive: true, force: true })
  } catch (e) {
    console.warn('[render] cleanup failed', e)
  }
}
