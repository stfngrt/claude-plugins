// The pure core of session-watch: events in, a ledger out; a ledger in, verdicts out.
// Nothing here touches `$`, so every detector runs in a test on a recorded sequence.

import type { Call, Incident, Ledger, Point, RateWindow, Sample, Thread, ToolStat } from '../types'

export const MAIN = 'main'

const MINUTE = 60_000
const SAMPLES = 60
const CALLS = 10
const TRAIL_MS = 3 * 60 * MINUTE

// ---------------------------------------------------------------------------
// Prices, USD per million tokens: input, 5m cache write, 1h cache write, cache read, output.
// Checked against https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-10.
// The engine reports cache writes without their TTL; Claude Code writes the main
// thread's with the 1h TTL and a subagent's with 5m, so each is priced that way.

type Price = readonly [number, number, number, number, number]

const PRICES: readonly (readonly [RegExp, Price])[] = [
  [/fable-5-1|mythos-5-1/, [10, 12.5, 20, 0.25, 50]],
  [/fable|mythos/, [10, 12.5, 20, 1, 50]],
  [/opus-5-5/, [4, 5, 8, 0.2, 20]],
  [/opus-4-1|opus-4-0|opus-4(?!-\d)/, [15, 18.75, 30, 1.5, 75]],
  [/opus/, [5, 6.25, 10, 0.5, 25]],
  [/sonnet-5-5/, [2, 2.5, 4, 0.1, 10]],
  [/sonnet-5/, [2, 2.5, 4, 0.2, 10]],
  [/sonnet/, [3, 3.75, 6, 0.3, 15]],
  [/haiku-5-5/, [0.1, 0.125, 0.2, 0.01, 0.5]],
  [/haiku-4-5/, [1, 1.25, 2, 0.1, 5]],
  [/haiku/, [0.8, 1, 1.6, 0.08, 4]],
]
// Claude Haiku 5.5 above 100,000 prompt tokens.
const HAIKU_LONG: Price = [0.5, 0.625, 1, 0.05, 2.5]
const FALLBACK: Price = [4, 5, 8, 0.2, 20]

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** What a request cost, split as tokenol's per-turn bars split it: read, written, uncached, output. */
export type Parts = [read: number, written: number, uncached: number, output: number]

export const costParts = (model: string, u: Usage, isMain: boolean): Parts => {
  const m = model.toLowerCase()
  const context = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const [input, write5m, write1h, read, output] =
    /haiku-5-5/.test(m) && context > 100_000 ? HAIKU_LONG : (PRICES.find(([re]) => re.test(m))?.[1] ?? FALLBACK)
  return [
    (u.cache_read_input_tokens * read) / 1e6,
    (u.cache_creation_input_tokens * (isMain ? write1h : write5m)) / 1e6,
    (u.input_tokens * input) / 1e6,
    (u.output_tokens * output) / 1e6,
  ]
}

export const costOf = (model: string, u: Usage, isMain: boolean): number => costParts(model, u, isMain).reduce((a, b) => a + b, 0)

export const sumParts = (xs: readonly Parts[]): Parts =>
  xs.reduce<Parts>((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]], [0, 0, 0, 0])

export const windowOf = (model: string): number => (/haiku-4|haiku-3/i.test(model) ? 200_000 : 1_000_000)

// ---------------------------------------------------------------------------
// The ledger and the events that move it.

export const emptyLedger = (): Ledger => ({
  threads: {},
  order: [],
  hostUsd: null,
  sinceHostUsd: 0,
  tools: {},
  turns: [],
  rateLimits: [],
  planTrail: [],
  incidents: [],
})

/** A ledger an earlier version of the mod left in `$.state` (it survives a reload), brought up to this shape. */
export const normalize = (l: Partial<Ledger> | null | undefined): Ledger => ({ ...emptyLedger(), ...(l ?? {}) })

const newThread = (id: string, at: number, fields: Partial<Thread> = {}): Thread => ({
  id,
  type: id === MAIN ? 'main' : 'subagent',
  description: id === MAIN ? 'main thread' : '',
  model: '',
  status: 'running',
  startedAt: at,
  lastActivityAt: at,
  busySince: null,
  requestsRunning: 0,
  requests: 0,
  toolCalls: 0,
  errors: 0,
  usd: 0,
  usdAtTurn: 0,
  window: 1_000_000,
  samples: [],
  calls: [],
  ...fields,
})

