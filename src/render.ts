import puppeteer, { Browser, Page } from 'puppeteer-core'
import chromium from '@sparticuz/chromium'
import ffmpeg from 'fluent-ffmpeg'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import type { RouteData, RenderResult } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const VIDEO_WIDTH = 1080
const VIDEO_HEIGHT = 1920
const FPS = 30
const TOTAL_FRAMES = 900 // 30 segundos
const READY_TIMEOUT_MS = 60_000

const MAPTILER_KEY = process.env.MAPTILER_KEY
if (!MAPTILER_KEY) {
  console.warn('[render] MAPTILER_KEY not set — animation will fail to load tiles')
}

/**
 * Sirve los archivos de /public en un puerto local para que Puppeteer
 * los cargue con http:// (necesario para que MapLibre y los workers
 * funcionen — file:// rompe la security policy de muchos browsers).
 */
function startStaticServer(): Promise<{ port: number; close: () => void }> {
  return new Promise(resolve => {
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
      } catch (e) {
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

/**
 * Captura frames llamando a window.__renderFrame(f) y haciendo
 * page.screenshot por cada frame. 100% deterministic — no dependemos
 * del wall clock del headless Chromium (que en containers sin GPU
 * corre demasiado rápido y el screencast pierde frames).
 *
 * Más lento que screencast (~25-40ms/frame vs streaming) pero garantiza
 * que los 900 frames quedan grabados.
 */
async function captureFrames(page: Page, framesDir: string): Promise<number> {
  const totalFrames = (await page.evaluate(() => (window as any).__totalFrames)) as number
  if (!totalFrames) throw new Error('window.__totalFrames not exposed by animation')

  console.log(`[render] capturing ${totalFrames} frames…`)
  const t0 = Date.now()

  for (let f = 0; f < totalFrames; f++) {
    // Renderizar el frame en la página y esperar a que se aplique.
    await page.evaluate((frame: number) => {
      return (window as any).__renderFrame(frame)
    }, f)

    const filePath = path.join(framesDir, `frame-${f.toString().padStart(5, '0')}.jpg`)
    await page.screenshot({
      path: filePath as `${string}.jpg`,
      type: 'jpeg',
      quality: 88,
      omitBackground: false,
    })

    if (f > 0 && f % 100 === 0) {
      const elapsed = (Date.now() - t0) / 1000
      const fps = f / elapsed
      console.log(`[render] frame ${f}/${totalFrames} (${fps.toFixed(1)}fps)`)
    }
  }

  console.log(`[render] captured all ${totalFrames} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return totalFrames
}

/**
 * Encodea los JPEGs capturados en MP4 H.264 con audio silente. Usamos
 * silent audio porque algunas plataformas (Instagram, TikTok) detectan
 * "video sin audio" y meten ruido o piden re-encode.
 */
function encodeMp4(framesDir: string, outputPath: string, framesCount: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(framesDir, 'frame-%05d.jpg'))
      .inputFPS(FPS)
      .input('anullsrc=r=44100:cl=stereo')
      .inputFormat('lavfi')
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-pix_fmt yuv420p',
        '-profile:v high',
        '-level 4.0',
        '-movflags +faststart',
        '-r 30',
        '-shortest',
        // Calidad razonable; con CRF 22 obtenemos ~15-25 MB en 30s @1080p
        '-crf 22',
        '-preset medium',
      ])
      .save(outputPath)
      .on('end', () => resolve())
      .on('error', err => reject(err))
  })
}

export async function renderFlyover(route: RouteData): Promise<RenderResult> {
  const t0 = Date.now()
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flyover-'))
  const framesDir = path.join(tmpRoot, 'frames')
  await fs.mkdir(framesDir, { recursive: true })
  const outputPath = path.join(tmpRoot, 'flyover.mp4')

  const { port, close: closeServer } = await startStaticServer()
  let browser: Browser | null = null
  try {
    // Habilitamos WebGL via SwiftShader desde la configuración de
    // @sparticuz/chromium. Sin esto el package por default tiene
    // graphics deshabilitados para optimizar el cold start en Lambda.
    chromium.setGraphicsMode = true

    const executablePath = await chromium.executablePath()
    console.log(`[render] using chromium at ${executablePath}`)

    browser = await puppeteer.launch({
      executablePath,
      args: [
        ...chromium.args,
        // Forzamos resolución del output.
        `--window-size=${VIDEO_WIDTH},${VIDEO_HEIGHT}`,
        '--font-render-hinting=none',
      ],
      defaultViewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, deviceScaleFactor: 1 },
      headless: chromium.headless,
    })
    const page = await browser.newPage()
    await page.setViewport({ width: VIDEO_WIDTH, height: VIDEO_HEIGHT, deviceScaleFactor: 1 })

    // Forward de logs del browser al stdout para que en Railway veamos
    // qué pasa adentro de la página (errores de MapLibre, WebGL, fetch).
    page.on('console', msg => {
      const type = msg.type()
      const text = msg.text()
      if (type === 'error' || type === 'warn') {
        console.log(`[browser:${type}] ${text}`)
      } else if (text.startsWith('[anim]')) {
        console.log(`[browser] ${text}`)
      }
    })
    page.on('pageerror', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`[browser:pageerror] ${message}`)
    })
    page.on('requestfailed', req => {
      const u = req.url()
      // Solo logueamos los fallos relevantes (tiles, scripts).
      if (
        u.includes('maptiler') ||
        u.includes('unpkg.com') ||
        u.endsWith('.js') ||
        u.endsWith('.css')
      ) {
        console.log(`[browser:requestfailed] ${u} → ${req.failure()?.errorText}`)
      }
    })

    // Inyectar la data de la ruta antes de cargar la página.
    await page.evaluateOnNewDocument(
      (input: unknown) => {
        ;(window as any).__flyoverInput = input
      },
      { route, maptilerKey: MAPTILER_KEY },
    )

    const url = `http://127.0.0.1:${port}/flyover.html`
    console.log(`[render] navigating to ${url}`)
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 })

    // Esperar a que la animación marque ready (terrain cargado, fuentes ok).
    // Si falla, sacamos screenshot para debug.
    try {
      await page.waitForFunction('window.__flyoverReady === true', {
        timeout: READY_TIMEOUT_MS,
      })
    } catch (waitErr) {
      // Capturar estado actual para diagnosticar.
      const debugPath = path.join(tmpRoot, 'debug-not-ready.jpg')
      try {
        await page.screenshot({ path: debugPath as `${string}.jpg`, type: 'jpeg', quality: 80 })
        console.log(`[render] screenshot saved at ${debugPath}`)
      } catch {}
      const state = await page.evaluate(() => ({
        hasInput: typeof (window as any).__flyoverInput !== 'undefined',
        ready: (window as any).__flyoverReady,
        error: (window as any).__flyoverError,
        mapInit: typeof (window as any).maplibregl !== 'undefined',
      }))
      console.log('[render] page state at timeout:', JSON.stringify(state))
      throw waitErr
    }

    const framesCount = await captureFrames(page, framesDir)

    if (framesCount < TOTAL_FRAMES * 0.9) {
      throw new Error(
        `captured only ${framesCount}/${TOTAL_FRAMES} frames — animation likely failed`,
      )
    }

    console.log(`[render] captured ${framesCount} frames in ${(Date.now() - t0) / 1000}s`)

    await encodeMp4(framesDir, outputPath, framesCount)
    const durationSeconds = (Date.now() - t0) / 1000
    console.log(`[render] encoded MP4 in ${durationSeconds.toFixed(1)}s total`)

    return {
      success: true,
      output_path: outputPath,
      frames_count: framesCount,
      duration_seconds: durationSeconds,
    }
  } catch (error: any) {
    console.error('[render] failed', error)
    return { success: false, error: error?.message || String(error) }
  } finally {
    if (browser) await browser.close().catch(() => {})
    closeServer()
    // Mantenemos tmpRoot por si quien orquesta quiere subir el MP4
    // todavía. El caller debe llamar cleanup() después de subir.
  }
}

export async function cleanupTmp(outputPath: string): Promise<void> {
  try {
    const dir = path.dirname(outputPath)
    await fs.rm(dir, { recursive: true, force: true })
  } catch (e) {
    console.warn('[render] cleanup failed', e)
  }
}
