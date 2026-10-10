export type CacheTally = { read: number; written: number; uncached: number }

export type ContextFill = { tokens: number; window: number }

export type CacheTtl = '5m' | '1h'

declare module 'claude-code' {
  interface PluginState {
    'cache-weather': {
      lastTurn: CacheTally | null
      session: CacheTally
      context: ContextFill | null
      ttl: CacheTtl | null
      refreshedAt: number | null
      tick: number
    }
  }
}
