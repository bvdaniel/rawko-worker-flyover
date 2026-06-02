import puppeteer, { Browser, Page, CDPSession } from 'puppeteer'
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
const READY_TIMEOUT_MS = 30_000
const COMPLETE_TIMEOUT_MS = 90_000

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
 * Captura frames via CDP screencast — más eficiente que page.screenshot
 * en loop porque el browser empuja frames a la frecuencia que pidas sin
 * bloquear el thread de la página.
 */
async function captureFrames(
  page: Page,
  client: CDPSession,
  framesDir: string,
): Promise<number> {
  let frameIdx = 0
  let lastWritten = -1

  client.on('Page.screencastFrame', async event => {
    const idx = frameIdx++
    try {
      const buf = Buffer.from(event.data, 'base64')
      await fs.writeFile(
        path.join(framesDir, `frame-${idx.toString().padStart(5, '0')}.jpg`),
        buf,
      )
      lastWritten = idx
    } catch (e) {
      console.error('[render] frame write error', e)
    } finally {
      try {
        await client.send('Page.screencastFrameAck', { sessionId: event.sessionId })
      } catch {
        // El cliente puede haberse cerrado.
      }
    }
  })

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    everyNthFrame: 1,
    maxWidth: VIDEO_WIDTH,
    maxHeight: VIDEO_HEIGHT,
  })

  // Esperar a que la página marque __flyoverComplete = true.
  await page.waitForFunction('window.__flyoverComplete === true', {
    timeout: COMPLETE_TIMEOUT_MS,
  })

  // Margen para que los últimos frames lleguen al ack.
  await new Promise(resolve => setTimeout(resolve, 500))

  await client.send('Page.stopScreencast')

  // Otro margen pequeño por si quedan acks en cola.
  await new Promise(resolve => setTimeout(resolve, 300))

  return lastWritten + 1
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
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none',
        // Window size matches el output, así no hay scaling raro.
        `--window-size=${VIDEO_WIDTH},${VIDEO_HEIGHT}`,
      ],
      defaultViewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, deviceScaleFactor: 1 },
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    })
    const page = await browser.newPage()
    await page.setViewport({ width: VIDEO_WIDTH, height: VIDEO_HEIGHT, deviceScaleFactor: 1 })

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
    await page.waitForFunction('window.__flyoverReady === true', {
      timeout: READY_TIMEOUT_MS,
    })

    const client = await page.target().createCDPSession()
    const framesCount = await captureFrames(page, client, framesDir)

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
