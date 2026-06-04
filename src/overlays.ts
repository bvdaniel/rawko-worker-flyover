// Overlays editoriales SVG. Sharp los rasteriza y composita encima del
// frame del mapa. 1080×1920 vertical, ámbar Rawko (#fbbf24) como acento.
//
// Bloques: title (intro), stats (route), waypoint (cards), outro.

function escapeXml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Font-size que asegura entrada en maxWidth px. widthRatio depende del
// font (Helvetica ≈ 0.55, Georgia bold ≈ 0.58).
function fitFontSize(
  text: string | undefined,
  maxWidth: number,
  maxFontSize: number,
  widthRatio = 0.58,
): number {
  const len = (text ?? '').length
  if (len === 0) return maxFontSize
  return Math.min(maxFontSize, maxWidth / (len * widthRatio))
}

const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

export function fmtDateEs(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`
}

export function fmtDurationEs(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`
  return `${m}m`
}

// Kinds reales de DB (snake_case)
const KIND_LABELS: Record<string, string> = {
  cumbre: 'Cumbre',
  camping: 'Camping',
  cruce_rio: 'Cruce de río',
  agua_potable: 'Agua potable',
  mirador: 'Mirador',
  puente: 'Puente',
  peligro: 'Peligro',
  descanso: 'Descanso',
  foto: 'Foto',
  tranquera: 'Tranquera',
}

export function kindLabelEs(kind: string | null | undefined): string {
  return KIND_LABELS[kind ?? ''] ?? 'Hito'
}

// Prioridad para distribuir waypoints en el video. Tier 1 = épico/útil.
const KIND_TIERS: Record<string, number> = {
  cumbre: 1, camping: 1, cruce_rio: 1, agua_potable: 1,
  mirador: 2, puente: 2, peligro: 2,
  descanso: 3, foto: 3, tranquera: 3,
}

export function kindTier(kind: string | null | undefined): number {
  return KIND_TIERS[kind ?? ''] ?? 3
}

export interface SvgTitleOpts {
  eyebrow?: string | null
  title?: string | null
  sub?: string | null
  opacity?: number
}