const withThread = (l: Ledger, id: string, at: number, change: (t: Thread) => Thread): Ledger => {
  const known = l.threads[id]
  const t = known ?? newThread(id, at)
  return {
    ...l,
    threads: { ...l.threads, [id]: change(t) },
    order: known ? l.order : [...l.order, id],
  }
}

export const totalUsd = (l: Ledger): number =>
  l.hostUsd === null ? Object.values(l.threads).reduce((s, t) => s + t.usd, 0) : l.hostUsd + l.sinceHostUsd

const trail = (points: Point[], at: number, value: number): Point[] =>
  [...points.filter(p => p.at >= at - TRAIL_MS), { at, value }].slice(-400)

const isBusy = (t: Thread): boolean => t.requestsRunning > 0 || t.calls.some(c => !c.isDone)

const settle = (t: Thread, at: number): Thread => {
  const busy = isBusy(t)
  return { ...t, lastActivityAt: at, busySince: busy ? (t.busySince ?? at) : null }
}

export const spawned = (
  l: Ledger,
  a: { id: string; parentId?: string; type: string; description: string; model: string; at: number },
): Ledger =>
  withThread(l, a.id, a.at, t => ({
    ...t,
    parentId: a.parentId ?? MAIN,
    type: a.type,
    description: a.description,
    model: a.model || t.model,
    window: windowOf(a.model || t.model),
    status: 'running',
    startedAt: Math.min(t.startedAt, a.at),
  }))

export const stepStarted = (l: Ledger, id: string, at: number, model: string, effort?: string): Ledger =>
  withThread(l, id, at, t =>
    settle(
      {
        ...t,
        model: t.model || model,
        effort: effort ?? t.effort,
        status: 'running',
        endedAt: undefined,
        requestsRunning: t.requestsRunning + 1,
        sentAt: at,
        busySince: t.busySince ?? at,
      },
      at,
    ),
  )

export type StepResult = {
  usage: (Usage & { model: string }) | null
  stopReason: string | null
  toolUses: readonly { name: string; input: unknown }[]
}

export const stepEnded = (l: Ledger, id: string, at: number, r: StepResult | null, window?: number): Ledger => {
  const u = r?.usage ?? null
  const isMain = id === MAIN
  const parts: Parts = u ? costParts(u.model, u, isMain) : [0, 0, 0, 0]
  const usd = parts.reduce((a, b) => a + b, 0)
  let next = withThread(l, id, at, t => {
    const sample: Sample | null = u && {
      at,
      context: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
      read: u.cache_read_input_tokens,
      written: u.cache_creation_input_tokens,
      uncached: u.input_tokens,
      output: u.output_tokens,
      usd,
      parts,
      ms: Math.max(0, at - (t.sentAt ?? at)),
      stop: r?.stopReason ?? null,
    }
    return settle(
      {
        ...t,
        model: u?.model || t.model,
        window: window ?? windowOf(u?.model || t.model),
        requestsRunning: Math.max(0, t.requestsRunning - 1),
        requests: t.requests + (u ? 1 : 0),
        usd: t.usd + usd,
        samples: sample ? [...t.samples, sample].slice(-SAMPLES) : t.samples,
      },
      at,
    )
  })
  if (usd > 0 && next.hostUsd !== null) next = { ...next, sinceHostUsd: next.sinceHostUsd + usd }
  return next
}

// The tool and its whole arguments: two edits of one file with different text are two calls.
export const callKey = (tool: string, args: Record<string, unknown>): string => {
  if (tool === 'Bash') return `Bash ${String(args.command ?? '')}`
  const { description: _d, ...rest } = args
  return `${tool} ${JSON.stringify(rest, Object.keys(rest).sort())}`
}

export const callSummary = (tool: string, args: Record<string, unknown>): string => {
  const pick = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill']
  const key = pick.find(k => typeof args[k] === 'string' && args[k])
  const text = key ? String(args[key]) : ''
  const short = key === 'file_path' || key === 'path' ? text.split('/').slice(-2).join('/') : text
  return short.replace(/\s+/g, ' ').trim().slice(0, 60)
}

