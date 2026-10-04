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

// How long after the last request a poke goes out, unless set: a quarter of a
// 1-hour cache, half of a 5-minute one.
export function defaultEvery(ttl: number): number {
  return ttl >= TTL_1H ? 15 * minute : 2.5 * minute
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

// The TTL the session's requests ask for, as Claude Code picks it from its
// environment: FORCE_PROMPT_CACHING_5M wins, then ENABLE_PROMPT_CACHING_1H.
export function ttlFrom(force5m: string | undefined, enable1h: string | undefined): number {
  if (isSet(force5m)) return TTL_5M
  if (isSet(enable1h)) return TTL_1H
  return TTL_5M
}

const isSet = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'

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
