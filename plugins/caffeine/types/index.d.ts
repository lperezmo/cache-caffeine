// What caffeine keeps for the session, so a reload of the mod finds it as it
// was: whether it is on, when it wears off (0 for never), when the last
// main-thread request went out, when the last turn that was not a poke began,
// whether the person turned off what auto turned on, and whether this run has
// no idle stop (`/caffeine forever`, gone once caffeine turns off).
export type Brew = { isOn: boolean; until: number; lastAt: number; activeAt: number; isAutoDeclined: boolean; isForever: boolean }

declare module 'claude-code' {
  interface PluginState {
    caffeine: { brew: Brew }
  }
}
