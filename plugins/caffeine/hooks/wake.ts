// Pure parts of the wake (what was wakey): which usage window is in the way,
// when to wake, the cron line for it, and keeping the machine up until then.

import { parseClock } from './brew'
import type { Limit } from './brew'

// What a wake is waiting out: the window, how full it is, and when it resets.
export type Block = { label: string; percent: number; resetsAt: number }

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'weekly' }

// The wake row shows from here: close enough to the line to plan a wake.
export const NEAR = { five_hour: 90, seven_day: 95 } as const

// Every wake prompt starts with this, so caffeine knows its own crons again
// (after `--resume`, which restores them) and its own fires.
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

// A couple of minutes after the reset, and never on :00 or :30, where a
// one-shot cron may fire up to 90 seconds early.
export function wakeAfter(resetsAt: number): number {
  let at = Math.ceil((resetsAt + 2 * minute) / minute) * minute
  const m = new Date(at).getMinutes()
  if (m === 0 || m === 30) {
    at += minute
  }
  return at
}

// "M H DoM Mon *" in local time, a one-shot's pinned minute.
export function cronAt(at: number): string {
  const d = new Date(at)
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`
}

// A time someone picked, moved up to its next whole minute, as a cron fires.
export const wholeMinute = (at: number) => Math.ceil(at / minute) * minute

// When a one-shot's "M H DoM Mon *" next fires after `now`. NaN for any other shape.
export function fromCron(cron: string, now: number): number {
  const parts = cron.trim().split(/\s+/).map(Number)
  if (parts.length !== 5 || parts.slice(0, 4).some(Number.isNaN)) {
    return Number.NaN
  }
  const [m, h, day, month] = parts as [number, number, number, number]
  const year = new Date(now).getFullYear()
  const at = new Date(year, month - 1, day, h, m).getTime()
  return at > now - minute ? at : new Date(year + 1, month - 1, day, h, m).getTime()
}

// `14:30`, `2:30pm`, `9pm`, `+90m`, `+2h`, `+1h30m`: the time, or null.
export function parseWhen(word: string, now: number): number | null {
  const relative = /^\+(?:(\d+)h)?(?:(\d+)m?)?$/.exec(word.trim().toLowerCase())
  if (relative && (relative[1] || relative[2])) {
    const ms = (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * minute
    return ms > 0 ? now + ms : null
  }
  return parseClock(word, now)
}

export type Os = 'windows' | 'mac' | 'linux'

// Where the plugin lives says which machine this is.
export function osOf(root: string): Os {
  if (/^[A-Za-z]:[\\/]/.test(root)) return 'windows'
  if (root.startsWith('/Users/')) return 'mac'
  return 'linux'
}

// Keeps the machine from sleeping for `seconds`, then lets go; killing it lets
// go at once. The display may still sleep.
export function awakeArgv(os: Os, seconds: number): string[] {
  const s = String(Math.max(1, Math.round(seconds)))
  if (os === 'windows') {
    const script =
      "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" +
      ` [void][W.P]::SetThreadExecutionState([uint32]'0x80000001'); Start-Sleep -Seconds ${s}`
    return ['powershell', '-NoProfile', '-Command', script]
  }
  if (os === 'mac') {
    return ['caffeinate', '-i', '-t', s]
  }
  return ['systemd-inhibit', '--what=sleep:idle', '--who=caffeine', '--why=waking Claude at a set time', 'sleep', s]
}
