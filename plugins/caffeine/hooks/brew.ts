// Pure parts of caffeine: how long the cache lives, when the next poke is
// due, the durations and times it reads and writes, and the usage line it
// will not cross.

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export const DEFAULT_MESSAGE = 'poke, just say okay'

const second = 1000
const minute = 60 * second
const hour = 60 * minute

export const TTL_5M = 5 * minute
export const TTL_1H = hour

// How long after the last request a poke goes out, unless set: at 80% of the
// TTL (48m of 1h, 4m of 5m). Each poke starts the TTL again, so one poke per
// lifetime, late in it, is all the cache needs; the rest is margin.
export const POKE_AT = 0.8

export function defaultEvery(ttl: number): number {
  return Math.round(ttl * POKE_AT)
}

// Turned off by itself after this long without a turn that was not a poke.
export const DEFAULT_IDLE = 8 * hour

// Pokes stop at these usage lines: the window is better spent on work.
export const LIMIT_LINE = { five_hour: 90, seven_day: 95 } as const
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'weekly' }

// The window over its line, if one is: `{ label, percent }`.
export function overLine(limits: readonly Limit[]): { label: string; percent: number } | null {
  for (const l of limits) {
    const line = LIMIT_LINE[l.kind as keyof typeof LIMIT_LINE]
    if (line !== undefined && l.percentUsed >= line) {
      return { label: LABELS[l.kind] ?? l.kind, percent: Math.round(l.percentUsed) }
    }
  }
  return null
}

// The TTL Claude Code's environment pins, or null when it leaves the choice
// automatic: CLAUDE_CODE_PROMPT_CACHE_TTL ("5m" or "1h") wins, then
// FORCE_PROMPT_CACHING_5M, then ENABLE_PROMPT_CACHING_1H.
export function ttlFromEnv(cacheTtl: string | undefined, force5m: string | undefined, enable1h: string | undefined): number | null {
  const v = cacheTtl?.trim().toLowerCase()
  if (v === '1h') return TTL_1H
  if (v === '5m') return TTL_5M
  if (isSet(force5m)) return TTL_5M
  if (isSet(enable1h)) return TTL_1H
  return null
}

const isSet = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'

// Claude Code's automatic choice: 1 hour on a Claude subscription within its
// usage limits (the only sessions with rate-limit windows), else 5 minutes.
export function ttlByPlan(limits: readonly Limit[]): number {
  return limits.length > 0 && limits.every(l => l.percentUsed < 100) ? TTL_1H : TTL_5M
}

// The TTL one request was written at, read off what it cost: the session's
// cost went up by `delta` dollars for `u`, and only the cache write's rate is
// unknown (2x for 1h, 1.25x for 5m). Null when the request wrote too little
// to tell, the model's price is unknown, or the rate fits neither (another
// request, a subagent's, landed in between).
export function ttlFromCost(delta: number, u: Usage, model: string): number | null {
  const price = inputPrice(model)
  if (price === null || u.cache_creation_input_tokens < 1000 || !(delta > 0)) {
    return null
  }
  const rest = u.input_tokens + u.output_tokens * 5 + u.cache_read_input_tokens * readRate(model)
  const rate = ((delta * 1e6) / price - rest) / u.cache_creation_input_tokens
  if (Math.abs(rate - 2) < 0.1) return TTL_1H
  if (Math.abs(rate - 1.25) < 0.1) return TTL_5M
  return null
}

// When the next poke goes out, given the last request, or null with none yet.
export function nextPokeAt(lastAt: number, every: number): number | null {
  return lastAt > 0 ? lastAt + every : null
}

// A cache read larger than what the request had to write again: still warm.
export function wasWarm(usage: { cache_read_input_tokens: number; cache_creation_input_tokens: number } | undefined): boolean | null {
  if (!usage) return null
  return usage.cache_read_input_tokens > usage.cache_creation_input_tokens
}

// `2h`, `90m`, `1h30m`, `2.5m`, `150s`: milliseconds, or null.
export function parseDuration(word: string): number | null {
  const w = word.trim().toLowerCase()
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+)s)?$/.exec(w)
  if (!m || (!m[1] && !m[2] && !m[3])) {
    return null
  }
  const ms = Number(m[1] ?? 0) * hour + Number(m[2] ?? 0) * minute + Number(m[3] ?? 0) * second
  return ms > 0 ? Math.round(ms) : null
}

// `18:00`, `6pm`, `6:30pm`: the next such time after `now`, or null.
export function parseClock(word: string, now: number): number | null {
  const time = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(word.trim().toLowerCase())
  if (!time || (!time[2] && !time[3])) {
    return null
  }
  let h = Number(time[1])
  const m = Number(time[2] ?? 0)
  if (time[3]) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (time[3] === 'pm' ? 12 : 0)
  }
  if (h > 23 || m > 59) {
    return null
  }
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  return d.getTime() <= now ? d.getTime() + 24 * hour : d.getTime()
}

