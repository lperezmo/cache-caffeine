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