const toolStat = (l: Ledger, tool: string, change: (s: ToolStat) => ToolStat): Ledger => ({
  ...l,
  tools: { ...l.tools, [tool]: change(l.tools[tool] ?? { calls: 0, errors: 0, ms: 0, threads: [] }) },
})

export const callStarted = (
  l: Ledger,
  id: string,
  c: { id: string; tool: string; key: string; summary: string; at: number },
): Ledger =>
  withThread(
    toolStat(l, c.tool, s => ({ ...s, calls: s.calls + 1, threads: s.threads.includes(id) ? s.threads : [...s.threads, id] })),
    id,
    c.at,
    t =>
    settle(
      {
        ...t,
        toolCalls: t.toolCalls + 1,
        runningTool: t.runningTool ?? { name: c.tool, summary: c.summary, at: c.at },
        calls: [...t.calls, { ...c, isDone: false, isError: false }].slice(-CALLS),
        busySince: t.busySince ?? c.at,
      },
      c.at,
    ),
  )

export const callEnded = (l: Ledger, id: string, callId: string, isError: boolean, at: number): Ledger => {
  const open = l.threads[id]?.calls.find(c => c.id === callId && !c.isDone)
  const counted = open
    ? toolStat(l, open.tool, s => ({ ...s, errors: s.errors + (isError ? 1 : 0), ms: s.ms + Math.max(0, at - open.at) }))
    : l
  return withThread(counted, id, at, t => {
    const ended = t.calls.find(c => c.id === callId && !c.isDone)
    const calls = t.calls.map(c => (c.id === callId ? { ...c, isDone: true, isError, endedAt: at } : c))
    const still = calls.find(c => !c.isDone)
    return settle(
      {
        ...t,
        calls,
        errors: t.errors + (isError ? 1 : 0),
        toolMs: (t.toolMs ?? 0) + (ended ? Math.max(0, at - ended.at) : 0),
        runningTool: still ? { name: still.tool, summary: still.summary, at: still.at } : undefined,
      },
      at,
    )
  })
}

export const turnEnded = (l: Ledger, id: string, at: number, reason: string): Ledger => {
  const next = withThread(l, id, at, t => ({
    ...t,
    status: id === MAIN ? 'idle' : reason === 'answer' ? 'done' : 'failed',
    endedAt: at,
    requestsRunning: 0,
    busySince: null,
    runningTool: undefined,
    calls: t.calls.map(c => ({ ...c, isDone: true })),
    usdAtTurn: t.usd,
  }))
  const before = l.threads[id]?.usdAtTurn ?? 0
  const usd = (next.threads[id]?.usd ?? 0) - before
  return { ...next, turns: [...next.turns, { at, threadId: id, usd }].slice(-60) }
}

export const compacted = (l: Ledger, id: string, at: number): Ledger =>
  withThread(l, id, at, t => ({ ...t, compactedFrom: t.samples.at(-1)?.context, compactedAt: at }))

export const measured = (
  l: Ledger,
  m: { at: number; usd?: number; rateLimits: readonly RateWindow[]; window?: number },
): Ledger => {
  let next: Ledger = { ...l, rateLimits: [...m.rateLimits] }
  if (m.usd !== undefined) next = { ...next, hostUsd: m.usd, sinceHostUsd: 0 }
  const five = m.rateLimits.find(r => r.kind === 'five_hour')
  if (five) next = { ...next, planTrail: trail(next.planTrail, m.at, five.percentUsed) }
  if (m.window && next.threads[MAIN]) next = withThread(next, MAIN, m.at, t => ({ ...t, window: m.window ?? t.window }))
  return next
}

// ---------------------------------------------------------------------------
// Measures.

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

/** The share of input the cache served, per request. */
export const hitRates = (samples: readonly Sample[]): number[] =>
  samples.map(s => (s.context === 0 ? 0 : s.read / s.context))

/** A request that wrote most of its context to the cache: the cache was cold or rebuilt. */
export const isRebuild = (s: Sample): boolean => s.context > 20_000 && s.written > s.context * 0.5

