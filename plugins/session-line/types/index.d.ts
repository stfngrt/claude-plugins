// An empty part is left out of the row.
export type Line = { model: string; dir: string; branch: string }

declare module 'claude-code' {
  interface PluginState {
    'session-line': {
      line: Line | null
    }
  }
}
