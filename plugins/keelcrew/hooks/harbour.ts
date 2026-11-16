// Harbour light: the Mate's session look. A harbour behind the conversation (a morning harbour by day, the night watch by
// night) whose lighthouse flies a magenta pennant while cards wait for the captain, today's watches and the week on its
// left, and the crew moored at a jetty; plus the cards a reply's ```keelcrew blocks draw. Pure functions: register.tsx
// reads the crew's state and draws.
import type { ThemeSetArgs } from 'claude-code'

import type { Card, CrewState, HarbourData, Moored, Watch } from '../types'


export const YOU = '#d63c9a'
export const WORK = '#2a9fa8'
export const BAD = '#e0574a'
export const AMBER = '#d99a1e'
export const MUTED = '#8a9aa8'
export const LEARN = '#8a6cf0'
export const TONE: Record<CrewState, string> = { work: WORK, review: MUTED, qa: LEARN, you: YOU, bad: BAD, paused: AMBER }
/** The word under each boat at the jetty. */
const WORD: Record<CrewState, string> = { work: 'Working', review: 'PR open', qa: 'In QA', you: 'Needs you', bad: 'Failed', paused: 'Paused' }
export const STOPS = ['Spec', 'Build', 'Review', 'PR', 'QA', 'Done']
const STOP_OF: Record<string, number> = { spec: 0, plan: 0, build: 1, verify: 1, review: 2, approval: 2, pr: 3, qa: 4, done: 5 }
/** At most this many boats at the jetty; the rest are counted. */
const MAX_BOATS = 6

/** A session has one theme and the latest set wins: while Harbour light is on, another plugin's theme set or clear is
 * refused (`origin` is the caller's plugin name; the engine's own calls pass). */
export const otherLook = (lookOn: boolean, origin: string): { deny: string } | null =>
  lookOn && origin !== 'keelcrew' && origin !== 'engine'
    ? { deny: 'Keelcrew keeps the Harbour light look on the Mate’s session. Switch it off on the board: Settings → This Mac → Harbour light look.' }
    : null

export const LOOK: ThemeSetArgs = { backdrop: { scene: 'harbour', glass: { blur: 10, opacity: 0.55 } } }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The voyage stop a board phase stands at, or -1. */
export const stopOf = (phase: string | undefined): number => STOP_OF[phase ?? ''] ?? -1

/** "40m", "2h 10m". */
export function duration(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Time spent at each voyage stop, from a ticket's phase log ('' where none); the current stop counts up to `now`. */
export function stopTimes(log: { phase: string; at: number }[] = [], now: number): string[] {
  const ms = STOPS.map(() => 0)
  log.forEach((p, i) => {
    const s = stopOf(p.phase)
    if (s >= 0 && s < 5) ms[s]! += (log[i + 1]?.at ?? now) - p.at
  })
  return ms.map(v => (v > 0 ? duration(v) : ''))
}

const isText = (v: unknown): v is string => typeof v === 'string'
const isOpt = (v: unknown) => v === undefined || isText(v)
const isTexts = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(isText))

/** Whether a parsed block has a card's shape, field by field: anything else stays text. */
function isCard(c: unknown): c is Card {
  if (!c || typeof c !== 'object') return false
  const x = c as Record<string, unknown>
  switch (x.kind) {
    case 'crew':
      return [x.role, x.key, x.title, x.status].every(isText) && (x.tone === undefined || x.tone === 'ok' || x.tone === 'bad') && isOpt(x.phase) && isTexts(x.facts)
    case 'you': {
      const r = x.risk as Record<string, unknown> | undefined
      return isText(x.key) && isText(x.title) && isTexts(x.facts) && (r === undefined || (!!r && typeof r === 'object' && isText(r.tier) && Array.isArray(r.why) && r.why.every(isText) && isOpt(r.clear)))
    }
    case 'learned':
      return isText(x.text) && isOpt(x.from) && isOpt(x.state)
    case 'deny':
      return isText(x.key) && isText(x.command) && isOpt(x.note)
    case 'wake':
      return isText(x.text)
    default:
      return false
  }
}