/** tokenol's Ctx: cache reads per output token over the last ten requests. */
export const ctxPerOutput = (samples: readonly Sample[], n = 10): number | null => {
  if (samples.length < n) return null
  const w = samples.slice(-n)
  const out = w.reduce((s, x) => s + x.output, 0)
  return out === 0 ? null : w.reduce((s, x) => s + x.read, 0) / out
}

/** Cache reads per cache write, over every request a thread made. */
export const reuse = (samples: readonly Sample[]): number | null => {
  const w = samples.reduce((s, x) => s + x.written, 0)
  return w === 0 ? null : samples.reduce((s, x) => s + x.read, 0) / w
}

/** Mean context growth per request over the last ten, or null across a compaction. */
export const creep = (samples: readonly Sample[], n = 10): number | null => {
  if (samples.length <= n) return null
  const w = samples.slice(-n - 1)
  const deltas = w.slice(1).map((s, i) => s.context - (w[i]?.context ?? 0))
  if (deltas.some(d => d < -20_000)) return null
  return deltas.reduce((a, b) => a + b, 0) / n
}

/** How many of the latest requests in a row sat at or above `share` of the window. */
export const plateau = (t: Thread, share = 0.9): number => {
  let run = 0
  for (const s of [...t.samples].reverse()) {
    if (s.context < share * t.window) break
    run++
  }
  return run
}

/** The most repeated call among the last ten, and whether every one of its runs failed. */
export const repeats = (calls: readonly Call[]): { count: number; call: Call; isFailing: boolean } | null => {
  const done = calls.filter(c => c.isDone)
  let best: { count: number; call: Call; isFailing: boolean } | null = null
  for (const c of done) {
    const same = done.filter(x => x.key === c.key)
    if (!best || same.length > best.count) best = { count: same.length, call: c, isFailing: same.every(x => x.isError) }
  }
  return best
}

export const errorRate = (calls: readonly Call[]): number | null => {
  const done = calls.filter(c => c.isDone)
  return done.length < CALLS ? null : done.filter(c => c.isError).length / done.length
}

// ---------------------------------------------------------------------------
// Verdicts. Fixed thresholds: tokenol's for efficiency, the replay of past sessions
// for the rest. `alert` raises a toast once per incident; `warn` only colours.

export type Level = 'ok' | 'warn' | 'alert'

export type Verdict = {
  id: string
  level: Exclude<Level, 'ok'>
  /** A few words for the row under the prompt. */
  cause: string
  /** One sentence for the toast and the pane. */
  sentence: string
  threadId?: string
}

// How the session spends rather than whether it is stuck: the sidebar lists these,
// the row under the prompt and the toasts leave them out.
const EFFICIENCY = new Set(['ctx', 'reuse', 'share', 'pricey'])

export const isEfficiency = (v: Verdict): boolean => EFFICIENCY.has(v.id.split(':')[0] ?? '')

export const T = {
  stallMin: 5,
  stallAlertMin: 10,
  hungToolMin: 15,
  hungToolAlertMin: 30,
  repeatAlert: 3,
  errorWarn: 0.2,
  errorAlert: 0.5,
  ctxPerOutput: 400,
  creepPerRequest: 2_000,
  creepFloor: 500_000,
  plateauShare: 0.9,
  plateauRun: 20,
  reinflate: 0.8,
  reuseMin: 20,
  subagentShare: 0.4,
  siblingFactor: 2,
  planAlertMin: 30,
} as const

export const nameOf = (t: Thread): string => (t.id === MAIN ? 'main thread' : `"${t.description || t.type}"`)

export const minutesText = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / MINUTE))
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