const two = (n: number) => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// 14:12 today, `Sat 14:12` on another day.
export function clock(at: number, now: number): string {
  const d = new Date(at)
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`
  return d.toDateString() === new Date(now).toDateString() ? time : `${DAYS[d.getDay()]} ${time}`
}

// 2h 05m, 12m, 2m 30s, 45s.
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / second))
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`
  if (s >= 600) return `${Math.round(s / 60)}m`
  if (s >= 60) return s % 60 ? `${Math.floor(s / 60)}m ${two(s % 60)}s` : `${s / 60}m`
  return `${s}s`
}

// What a request costs, in input-token equivalents (base input price = 1),
// by the API's own ratios: output 5x, cache writes 1.25x (5m) or 2x (1h),
// cache reads 0.1x, except 0.05x on Opus 5.5 and 0.025x on Fable 5.1 and
// Mythos 5.1.
export function readRate(model: string): number {
  if (/fable-5-1|mythos-5-1/.test(model)) return 0.025
  if (/opus-5-5/.test(model)) return 0.05
  return 0.1
}

export const writeRate = (ttl: number) => (ttl >= TTL_1H ? 2 : 1.25)

// API list input price, $ per million tokens, for the models caffeine knows.
const PRICES: [RegExp, number][] = [
  [/fable-5|mythos-5/, 10],
  [/opus-5-5/, 4],
  [/opus-[45]/, 5],
  [/sonnet-5/, 2],
  [/sonnet-4-6/, 3],
  [/haiku-4-5/, 1],
]

export function inputPrice(model: string): number | null {
  return PRICES.find(([re]) => re.test(model))?.[1] ?? null
}

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function equivalents(u: Usage, model: string, ttl: number): number {
  return u.input_tokens + u.output_tokens * 5 + u.cache_read_input_tokens * readRate(model) + u.cache_creation_input_tokens * writeRate(ttl)
}

// A poke over `context` cached tokens: the read, plus a short exchange.
export const pokeGuess = (context: number): Usage => ({ input_tokens: 40, output_tokens: 10, cache_read_input_tokens: context, cache_creation_input_tokens: 60 })

// 7.3k, 284k, 1.2M.
export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

export function dollars(equiv: number, model: string): string {
  const price = inputPrice(model)
  if (price === null) return ''
  const usd = (equiv * price) / 1e6
  return usd < 0.01 ? 'under $0.01' : `about $${usd.toFixed(2)}`
}

// What one main-thread request says about the cache from its timing alone, as
// Cache Keeper reads it: the gap since the request before, and how the prompt
// split between reading the cache and writing it. Past 5.5 minutes a 5-minute
// cache has expired, so a mostly-read prompt proves the 1-hour TTL, and a
// mostly-written one means the cache had gone cold (under an hour: a 5-minute
// TTL, unless something else rewrote it, which `isExempt` says: the first
// request after a compaction or a model switch). Small prompts say nothing.
export type Reading = { isCold: boolean; ttl: number | null }

export const GAP = 5.5 * minute

export function readTiming(gap: number, u: Usage, isExempt: boolean): Reading {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  if (total < 30_000 || gap < GAP) {
    return { isCold: false, ttl: null }
  }
  if (u.cache_read_input_tokens / total > 0.8) {
    return { isCold: false, ttl: TTL_1H }
  }
  if (u.cache_creation_input_tokens / total > 0.5 && !isExempt) {
    return { isCold: true, ttl: gap < TTL_1H ? TTL_5M : null }
  }
  return { isCold: false, ttl: null }
}

// A poke that wrote more than a tenth of what it read found the cache cold:
// the pokes are not keeping it warm.
export function pokeWasCold(u: Usage): boolean {
  return u.cache_creation_input_tokens > 0.1 * u.cache_read_input_tokens
}

// The cup on the row: how warm the cache is, as a coffee's temperature from
// 100F (just written or read) down to 40F (expired), the steam over it
// thinning as it cools, and a color from red to blue. `frame` shimmers the
// steam.
export type Warmth = { degrees: number; steam: string; color: string }

const STEAM = [['   '], [' ~ ', '  ~'], ['≈ ≈', ' ≈≈'], ['≋≋≋', '≈≋≈']]

export function warmth(left: number, ttl: number, frame = 0): Warmth {
  const f = Math.max(0, Math.min(1, left / ttl))
  const degrees = Math.round(40 + 60 * f)
  const level = degrees >= 85 ? 3 : degrees >= 65 ? 2 : degrees >= 48 ? 1 : 0
  const frames = STEAM[level]!
  const color = degrees >= 85 ? '#ff5a36' : degrees >= 70 ? '#ff9a3c' : degrees >= 55 ? '#f2c94c' : degrees > 40 ? '#9cb8d8' : '#5b8fd9'
  return { degrees, steam: frames[frame % frames.length]!, color }
}
