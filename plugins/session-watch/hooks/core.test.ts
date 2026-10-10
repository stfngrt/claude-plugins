import { expect, test } from 'claude-code/testing'

import type { Ledger } from '../types'
import {
  MAIN,
  callEnded,
  callKey,
  callStarted,
  compacted,
  costOf,
  diagnose,
  stackedBar,
  emptyLedger,
  evaluate,
  isEfficiency,
  measured,
  rowSegments,
  sparkline,
  spawned,
  stepEnded,
  stepStarted,
  track,
  tree,
  turnEnded,
} from './core'
import type { StepResult } from './core'

const MIN = 60_000
const OPUS = 'claude-opus-5-5'

const usage = (context: number, output = 400, written = 2_000) => ({
  model: OPUS,
  input_tokens: 10,
  cache_read_input_tokens: Math.max(0, context - written - 10),
  cache_creation_input_tokens: written,
  output_tokens: output,
})

const step = (l: Ledger, id: string, at: number, context: number, extra: Partial<StepResult> = {}, output = 400): Ledger =>
  stepEnded(stepStarted(l, id, at - 1_000, OPUS), id, at, { usage: usage(context, output), stopReason: 'tool_use', toolUses: [], ...extra })

const call = (l: Ledger, id: string, at: number, n: number, command: string, isError = false): Ledger => {
  const key = callKey('Bash', { command })
  const started = callStarted(l, id, { id: `t${n}`, tool: 'Bash', key, summary: command, at })
  return callEnded(started, id, `t${n}`, isError, at + 500)
}

const round = (n: number | null) => (n === null ? null : Math.round(n * 1e6) / 1e6)

const ids = (l: Ledger, now: number) => evaluate(l, now).map(v => `${v.id}/${v.level}`)

// What reaches the row and the toasts: the efficiency findings stay in the sidebar.
const walls = (l: Ledger, now: number) => evaluate(l, now).filter(v => !isEfficiency(v)).map(v => `${v.id}/${v.level}`)

// A normal session: steady requests, varied calls, a growing but small context.
const normal = (): Ledger => {
  let l = spawned(emptyLedger(), { id: 'a1', type: 'Explore', description: 'map the repo', model: OPUS, at: 0 })
  for (let i = 0; i < 30; i++) {
    l = step(l, MAIN, i * 20_000, 40_000 + i * 1_500)
    l = call(l, MAIN, i * 20_000 + 2_000, i, `ls dir${i}`)
    l = step(l, 'a1', i * 20_000 + 5_000, 30_000 + i * 1_000)
    l = call(l, 'a1', i * 20_000 + 6_000, 100 + i, `grep -r term${i}`)
  }
  return l
}

test('prices charge each token kind at its own rate, 1h writes on main and 5m in subagents', () => {
  const u = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }
  expect(round(costOf(OPUS, u, true))).toBe(32.2)
  expect(round(costOf(OPUS, u, false))).toBe(29.2)
  expect(round(costOf('claude-sonnet-5-5', u, false))).toBe(14.6)
  expect(round(costOf('claude-fable-5', u, false))).toBe(73.5)
})

test('a normal session raises nothing', () => {
  const l = normal()
  expect(walls(l, 30 * 20_000)).toEqual([])
})

test('a subagent that goes quiet is stalled, and red after ten minutes', () => {
  let l = normal()
  const last = 30 * 20_000
  expect(walls(l, last + 4 * MIN)).toEqual([])
  expect(ids(l, last + 6 * MIN)).toContain('stall:a1/warn')
  expect(ids(l, last + 11 * MIN)).toContain('stall:a1/alert')
  // A finished agent is not stalled.
  l = turnEnded(l, 'a1', last + MIN, 'answer')
  expect(ids(l, last + 11 * MIN).some(x => x.startsWith('stall:a1'))).toBe(false)
})

test('a long request or a long tool is not a stall; a hung tool is', () => {
  let l = turnEnded(normal(), MAIN, 30 * 20_000, 'answer')
  const t0 = 30 * 20_000
  l = stepStarted(l, 'a1', t0, OPUS)
  expect(ids(l, t0 + 12 * MIN).some(x => x.includes(':a1'))).toBe(false)
  l = stepEnded(l, 'a1', t0 + 12 * MIN, { usage: usage(60_000), stopReason: 'tool_use', toolUses: [] })
  l = callStarted(l, 'a1', { id: 'long', tool: 'Bash', key: 'Bash npm test', summary: 'npm test', at: t0 + 12 * MIN })
  expect(ids(l, t0 + 20 * MIN).some(x => x.includes(':a1'))).toBe(false)
  expect(ids(l, t0 + 28 * MIN)).toContain('hung:a1/warn')
  expect(ids(l, t0 + 43 * MIN)).toContain('hung:a1/alert')
})