const threadVerdicts = (l: Ledger, t: Thread, now: number): Verdict[] => {
  const out: Verdict[] = []
  const v = (kind: string, level: Verdict['level'], cause: string, sentence: string) =>
    out.push({ id: `${kind}:${t.id}`, level, cause, sentence, threadId: t.id })
  const who = nameOf(t)

  if (t.status === 'running') {
    const quiet = now - t.lastActivityAt
    if (t.runningTool && now - t.runningTool.at >= T.hungToolMin * MINUTE) {
      const age = now - t.runningTool.at
      v('hung', age >= T.hungToolAlertMin * MINUTE ? 'alert' : 'warn', `${who} ${t.runningTool.name} running ${minutesText(age)}`,
        `${who} has waited ${minutesText(age)} on ${t.runningTool.name}${t.runningTool.summary ? ` (${t.runningTool.summary})` : ''}.`)
    } else if (!isBusy(t) && quiet >= T.stallMin * MINUTE) {
      v('stall', quiet >= T.stallAlertMin * MINUTE ? 'alert' : 'warn', `${who} quiet ${minutesText(quiet)}`,
        `${who} has made no request and no tool call for ${minutesText(quiet)}.`)
    }
  }

  const last = t.samples.at(-1)
  if (last?.stop === 'model_context_window_exceeded' || last?.stop === 'max_tokens') {
    const what = last.stop === 'max_tokens' ? 'the output limit' : 'the context window'
    v('wall', 'alert', `${who} hit ${what}`, `${who}'s last response stopped at ${what}.`)
  }

  const rep = repeats(t.calls)
  if (rep && rep.count >= T.repeatAlert) {
    v('loop', 'alert', `${who} looping on ${rep.call.tool}`,
      `${who} ran the same ${rep.call.tool} call ${rep.count} times in its last ${CALLS}${rep.call.summary ? `: ${rep.call.summary}` : ''}.`)
  } else if (rep && rep.count >= 2 && rep.isFailing) {
    v('retry', 'warn', `${who} retrying a failing ${rep.call.tool}`,
      `${who} retried a ${rep.call.tool} call that failed${rep.call.summary ? `: ${rep.call.summary}` : ''}.`)
  }

  const err = errorRate(t.calls)
  if (err !== null && err > T.errorWarn) {
    v('errors', err >= T.errorAlert ? 'alert' : 'warn', `${who} ${Math.round(err * 100)}% tool errors`,
      `${Math.round(err * 100)}% of ${who}'s last ${CALLS} tool calls failed.`)
  }

  const run = plateau(t, T.plateauShare)
  if (run >= T.plateauRun) {
    v('ceiling', 'alert', `${who} at the context ceiling`, `${who} has run ${run} requests at 90% of its context window or more.`)
  } else if (last && last.context >= T.plateauShare * t.window) {
    v('ceiling', 'warn', `${who} context ${Math.round((last.context / t.window) * 100)}%`, `${who}'s context is over 90% of its window.`)
  }

  const growth = creep(t.samples)
  const peak = Math.max(0, ...t.samples.map(s => s.context))
  if (growth !== null && growth >= T.creepPerRequest && peak >= T.creepFloor) {
    v('creep', 'warn', `${who} context +${Math.round(growth / 1000)}k/request`,
      `${who}'s context grows ${Math.round(growth / 1000)}k tokens a request at ${Math.round(peak / 1000)}k.`)
  }

  // tokenol's re-inflation, looked for in the 30 requests after a compaction.
  const since = t.samples.filter(s => s.at > (t.compactedAt ?? Infinity))
  if (t.compactedFrom && last && since.length > 0 && since.length <= 30 && last.context >= t.compactedFrom * T.reinflate) {
    v('reinflate', 'warn', `${who} refilled after compacting`,
      `${who} grew back to ${Math.round((last.context / t.compactedFrom) * 100)}% of its size before compacting.`)
  }

  const cpo = ctxPerOutput(t.samples)
  if (cpo !== null && cpo > T.ctxPerOutput) {
    v('ctx', 'warn', `${who} ${Math.round(cpo)}:1 context:output`,
      `${who} reads ${Math.round(cpo)} context tokens per token it writes (tokenol's target is under 400).`)
  }

  if (t.id !== MAIN) {
    const siblings = Object.values(l.threads).filter(x => x.id !== MAIN && x.parentId === t.parentId)
    const med = median(siblings.map(x => x.usd))
    if (siblings.length >= 3 && med > 0 && t.usd > T.siblingFactor * med) {
      v('pricey', 'warn', `${who} ${(t.usd / med).toFixed(1)}× its siblings`, `${who} has cost ${(t.usd / med).toFixed(1)}× the median of its sibling agents.`)
    }
  }
  return out
}

