import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { awakeArgv, blocking, cronAt, fromCron, isNear, MARK, osOf, parseWhen, wakeAfter } from '../hooks/wake'
import { pokeWasCold, readTiming } from '../hooks/brew'
import { clock, defaultEvery, dollars, equivalents, readRate, tokens, nextPokeAt, overLine, parseClock, parseDuration, span, TTL_1H, TTL_5M, ttlByPlan, ttlFromCost, ttlFromEnv, wasWarm } from '../hooks/brew'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
}

const MIN = 60_000
const at = (h: number, m: number, day = 4) => new Date(2026, 9, day, h, m).getTime()

test('durations, times and the cadence', () => {
  expect(parseDuration('2h')).toBe(120 * MIN)
  expect(parseDuration('90m')).toBe(90 * MIN)
  expect(parseDuration('1h30m')).toBe(90 * MIN)
  expect(parseDuration('2.5m')).toBe(150_000)
  expect(parseDuration('150s')).toBe(150_000)
  expect(parseDuration('soon')).toBeNull()
  expect(parseDuration('')).toBeNull()
  expect(parseClock('18:00', at(9, 0))).toBe(at(18, 0))
  expect(parseClock('6pm', at(9, 0))).toBe(at(18, 0))
  expect(parseClock('8:00', at(9, 0))).toBe(at(8, 0, 5))
  expect(parseClock('18', at(9, 0))).toBeNull()
  expect(clock(at(14, 12), at(9, 0))).toBe('14:12')
  expect(span(125 * MIN)).toBe('2h 05m')
  expect(span(12 * MIN)).toBe('12m')
  expect(span(150_000)).toBe('2m 30s')
  expect(span(45_000)).toBe('45s')
  expect(defaultEvery(TTL_1H)).toBe(48 * MIN)
  expect(defaultEvery(TTL_5M)).toBe(4 * MIN)
  expect(ttlFromEnv(undefined, undefined, '1')).toBe(TTL_1H)
  expect(ttlFromEnv(undefined, '1', '1')).toBe(TTL_5M)
  expect(ttlFromEnv('1h', '1', undefined)).toBe(TTL_1H)
  expect(ttlFromEnv('5m', undefined, '1')).toBe(TTL_5M)
  expect(ttlFromEnv(undefined, undefined, undefined)).toBeNull()
  expect(ttlFromEnv(undefined, undefined, '0')).toBeNull()
  expect(ttlByPlan([{ kind: 'five_hour', percentUsed: 19 }])).toBe(TTL_1H)
  expect(ttlByPlan([{ kind: 'five_hour', percentUsed: 100 }])).toBe(TTL_5M)
  expect(ttlByPlan([])).toBe(TTL_5M)
  // two real Haiku requests, as Claude Code priced them (1h writes)
  const haiku = 'claude-haiku-4-5-20251001'
  expect(ttlFromCost(0.013878, { input_tokens: 10, output_tokens: 51, cache_read_input_tokens: 20570, cache_creation_input_tokens: 5778 }, haiku)).toBe(TTL_1H)
  expect(ttlFromCost(0.0202628, { input_tokens: 10, output_tokens: 74, cache_read_input_tokens: 26348, cache_creation_input_tokens: 8624 }, haiku)).toBe(TTL_1H)
  expect(ttlFromCost(0.009781, { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 20570, cache_creation_input_tokens: 6011 }, haiku)).toBe(TTL_5M)
  // too little written to tell, an unknown price, a subagent's cost mixed in
  expect(ttlFromCost(0.002, { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 20570, cache_creation_input_tokens: 200 }, haiku)).toBeNull()
  expect(ttlFromCost(0.0138, { input_tokens: 10, output_tokens: 51, cache_read_input_tokens: 20570, cache_creation_input_tokens: 5778 }, 'other')).toBeNull()
  expect(ttlFromCost(0.05, { input_tokens: 10, output_tokens: 51, cache_read_input_tokens: 20570, cache_creation_input_tokens: 5778 }, haiku)).toBeNull()
  expect(nextPokeAt(0, MIN)).toBeNull()
  expect(nextPokeAt(1000, MIN)).toBe(1000 + MIN)
  expect(wasWarm({ cache_read_input_tokens: 90_000, cache_creation_input_tokens: 200 })).toBe(true)
  expect(wasWarm({ cache_read_input_tokens: 0, cache_creation_input_tokens: 90_000 })).toBe(false)
  expect(wasWarm(undefined)).toBeNull()
  expect(overLine([{ kind: 'five_hour', percentUsed: 89 }])).toBeNull()
  expect(overLine([{ kind: 'five_hour', percentUsed: 91.4 }])).toEqual({ label: '5h', percent: 91 })
  expect(overLine([{ kind: 'seven_day', percentUsed: 95 }])?.label).toBe('weekly')
})

