// Pure parts of the wake (what was wakey): which usage window is in the way,
// when to wake, and the cron line for it.

import { parseClock } from './brew'
import type { Limit } from './brew'

// What a wake is waiting out: the window, how full it is, and when it resets.
export type Block = { label: string; percent: number; resetsAt: number }

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'weekly' }

// The wake row shows from here: close enough to the line to plan a wake.
export const NEAR = { five_hour: 90, seven_day: 95 } as const

// Every wake prompt starts with this, so it reads as caffeine's in the transcript.
export const MARK = '[caffeine]'
export const DEFAULT_WAKE = 'The usage limit has reset. Pick up where you left off.'

const minute = 60_000

function window(l: Limit): Block | null {
  const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : Number.NaN
  if (Number.isNaN(resetsAt) || !(l.kind in LABELS)) {
    return null
  }
  return { label: LABELS[l.kind]!, percent: Math.round(l.percentUsed), resetsAt }
}

// The window to wait out: of the full ones, the one that resets last (a full
// week outlasts a 5-hour reset); with none full, the 5-hour one.
export function blocking(limits: readonly Limit[]): Block | null {
  const windows = limits.map(window).filter((w): w is Block => w !== null)
  const full = windows.filter(w => w.percent >= 100).sort((a, b) => b.resetsAt - a.resetsAt)
  return full[0] ?? windows.find(w => w.label === '5h') ?? null
}

export function isNear(limits: readonly Limit[]): boolean {
  return limits.some(l => {
    const line = NEAR[l.kind as keyof typeof NEAR]
    return line !== undefined && l.percentUsed >= line
  })
}

// A couple of minutes after the reset, so the window has surely turned over
// (and never on :00 or :30, the busiest minutes).
export function wakeAfter(resetsAt: number): number {
  let at = Math.ceil((resetsAt + 2 * minute) / minute) * minute
  const m = new Date(at).getMinutes()
  if (m === 0 || m === 30) {
    at += minute
  }
  return at
}

// A time someone picked, moved up to its next whole minute.
export const wholeMinute = (at: number) => Math.ceil(at / minute) * minute

// `14:30`, `2:30pm`, `9pm`, `+90m`, `+2h`, `+1h30m`: the time, or null.
export function parseWhen(word: string, now: number): number | null {
  const relative = /^\+(?:(\d+)h)?(?:(\d+)m?)?$/.exec(word.trim().toLowerCase())
  if (relative && (relative[1] || relative[2])) {
    const ms = (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * minute
    return ms > 0 ? now + ms : null
  }
  return parseClock(word, now)
}