export const planOutlook = (l: Ledger, now: number): { percent: number; resetsInMs: number | null; outInMs: number | null } | null => {
  const five = l.rateLimits.find(r => r.kind === 'five_hour')
  if (!five) return null
  const resetsAt = five.resetsAt ? Date.parse(five.resetsAt) : NaN
  const resetsInMs = Number.isFinite(resetsAt) ? resetsAt - now : null
  const from = [...l.planTrail].reverse().find(p => p.at <= now - 30 * MINUTE) ?? l.planTrail[0]
  const last = l.planTrail.at(-1)
  let outInMs: number | null = null
  if (from && last && last.at - from.at >= 5 * MINUTE && last.value > from.value) {
    const perMs = (last.value - from.value) / (last.at - from.at)
    outInMs = Math.max(0, (100 - five.percentUsed) / perMs)
  }
  return { percent: five.percentUsed, resetsInMs, outInMs }
}

export const evaluate = (l: Ledger, now: number): Verdict[] => {
  const out = l.order.flatMap(id => {
    const t = l.threads[id]
    return t ? threadVerdicts(l, t, now) : []
  })

  const plan = planOutlook(l, now)
  if (plan && plan.outInMs !== null && plan.resetsInMs !== null && plan.outInMs < plan.resetsInMs) {
    out.push({
      id: 'plan',
      level: plan.outInMs <= T.planAlertMin * MINUTE ? 'alert' : 'warn',
      cause: `plan window out in ${minutesText(plan.outInMs)}`,
      sentence: `At this pace the five-hour plan window runs out in ${minutesText(plan.outInMs)}, before it resets in ${minutesText(plan.resetsInMs)}.`,
    })
  }

  const total = totalUsd(l)
  const sub = Object.values(l.threads).filter(t => t.id !== MAIN).reduce((s, t) => s + t.usd, 0)
  const est = Object.values(l.threads).reduce((s, t) => s + t.usd, 0)
  if (total > 0.5 && est > 0 && sub / est > T.subagentShare) {
    out.push({
      id: 'share',
      level: 'warn',
      cause: `subagents ${Math.round((sub / est) * 100)}% of cost`,
      sentence: `Subagents account for ${Math.round((sub / est) * 100)}% of the session's cost.`,
    })
  }

  const main = l.threads[MAIN]
  const r = main && main.samples.length >= 20 ? reuse(main.samples) : null
  if (r !== null && r < T.reuseMin) {
    out.push({
      id: 'reuse',
      level: 'warn',
      cause: `cache reuse ${Math.round(r)}:1`,
      sentence: `The main thread reads its cache only ${Math.round(r)} times per write (tokenol's floor is 20).`,
    })
  }

  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'alert' ? -1 : 1))
}

/**
 * Folds verdicts into the incident log. Returns the log and the incidents that just
 * turned `alert`, each toasted once; one whose cause has been gone five minutes closes.
 */
export const track = (incidents: readonly Incident[], verdicts: readonly Verdict[], now: number): { incidents: Incident[]; raised: Verdict[] } => {
  const raised: Verdict[] = []
  const next = incidents.map(i => ({ ...i }))
  for (const v of verdicts) {
    const open = next.find(i => i.id === v.id && !i.isClosed)
    if (!open) {
      next.push({ id: v.id, level: v.level, cause: v.sentence, at: now, seenAt: now, isClosed: false })
      if (v.level === 'alert') raised.push(v)
    } else {
      if (v.level === 'alert' && open.level === 'warn') raised.push(v)
      open.level = open.level === 'alert' ? 'alert' : v.level
      open.cause = v.sentence
      open.seenAt = now
    }
  }
  for (const i of next) {
    if (!i.isClosed && i.seenAt < now - 5 * MINUTE) i.isClosed = true
  }
  return { incidents: next.slice(-50), raised }
}

// ---------------------------------------------------------------------------
// Diagnosis: what went wrong, or what was wasteful, in one subagent's run, as plain
// sentences for the sidebar. Not alarms: they never colour the row or raise a toast.

export type Note = { text: string; tone: 'info' | 'warn' }

const isCold = (s: Sample): boolean => s.context > 10_000 && s.read < s.context * 0.1