// What the next request's response reports, for the turn.step stand-in.
let stepResult: object | null = null

// The engine beneath caffeine: the UI ops, the prompts it submits, the turns.
function world(on: On, submitted: string[], crons: { cron: string; prompt: string }[] = [], pushed: string[] = []) {
  on('tool.call', ($, e) => {
    if (e.tool === 'CronCreate') {
      crons.push({ cron: String(e.cron), prompt: String(e.prompt) })
      return { result: { id: `job${crons.length}`, humanSchedule: 'once', recurring: false } }
    }
    if (e.tool === 'CronDelete') return { result: { id: String(e.id) } }
    if (e.tool === 'CronList') return { result: { jobs: [] } }
    if (e.tool === 'PushNotification') {
      pushed.push(String(e.message))
      return { result: { message: String(e.message) } }
    }
    return { deny: 'unexpected' }
  })
  on('process.spawn', async function* () {
    // the keep-awake child: nothing to say, then done
    return { code: 0, signal: null } as never
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { rateLimits: [] } }) as never)
  on('session.measure', ($, e) => ({ changed: e.changed }) as never)
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'okay', toolUses: [], stopReason: 'end_turn', usage: stepResult } as never
  })
  // what another mod (clawd-buddy) or the engine draws in the band beneath caffeine
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="beneath" />
  })
}

// One main-thread turn: its start, one request, its end.
async function turn($: Engine, id: string, text: string, usage?: object, stepUsage?: object) {
  await $.turn.start({ text, turnId: id })
  stepResult = stepUsage ?? null
  for await (const _ of $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 3 } as never)) {
    // nothing streams
  }
  await $.turn.complete({ answer: 'okay', durationMs: 900, isAborted: false, turnId: id, reason: 'answer', usage } as never)
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'caffeine', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

test('on, it pokes 48 minutes after the last request on a 1h cache, and not on a cold one', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })

  expect((await run($, 'on')).text).toContain('until you turn it off, poking 48m after the last request (1h cache)')
  await turn($, 't1', 'fix the tests')
  await time.advance(47 * MIN)
  expect(submitted).toEqual([])
  await time.advance(1 * MIN + 5_000)
  expect(submitted).toEqual(['poke, just say okay'])

  // the poke's own turn: warm, counted, and the next one 48 minutes after it
  await turn($, 't2', 'poke, just say okay', { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 40, model: 'claude-opus-5-5' })
  expect((await run($, 'status')).text).toContain('1 poke')
  expect((await run($, 'status')).text).toContain('found the cache warm')
  await time.advance(48 * MIN + 5_000)
  expect(submitted.length).toBe(2)
  await turn($, 't3', 'poke, just say okay')

  // turned on again after the TTL ran out: no poke into a cold cache
  await run($, 'off')
  await time.advance(70 * MIN)
  await run($, 'on')
  await time.advance(10_000)
  expect(submitted.length).toBe(2)
  expect((await run($, 'status')).text).toContain('cache went cold')

  expect((await run($, 'off')).text).toBe('Caffeine off.')
})