/** The reply cut into markdown and keelcrew cards, or null when it holds none. A block that isn't a card stays text. */
export function pieces(text: string): (string | Card)[] | null {
  const out: (string | Card)[] = []
  let at = 0
  for (const m of text.matchAll(/```keelcrew\n([\s\S]*?)```/g)) {
    let card: Card
    try {
      card = JSON.parse(m[1] ?? '') as Card
    } catch {
      continue
    }
    if (!isCard(card)) continue
    if (m.index > at) out.push(text.slice(at, m.index))
    out.push(card)
    at = m.index + m[0].length
  }
  if (!out.some(p => typeof p !== 'string')) return null
  if (at < text.length) out.push(text.slice(at))
  return out
}

/** A card as one line of text, for a surface that draws no cards (the terminal). */
export function cardLine(c: Card): string {
  switch (c.kind) {
    case 'crew':
      return `**${c.key}** ${c.role}: ${c.title} (${c.status})${c.facts?.length ? `. ${c.facts.join(', ')}` : ''}`
    case 'you':
      return `**Needs you:** ${c.key} ${c.title}${c.risk ? ` (${c.risk.tier} risk: ${c.risk.why.join(', ')})` : ''}`
    case 'learned':
      return `**Learned:** ${c.text}${c.from ? ` (from ${c.from})` : ''}`
    case 'deny':
      return `**Refused** for ${c.key}: \`${c.command}\`${c.note ? `. ${c.note}` : ''}`
    case 'wake':
      return c.text
  }
}

/** The text with every card drawn as its one line. */
export const plainText = (parts: (string | Card)[]): string => parts.map(p => (typeof p === 'string' ? p : `\n${cardLine(p)}\n`)).join('')

/** The voyage track: done stops filled, the current one a ship (a cross when it failed), with time per stop. */
export function track(stop: number, failed: boolean, times: string[]): string {
  const xs = STOPS.map((_, i) => 24 + i * 118)
  const last = xs[xs.length - 1]!
  const x = xs[Math.max(0, stop)] ?? 24
  const known = times.filter(Boolean)
  const slowest = known.length > 1 ? times.indexOf(times.reduce((a, b) => (minutes(b) > minutes(a) ? b : a), '')) : -1
  const dots = xs.map((cx, i) => (i < stop ? `<circle cx="${cx}" cy="14" r="4.5" fill="${WORK}"/>` : i > stop ? `<circle cx="${cx}" cy="14" r="4" fill="none" stroke="${MUTED}" stroke-width="1.6"/>` : '')).join('')
  const here = failed
    ? `<circle cx="${x}" cy="14" r="9" fill="${BAD}"/><path d="M${x - 3.5} 10.5l7 7M${x + 3.5} 10.5l-7 7" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`
    : `<circle cx="${x}" cy="14" r="12" fill="${WORK}" opacity=".18"/><g transform="translate(${x - 9} 4)" fill="${WORK}"><path d="M0 11h18l-3.5 5.5H3.5z"/><path d="M9.5 0v10H3z"/><path d="M10.5 2v8h5z" opacity=".7"/></g>`
  const labels = xs
    .map((cx, i) => {
      const anchor = i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle'
      const tx = i === 0 ? cx - 6 : i === xs.length - 1 ? cx + 6 : cx
      const cur = i === stop
      const t = times[i] ? `<text x="${tx}" y="55" text-anchor="${anchor}" font-size="10.5" font-weight="${i === slowest ? 600 : 400}" fill="${i === slowest ? AMBER : MUTED}">${times[i]}</text>` : ''
      return `<text x="${tx}" y="40" text-anchor="${anchor}" font-size="11" font-weight="${cur ? 600 : 400}" fill="${cur ? (failed ? BAD : WORK) : MUTED}">${STOPS[i]}</text>${t}`
    })
    .join('')
  const rest = stop < xs.length - 1 ? `<line x1="${x}" y1="14" x2="${last}" y2="14" stroke="${MUTED}" stroke-width="2" stroke-dasharray="2 6" stroke-linecap="round" opacity=".6"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 ${known.length ? 60 : 46}" font-family="-apple-system, system-ui, sans-serif"><line x1="24" y1="14" x2="${x}" y2="14" stroke="${WORK}" stroke-width="2.5" stroke-linecap="round"/>${rest}${dots}${here}${labels}</svg>`
}