export function svgTitle(opts: SvgTitleOpts): string {
  const { eyebrow, title, sub, opacity = 1 } = opts
  const titleFontSize = fitFontSize(title ?? '', 880, 120, 0.6)
  const eyebrowText = escapeXml((eyebrow ?? '').toUpperCase())
  const eyebrowSize = 26
  const eyebrowLetterSpacing = 8
  const eyebrowApproxW = eyebrowText.length * (eyebrowSize * 0.55 + eyebrowLetterSpacing)
  const eyebrowLineLen = (900 - eyebrowApproxW) / 2 - 30
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
  <defs>
    <filter id="textShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="5"/>
      <feOffset dx="0" dy="3"/>
      <feFlood flood-color="black" flood-opacity="0.75"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
  </defs>
  <g opacity="${opacity}">
    ${eyebrowLineLen > 30 ? `<rect x="90" y="278" width="${eyebrowLineLen}" height="2" fill="#fbbf24" opacity="0.85"/>` : ''}
    <text x="540" y="290" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${eyebrowSize}" font-weight="800" letter-spacing="${eyebrowLetterSpacing}" fill="#fbbf24" filter="url(#textShadow)">${eyebrowText}</text>
    ${eyebrowLineLen > 30 ? `<rect x="${1080 - 90 - eyebrowLineLen}" y="278" width="${eyebrowLineLen}" height="2" fill="#fbbf24" opacity="0.85"/>` : ''}
    <text x="540" y="455" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${titleFontSize.toFixed(0)}" font-weight="900" font-style="italic" fill="white" filter="url(#textShadow)">${escapeXml(title ?? '')}</text>
    <text x="540" y="540" text-anchor="middle" font-family="Georgia, serif" font-size="34" font-style="italic" fill="rgba(255,255,255,0.92)" filter="url(#textShadow)">${escapeXml(sub ?? '')}</text>
    <rect x="490" y="580" width="100" height="3" fill="#fbbf24"/>
  </g>
</svg>
`
}

export interface SvgStatsOpts {
  km: number
  alt: number
  dPlus: number
  opacity?: number
}

// Stats UP TOP con fondo casi transparente (35% opacidad) + texto con
// shadow para mantener legibilidad sobre cualquier zona del mapa.
export function svgStats(opts: SvgStatsOpts): string {
  const { km, alt, dPlus, opacity = 1 } = opts
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
  <defs>
    <filter id="ts" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="3"/>
      <feOffset dx="0" dy="2"/>
      <feFlood flood-color="black" flood-opacity="0.85"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
  </defs>
  <g opacity="${opacity}">
    <rect x="60" y="200" rx="32" ry="32" width="960" height="160" fill="rgba(0,0,0,0.32)"/>
    <rect x="380" y="240" width="2" height="80" fill="rgba(251,191,36,0.65)"/>
    <rect x="700" y="240" width="2" height="80" fill="rgba(251,191,36,0.65)"/>
    <g font-family="Helvetica, Arial, sans-serif" fill="white" text-anchor="middle" filter="url(#ts)">
      <text x="220" y="285" font-size="72" font-weight="900" font-style="italic">${km.toFixed(1)}</text>
      <text x="220" y="330" font-size="20" font-weight="900" letter-spacing="7" fill="#fbbf24">KM</text>
      <text x="540" y="285" font-size="72" font-weight="900" font-style="italic">${Math.round(alt)}</text>
      <text x="540" y="330" font-size="20" font-weight="900" letter-spacing="7" fill="#fbbf24">M ALT</text>
      <text x="860" y="285" font-size="72" font-weight="900" font-style="italic">${Math.round(dPlus)}</text>
      <text x="860" y="330" font-size="20" font-weight="900" letter-spacing="7" fill="#fbbf24">M D+</text>
    </g>
  </g>
</svg>
`
}

export interface SvgWaypointOpts {
  kindLabel: string
  customTitle: string | null
  meta?: string
  opacity?: number
  hasPhoto?: boolean
  index?: number | null
  total?: number | null
}

export function svgWaypoint(opts: SvgWaypointOpts): string {
  const { kindLabel, customTitle, meta, opacity = 1, hasPhoto = false, index = null, total = null } = opts
  // Card debajo del bloque de stats (que ahora está a y=200-360).
  // Posición y=420 deja la mitad inferior libre para UI de Reels.
  const cardX = 60
  const cardY = 420
  const cardW = 960
  const cardH = 230
  const photoSize = 180
  const photoX = cardX + 25
  const photoY = cardY + 25
  const textX = hasPhoto ? photoX + photoSize + 36 : cardX + 36
  const titleAreaW = cardW - (hasPhoto ? photoSize + 100 : 80) - 80
  const headline = customTitle || kindLabel
  const titleSize = fitFontSize(headline, titleAreaW, 50, 0.55)
  const badgeX = cardX + cardW - 60
  const badgeY = cardY + 40
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
  <defs>
    <filter id="tw" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="3"/>
      <feOffset dx="0" dy="2"/>
      <feFlood flood-color="black" flood-opacity="0.85"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
  </defs>
  <g opacity="${opacity}">
    <!-- Background card 40% opaco — el mapa se ve detrás -->
    <rect x="${cardX}" y="${cardY}" rx="32" ry="32" width="${cardW}" height="${cardH}" fill="rgba(0,0,0,0.4)"/>
    ${hasPhoto ? `<rect x="${photoX}" y="${photoY}" width="${photoSize}" height="${photoSize}" rx="20" ry="20" fill="rgba(20,20,20,0.4)"/>` : ''}
    ${index != null && total != null
        ? `<text x="${badgeX}" y="${badgeY + 8}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="900" letter-spacing="3" fill="rgba(251,191,36,1)" filter="url(#tw)">${String(index).padStart(2, '0')} / ${String(total).padStart(2, '0')}</text>`
        : ''}
    ${customTitle
        ? `<text x="${textX}" y="${cardY + 80}" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="900" letter-spacing="6" fill="#fbbf24" filter="url(#tw)">${escapeXml((kindLabel ?? '').toUpperCase())}</text>
    <text x="${textX}" y="${cardY + 145}" font-family="Helvetica, Arial, sans-serif" font-size="${titleSize.toFixed(0)}" font-weight="900" fill="white" filter="url(#tw)">${escapeXml(headline)}</text>`
        : `<text x="${textX}" y="${cardY + 130}" font-family="Helvetica, Arial, sans-serif" font-size="${titleSize.toFixed(0)}" font-weight="900" fill="white" filter="url(#tw)">${escapeXml(headline)}</text>`}
    <text x="${textX}" y="${cardY + 195}" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="500" fill="rgba(255,255,255,0.92)" letter-spacing="2" filter="url(#tw)">${escapeXml(meta ?? '')}</text>
  </g>
</svg>
`
}

// Posición donde el render componente el thumbnail real del waypoint
// (matchea el placeholder en svgWaypoint). Card ahora a y=420.
export const WAYPOINT_PHOTO_RECT = { x: 85, y: 445, w: 180, h: 180 }

export interface SvgOutroOpts {
  title: string
  location?: string | null
  date?: string | null
  km: number
  dPlus: number
  time: string
  wps: number
  opacity?: number
}

// Outro compactado en el tercio superior + brand en el tercio medio.
// La mitad inferior queda libre para la UI de Reels/TikTok.
export function svgOutro(opts: SvgOutroOpts): string {
  const { title, location, date, km, dPlus, time, wps, opacity = 1 } = opts
  const titleSize = fitFontSize(title, 880, 110, 0.6)
  const kmStr = km.toFixed(1)
  const dPlusStr = String(Math.round(dPlus))
  const timeStr = String(time ?? '')
  const wpsStr = String(wps ?? '')
  const colMax = 340
  const kmSize = fitFontSize(kmStr, colMax, 96, 0.55)
  const dSize = fitFontSize(dPlusStr, colMax, 96, 0.55)
  const tSize = fitFontSize(timeStr, colMax, 96, 0.55)
  const wSize = fitFontSize(wpsStr, colMax, 96, 0.55)
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
  <defs>
    <linearGradient id="vignette" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0.92)"/>
      <stop offset="65%" stop-color="rgba(0,0,0,0.55)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.3)"/>
    </linearGradient>
  </defs>
  <g opacity="${opacity}">
    <rect x="0" y="0" width="1080" height="1920" fill="url(#vignette)"/>

    <!-- Top: lugar con líneas decorativas (y=220) -->
    <rect x="280" y="220" width="80" height="2" fill="#fbbf24" opacity="0.85"/>
    <text x="540" y="232" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="800" letter-spacing="9" fill="#fbbf24">${escapeXml((location ?? '').toUpperCase())}</text>
    <rect x="720" y="220" width="80" height="2" fill="#fbbf24" opacity="0.85"/>

    <!-- Título italic HUGE (y=340) -->
    <text x="540" y="340" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${titleSize.toFixed(0)}" font-weight="900" font-style="italic" fill="white">${escapeXml(title)}</text>

    <!-- Date discreto (y=395) -->
    <text x="540" y="395" text-anchor="middle" font-family="Georgia, serif" font-size="28" font-style="italic" fill="rgba(255,255,255,0.85)">${escapeXml(date ?? '')}</text>

    <!-- Grid 2×2 de stats compacto en y=480-810 -->
    <g font-family="Helvetica, Arial, sans-serif" fill="white" text-anchor="middle">
      <rect x="540" y="500" width="2" height="300" fill="rgba(251,191,36,0.4)"/>
      <rect x="160" y="650" width="760" height="2" fill="rgba(251,191,36,0.4)"/>
      <text x="320" y="580" font-size="${kmSize.toFixed(0)}" font-weight="900" font-style="italic">${kmStr}</text>
      <text x="320" y="625" font-size="20" font-weight="900" letter-spacing="7" fill="#fbbf24">KILÓMETROS</text>
      <text x="760" y="580" font-size="${dSize.toFixed(0)}" font-weight="900" font-style="italic">${dPlusStr}</text>
      <text x="760" y="625" font-size="20" font-weight="900" letter-spacing="7" fill="#fbbf24">D+ METROS</text>
      <text x="320" y="750" font-size="${tSize.toFixed(0)}" font-weight="900" font-style="italic">${escapeXml(timeStr)}</text>
      <text x="320" y="795" font-size="20" font-weight="900" letter-spacing="7" fill="#fbbf24">TIEMPO</text>
      <text x="760" y="750" font-size="${wSize.toFixed(0)}" font-weight="900" font-style="italic">${wpsStr}</text>
      <text x="760" y="795" font-size="20" font-weight="900" letter-spacing="7" fill="#fbbf24">HITOS</text>
    </g>

    <!-- Brand en y=900 (justo arriba del tercio inferior) -->
    <rect x="490" y="880" width="100" height="3" fill="#fbbf24"/>
    <text x="540" y="965" text-anchor="middle" font-family="Georgia, serif" font-size="76" font-weight="900" font-style="italic" fill="#f5f1ea">Rawko</text>
    <text x="540" y="1010" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="800" letter-spacing="10" fill="rgba(245,241,234,0.65)">RAWKO.IO</text>
  </g>
</svg>
`
}
