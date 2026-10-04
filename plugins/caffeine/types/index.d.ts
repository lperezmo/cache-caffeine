// What caffeine keeps for the session, so a reload of the mod finds it as it
// was: whether it is on, when it wears off (0 for never), when the last
// main-thread request went out and when the last turn that was not a poke began.
export type Brew = { isOn: boolean; until: number; lastAt: number; activeAt: number }

declare module 'claude-code' {
  interface PluginState {
    caffeine: { brew: Brew }
  }
}