const minutes = (t: string): number => {
  const m = /^(?:(\d+)h )?(\d+)m$/.exec(t)
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : -1
}

const NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** Whether one cron field matches a value: `*`, lists, ranges, steps (`10-18/2`, `*\/15`) and day or month names. */
function fieldHas(field: string, v: number, min: number, max: number): boolean {
  const named = field.toUpperCase().replace(/[A-Z]{3}/g, n => String(NAMES.indexOf(n) < 7 ? NAMES.indexOf(n) : NAMES.indexOf(n) - 6))
  return named.split(',').some(part => {
    const [range = '*', stepText] = part.split('/')
    const step = Number(stepText ?? 1) || 1
    const [lo, hi] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(Number) : [Number(range), stepText ? max : Number(range)]
    return lo !== undefined && hi !== undefined && v >= lo && v <= hi && (v - lo) % step === 0
  })
}

/** The minutes of the day (0-1439) a five-field cron runs on `day`, local time. */
export function cronTimes(cron: string, day: Date): number[] {
  const [mi = '', ho = '', dom = '', mon = '', dow = ''] = cron.trim().split(/\s+/)
  const wd = day.getDay()
  if (!fieldHas(dom, day.getDate(), 1, 31) || !fieldHas(mon, day.getMonth() + 1, 1, 12) || !(fieldHas(dow, wd, 0, 7) || (wd === 0 && fieldHas(dow, 7, 0, 7)))) return []
  const out: number[] = []
  for (let h = 0; h < 24; h++) if (fieldHas(ho, h, 0, 23)) for (let m = 0; m < 60; m++) if (fieldHas(mi, m, 0, 59)) out.push(h * 60 + m)
  return out
}

/** Today's watches around now: the last one done and up to three to come. `schedules` are [name, cron]. */
export function watchesToday(schedules: [string, string][], now: number): Watch[] {
  const day = new Date(now)
  const at = day.getHours() * 60 + day.getMinutes()
  const runs = schedules.flatMap(([name, cron]) => cronTimes(cron, day).map(m => ({ m, name }))).sort((a, b) => a.m - b.m)
  const done = runs.filter(r => r.m <= at).slice(-1)
  const later = runs.filter(r => r.m > at).slice(0, 4 - done.length)
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return [...done.map(r => ({ at: hhmm(r.m), name: r.name, state: 'done' as const })), ...later.map((r, i) => ({ at: hhmm(r.m), name: r.name, state: i === 0 ? ('next' as const) : ('later' as const) }))]
}

const waves = (y: number, step: number, n: number): string => `M0 ${y} q${step / 2} -6 ${step} 0` + ` t${step} 0`.repeat(n)

function panel(d: HarbourData): string {
  if (!d.watches.length && !d.week) return ''
  const rows = d.watches
    .map((w, i) => {
      const y = 172 + i * 24
      const next = w.state === 'next'
      const bar = next ? `<rect x="44" y="${y - 15}" width="284" height="21" rx="6" fill="${WORK}" opacity=".16"/>` : ''
      const tag = w.state === 'done' ? '✓ done' : next ? 'next' : ''
      return `${bar}<text x="56" y="${y}" class="ink mono" font-size="12">${w.at}</text><text x="104" y="${y}" class="${w.state === 'done' ? 'mut' : 'ink'}" font-size="12.5" font-weight="${next ? 600 : 400}">${esc(w.name)}</text><text x="318" y="${y}" text-anchor="end" font-size="11" font-weight="600" fill="${next ? WORK : MUTED}">${tag}</text>`
    })
    .join('')
  const watches = d.watches.length ? `<text x="56" y="142" class="mut" font-size="11.5" font-weight="600">Watches today</text>${rows}` : `<text x="56" y="142" class="mut" font-size="11.5" font-weight="600">No watches left today</text>`
  const w = d.week
  const stats = w
    ? ([[String(w.shipped), 'shipped'], [w.qaKnown ? `${w.qaPassed}/${w.qaKnown}` : '–', 'QA first pass'], [String(w.lessons), 'lessons']] as const)
        .map(([n, label], i) => `<text x="${56 + i * 94}" y="308" class="ink" font-size="24" font-weight="700">${n}</text><text x="${56 + i * 94}" y="326" class="mut" font-size="11">${label}</text>`)
        .join('')
    : ''
  const week = w ? `<line x1="56" y1="262" x2="316" y2="262" class="rule"/><text x="56" y="284" class="mut" font-size="11.5" font-weight="600">This week</text>${stats}` : ''
  return `<rect x="36" y="112" width="300" height="${w ? 236 : 172}" rx="16" class="glass"/>${watches}${week}`
}