test('the band toggles it, edits the message, and draws what is beneath', async ($, on) => {
  mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  world(on, [])
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const mount = () => $.ui.mount({ plugin: 'caffeine', surface, component: 'AbovePrompt', props: PROPS })
    let ui = await mount()
    expect(JSON.stringify(await ui.drawn())).toContain('caffeine off')
    expect(await ui.find({ key: 'beneath' })).toBeDefined()
    await ui.press({ key: 'caffeine-toggle' })
    await ui.unmount()
    ui = await mount()
    expect(JSON.stringify(await ui.drawn())).toContain('waits for the first reply')

    await ui.press({ key: 'caffeine-edit' })
    await ui.unmount()
    ui = await mount()
    expect(await ui.find({ key: 'caffeine-message' })).toBeDefined()
    await ui.input({ key: 'caffeine-message', text: `still there? (${surface})` })
    expect((await run($, 'message')).text).toBe(`The poke says: still there? (${surface})`)
    await ui.unmount()
    ui = await mount()
    expect(await ui.find({ key: 'caffeine-message' })).toBeUndefined()
    await ui.press({ key: 'caffeine-toggle' })
    await ui.unmount()
  }
  expect((await run($, 'message reset')).text).toBe('The poke now says: poke, just say okay')

  // bandless: the row steps aside for the other mods' rows
  expect((await run($, 'band off')).text).toContain('status line')
  const ui = await $.ui.mount({ plugin: 'caffeine', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(JSON.stringify(await ui.drawn())).not.toContain('caffeine')
  expect(await ui.find({ key: 'beneath' })).toBeDefined()
})

test('it wears off, turns itself off when idle, and pauses near the usage limit', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })

  expect((await run($, 'warm 1h')).text).toBe('Caffeine on, keeping the cache warm until 10:00.')
  await turn($, 't1', 'hello')
  await time.advance(4 * MIN + 5_000)
  expect(submitted.length).toBe(1)
  await turn($, 't2', 'poke, just say okay')
  await time.advance(61 * MIN)
  expect((await run($, 'status')).text).toContain('caffeine off')

  // idle: off after 20 minutes with only pokes
  expect((await run($, 'idle 20m')).text).toContain('after 20m')
  await run($, 'on')
  for (let i = 0; i < 10; i++) {
    await time.advance(4 * MIN + 5_000)
    if (submitted.length > i + 1) await turn($, `p${i}`, 'poke, just say okay')
  }
  expect((await run($, 'status')).text).toContain('caffeine off')
  const sent = submitted.length

  // no end: asked first (no dialog here, so it says how to confirm); a yes removes the stop
  expect((await run($, 'forever')).text).toContain('/caffeine forever yes confirms it')
  expect((await run($, 'status')).text).toContain('Off by itself after 20m idle')
  expect((await run($, 'idle off yes')).text).toContain('Caffeine on with no end')
  expect((await run($, 'status')).text).toContain('until you turn it off\nCache TTL')
  expect((await run($, 'status')).text).toContain('No idle stop this time: on until you turn it off')
  // off, then on again: the idle stop is back
  await run($, 'off')
  await run($, 'on')
  expect((await run($, 'status')).text).toContain('until you turn it off (or 20m idle)')
  expect((await run($, 'status')).text).toContain('Off by itself after 20m idle')

  // near the 5-hour line: paused, no pokes
  await run($, 'idle off yes')
  await run($, 'on')
  await turn($, 't3', 'more work')
  await $.session.measure({
    changed: ['rateLimits'],
    context: { tokens: 1000, max: 200000, percent: 0.5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 93, resetsAt: new Date(at(14, 0)).toISOString() }],
  } as never)
  await time.advance(4 * MIN)
  expect(submitted.length).toBe(sent)
  expect((await run($, 'status')).text).toContain('paused · 5h limit 93%')

  // a subscription (it has rate-limit windows) defaults to the 1h cache
  expect((await run($, 'status')).text).toContain('Cache TTL 1h (the subscription default)')
  expect((await run($, 'ttl 5m')).text).toContain('Cache TTL 5m')
  expect((await run($, 'every 10m')).text).toContain('past the 5m cache')
  expect((await run($, 'ttl 1h')).text).toContain('Cache TTL 1h')
  expect((await run($, 'every 10m')).text).toBe('Poking 10m after the last request.')
  expect((await run($, 'nonsense')).text).toContain('Not a caffeine command')
})