export const diagnose = (l: Ledger, t: Thread, now: number): Note[] => {
  const notes: Note[] = []
  const first = t.samples[0]
  const out = t.samples.reduce((a, s) => a + s.output, 0)
  if (first && isCold(first) && t.usd > 0) {
    const share = first.usd / t.usd
    notes.push({ text: `cold start: wrote a ${tokensText(first.written)} prefix, ${Math.round(share * 100)}% of its cost`, tone: 'info' })
    if (t.id !== MAIN && t.status !== 'running' && t.requests <= 3 && share > 0.5) {
      notes.push({ text: `setup outweighed the work (${tokensText(out)} tokens out): too small to delegate`, tone: 'warn' })
    }
    // Siblings that started within 15 s of each other cold, on about the same prefix,
    // each paid to write it: no request was done in time for another to read it.
    const twins = Object.values(l.threads).filter(o => {
      const f = o.samples[0]
      return o.id !== t.id && o.id !== MAIN && f && isCold(f) && Math.abs(f.at - first.at) < 15_000 && Math.abs(f.context - first.context) < first.context * 0.2
    })
    if (t.id !== MAIN && twins.length > 0) {
      notes.push({ text: `started with ${twins.length} other${twins.length > 1 ? 's' : ''}; each wrote the same ~${tokensText(first.written)} prefix`, tone: 'info' })
    }
  }
  const rebuilds = t.samples.slice(1).filter(isRebuild).length
  if (rebuilds > 0) {
    notes.push({ text: `cache rebuilt ${rebuilds}× mid-run: a pause outlived the cache, or the prefix changed`, tone: 'warn' })
  }
  const end = t.status === 'running' ? now : (t.endedAt ?? now)
  const ran = end - t.startedAt
  if (ran >= 60_000 && (t.toolMs ?? 0) / ran > 0.6) {
    notes.push({ text: `${Math.round(((t.toolMs ?? 0) / ran) * 100)}% of its time waiting on tools`, tone: 'info' })
  }
  if (t.toolCalls > 0 && t.errors > 0) {
    notes.push({ text: `${t.errors} of ${t.toolCalls} tool calls failed`, tone: t.errors / t.toolCalls > T.errorWarn ? 'warn' : 'info' })
  }
  const parts = sumParts(t.samples.map(s => s.parts ?? [0, 0, 0, 0]))
  const total = parts.reduce((a, b) => a + b, 0)
  if (total > 0 && t.samples.length >= 5 && parts[1] / total > 0.5) {
    notes.push({ text: `${Math.round((parts[1] / total) * 100)}% of its cost went to cache writes`, tone: 'warn' })
  }
  return notes
}

// ---------------------------------------------------------------------------
// Drawing helpers shared by the row and the pane.

export type BarKind = 'read' | 'written' | 'uncached' | 'output' | 'empty'

const BAR_CHAR: Record<BarKind, string> = { read: '█', written: '▓', uncached: '░', output: '▒', empty: ' ' }

/**
 * A horizontal stacked bar: each value a run of its own glyph, `max` filling `width`
 * cells. Every value above zero keeps at least one cell, so a thin slice (a few
 * uncached tokens) still shows; the cells it takes come off the widest part.
 */
export const stackedBar = (values: readonly { kind: BarKind; value: number }[], max: number, width: number): { kind: BarKind; text: string }[] => {
  const shown = values.filter(v => v.value > 0)
  if (max <= 0 || shown.length === 0) return []
  const sum = shown.reduce((a, v) => a + v.value, 0)
  const target = Math.max(shown.length, Math.min(width, Math.round((sum / max) * width)))
  const exact = shown.map(v => (v.value / sum) * target)
  const cells = exact.map(x => Math.max(1, Math.floor(x)))
  // Hand out what is left by the largest remainder, then take back any excess from the widest.
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r)
  for (let k = 0; cells.reduce((a, b) => a + b, 0) < target && k < order.length; k++) {
    const i = order[k]?.i ?? 0
    cells[i] = (cells[i] ?? 0) + 1
  }
  while (cells.reduce((a, b) => a + b, 0) > target) {
    const widest = cells.indexOf(Math.max(...cells))
    if ((cells[widest] ?? 0) <= 1) break
    cells[widest] = (cells[widest] ?? 1) - 1
  }
  return shown.map((v, i) => ({ kind: v.kind, text: BAR_CHAR[v.kind].repeat(cells[i] ?? 1) }))
}

