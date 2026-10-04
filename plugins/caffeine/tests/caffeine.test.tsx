import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { clock, defaultEvery, nextPokeAt, overLine, parseClock, parseDuration, span, TTL_1H, TTL_5M, ttlFrom, wasWarm } from '../hooks/brew'

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
  expect(defaultEvery(TTL_1H)).toBe(15 * MIN)
  expect(defaultEvery(TTL_5M)).toBe(150_000)
  expect(ttlFrom(undefined, '1')).toBe(TTL_1H)
  expect(ttlFrom('1', '1')).toBe(TTL_5M)
  expect(ttlFrom(undefined, undefined)).toBe(TTL_5M)
  expect(ttlFrom(undefined, '0')).toBe(TTL_5M)
  expect(nextPokeAt(0, MIN)).toBeNull()
  expect(nextPokeAt(1000, MIN)).toBe(1000 + MIN)
  expect(wasWarm({ cache_read_input_tokens: 90_000, cache_creation_input_tokens: 200 })).toBe(true)
  expect(wasWarm({ cache_read_input_tokens: 0, cache_creation_input_tokens: 90_000 })).toBe(false)
  expect(wasWarm(undefined)).toBeNull()
  expect(overLine([{ kind: 'five_hour', percentUsed: 89 }])).toBeNull()
  expect(overLine([{ kind: 'five_hour', percentUsed: 91.4 }])).toEqual({ label: '5h', percent: 91 })
  expect(overLine([{ kind: 'seven_day', percentUsed: 95 }])?.label).toBe('weekly')
})

// The engine beneath caffeine: the UI ops, the prompts it submits, the turns.
function world(on: On, submitted: string[]) {
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
    return { turnId: e.turnId, index: e.index, answer: 'okay', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  // what another mod (clawd-buddy) or the engine draws in the band beneath caffeine
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="beneath" />
  })
}

// One main-thread turn: its start, one request, its end.
async function turn($: Engine, id: string, text: string, usage?: object) {
  await $.turn.start({ text, turnId: id })
  for await (const _ of $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 3 } as never)) {
    // nothing streams
  }
  await $.turn.complete({ answer: 'okay', durationMs: 900, isAborted: false, turnId: id, reason: 'answer', usage } as never)
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'caffeine', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

test('on, it pokes 15 minutes after the last request on a 1h cache, and not on a cold one', async ($, on) => {
  const time = mock.clock(on, { now: at(9, 0) })
  mock.store(on)
  mock.env(on, { ENABLE_PROMPT_CACHING_1H: '1' })
  const submitted: string[] = []
  world(on, submitted)
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })

  expect((await run($, 'on')).text).toContain('poking 15m after the last request (1h cache)')
  await turn($, 't1', 'fix the tests')
  await time.advance(14 * MIN)
  expect(submitted).toEqual([])
  await time.advance(1 * MIN + 5_000)
  expect(submitted).toEqual(['poke, just say okay'])

  // the poke's own turn: warm, counted, and the next one 15 minutes after it
  await turn($, 't2', 'poke, just say okay', { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 40, model: 'claude-opus-5-5' })
  expect((await run($, 'status')).text).toContain('1 poke')
  expect((await run($, 'status')).text).toContain('found the cache warm')
  await time.advance(15 * MIN + 5_000)
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

  expect((await run($, 'for 1h')).text).toBe('Caffeine on until 10:00.')
  await turn($, 't1', 'hello')
  await time.advance(150_000 + 5_000)
  expect(submitted.length).toBe(1)
  await turn($, 't2', 'poke, just say okay')
  await time.advance(61 * MIN)
  expect((await run($, 'status')).text).toContain('caffeine off')

  // idle: off after 20 minutes with only pokes
  expect((await run($, 'idle 20m')).text).toContain('after 20m')
  await run($, 'on')
  for (let i = 0; i < 10; i++) {
    await time.advance(150_000 + 5_000)
    if (submitted.length > i + 1) await turn($, `p${i}`, 'poke, just say okay')
  }
  expect((await run($, 'status')).text).toContain('caffeine off')
  const sent = submitted.length

  // near the 5-hour line: paused, no pokes
  await run($, 'idle off')
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

  expect((await run($, 'every 10m')).text).toContain('past the 5m cache')
  expect((await run($, 'ttl 1h')).text).toContain('Cache TTL 1h')
  expect((await run($, 'every 10m')).text).toBe('Poking 10m after the last request.')
  expect((await run($, 'nonsense')).text).toContain('Not a caffeine command')
})