test('the wake: windows, times, cron lines and keep-awake commands', () => {
  const five = { kind: 'five_hour', percentUsed: 100, resetsAt: new Date(at(14, 10)).toISOString() }
  const week = { kind: 'seven_day', percentUsed: 40, resetsAt: new Date(at(9, 0, 8)).toISOString() }
  expect(blocking([five, week])?.label).toBe('5h')
  expect(blocking([five, { ...week, percentUsed: 100 }])?.label).toBe('weekly')
  expect(isNear([{ ...five, percentUsed: 89 }])).toBe(false)
  expect(isNear([{ ...five, percentUsed: 90 }])).toBe(true)
  expect(new Date(wakeAfter(at(14, 10))).getMinutes()).toBe(12)
  expect(new Date(wakeAfter(at(14, 28))).getMinutes()).toBe(31)
  expect(cronAt(at(14, 12))).toBe('12 14 4 10 *')
  expect(fromCron('12 14 4 10 *', at(9, 0))).toBe(at(14, 12))
  expect(parseWhen('+1h30m', at(9, 0))).toBe(at(10, 30))
  expect(parseWhen('2:30pm', at(9, 0))).toBe(at(14, 30))
  expect(parseWhen('soon', at(9, 0))).toBeNull()
  expect(osOf('C:\\Users\\x\\.claude')).toBe('windows')
  expect(osOf('/Users/x/.claude')).toBe('mac')
  expect(osOf('/home/x/.claude')).toBe('linux')
  expect(awakeArgv('windows', 60)[0]).toBe('powershell')
  expect(awakeArgv('mac', 60)).toEqual(['caffeinate', '-i', '-t', '60'])
  expect(awakeArgv('linux', 60).slice(0, 2)).toEqual(['systemd-inhibit', '--what=sleep:idle'])
})

test('cost: per-model cache read rates and the poke against a rewrite', () => {
  expect(readRate('claude-opus-5-5')).toBe(0.05)
  expect(readRate('claude-fable-5-1')).toBe(0.025)
  expect(readRate('claude-sonnet-5-5')).toBe(0.1)
  const poke = { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 60 }
  expect(equivalents(poke, 'claude-opus-5-5', 3_600_000)).toBe(40 + 50 + 5000 + 120)
  expect(tokens(284_000)).toBe('284k')
  expect(tokens(7300)).toBe('7.3k')
  expect(dollars(1_000_000, 'claude-opus-5-5')).toBe('about $4.00')
  expect(dollars(100, 'claude-opus-5-5')).toBe('under $0.01')
  expect(dollars(100, 'some-other-model')).toBe('')
})

test('near the limit the band offers a wake; a press books it and keeps the cache warm until then', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  const crons: { cron: string; prompt: string }[] = []
  const pushed: string[] = []
  world(on, [], crons, pushed)
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  const resetsAt = at(11, 0)
  await $.session.measure({
    changed: ['rateLimits'],
    context: { tokens: 1000, max: 200000, percent: 0.5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 96, resetsAt: new Date(resetsAt).toISOString() }],
  } as never)

  const mount = () => $.ui.mount({ plugin: 'caffeine', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  let ui = await mount()
  expect(JSON.stringify(await ui.drawn())).toContain('5h limit 96%')
  expect(await ui.find({ key: 'beneath' })).toBeDefined()
  await ui.press({ key: 'caffeine-wake' })
  await time.advance(100)
  expect(crons.length).toBe(1)
  expect(crons[0]!.cron).toBe(cronAt(wakeAfter(resetsAt)))
  expect(crons[0]!.prompt.startsWith(MARK)).toBe(true)
  // caffeine came on with the wake, until it
  expect((await run($, 'status')).text).toContain(`until ${clock(wakeAfter(resetsAt), at(9, 0))}`)
  await ui.unmount()
  ui = await mount()
  expect(JSON.stringify(await ui.drawn())).toContain('Claude continues at')

  // cancelling the wake turns off what it turned on
  await ui.press({ key: 'caffeine-wake-cancel' })
  expect((await run($, 'status')).text).toContain('caffeine off')
  expect((await run($, 'status')).text).toContain('Wake: none booked.')

  // a wake at a time, and its fire
  expect((await run($, 'wake +90m')).text).toContain('Booking the wake for 10:31')
  await time.advance(100)
  expect(crons.length).toBe(2)
  await $.prompt.submit({ text: crons[1]!.prompt } as never)
  await time.settle()
  expect(pushed.length).toBe(1)
  expect((await run($, 'status')).text).toContain('Wake: none booked.')
  expect((await run($, 'wake prompt run the tests again')).text).toContain('run the tests again')
  expect((await run($, 'wake auto on')).text).toContain('on.')
  expect((await run($, 'wake nonsense')).text).toContain('Not a time I know')
  await ui.unmount()
})

