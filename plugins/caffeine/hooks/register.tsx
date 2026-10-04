import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Brew } from '../types'
import {
  clock,
  DEFAULT_IDLE,
  DEFAULT_MESSAGE,
  defaultEvery,
  nextPokeAt,
  overLine,
  parseClock,
  parseDuration,
  span,
  TTL_1H,
  TTL_5M,
  ttlFrom,
  wasWarm,
} from './brew'
import type { Limit } from './brew'

// The session's switch, kept by the host so a reload of the mod finds it.
const brew = atom({ plugin: 'caffeine', key: 'brew' } as const, { isOn: false, until: 0, lastAt: 0, activeAt: 0 })

type Caffeine = Brew & {
  // a main-thread turn is running; its own requests keep the cache warm
  isBusy: boolean
  // a poke submitted and waiting for its turn, then running in it
  poke: 'none' | 'sent' | 'running'
  pokeTurnId: string
  sentAt: number
  pokes: number
  // whether the last poke found the cache still warm
  lastWarm: boolean | null
  limits: Limit[]
  // the TTL from Claude Code's environment, and the person's override
  envTtl: number
  ttl: number | null
  // settings kept across sessions
  message: string
  every: number | null
  isBanded: boolean
  idle: number
  // the band's message field is open
  isEditing: boolean
  bandId: string
}

const MINUTE = 60_000

const ttlOf = (c: Caffeine) => c.ttl ?? c.envTtl
const everyOf = (c: Caffeine) => c.every ?? defaultEvery(ttlOf(c))
const ttlLabel = (ms: number) => (ms >= TTL_1H ? '1h' : '5m')

// Says how it went: a toast, and a line in the transcript that outlasts it.
function tell($: EngineInterface, text: string): void {
  $.ui.toast(`caffeine: ${text}`)
  $.ui.log(`caffeine: ${text}`)
}

async function setting<T>($: EngineInterface, key: string, fallback: T): Promise<T> {
  try {
    const value = await $.store.get(key)
    return value === undefined || value === null ? fallback : (value as T)
  } catch {
    return fallback
  }
}

async function load($: EngineInterface, c: Caffeine): Promise<void> {
  c.message = await setting($, 'message', DEFAULT_MESSAGE)
  c.every = await setting<number | null>($, 'every', null)
  c.isBanded = await setting($, 'band', true)
  c.idle = await setting($, 'idle', DEFAULT_IDLE)
  c.ttl = await setting<number | null>($, 'ttl', null)
  try {
    c.envTtl = ttlFrom(await $.env.get('FORCE_PROMPT_CACHING_5M'), await $.env.get('ENABLE_PROMPT_CACHING_1H'))
  } catch {
    c.envTtl = TTL_5M
  }
}

async function keep($: EngineInterface, c: Caffeine): Promise<void> {
  const kept: Brew = { isOn: c.isOn, until: c.until, lastAt: c.lastAt, activeAt: c.activeAt }
  await update($, brew, () => kept).catch(() => undefined)
}

// One line for the band, the status line and /caffeine status.
function describe(c: Caffeine, now: number): { text: string; color?: string; isDim?: boolean } {
  if (!c.isOn) {
    return { text: 'caffeine off', isDim: true }
  }
  const tail = [c.pokes ? `${c.pokes} poke${c.pokes === 1 ? '' : 's'}` : '', c.until ? `until ${clock(c.until, now)}` : '']
    .filter(Boolean)
    .map(t => ` · ${t}`)
    .join('')
  const over = overLine(c.limits)
  if (over) {
    return { text: `caffeine paused · ${over.label} limit ${over.percent}%${tail}`, color: 'yellow' }
  }
  if (c.lastAt === 0) {
    return { text: `caffeine on · waits for the first reply${tail}`, color: 'green' }
  }
  if (c.isBusy || c.poke !== 'none') {
    return { text: `caffeine on · cache warm${tail}`, color: 'green' }
  }
  if (now - c.lastAt >= ttlOf(c)) {
    return { text: `caffeine on · cache went cold, waits for your next turn${tail}`, color: 'yellow' }
  }
  const at = nextPokeAt(c.lastAt, everyOf(c))!
  return { text: `caffeine on · poke at ${clock(at, now)} (in ${span(at - now)})${tail}`, color: 'green' }
}

