import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Brew } from '../types'
import {
  clock,
  DEFAULT_IDLE,
  DEFAULT_MESSAGE,
  defaultEvery,
  dollars,
  equivalents,
  nextPokeAt,
  overLine,
  parseClock,
  parseDuration,
  pokeGuess,
  pokeWasCold,
  readTiming,
  readRate,
  span,
  tokens,
  TTL_1H,
  TTL_5M,
  ttlByPlan,
  ttlFromCost,
  ttlFromEnv,
  writeRate,
} from './brew'
import type { Limit, Usage } from './brew'
import { awakeArgv, blocking, cronAt, DEFAULT_WAKE, fromCron, isNear, MARK, osOf, parseWhen, wakeAfter, wholeMinute } from './wake'
import type { Block } from './wake'

// The session's switch, kept by the host so a reload of the mod finds it.
const brew = atom({ plugin: 'caffeine', key: 'brew' } as const, {
  isOn: false,
  until: 0,
  lastAt: 0,
  activeAt: 0,
  isAutoDeclined: false,
  isForever: false,
})

// A wake booked with CronCreate: its job, when it fires, and what it waits out.
type Armed = { id: string; at: number; label: string }

type Caffeine = Brew & {
  // a main-thread turn is running; its own requests keep the cache warm
  isBusy: boolean
  // a poke submitted and waiting for its turn, then running in it
  poke: 'none' | 'sent' | 'running'
  pokeTurnId: string
  sentAt: number
  pokes: number
  // what the pokes cost this session, in input-token equivalents
  spent: number
  lastPoke: Usage | null
  // whether the last poke found the cache still warm
  lastWarm: boolean | null
  limits: Limit[]
  context: number
  model: string
  // the TTL: the person's override, Claude Code's environment, and what the
  // session's own requests cost; else Claude Code's automatic choice by plan
  ttl: number | null
  envTtl: number | null
  measuredTtl: number | null
  // what request timing says, for models caffeine has no price for
  timedTtl: number | null
  // the next request follows a compaction, which rewrites the cache anyway
  isAfterCompact: boolean
  // the last time a request found the cache cold, and the gap before it
  coldAt: number
  coldGap: number
  // settings kept across sessions
  message: string
  every: number | null
  isBanded: boolean
  idle: number
  // turn on by itself once the context passes this many tokens; 0 is never
  autoAt: number
  // the band's message field is open
  isEditing: boolean
  bandId: string
  // the wake
  armed: Armed | null
  // the last reply failed on the usage limit
  isHit: boolean
  // the reset someone said "not now" to; the wake row stays down until it passes
  dismissed: number
  // caffeine was off when the wake was booked, and comes off with it
  isWakeLit: boolean
  // the child keeping the machine up while a wake waits; leaving its loop ends it
  awake: AsyncIterator<unknown> | null
}

const MINUTE = 60_000
// `/caffeine warm` alone
const WARM = 60 * MINUTE

// what the requests cost is the truth; the environment and the plan are what Claude Code should pick
const ttlOf = (c: Caffeine) => c.ttl ?? c.measuredTtl ?? c.envTtl ?? c.timedTtl ?? ttlByPlan(c.limits)

// Where the TTL caffeine works with comes from, for /caffeine status.
function ttlSource(c: Caffeine): string {
  if (c.ttl !== null) return 'set with /caffeine ttl'
  if (c.measuredTtl !== null) return 'measured from what requests cost'
  if (c.envTtl !== null) return 'from the environment'
  if (c.timedTtl !== null) return 'measured from request timing'
  if (c.limits.length) return 'the subscription default'
  return c.lastAt ? 'the API-key default' : 'a guess until the first reply shows the plan'
}
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
  c.idle = (await setting($, 'idle', DEFAULT_IDLE)) || DEFAULT_IDLE
  c.ttl = await setting<number | null>($, 'ttl', null)
  c.autoAt = await setting($, 'autoAt', 0)
  try {
    c.envTtl = ttlFromEnv(
      await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      await $.env.get('FORCE_PROMPT_CACHING_5M'),
      await $.env.get('ENABLE_PROMPT_CACHING_1H'),
    )
  } catch {
    c.envTtl = null
  }
}