test('auto turns it on past the context size, once; away 1h; cost reads the session', async ($, on) => {
  mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  world(on, [])
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  const measure = (n: number) =>
    $.session.measure({ changed: ['context'], context: { tokens: n, max: 1_000_000, percent: n / 1e4 }, rateLimits: [] } as never)

  expect((await run($, 'cost')).text).toContain('No reply yet')
  expect((await run($, 'auto 100k')).text).toContain('passes 100k tokens')
  await measure(90_000)
  expect((await run($, 'status')).text).toContain('caffeine off')
  await turn($, 't1', 'read the whole repo')
  await measure(120_000)
  expect((await run($, 'status')).text).toContain('caffeine on')
  // turned off by hand: auto leaves it off for the session
  await run($, 'off')
  await measure(130_000)
  expect((await run($, 'status')).text).toContain('caffeine off')

  const cost = (await run($, 'cost')).text
  expect(cost).toContain('Context 130k tokens on claude-opus-5-5, 1h cache')
  expect(cost).toContain('cache read at 0.05x')
  expect(cost).toContain('written again at 2x')
  expect(cost).toContain('A rewrite costs about 39 pokes')

  // on with no end the row says so; a set length says when it ends
  await run($, 'on')
  const ui = await $.ui.mount({ plugin: 'caffeine', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(JSON.stringify(await ui.drawn())).toContain('until you turn it off (or 8h idle)')
  expect(await ui.find({ key: 'caffeine-away' })).toBeUndefined()
  await ui.unmount()
  expect((await run($, 'warm')).text).toBe('Caffeine on, keeping the cache warm until 10:00.')
  expect((await run($, 'warm 30m')).text).toBe('Caffeine on, keeping the cache warm until 09:30.')
  expect((await run($, 'status')).text).toContain('until 09:30 (30m left)')
})

test('timing: a read after 5.5 minutes proves 1h, a rewrite under an hour means 5m, exempt after a compaction', () => {
  const read = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 300 }
  const wrote = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 88_000 }
  expect(readTiming(20 * MIN, read, false)).toEqual({ isCold: false, ttl: TTL_1H })
  expect(readTiming(4 * MIN, read, false)).toEqual({ isCold: false, ttl: null })
  expect(readTiming(20 * MIN, wrote, false)).toEqual({ isCold: true, ttl: TTL_5M })
  expect(readTiming(90 * MIN, wrote, false)).toEqual({ isCold: true, ttl: null })
  expect(readTiming(20 * MIN, wrote, true)).toEqual({ isCold: false, ttl: null })
  expect(readTiming(20 * MIN, { ...wrote, cache_creation_input_tokens: 8_000 }, false)).toEqual({ isCold: false, ttl: null })
  expect(pokeWasCold(read)).toBe(false)
  expect(pokeWasCold(wrote)).toBe(true)
})

test('a poke that finds the cache cold turns caffeine off; timing sets the TTL where cost cannot', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, {})
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
  const big = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 300, model: 'some-new-model' }

  // a request read the cache after 20 minutes: the TTL is 1h, measured from timing
  await turn($, 't1', 'hello', undefined, big)
  await time.advance(20 * MIN)
  await turn($, 't2', 'more', undefined, big)
  expect((await run($, 'status')).text).toContain('Cache TTL 1h (measured from request timing)')

  await run($, 'on')
  await time.advance(48 * MIN + 5_000)
  expect(submitted.length).toBe(1)
  const cold = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 89_000, model: 'some-new-model' }
  await turn($, 'p1', 'poke, just say okay', cold, cold)
  const status = (await run($, 'status')).text
  expect(status).toContain('caffeine off')
  expect(status).toContain('The last poke found the cache cold.')
  expect(status).toContain('The cache last went cold before 10:08, after 48m idle.')
})