/** A request's input as tokenol draws it: read from the cache, written to it, uncached. */
export const tokenBar = (s: Sample, max: number, width: number) =>
  stackedBar(
    [
      { kind: 'read', value: s.read },
      { kind: 'written', value: s.written },
      { kind: 'uncached', value: s.uncached },
    ],
    max,
    width,
  )

export const costBar = (p: Parts, max: number, width: number) =>
  stackedBar(
    [
      { kind: 'read', value: p[0] },
      { kind: 'written', value: p[1] },
      { kind: 'uncached', value: p[2] },
      { kind: 'output', value: p[3] },
    ],
    max,
    width,
  )

const BLOCKS = '▁▂▃▄▅▆▇█'

/** One block per value, scaled to `max` (the largest value when not given). */
export const sparkline = (values: readonly number[], max?: number): string => {
  const top = max ?? Math.max(0, ...values)
  return values.map(v => (top <= 0 ? BLOCKS[0] : BLOCKS[Math.min(7, Math.max(0, Math.round((v / top) * 7)))])).join('')
}

export const usdText = (usd: number): string => (usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`)

export const tokensText = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

export const isEstimate = (l: Ledger): boolean => l.hostUsd === null

export type Segment = { text: string; color?: 'warning' | 'error' }

/** The row under the prompt: dim figures while all is normal; a drifting signal names its cause. */
export const rowSegments = (l: Ledger, now: number, verdicts: readonly Verdict[], detail: 0 | 1 | 2 | 3 = 0): Segment[] => {
  const segs: Segment[] = []
  const sep = () => segs.length && segs.push({ text: ' · ' })
  const issues = verdicts.filter(v => !isEfficiency(v)).slice(0, detail >= 2 ? 1 : 2)
  for (const v of issues) {
    sep()
    segs.push({ text: `⚠ ${v.cause}`, color: v.level === 'alert' ? 'error' : 'warning' })
  }
  if (detail >= 3 && segs.length) return segs

  const agents = l.order.filter(id => id !== MAIN)
  const running = agents.filter(id => l.threads[id]?.status === 'running').length
  if (agents.length) {
    sep()
    segs.push({ text: running ? `${running}/${agents.length} agents running` : `${agents.length} agents` })
  }
  const main = l.threads[MAIN]
  const last = main?.samples.at(-1)
  if (main && last && detail <= 1) {
    sep()
    segs.push({ text: `ctx ${Math.round((last.context / main.window) * 100)}%` })
  }
  const calls = Object.values(l.tools).reduce((a, x) => a + x.calls, 0)
  const errors = Object.values(l.tools).reduce((a, x) => a + x.errors, 0)
  if (calls && detail === 0) {
    sep()
    segs.push({ text: `${calls} tools${errors ? `, ${errors} failed` : ''}` })
  }
  const plan = planOutlook(l, now)
  if (plan && detail <= 2 && !issues.some(v => v.id === 'plan')) {
    sep()
    segs.push({ text: `5h ${Math.round(plan.percent)}%${plan.resetsInMs !== null && detail === 0 ? ` (${minutesText(plan.resetsInMs)} left)` : ''}` })
  }
  return segs
}

export const cellWidth = (text: string): number => [...text].length

export const fitRow = (draw: (detail: 0 | 1 | 2 | 3) => Segment[], columns: number | undefined): Segment[] => {
  for (const d of [0, 1, 2, 3] as const) {
    const s = draw(d)
    if (columns === undefined || cellWidth(s.map(x => x.text).join('')) <= columns) return s
  }
  return draw(3)
}

/** The threads as a tree: each with its depth, children after their parent. */
export const tree = (l: Ledger): { t: Thread; depth: number }[] => {
  const out: { t: Thread; depth: number }[] = []
  const walk = (parent: string | undefined, depth: number) => {
    for (const id of l.order) {
      const t = l.threads[id]
      if (!t || t.id === MAIN) continue
      if ((t.parentId ?? MAIN) === (parent ?? MAIN)) {
        out.push({ t, depth })
        walk(t.id, depth + 1)
      }
    }
  }
  const main = l.threads[MAIN]
  if (main) out.push({ t: main, depth: 0 })
  walk(MAIN, main ? 1 : 0)
  return out
}