async function refresh($: EngineInterface, c: Caffeine): Promise<void> {
  if (c.isBanded || !c.isOn) {
    $.ui.status(undefined)
  } else {
    $.ui.status(describe(c, await $.clock.now()).text)
  }
  $.ui.invalidate('ui.render')
}

async function switchOn($: EngineInterface, c: Caffeine, isOn: boolean, until = 0): Promise<void> {
  c.isOn = isOn
  c.until = isOn ? until : 0
  if (isOn) {
    c.activeAt = await $.clock.now()
  } else {
    c.poke = c.poke === 'running' ? 'running' : 'none'
  }
  await keep($, c)
  await refresh($, c)
}

// Sends the poke: a prompt of its own, run once the session is idle.
function poke($: EngineInterface, c: Caffeine, now: number): void {
  c.poke = 'sent'
  c.sentAt = now
  void $.prompt.submit({ text: c.message }).catch(() => {
    c.poke = 'none'
  })
}

async function tick($: EngineInterface, c: Caffeine): Promise<void> {
  if (!c.isOn) {
    return
  }
  const now = await $.clock.now()
  if (c.until && now >= c.until) {
    await switchOn($, c, false)
    tell($, 'wore off.')
    return
  }
  if (c.idle && now - c.activeAt >= c.idle) {
    await switchOn($, c, false)
    tell($, `turned off after ${span(c.idle)} without a turn of your own.`)
    return
  }
  if (c.poke !== 'none') {
    // a poke that never got its turn (a dialog, a closed prompt) stops holding the rest up
    if (c.poke === 'sent' && now - c.sentAt > 10 * MINUTE) c.poke = 'none'
    return
  }
  // a cold cache gains nothing from a poke: it would only be written again
  if (c.isBusy || c.lastAt === 0 || overLine(c.limits) || now - c.lastAt >= ttlOf(c)) {
    return
  }
  const due = nextPokeAt(c.lastAt, everyOf(c))
  if (due !== null && now >= due) {
    poke($, c, now)
  }
}

async function setMessage($: EngineInterface, c: Caffeine, text: string): Promise<string> {
  c.message = text.trim() || DEFAULT_MESSAGE
  c.isEditing = false
  await $.store.set('message', c.message)
  await refresh($, c)
  return c.message
}

async function editInBand($: EngineInterface, c: Caffeine): Promise<void> {
  c.isEditing = true
  $.ui.invalidate('ui.render')
  if (c.bandId) {
    await $.ui.focus({ requestId: c.bandId, key: 'caffeine-message' }).catch(() => undefined)
  }
}

const help = [
  '/caffeine              turn it on or off for this session',
  '/caffeine on | off',
  '/caffeine for 2h       on, and off again after 2h (90m, 1h30m)',
  '/caffeine until 18:00  on, and off again at 18:00 (6pm)',
  '/caffeine poke         poke now',
  '/caffeine message …    what the poke says (alone: show it; "reset": the default)',
  '/caffeine every 10m    poke this long after the last request (alone: back to auto)',
  '/caffeine ttl 1h|5m    the cache TTL, when Claude Code picks one caffeine cannot see (auto: undo)',
  '/caffeine idle 8h|off  turn off after this long without a turn of your own',
  '/caffeine band on|off  the row above the prompt; off moves it to the status line',
  '/caffeine status       what it is doing',
].join('\n')

