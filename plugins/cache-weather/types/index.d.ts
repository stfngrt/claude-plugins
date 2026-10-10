export type CacheTally = { read: number; written: number; uncached: number }

export type ContextFill = { tokens: number; window: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-weather': {
      lastTurn: CacheTally | null
      session: CacheTally
      context: ContextFill | null
    }
  }
}