test('the same call three times in the last ten is a loop', () => {
  let l = normal()
  const t0 = 30 * 20_000
  l = call(l, 'a1', t0 + 1_000, 900, 'npm test')
  l = call(l, 'a1', t0 + 2_000, 901, 'cat a.txt')
  l = call(l, 'a1', t0 + 3_000, 902, 'npm test')
  expect(ids(l, t0 + 4_000).some(x => x.startsWith('loop:'))).toBe(false)
  l = call(l, 'a1', t0 + 4_000, 903, 'npm test')
  const v = evaluate(l, t0 + 5_000).find(x => x.id === 'loop:a1')
  expect(v?.level).toBe('alert')
  expect(v?.cause).toBe('"map the repo" looping on Bash')
})

test('a failing command retried once is a warning', () => {
  let l = normal()
  const t0 = 30 * 20_000
  l = call(l, MAIN, t0 + 1_000, 900, 'make build', true)
  l = call(l, MAIN, t0 + 2_000, 901, 'make build', true)
  expect(ids(l, t0 + 3_000)).toContain('retry:main/warn')
})

test('edits of one file with different text are different calls', () => {
  expect(callKey('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })).not.toBe(
    callKey('Edit', { file_path: 'a.ts', old_string: 'y', new_string: 'z' }),
  )
  expect(callKey('Bash', { command: 'ls', description: 'list' })).toBe(callKey('Bash', { command: 'ls', description: 'other' }))
})

test('more than 20% errors in ten calls is an error storm, half is red', () => {
  let l = normal()
  const t0 = 30 * 20_000
  for (let i = 0; i < 10; i++) l = call(l, 'a1', t0 + i * 1_000, 500 + i, `cmd ${i}`, i < 3)
  expect(ids(l, t0 + 11_000)).toContain('errors:a1/warn')
  for (let i = 0; i < 10; i++) l = call(l, 'a1', t0 + 20_000 + i * 1_000, 600 + i, `cmd b${i}`, i % 2 === 0)
  expect(ids(l, t0 + 31_000)).toContain('errors:a1/alert')
})

test('a response cut at the context window or the output limit is a wall', () => {
  let l = normal()
  l = step(l, 'a1', 30 * 20_000, 80_000, { stopReason: 'model_context_window_exceeded' })
  expect(ids(l, 30 * 20_000 + 1_000)).toContain('wall:a1/alert')
})

test('context creep counts only past 500k, as tokenol does', () => {
  let small = emptyLedger()
  for (let i = 0; i < 15; i++) small = step(small, MAIN, i * 10_000, 100_000 + i * 5_000)
  expect(ids(small, 150_000).some(x => x.startsWith('creep'))).toBe(false)

  let big = emptyLedger()
  for (let i = 0; i < 15; i++) big = step(big, MAIN, i * 10_000, 480_000 + i * 5_000)
  expect(ids(big, 150_000)).toContain('creep:main/warn')
})

test('twenty requests at 90% of the window is the ceiling plateau', () => {
  let l = emptyLedger()
  for (let i = 0; i < 19; i++) l = step(l, MAIN, i * 10_000, 920_000, {}, 4_000)
  expect(ids(l, 200_000)).toContain('ceiling:main/warn')
  l = step(l, MAIN, 200_000, 925_000, {}, 4_000)
  expect(ids(l, 201_000)).toContain('ceiling:main/alert')
})

test('growing back to 80% of the size before compacting is re-inflation', () => {
  let l = emptyLedger()
  for (let i = 0; i < 5; i++) l = step(l, MAIN, i * 10_000, 400_000 + i * 10_000)
  l = compacted(l, MAIN, 60_000)
  l = step(l, MAIN, 70_000, 60_000)
  expect(ids(l, 71_000).some(x => x.startsWith('reinflate'))).toBe(false)
  l = step(l, MAIN, 80_000, 360_000)
  expect(ids(l, 81_000)).toContain('reinflate:main/warn')
})

test('reading over 400 context tokens per output token is flagged', () => {
  let l = emptyLedger()
  for (let i = 0; i < 10; i++) l = step(l, MAIN, i * 10_000, 200_000, {}, 300)
  expect(ids(l, 100_000)).toContain('ctx:main/warn')
})

test('the plan window is projected to run out before it resets', () => {
  let l = emptyLedger()
  const resetsAt = new Date(3 * 60 * MIN).toISOString()
  // 1% a minute from 40%: out in 30 more minutes, long before the reset.
  for (let i = 0; i <= 30; i++) l = measured(l, { at: i * MIN, rateLimits: [{ kind: 'five_hour', percentUsed: 40 + i, resetsAt }] })
  const v = evaluate(l, 30 * MIN).find(x => x.id === 'plan')
  expect(v?.level).toBe('alert')
  expect(v?.cause).toBe('plan window out in 30m')
})

test('subagents above 40% of the cost and one costing over 2× its siblings are flagged, in the sidebar only', () => {
  let l = emptyLedger()
  l = step(l, MAIN, 1_000, 50_000)
  for (const [n, size] of [['a', 50_000], ['b', 50_000], ['c', 50_000], ['d', 600_000]] as const) {
    l = spawned(l, { id: n, type: 'general-purpose', description: n, model: OPUS, at: 0 })
    for (let i = 0; i < 6; i++) l = step(l, n, 2_000 + i * 1_000, size)
    l = turnEnded(l, n, 20_000, 'answer')
  }
  l = measured(l, { at: 21_000, usd: 2, rateLimits: [] })
  const found = ids(l, 21_000)
  expect(found).toContain('share/warn')
  expect(found).toContain('pricey:d/warn')
  expect(rowSegments(l, 21_000, evaluate(l, 21_000)).some(s => s.text.startsWith('⚠'))).toBe(false)
})

test('an incident toasts once when it turns red and closes five minutes after its cause is gone', () => {
  const alert = { id: 'loop:a1', level: 'alert' as const, cause: 'x', sentence: 'X.' }
  let r = track([], [alert], 0)
  expect(r.raised.length).toBe(1)
  r = track(r.incidents, [alert], 15_000)
  expect(r.raised.length).toBe(0)
  r = track(r.incidents, [], 6 * MIN)
  expect(r.incidents[0]?.isClosed).toBe(true)
  r = track(r.incidents, [alert], 7 * MIN)
  expect(r.raised.length).toBe(1)
})

test('nested subagents sit under their parent', () => {
  let l = step(emptyLedger(), MAIN, 0, 10_000)
  l = spawned(l, { id: 'p', type: 'general-purpose', description: 'parent', model: OPUS, at: 1 })
  l = spawned(l, { id: 'q', type: 'general-purpose', description: 'other', model: OPUS, at: 2 })
  l = spawned(l, { id: 'c', parentId: 'p', type: 'Explore', description: 'child', model: OPUS, at: 3 })
  expect(tree(l).map(x => `${x.t.id}${x.depth}`)).toEqual(['main0', 'p1', 'c2', 'q1'])
})

test('the row names a drifting cause and drops detail to fit', () => {
  const l = normal()
  const quiet = rowSegments(l, 30 * 20_000, [])
  expect(quiet.map(s => s.text).join('')).toBe('1/1 agents running · ctx 8% · 60 tools')
  expect(quiet.every(s => s.color === undefined)).toBe(true)
  const verdicts = evaluate(l, 30 * 20_000 + 11 * MIN)
  const loud = rowSegments(l, 30 * 20_000 + 11 * MIN, verdicts, 3)
  expect(loud[0]).toEqual({ text: '⚠ "map the repo" quiet 11m', color: 'error' })
})

test('tool stats count calls, failures, time and threads for the whole session', () => {
  let l = call(emptyLedger(), MAIN, 0, 1, 'ls')
  l = call(l, 'a1', 1_000, 2, 'npm test', true)
  expect(l.tools.Bash).toEqual({ calls: 2, errors: 1, ms: 1_000, threads: ['main', 'a1'] })
  expect(l.threads.a1?.toolMs).toBe(500)
})

test('a request records how long it took', () => {
  const l = step(emptyLedger(), MAIN, 5_000, 30_000)
  expect(l.threads.main?.samples[0]?.ms).toBe(1_000)
})

// The two agents of the live trial: started together, each wrote the same ~20k prefix
// cold, read it once and handed back about 45 tokens.
test('two tiny agents started together are diagnosed as cold, twin and too small', () => {
  let l = emptyLedger()
  const cold = (written: number) => ({ model: 'claude-sonnet-5-5', input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: written, output_tokens: 20 })
  const warm = (read: number) => ({ model: 'claude-sonnet-5-5', input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: 1_100, output_tokens: 24 })
  for (const [id, at] of [['a', 0], ['b', 400]] as const) {
    l = spawned(l, { id, type: 'Explore', description: id, model: 'claude-sonnet-5-5', at })
    l = stepEnded(stepStarted(l, id, at, 'claude-sonnet-5-5', 'low'), id, at + 2_000, { usage: cold(19_600), stopReason: 'tool_use', toolUses: [] })
    l = stepEnded(stepStarted(l, id, at + 3_000, 'claude-sonnet-5-5', 'low'), id, at + 4_000, { usage: warm(19_600), stopReason: 'end_turn', toolUses: [] })
    l = turnEnded(l, id, at + 4_500, 'answer')
  }
  const notes = diagnose(l, l.threads.a!, 10_000).map(n => n.text)
  expect(notes[0]).toBe('cold start: wrote a 20k prefix, 91% of its cost')
  expect(notes).toContain('setup outweighed the work (44 tokens out): too small to delegate')
  expect(notes).toContain('started with 1 other; each wrote the same ~20k prefix')
})

test('a stacked bar gives each part its glyph and at least one cell', () => {
  const bar = stackedBar([{ kind: 'read', value: 90 }, { kind: 'written', value: 1 }, { kind: 'uncached', value: 9 }], 100, 10)
  expect(bar.map(b => b.text).join('')).toBe('████████▓░')
  // Half the scale fills half the width.
  expect(stackedBar([{ kind: 'read', value: 50 }], 100, 10).map(b => b.text).join('')).toBe('█████')
})

test('a sparkline scales to the window', () => {
  expect(sparkline([0, 500_000, 1_000_000], 1_000_000)).toBe('▁▅█')
})