function jetty(crew: Moored[]): string {
  if (!crew.length) return ''
  const shown = crew.slice(0, MAX_BOATS)
  const top = 556
  const step = shown.length > 4 ? 44 : 54
  const end = top + 24 + shown.length * step
  const planks = Array.from({ length: Math.floor((end - top) / 12) }, (_, i) => `<rect x="44" y="${top + 6 + i * 12}" width="18" height="2" class="tower" opacity=".5"/>`).join('')
  const boats = shown
    .map((b, i) => {
      const y = top + 50 + i * step
      const tone = TONE[b.state]
      const flag = b.state === 'you' ? `<path class="wave2" d="M1 -40 L22 -35 L1 -30Z" fill="${YOU}"/>` : ''
      const buoy = b.state === 'bad' ? `<circle cx="32" cy="3" r="5" fill="${BAD}"/><path d="M29.5 0.5l5 5M34.5 0.5l-5 5" stroke="#fff" stroke-width="1.4"/>` : ''
      const boat = `<g transform="translate(100 ${y})"><path d="M-24 0 L24 0 L18 9 L-18 9Z" fill="${tone}"/><rect x="-8" y="-7" width="16" height="7" rx="2" class="sail"/><rect x="-1" y="-40" width="2" height="40" class="mast"/><path d="M2 -36 L2 -9 L17 -9Z" class="sail" opacity=".92"/>${flag}${buoy}</g>`
      const word = WORD[b.state]
      return `<path d="M62 ${y - 2} q14 8 18 2" fill="none" class="rope"/>${boat}<text x="144" y="${y - 12}" class="ink mono" font-size="13" font-weight="600">${esc(b.key)}</text><text x="144" y="${y + 5}" font-size="12" font-weight="600" fill="${tone}">${word}<tspan class="mut" font-weight="400">   ${esc(b.role)}</tspan></text>`
    })
    .join('')
  const more = crew.length > shown.length ? `<text x="144" y="${end + 18}" class="mut" font-size="11.5">and ${crew.length - shown.length} more</text>` : ''
  return `<text x="44" y="${top - 14}" class="mut" font-size="11.5" font-weight="600">Crew aboard</text><rect x="42" y="${top}" width="22" height="${end - top}" rx="3" class="land"/>${planks}${boats}${more}`
}