async function keep($: EngineInterface, c: Caffeine): Promise<void> {
  const kept: Brew = { isOn: c.isOn, until: c.until, lastAt: c.lastAt, activeAt: c.activeAt, isAutoDeclined: c.isAutoDeclined, isForever: c.isForever }
  await update($, brew, () => kept).catch(() => undefined)
}

// How long caffeine keeps the cache warm: to a set time, or until it is turned off.
function howLong(c: Caffeine, now: number): string {
  if (c.until) {
    return `until ${clock(c.until, now)} (${span(c.until - now)} left)`
  }
  return c.isForever || c.armed ? 'until you turn it off' : `until you turn it off (or ${span(c.idle).replace(' 00m', '')} idle)`
}

// One line for the band, the status line and /caffeine status.
function describe(c: Caffeine, now: number): { text: string; color?: string; isDim?: boolean } {
  if (!c.isOn) {
    return { text: 'caffeine off', isDim: true }
  }
  const tail = [c.pokes ? `${c.pokes} poke${c.pokes === 1 ? '' : 's'}` : '', howLong(c, now)]
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

async function costNow($: EngineInterface): Promise<number | null> {
  try {
    const usd = (await $.session.usage()).cost?.usd
    return typeof usd === 'number' ? usd : null
  } catch {
    return null
  }
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
  c.isWakeLit = false
  c.isForever = false
  if (isOn) {
    c.activeAt = await $.clock.now()
  } else if (c.poke === 'sent') {
    c.poke = 'none'
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
    const wasWake = c.isWakeLit
    await switchOn($, c, false)
    if (!wasWake) tell($, 'wore off.')
    return
  }
  if (!c.isForever && !c.armed && now - c.activeAt >= c.idle) {
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

// What the pokes cost against one cache rewrite.
function costLines(c: Caffeine): string[] {
  const ttl = ttlOf(c)
  const model = c.model
  if (!model || c.context === 0) {
    return ['No reply yet this session: the cost comes with the first one.']
  }
  const poked = c.lastPoke ?? pokeGuess(c.context)
  const each = equivalents(poked, model, ttl)
  const rewrite = c.context * writeRate(ttl)
  const ratio = rewrite / each
  const usd = (n: number) => {
    const d = dollars(n, model)
    return d ? `, ${d}` : ''
  }
  return [
    `Context ${tokens(c.context)} tokens on ${model}, ${ttlLabel(ttl)} cache, a poke ${span(everyOf(c))} after the last request.`,
    `One poke: ${tokens(each)} input-token equivalents${usd(each)}${c.lastPoke ? ' (the last one, measured)' : ` (cache read at ${readRate(model)}x)`}.`,
    `One cache rewrite: ${tokens(rewrite)} (written again at ${writeRate(ttl)}x)${usd(rewrite)}.`,
    `A rewrite costs about ${Math.round(ratio)} pokes: caffeine pays off if you are back within ${span(ratio * everyOf(c))}.`,
    c.pokes ? `This session: ${c.pokes} poke${c.pokes === 1 ? '' : 's'}, ${tokens(c.spent)}${usd(c.spent)}.` : '',
    'At API list prices; on a Pro or Max plan the same tokens count against your usage limits instead.',
  ].filter(Boolean)
}

// The wake: a one-shot CronCreate that submits the wake prompt at a set time.

function stopAwake(c: Caffeine): void {
  const child = c.awake
  c.awake = null
  void child?.return?.(undefined)
}

// Holds off sleep until a little after the wake, unless turned off.
async function keepAwake($: EngineInterface, c: Caffeine, at: number): Promise<void> {
  stopAwake(c)
  if (!(await setting($, 'awake', true))) {
    return
  }
  const seconds = (at - (await $.clock.now())) / 1000 + 180
  try {
    const child = $.process.spawn({ argv: awakeArgv(osOf($.plugin.root), seconds) })[Symbol.asyncIterator]()
    c.awake = child
    void (async () => {
      try {
        while (!(await child.next()).done) {
          // nothing to read; the child's life is the point
        }
      } catch {
        // no keep-awake command here; sleep is the machine's own business then
      }
    })()
  } catch {
    // same
  }
}

async function arm($: EngineInterface, c: Caffeine, at: number, label: string): Promise<void> {
  await disarm($, c)
  const prompt = `${MARK} ${await setting($, 'wakePrompt', DEFAULT_WAKE)}`
  const made = await $.tool.call({ tool: 'CronCreate', cron: cronAt(at), prompt, recurring: false })
  if (made.deny !== undefined) {
    tell($, `could not book the wake: ${made.deny}`)
    return
  }
  const id = (made.result as { id?: unknown } | undefined)?.id
  if (made.isError || typeof id !== 'string') {
    tell($, `could not book the wake: ${made.text ?? 'CronCreate gave no job id'}`)
    return
  }
  c.armed = { id, at, label }
  await keepAwake($, c, at)
  // the cache stays warm until Claude picks the work back up
  if (!c.isOn) {
    await switchOn($, c, true, at)
    c.isWakeLit = true
  }
  const now = await $.clock.now()
  tell($, `Claude continues at ${clock(at, now)} (in ${span(at - now)})${label ? `, after the ${label} reset` : ''}. Keep this session open.`)
  $.ui.invalidate('ui.render')
}

async function disarm($: EngineInterface, c: Caffeine): Promise<boolean> {
  const armed = c.armed
  c.armed = null
  stopAwake(c)
  if (c.isWakeLit) {
    await switchOn($, c, false)
  }
  $.ui.invalidate('ui.render')
  if (!armed) {
    return false
  }
  await $.tool.call({ tool: 'CronDelete', id: armed.id }).catch(() => undefined)
  return true
}

// After `--resume` the session's crons come back; take back the one that is ours.
async function adopt($: EngineInterface, c: Caffeine): Promise<void> {
  try {
    const listed = await $.tool.call({ tool: 'CronList' })
    const jobs = ((listed.result as { jobs?: { id: string; cron: string; prompt: string }[] } | undefined)?.jobs ?? []).filter(
      j => j.prompt.startsWith(MARK),
    )
    const now = await $.clock.now()
    const job = jobs.map(j => ({ ...j, at: fromCron(j.cron, now) })).find(j => j.at > now)
    if (job && !c.armed) {
      c.armed = { id: job.id, at: job.at, label: '' }
      await keepAwake($, c, job.at)
      $.ui.invalidate('ui.render')
    }
  } catch {
    // no crons to read; nothing booked
  }
}

// The wake at the reset of whatever window is in the way.
async function armAtReset($: EngineInterface, c: Caffeine): Promise<void> {
  const block = blocking(c.limits)
  if (!block) {
    tell($, 'no reset time yet: it comes with the first reply on a Pro or Max plan. /caffeine wake 14:30 picks a time.')
    return
  }
  await arm($, c, wakeAfter(block.resetsAt), block.label)
}

const NO_RESET = 'No reset time yet: it comes with the first reply on a Pro or Max plan. /caffeine wake 14:30 picks a time.'

async function wakeCommand($: EngineInterface, c: Caffeine, args: string): Promise<{ text: string }> {
  const [word = '', ...rest] = args.split(/\s+/)
  const arg = word.toLowerCase()
  const value = rest.join(' ').trim()
  const now = await $.clock.now()
  const flip = async (key: string, name: string, fallback: boolean) => {
    const v = value.toLowerCase()
    const next = v === 'on' ? true : v === 'off' ? false : !(await setting($, key, fallback))
    await $.store.set(key, next)
    return { text: `${name} ${next ? 'on' : 'off'}.` }
  }
  switch (arg) {
    case '': {
      if (!blocking(c.limits)) return { text: NO_RESET }
      $.clock.after(50, () => void armAtReset($, c))
      return { text: 'Booking the wake…' }
    }
    case 'off':
    case 'cancel':
      $.clock.after(50, () => void disarm($, c).then(was => tell($, was ? 'wake cancelled.' : 'no wake was booked.')))
      return { text: 'Cancelling the wake…' }
    case 'prompt':
      if (!value) return { text: `On waking Claude is told: ${await setting($, 'wakePrompt', DEFAULT_WAKE)}` }
      await $.store.set('wakePrompt', value)
      return { text: `On waking Claude will be told: ${value}${c.armed ? ' (from the next wake you book)' : ''}` }
    case 'auto':
      return flip('wakeAuto', 'Booking a wake whenever the limit hits:', false)
    case 'awake':
      return flip('awake', 'Keeping the computer awake until a wake:', true)
    case 'push':
      return flip('push', 'A phone notification on waking:', true)
    default: {
      const at = parseWhen(word, now)
      if (at === null) return { text: `Not a time I know: ${word}. Try 14:30, 2:30pm or +90m.` }
      $.clock.after(50, () => void arm($, c, wholeMinute(at), ''))
      return { text: `Booking the wake for ${clock(wholeMinute(at), now)}…` }
    }
  }
}

const FOREVER = 'Yes, no end'
const KEEP_STOP = 'Keep the idle stop'

// No end at all, but only once the person has said so: the dialog spells out
// what it costs, and a run with no one to ask takes a trailing "yes" instead.
async function forever($: EngineInterface, c: Caffeine, isSure: boolean): Promise<{ text: string }> {
  const perDay = Math.round((24 * 60 * MINUTE) / everyOf(c))
  if (!isSure) {
    let answer: string
    try {
      answer = await $.ui.ask(
        `Keep the cache warm with no end, this time? Caffeine will poke ${span(everyOf(c))} after the last request until you turn it off, about ${perDay} pokes a day while you are away, and each one uses your plan's usage. Once you turn it off, the idle stop is back.`,
        { header: 'caffeine', options: [FOREVER, KEEP_STOP] },
      )
    } catch {
      return { text: 'No one to ask here. /caffeine forever yes confirms it.' }
    }
    if (answer !== FOREVER) {
      return { text: `Kept: caffeine still turns itself off after ${span(c.idle)} without a turn of your own.` }
    }
  }
  if (!c.isOn || c.until) {
    await switchOn($, c, true)
  }
  c.isForever = true
  await keep($, c)
  await refresh($, c)
  return { text: `Caffeine on with no end: it keeps the cache warm until you turn it off. The next time you turn it on, the ${span(c.idle)} idle stop is back.` }
}

const help = [
  '/caffeine              turn it on or off for this session',
  '/caffeine on | off',
  '/caffeine warm 1h      keep the cache warm for 1h, then off (90m, 1h30m; alone: 1h)',
  '/caffeine until 18:00  on, and off again at 18:00 (6pm)',
  '/caffeine poke         poke now',
  '/caffeine message …    what the poke says (alone: show it; "reset": the default)',
  '/caffeine auto 100k    turn on by itself once the context passes 100k tokens (off: never)',
  '/caffeine cost         what the pokes cost against one cache rewrite',
  '/caffeine every 10m    poke this long after the last request (alone: back to auto)',
  '/caffeine ttl 1h|5m    pin the cache TTL (auto: back to detecting it)',
  '/caffeine forever      on with no end this time, once you confirm (also: idle off); off brings the idle stop back',
  '/caffeine idle 8h      turn off after this long without a turn of your own',
  '/caffeine band on|off  the row above the prompt; off moves it to the status line',
  '/caffeine wake         wake Claude just after the usage limit resets',
  '/caffeine wake 14:30   at a time (2:30pm, +90m, +2h work too); off cancels',
  '/caffeine wake prompt …  what Claude is told on waking',
  '/caffeine wake auto | awake | push   book by itself at the limit; keep the computer awake; phone notification (on/off)',
  '/caffeine status       what it is doing',
].join('\n')

export const register: Register = on => {
  const c: Caffeine = {
    isOn: false,
    until: 0,
    lastAt: 0,
    activeAt: 0,
    isAutoDeclined: false,
    isForever: false,
    isBusy: false,
    poke: 'none',
    pokeTurnId: '',
    sentAt: 0,
    pokes: 0,
    spent: 0,
    lastPoke: null,
    lastWarm: null,
    limits: [],
    context: 0,
    model: '',
    ttl: null,
    envTtl: null,
    measuredTtl: null,
    timedTtl: null,
    isAfterCompact: false,
    coldAt: 0,
    coldGap: 0,
    message: DEFAULT_MESSAGE,
    every: null,
    isBanded: true,
    idle: DEFAULT_IDLE,
    autoAt: 0,
    isEditing: false,
    bandId: '',
    armed: null,
    isHit: false,
    dismissed: 0,
    isWakeLit: false,
    awake: null,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'caffeine',
      description: 'Keep the prompt cache warm while you step away, and wake Claude when the usage limit resets',
    })
    const started = await next(e)
    await load($, c)
    try {
      Object.assign(c, await read($, brew))
    } catch {
      // a fresh session: off
    }
    try {
      const usage = await $.session.usage()
      c.limits = [...usage.rateLimits]
    } catch {
      // the first reply brings them
    }
    $.clock.after(50, () => void adopt($, c))
    $.clock.every(5_000, () => void tick($, c))
    // the countdowns
    $.clock.every(30_000, () => {
      if (c.isOn || c.armed || isNear(c.limits)) void refresh($, c)
    })
    await refresh($, c)
    return started
  })

  on('session.measure', async ($, e, next) => {
    const wasNear = isNear(c.limits)
    c.limits = [...e.rateLimits]
    c.context = e.context?.tokens ?? c.context
    if (c.autoAt && !c.isOn && !c.isAutoDeclined && c.context >= c.autoAt) {
      await switchOn($, c, true)
      tell($, `on: the context passed ${tokens(c.autoAt)} tokens. /caffeine off turns it off for this session.`)
    }
    const block = blocking(c.limits)
    if (block && block.percent >= 100 && !c.armed && (await setting($, 'wakeAuto', false))) {
      await armAtReset($, c)
    } else if (!wasNear && isNear(c.limits) && block) {
      $.ui.toast(`caffeine: ${block.label} limit at ${block.percent}%, resets ${clock(block.resetsAt, await $.clock.now())}. /caffeine wake books a wake.`)
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit') {
      c.isHit = true
      if (!c.armed && (await setting($, 'wakeAuto', false))) {
        await armAtReset($, c)
      }
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Each main-thread request reads the cached prompt and starts its TTL again.
  // What it cost says which TTL it was written at.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }
    const at = await $.clock.now()
    const gap = c.lastAt ? at - c.lastAt : 0
    // a first request, a compaction or another model writes the cache whatever the TTL
    const isExempt = c.lastAt === 0 || c.isAfterCompact || (c.model !== '' && c.model !== e.model)
    c.model = e.model
    c.lastAt = at
    c.isAfterCompact = false
    void keep($, c)
    const before = await costNow($)
    const result = yield* next(e)
    const after = await costNow($)
    if (result.usage) {
      const priced = before !== null && after !== null ? ttlFromCost(after - before, result.usage, result.usage.model || e.model) : null
      if (priced !== null) c.measuredTtl = priced
      const timing = readTiming(gap, result.usage, isExempt)
      if (timing.ttl !== null) c.timedTtl = timing.ttl
      if (timing.isCold) {
        c.coldAt = at
        c.coldGap = gap
        if (c.isOn && c.poke !== 'running') {
          tell($, `the cache had gone cold after ${span(gap)} idle; this request wrote it again.`)
        }
      }
      if (priced !== null || timing.ttl !== null) void refresh($, c)
    }
    return result
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
        if (e.usage) {
          c.lastPoke = e.usage
          c.spent += equivalents(e.usage, e.usage.model || c.model, ttlOf(c))
        }
        if (e.usage && pokeWasCold(e.usage)) {
          c.lastWarm = false
          await switchOn($, c, false)
          tell(
            $,
            `turned off: its poke found the cache cold (it wrote ${tokens(e.usage.cache_creation_input_tokens)} tokens again), so the pokes were not keeping it warm. /caffeine status says why it may be; turn it on again to retry.`,
          )
        } else if (e.usage) {
          c.lastWarm = true
        }
      }
      await keep($, c)
      await refresh($, c)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.text.startsWith(MARK)) {
      // our wake fired
      c.armed = null
      c.isHit = false
      stopAwake(c)
      $.ui.invalidate('ui.render')
      if (await setting($, 'push', true)) {
        void $.tool
          .call({ tool: 'PushNotification', message: 'caffeine: the wake fired and Claude is back at it.', status: 'proactive' })
          .catch(() => undefined)
      }
    } else if (e.origin.kind !== 'plugin') {
      c.isHit = false
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    c.isAfterCompact = true
    return done
  })

  on('session.end', ($, e, next) => {
    stopAwake(c)
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
        if (c.isOn) c.isAutoDeclined = true
        await switchOn($, c, !c.isOn)
        return { text: c.isOn ? `Caffeine on: ${describe(c, now).text.replace(/^caffeine on · /, '')}.` : 'Caffeine off.' }
      case 'on':
        await switchOn($, c, true)
        return { text: `Caffeine on until you turn it off, poking ${span(everyOf(c))} after the last request (${ttlLabel(ttlOf(c))} cache).` }
      case 'off':
        c.isAutoDeclined = true
        await switchOn($, c, false)
        return { text: 'Caffeine off.' }
      case 'for':
      case 'warm': {
        const ms = value ? parseDuration(value) : WARM
        if (ms === null) return { text: `Not a duration I know: ${value}. Try 2h, 90m or 1h30m.` }
        await switchOn($, c, true, now + ms)
        return { text: `Caffeine on, keeping the cache warm until ${clock(now + ms, now)}.` }
      }
      case 'until': {
        const at = parseClock(value, now)
        if (at === null) return { text: `Not a time I know: ${value || '(none)'}. Try 18:00 or 6pm.` }
        await switchOn($, c, true, at)
        return { text: `Caffeine on, keeping the cache warm until ${clock(at, now)}.` }
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
      case 'auto': {
        const v = value.toLowerCase()
        if (!v) return { text: c.autoAt ? `Caffeine turns on by itself past ${tokens(c.autoAt)} tokens of context.` : 'Auto is off. /caffeine auto 100k turns it on.' }
        const n = v === 'off' ? 0 : v === 'on' ? 100_000 : /^(\d+(?:\.\d+)?)(k|m)?$/.test(v) ? Math.round(Number.parseFloat(v) * (v.endsWith('m') ? 1e6 : v.endsWith('k') ? 1e3 : 1)) : null
        if (n === null || (n > 0 && n < 1000)) return { text: `Not a token count I know: ${value}. Try 100k, or off.` }
        c.autoAt = n
        await $.store.set('autoAt', n)
        return { text: n ? `Caffeine turns on by itself once the context passes ${tokens(n)} tokens (now ${tokens(c.context)}).` : 'Auto off.' }
      }
      case 'cost':
        return { text: costLines(c).join('\n') }
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
        const ttl = v === '1h' ? TTL_1H : v === '5m' ? TTL_5M : null
        if (ttl === null && v && v !== 'auto') return { text: 'The TTL is 1h, 5m or auto.' }
        c.ttl = ttl
        await $.store.set('ttl', ttl)
        await refresh($, c)
        return { text: `Cache TTL ${ttlLabel(ttlOf(c))} (${ttlSource(c)}); poking ${span(everyOf(c))} after the last request.` }
      }
      case 'forever':
        return forever($, c, value.toLowerCase() === 'yes')
      case 'idle': {
        const [first = '', second = ''] = value.toLowerCase().split(/\s+/)
        if (first === 'off' || first === 'never') {
          return forever($, c, second === 'yes')
        }
        const ms = parseDuration(value)
        if (ms === null) return { text: `Not a duration I know: ${value || '(none)'}. Try 8h, or off for no end this time.` }
        c.idle = ms
        await $.store.set('idle', ms)
        return { text: `Caffeine turns itself off after ${span(ms)} without a turn of your own.` }
      }
      case 'band': {
        const v = value.toLowerCase()
        c.isBanded = v === 'on' ? true : v === 'off' ? false : !c.isBanded
        await $.store.set('band', c.isBanded)
        await refresh($, c)
        return { text: c.isBanded ? 'Caffeine shows in its row above the prompt.' : 'Caffeine shows in the status line while on; no row above the prompt.' }
      }
      case 'wake':
        return wakeCommand($, c, value)
      case 'status': {
        const block = blocking(c.limits)
        const lines = [
          describe(c, now).text,
          `Cache TTL ${ttlLabel(ttlOf(c))} (${ttlSource(c)}) · poke ${span(everyOf(c))} after the last request${c.every === null ? ' (auto)' : ''}`,
          `${c.isForever ? 'No idle stop this time: on until you turn it off' : `Off by itself after ${span(c.idle)} idle`} · auto ${c.autoAt ? `past ${tokens(c.autoAt)}` : 'off'} · band ${c.isBanded ? 'on' : 'off'}`,
          c.lastWarm === null ? '' : `The last poke found the cache ${c.lastWarm ? 'warm' : 'cold'}.`,
          c.coldAt ? `The cache last went cold before ${clock(c.coldAt, now)}, after ${span(c.coldGap)} idle.` : '',
          `The poke says: ${c.message}`,
          c.armed ? `Wake: Claude continues at ${clock(c.armed.at, now)} (in ${span(c.armed.at - now)}).` : 'Wake: none booked.',
          block ? `${block.label} limit ${block.percent}%, resets ${clock(block.resetsAt, now)}.` : '',
        ]
        return { text: lines.filter(Boolean).join('\n') }
      }
      default:
        return { text: `Not a caffeine command: ${word}\n${help}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if ((e.surface !== 'terminal' && e.surface !== 'desktop') || e.props.hasSurvey) {
      return next(e)
    }
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    c.bandId = e.requestId

    // the wake row: near the limit an offer, once booked a countdown
    const block: Block | null = blocking(c.limits)
    const isOffered = !c.armed && block !== null && (isNear(c.limits) || c.isHit) && c.dismissed !== block.resetsAt
    const armed = c.armed
    const wakeRow = armed ? (
      <Box key="caffeine-wake-row" flexDirection="row" columnGap={2}>
        <Text key="wake-text" color="cyan" wrap="truncate-end">
          {`caffeine · Claude continues at ${clock(armed.at, now)} (in ${span(armed.at - now)})`}
        </Text>
        <Button key="caffeine-wake-cancel" plain dimColor hotkey="n" onPress={() => void disarm($, c).then(() => tell($, 'wake cancelled.'))}>
          cancel
        </Button>
      </Box>
    ) : isOffered ? (
      <Box key="caffeine-wake-row" flexDirection="row" columnGap={2}>
        <Text key="wake-text" color={block!.percent >= 100 ? 'red' : 'yellow'} wrap="truncate-end">
          {`${block!.label} limit ${block!.percent}% · resets ${clock(block!.resetsAt, now)} (in ${span(block!.resetsAt - now)})`}
        </Text>
        <Button key="caffeine-wake" plain hotkey="u" onPress={() => void armAtReset($, c)}>
          {`wake Claude at ${clock(wakeAfter(block!.resetsAt), now)}`}
        </Button>
        <Button
          key="caffeine-wake-dismiss"
          plain
          dimColor
          hotkey="n"
          onPress={() => {
            c.dismissed = block!.resetsAt
            $.ui.invalidate('ui.render')
          }}
        >
          not now
        </Button>
      </Box>
    ) : null

    // the switch row
    const line = describe(c, now)
    const row = !c.isBanded ? null : c.isEditing ? (
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
        <Button
          key="caffeine-toggle"
          plain
          hotkey="t"
          onPress={() => {
            if (c.isOn) c.isAutoDeclined = true
            void switchOn($, c, !c.isOn)
          }}
        >
          {c.isOn ? 'turn off' : 'turn on'}
        </Button>
        <Button key="caffeine-edit" plain dimColor hotkey="e" onPress={() => void editInBand($, c)}>
          message
        </Button>
      </Box>
    )

    if (!wakeRow && !row) {
      return next(e)
    }
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {wakeRow}
        {row}
        {below}
      </Box>
    )
  })
}