export const register: Register = on => {
  const c: Caffeine = {
    isOn: false,
    until: 0,
    lastAt: 0,
    activeAt: 0,
    isBusy: false,
    poke: 'none',
    pokeTurnId: '',
    sentAt: 0,
    pokes: 0,
    lastWarm: null,
    limits: [],
    envTtl: TTL_5M,
    ttl: null,
    message: DEFAULT_MESSAGE,
    every: null,
    isBanded: true,
    idle: DEFAULT_IDLE,
    isEditing: false,
    bandId: '',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'caffeine', description: 'Keep the prompt cache warm while you step away: a short poke before it expires' })
    const started = await next(e)
    await load($, c)
    try {
      Object.assign(c, await read($, brew))
    } catch {
      // a fresh session: off
    }
    try {
      c.limits = [...(await $.session.usage()).rateLimits]
    } catch {
      // the first reply brings them
    }
    $.clock.every(5_000, () => void tick($, c))
    // the countdown
    $.clock.every(30_000, () => {
      if (c.isOn) void refresh($, c)
    })
    await refresh($, c)
    return started
  })

  on('session.measure', ($, e, next) => {
    c.limits = [...e.rateLimits]
    return next(e)
  })

  // Each main-thread request reads the cached prompt and starts its TTL again.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      void $.clock.now().then(t => {
        c.lastAt = t
        void keep($, c)
      })
    }
    return yield* next(e)
  })

  on('turn.start', async ($, e, next) => {
    c.isBusy = true
    if (c.poke === 'sent' && e.text.includes(c.message)) {
      c.poke = 'running'
      c.pokeTurnId = e.turnId
    } else {
      c.activeAt = await $.clock.now()
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      c.isBusy = false
      if (c.poke === 'running' && e.turnId === c.pokeTurnId) {
        c.poke = 'none'
        c.pokes += 1
        const warm = wasWarm(e.usage)
        if (warm === false && c.lastWarm !== false) {
          tell($, `that poke found the cache cold. /caffeine every ${span(everyOf(c) / 2)} pokes sooner.`)
        }
        c.lastWarm = warm
      }
      await keep($, c)
      await refresh($, c)
    }
    return next(e)
  })

  on('command.run', { command: 'caffeine' }, async ($, e) => {
    const args = e.args.trim()
    const [word = '', ...rest] = args.split(/\s+/)
    const arg = word.toLowerCase()
    const value = rest.join(' ').trim()
    const now = await $.clock.now()
    switch (arg) {
      case 'help':
        return { text: help }
      case '':
        await switchOn($, c, !c.isOn)
        return { text: c.isOn ? `Caffeine on: ${describe(c, now).text.replace(/^caffeine on · /, '')}.` : 'Caffeine off.' }
      case 'on':
        await switchOn($, c, true)
        return { text: `Caffeine on, poking ${span(everyOf(c))} after the last request (${ttlLabel(ttlOf(c))} cache).` }
      case 'off':
        await switchOn($, c, false)
        return { text: 'Caffeine off.' }
      case 'for': {
        const ms = parseDuration(value)
        if (ms === null) return { text: `Not a duration I know: ${value || '(none)'}. Try 2h, 90m or 1h30m.` }
        await switchOn($, c, true, now + ms)
        return { text: `Caffeine on until ${clock(now + ms, now)}.` }
      }
      case 'until': {
        const at = parseClock(value, now)
        if (at === null) return { text: `Not a time I know: ${value || '(none)'}. Try 18:00 or 6pm.` }
        await switchOn($, c, true, at)
        return { text: `Caffeine on until ${clock(at, now)}.` }
      }
      case 'poke':
        if (c.poke !== 'none') return { text: 'A poke is already on its way.' }
        // a prompt submitted from inside this command would wait on the turn it holds
        $.clock.after(50, () => void $.clock.now().then(t => poke($, c, t)))
        return { text: `Poking: ${c.message}` }
      case 'message':
      case 'say': {
        if (!value) return { text: `The poke says: ${c.message}` }
        const saved = await setMessage($, c, value.toLowerCase() === 'reset' ? '' : value)
        return { text: `The poke now says: ${saved}` }
      }
      case 'every': {
        if (!value || value === 'auto') {
          c.every = null
          await $.store.set('every', null)
          await refresh($, c)
          return { text: `Poking ${span(everyOf(c))} after the last request (auto, ${ttlLabel(ttlOf(c))} cache).` }
        }
        const ms = parseDuration(value)
        if (ms === null || ms < 30_000) return { text: `Not a duration I know (30s or more): ${value}.` }
        if (ms >= ttlOf(c)) return { text: `${span(ms)} is past the ${ttlLabel(ttlOf(c))} cache: it would be cold by then.` }
        c.every = ms
        await $.store.set('every', ms)
        await refresh($, c)
        return { text: `Poking ${span(ms)} after the last request.` }
      }
      case 'ttl': {
        const v = value.toLowerCase()
        c.ttl = v === '1h' ? TTL_1H : v === '5m' ? TTL_5M : null
        if (c.ttl === null && v && v !== 'auto') return { text: 'The TTL is 1h, 5m or auto.' }
        await $.store.set('ttl', c.ttl)
        await refresh($, c)
        return { text: `Cache TTL ${ttlLabel(ttlOf(c))}${c.ttl === null ? ' (from the environment)' : ''}; poking ${span(everyOf(c))} after the last request.` }
      }
      case 'idle': {
        const ms = value === 'off' || value === 'never' ? 0 : parseDuration(value)
        if (ms === null) return { text: `Not a duration I know: ${value || '(none)'}. Try 8h, or off.` }
        c.idle = ms
        await $.store.set('idle', ms)
        return { text: ms ? `Caffeine turns itself off after ${span(ms)} without a turn of your own.` : 'Caffeine stays on until you turn it off.' }
      }
      case 'band': {
        const v = value.toLowerCase()
        c.isBanded = v === 'on' ? true : v === 'off' ? false : !c.isBanded
        await $.store.set('band', c.isBanded)
        await refresh($, c)
        return { text: c.isBanded ? 'Caffeine shows in its row above the prompt.' : 'Caffeine shows in the status line while on; no row above the prompt.' }
      }
      case 'status': {
        const lines = [
          describe(c, now).text,
          `Cache TTL ${ttlLabel(ttlOf(c))}${c.ttl === null ? ' (from the environment)' : ''} · poke ${span(everyOf(c))} after the last request${c.every === null ? ' (auto)' : ''}`,
          `Off by itself after ${c.idle ? span(c.idle) : 'never'} idle · band ${c.isBanded ? 'on' : 'off'}`,
          c.lastWarm === null ? '' : `The last poke found the cache ${c.lastWarm ? 'warm' : 'cold'}.`,
          `The poke says: ${c.message}`,
        ]
        return { text: lines.filter(Boolean).join('\n') }
      }
      default:
        return { text: `Not a caffeine command: ${word}\n${help}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if ((e.surface !== 'terminal' && e.surface !== 'desktop') || e.props.hasSurvey || !c.isBanded) {
      return next(e)
    }
    c.bandId = e.requestId
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const line = describe(c, now)
    const row = c.isEditing ? (
      <Box key="caffeine" flexDirection="row" columnGap={2}>
        <Input
          key="caffeine-message"
          label="caffeine says: "
          value={c.message}
          placeholder={DEFAULT_MESSAGE}
          submitLabel="save"
          autoFocus
          onSubmit={text => void setMessage($, c, text).then(saved => tell($, `the poke now says: ${saved}`))}
        />
        <Button
          key="caffeine-cancel"
          plain
          dimColor
          hotkey="q"
          onPress={() => {
            c.isEditing = false
            $.ui.invalidate('ui.render')
          }}
        >
          cancel
        </Button>
      </Box>
    ) : (
      <Box key="caffeine" flexDirection="row" columnGap={2}>
        <Text key="text" color={line.color} dimColor={line.isDim} wrap="truncate-end">
          {line.text}
        </Text>
        <Button key="caffeine-toggle" plain hotkey="t" onPress={() => void switchOn($, c, !c.isOn)}>
          {c.isOn ? 'turn off' : 'turn on'}
        </Button>
        <Button key="caffeine-edit" plain dimColor hotkey="e" onPress={() => void editInBand($, c)}>
          message
        </Button>
      </Box>
    )
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })
}