/** The harbour behind the Mate's conversation, drawn from the crew's state. */
export function scene(d: HarbourData): string {
  const signal = d.waiting > 0
  const beam = signal ? '#ff6fcf' : '#ffd68c'
  const pennant = signal ? `<rect class="land" x="1261" y="190" width="2.4" height="50"/><path class="wave" d="M1263 191 L1318 200 L1263 211Z" fill="#c2188a"/>` : ''
  const info = `<g class="info" font-family="-apple-system, system-ui, sans-serif">${panel(d)}${jetty(d.crew)}</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ska"/><stop offset=".56" class="skb"/></linearGradient>
<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="skb"/><stop offset=".25" class="wat"/></linearGradient>
<radialGradient id="beam" cx="0" cy=".5" r="1"><stop offset="0" stop-color="${beam}" stop-opacity=".5"/><stop offset="1" stop-color="${beam}" stop-opacity="0"/></radialGradient>
<radialGradient id="beamL" cx="1" cy=".5" r="1"><stop offset="0" stop-color="${beam}" stop-opacity=".5"/><stop offset="1" stop-color="${beam}" stop-opacity="0"/></radialGradient>
<radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff6dc" stop-opacity=".95"/><stop offset="1" stop-color="#fff6dc" stop-opacity="0"/></radialGradient>
</defs>
<style>
svg{--sky-a:#a9cfe8;--sky-b:#f3f8fa;--land:#6f93ab;--land-2:#9ab8cc;--water:#b4d3e6;--tower:#f4f7f9;--band:#c0392b;--glint:#ffffff;--line:#5d7d93}
.night,.town{opacity:0}.day{opacity:1}
.ink{fill:#121a22}.mut{fill:#4f5e6c}.mono{font-family:ui-monospace, Menlo, monospace}
.glass{fill:#ffffff;opacity:.62}.rule{stroke:#121a22;opacity:.14}.rope{stroke:#6f93ab;stroke-width:1.2}.sail{fill:#f4f7f9}.mast{fill:#6f93ab}
@media (prefers-color-scheme: dark){
svg{--sky-a:#01050b;--sky-b:#123049;--land:#020a12;--land-2:#071624;--water:#061624;--tower:#0d1c29;--band:#0d1c29;--glint:#ffcf7a;--line:#3c5c74}
.night,.town{opacity:1}.day{opacity:0}
.ink{fill:#e6eef5}.mut{fill:#93a9ba}.glass{fill:#0b1a28;opacity:.72}.rule{stroke:#e6eef5}.sail{fill:#8da3b5}.mast{fill:#8da3b5}
}
@media (max-aspect-ratio: 5/4){.info{display:none}}
.ska{stop-color:var(--sky-a)}.skb{stop-color:var(--sky-b)}.wat{stop-color:var(--water)}
.land{fill:var(--land)}.land2{fill:var(--land-2)}.tower{fill:var(--tower)}.band{fill:var(--band)}.glint{fill:var(--glint)}
.tide,.tide2{fill:none;stroke:var(--line)}
.tw{animation:tw 7s ease-in-out infinite}.tw:nth-child(3n){animation-delay:-2.5s}.tw:nth-child(4n){animation-delay:-5s}
@keyframes tw{50%{opacity:.2}}
.beam{transform-origin:1262px 300px;animation:sweep 16s ease-in-out infinite${signal ? ',pulse 3.2s ease-in-out infinite' : ''}}
@keyframes sweep{0%,100%{transform:rotate(-34deg)}50%{transform:rotate(10deg)}}
@keyframes pulse{50%{opacity:.55}}
.tide{animation:tide 20s ease-in-out infinite alternate}.tide2{animation:tide 27s ease-in-out infinite alternate-reverse}
@keyframes tide{to{transform:translateX(-80px)}}
.boat{animation:sail 160s linear infinite}
@keyframes sail{from{transform:translate(-120px,0)}to{transform:translate(1560px,0)}}
.gull{animation:gull 60s linear infinite}
@keyframes gull{from{transform:translate(1500px,40px)}to{transform:translate(-200px,-10px)}}
.shim{animation:shim 4s ease-in-out infinite}.shim:nth-child(2n){animation-delay:-2s}
@keyframes shim{50%{opacity:.25}}
.wave2{animation:wave2 2.6s ease-in-out infinite}
@keyframes wave2{50%{transform:scaleX(.86)}}
.wave{transform-origin:1263px 200px;animation:wave 2.6s ease-in-out infinite}
@keyframes wave{50%{transform:scaleX(.86) skewY(3deg)}}
</style>
<rect width="1440" height="900" fill="url(#sky)"/>
<g class="day"><circle cx="1080" cy="190" r="190" fill="url(#sun)"/><circle cx="1080" cy="190" r="34" fill="#fff8e6"/></g>
<g class="night">
<path d="M1370 100a30 30 0 1 0 26 44a23 23 0 1 1 -26 -44z" fill="#c9d4e2" opacity=".55"/>
<g fill="#d8e6ff"><circle class="tw" cx="120" cy="70" r="1.3"/><circle class="tw" cx="330" cy="120" r="1"/><circle class="tw" cx="520" cy="50" r="1.5"/><circle class="tw" cx="700" cy="140" r="1"/><circle class="tw" cx="860" cy="70" r="1.2"/><circle class="tw" cx="980" cy="40" r="1.4"/><circle class="tw" cx="1120" cy="120" r="1"/><circle class="tw" cx="1410" cy="190" r="1"/><circle class="tw" cx="600" cy="230" r="1.1"/><circle class="tw" cx="430" cy="300" r="1"/><circle class="tw" cx="760" cy="300" r="1"/><circle class="tw" cx="1000" cy="250" r="1.2"/><circle class="tw" cx="1240" cy="30" r="1"/></g>
<path class="beam" d="M1262 300 L1900 170 L1900 440 Z" fill="url(#beam)"/>
<path class="beam" d="M1262 300 L620 160 L620 420 Z" fill="url(#beamL)" opacity=".6"/>
</g>
<path class="land2" d="M0 470 C120 452 210 430 330 440 C450 450 520 420 640 432 C760 444 840 452 960 446 C1060 441 1110 430 1160 436 L1160 500 L0 500Z"/>
<path class="land" d="M1110 500 C1150 430 1200 380 1236 352 L1290 352 C1320 372 1380 392 1440 384 L1440 500Z"/>
<path class="land" d="M0 500 C140 480 260 486 400 482 C560 478 680 494 860 508 L0 510Z"/>
<g class="town" fill="#ffcf7a"><rect x="96" y="470" width="3" height="3"/><rect x="140" y="466" width="3" height="3"/><rect x="186" y="472" width="2" height="2"/><rect x="250" y="462" width="3" height="3"/><rect x="300" y="470" width="2" height="2"/><rect x="372" y="466" width="3" height="3"/><rect x="430" y="474" width="2" height="2"/><rect x="520" y="470" width="3" height="3"/></g>
<path class="tower" d="M1250 352 L1254 262 L1270 262 L1274 352Z"/><rect class="band" x="1253" y="300" width="18" height="12"/><rect class="band" x="1253" y="326" width="20" height="10"/>
<rect class="land" x="1250" y="250" width="24" height="13" rx="2"/><path class="land" d="M1248 250 L1262 238 L1276 250Z"/>${pennant}
<rect class="glint" x="1255" y="252" width="14" height="9" rx="1.5"/>
<rect y="508" width="1440" height="392" fill="url(#sea)"/>
<g class="town" fill="#ffcf7a"><rect class="shim" x="1258" y="530" width="8" height="2" rx="1"/><rect class="shim" x="1252" y="546" width="20" height="2" rx="1"/><rect class="shim" x="1260" y="566" width="10" height="2" rx="1"/><rect class="shim" x="1248" y="590" width="26" height="2" rx="1"/><rect class="shim" x="140" y="524" width="10" height="2" rx="1"/><rect class="shim" x="250" y="532" width="14" height="2" rx="1"/><rect class="shim" x="372" y="526" width="9" height="2" rx="1"/></g>
<g class="day" fill="#ffffff"><rect class="shim" x="1050" y="540" width="40" height="2" rx="1"/><rect class="shim" x="1030" y="560" width="70" height="2" rx="1"/><rect class="shim" x="1060" y="584" width="30" height="2" rx="1"/></g>
<g class="tide" opacity=".55" stroke-width="1.2"><path d="${waves(600, 80, 19)}"/><path d="${waves(700, 80, 19)}"/></g>
<g class="tide2" opacity=".4" stroke-width="1"><path d="${waves(650, 100, 15)}"/><path d="${waves(790, 100, 15)}"/></g>
<g class="boat"><g transform="translate(0 512)"><path class="land" d="M0 0 L46 0 L40 8 L6 8Z"/><path class="tower" d="M22 -2 L22 -44 L42 -4Z"/><path class="tower" d="M20 -4 L20 -36 L4 -4Z" opacity=".85"/><circle class="town" cx="23" cy="-46" r="1.6" fill="#ffcf7a"/></g></g>
<g class="gull day" fill="none" stroke-width="1.6" stroke-linecap="round" stroke="#6f93ab"><path d="M0 200 q6 -6 12 0 q6 -6 12 0"/><path d="M40 222 q5 -5 10 0 q5 -5 10 0"/></g>
${info}
</svg>`
}
