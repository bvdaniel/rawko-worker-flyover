// Test rápido para validar si Chrome en este host puede usar la GPU
// para WebGL. Si vendor/renderer reporta "NVIDIA" → hardware acel.
// Si reporta "SwiftShader" o "Mesa software" → fallback software.

import puppeteer from 'puppeteer'

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=angle',
    '--use-angle=gl-egl',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
  ],
})

const page = await browser.newPage()
await page.goto('about:blank')

const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas')
  document.body.appendChild(c)
  const gl = c.getContext('webgl2')
  if (!gl) return { error: 'no webgl2 context' }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    vendor: gl.getParameter(gl.VENDOR),
    renderer: gl.getParameter(gl.RENDERER),
    unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
    unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
  }
})

console.log(JSON.stringify(gpu, null, 2))
await browser.close()
