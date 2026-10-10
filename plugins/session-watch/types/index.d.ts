export type ThreadStatus = 'running' | 'idle' | 'done' | 'failed'

/** One model request of a thread, as its `turn.step` result reported it. */
export type Sample = {
  at: number
  /** Input tokens the request was answered over: uncached, read and written together. */
  context: number
  read: number
  written: number
  uncached: number
  output: number
  /** Estimated cost of the request, in US dollars. */
  usd: number
  /** That cost split: cache read, cache written, uncached input, output. */
  parts?: [number, number, number, number]
  /** From when the request was sent to when its answer was in, in milliseconds. */
  ms?: number
  stop: string | null
}

/** One tool call of a thread. `key` is the tool and its whole arguments, for repeat detection. */
export type Call = {
  id: string
  tool: string
  key: string
  summary: string
  at: number
  isDone: boolean
  isError: boolean
  endedAt?: number
}

/** The main conversation (`id: 'main'`) or one subagent. */
export type Thread = {
  id: string
  parentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: ThreadStatus
  startedAt: number
  endedAt?: number
  /** The last time a request or a tool call of this thread started or ended. */
  lastActivityAt: number
  /** When the oldest request or tool call still running started; null when none runs. */
  busySince: number | null
  requestsRunning: number
  /** When its latest request was sent. */
  sentAt?: number
  /** The tool still running longest, with when it started. */
  runningTool?: { name: string; summary: string; at: number }
  requests: number
  toolCalls: number
  errors: number
  /** Milliseconds its tool calls ran, summed. */
  toolMs?: number
  usd: number
  /** The thread's cost when its last turn ended, for the per-turn timeline. */
  usdAtTurn: number
  window: number
  /** True once the host measured this thread's window (the main thread's), so a model default never replaces it. */
  isWindowMeasured?: boolean
  samples: Sample[]
  calls: Call[]
  /** The context just before the last compaction, and when it compacted. */
  compactedFrom?: number
  compactedAt?: number
}

export type ToolStat = { calls: number; errors: number; ms: number; threads: string[] }

export type Point = { at: number; value: number }

export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type Incident = {
  id: string
  level: 'warn' | 'alert'
  cause: string
  at: number
  /** When the cause last held; an incident whose cause is gone five minutes is closed. */
  seenAt: number
  isClosed: boolean
}

export type Ledger = {
  threads: Record<string, Thread>
  /** Thread ids in the order they started. */
  order: string[]
  /** Claude Code's own cost figure, and when it was read; null where the host keeps none. */
  hostUsd: number | null
  /** Estimated cost of requests since the host figure was last read. */
  sinceHostUsd: number
  /** Every tool this session called: how often, how often it failed, how long it ran, and in which threads. */
  tools: Record<string, ToolStat>
  /** Cost of each finished turn, main thread and subagents alike. */
  turns: { at: number; threadId: string; usd: number }[]
  rateLimits: RateWindow[]
  /** The five-hour window's percentUsed over time. */
  planTrail: Point[]
  incidents: Incident[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-watch': {
      ledger: Ledger
      /** The clock, moved on every fifteen seconds so ages stay current. */
      now: number
    }
  }
}
