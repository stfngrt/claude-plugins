import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ledger, Thread } from '../types'
import {
  MAIN,
  creep,
  callEnded,
  callKey,
  callStarted,
  callSummary,
  compacted,
  costBar,
  diagnose,
  emptyLedger,
  errorRate,
  evaluate,
  fitRow,
  hitRates,
  isEfficiency,
  isEstimate,
  isRebuild,
  measured,
  normalize,
  minutesText,
  planOutlook,
  rowSegments,
  spawned,
  stepEnded,
  stepStarted,
  sumParts,
  tokenBar,
  tokensText,
  totalUsd,
  track,
  tree,
  turnEnded,
  usdText,
} from './core'
import type { BarKind, Verdict } from './core'

const ledger = atom({ plugin: 'session-watch', key: 'ledger' } as const, emptyLedger())
const now = atom({ plugin: 'session-watch', key: 'now' } as const, 0)

const PANE = 'session-watch'
const TICK_MS = 15_000

// Bookkeeping that must never fail the turn, tool call or spawn it watches.
async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch {
    // The watch misses one update; the session goes on as usual.
  }
}

// Every write goes through normalize, so a ledger an older version left behind takes the new fields.
const edit = ($: EngineInterface, change: (l: Ledger) => Ledger) => update($, ledger, prev => change(normalize(prev)))

const lastEventAt = (l: Ledger): number =>
  Math.max(0, ...Object.values(l.threads).map(t => t.lastActivityAt))

const secondsText = (ms: number): string => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : minutesText(ms))

// Errors the person caused (a refused permission, a rejected call) are no sign of a wall.
const isRefusal = (text: string | undefined): boolean =>
  /permission .*denied|rejected|doesn't want|user declined|was blocked by/i.test(text ?? '')

const toolArgs = (e: Record<string, unknown>): Record<string, unknown> => {
  const { tool: _t, tool_use_id: _id, agentId: _a, requestMeta: _r, ...args } = e
  return args
}

// Keeps the incident log and raises a toast for each incident that just turned red.
async function refresh($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  const l = normalize(await read($, ledger))
  const verdicts = evaluate(l, at).filter(v => !isEfficiency(v))
  let raised: Verdict[] = []
  await edit($, prev => {
    const tracked = track(prev.incidents, verdicts, at)
    raised = tracked.raised
    return { ...prev, incidents: tracked.incidents }
  })
  for (const v of raised) $.ui.toast(`session-watch: ${v.sentence}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await quietly(async () => {
      await $.command.register({
        name: 'session-watch',
        description: 'Show or hide the session-watch sidebar: subagents, cache, context and spend over time, and what tripped',
      })
      await update($, now, () => 0)
    })
    $.clock.every(TICK_MS, () => {
      void quietly(async () => {
        const at = await $.clock.now()
        await update($, now, () => at)
        await refresh($)
      })
    })
    return started
  })

  // A /clear or a resume moves the process to another conversation: the watch starts over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await quietly(() => update($, ledger, () => emptyLedger()))
    return next(e)
  })

  // Each model request: marked busy when sent, so a long answer is never taken for a stall.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? MAIN
    const effort = e.effort === undefined ? undefined : String(e.effort)
    await quietly(async () => {
      const at = await $.clock.now()
      await edit($, l =>  stepStarted(l, id, at, e.model, effort))
    })
    // A request that failed or was interrupted still leaves the busy count.
    let ended = false
    try {
      const r = yield* next(e)
      ended = true
      await quietly(async () => {
        const at = await $.clock.now()
        await edit($, l =>  stepEnded(l, id, at, { usage: r.usage, stopReason: r.stopReason, toolUses: r.toolUses }))
      })
      return r
    } finally {
      if (!ended) {
        await quietly(async () => {
          const at = await $.clock.now()
          await edit($, l =>  stepEnded(l, id, at, null))
        })
      }
    }
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const tool = String(e.tool)
    const args = toolArgs(e as unknown as Record<string, unknown>)
    await quietly(async () => {
      const at = await $.clock.now()
      await edit($, l => 
        callStarted(l, id, { id: e.tool_use_id, tool, key: callKey(tool, args), summary: callSummary(tool, args), at }),
      )
    })
    let isError = false
    try {
      const r = await next(e)
      isError = r.isError === true && !isRefusal(r.text)
      return r
    } catch (error) {
      // A call that threw failed as surely as one that answered an error.
      isError = true
      throw error
    } finally {
      await quietly(async () => {
        const at = await $.clock.now()
        await edit($, l =>  callEnded(l, id, e.tool_use_id, isError, at))
      })
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny === undefined && started.agentId) {
      const agentId = started.agentId
      await quietly(async () => {
        const at = await $.clock.now()
        await edit($, l => 
          spawned(l, { id: agentId, parentId: e.parentAgentId, type: e.subagentType, description: e.description, model: started.model, at }),
        )
      })
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    await quietly(async () => {
      const at = await $.clock.now()
      await edit($, l =>  turnEnded(l, e.agentId ?? MAIN, at, e.reason))
      await refresh($)
    })
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await quietly(async () => {
      const at = await $.clock.now()
      await edit($, l =>  compacted(l, e.agentId ?? MAIN, at))
    })
    return result
  })

  // Claude Code's own cost, the plan windows and the main context window, pushed after each main turn.
  on('session.measure', async ($, e, next) => {
    await quietly(async () => {
      const at = await $.clock.now()
      await edit($, l =>  measured(l, { at, usd: e.cost?.usd, rateLimits: e.rateLimits, window: e.context.window }))
      await refresh($)
    })
    return next(e)
  })

  on('command.run', { command: 'session-watch' }, async $ => {
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'session-watch sidebar closed.' }
    }
    const at = await $.clock.now()
    await update($, now, () => at)
    await $.ui.open({ id: PANE, title: 'Session watch' })
    return { text: 'session-watch sidebar opened.' }
  })

  // Under the prompt. While all is normal the figures ride dim at the end of the engine's
  // hint line (the terminal's `tail`), so cache-weather's row keeps the space; a drifting
  // signal takes a row of its own and names its cause.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const l = normalize(await read($, ledger))
    const at = Math.max(await read($, now), lastEventAt(l))
    if (l.order.length === 0) return next(e)

    const verdicts = evaluate(l, at).filter(v => !isEfficiency(v))
    const cols = e.viewport?.columns
    if (verdicts.length === 0 && e.surface === 'terminal') {
      const tail = fitRow(d => rowSegments(l, at, [], d), cols ? Math.max(20, Math.floor(cols / 3)) : undefined)
      return next({ ...e, props: { ...e.props, tail: tail.map(s => s.text).join('') } })
    }

    const line = await next(e)
    const segments = fitRow(d => rowSegments(l, at, verdicts, d), cols)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {segments.map(s => (s.color === undefined ? <Text dimColor>{s.text}</Text> : <Text color={s.color}>{s.text}</Text>))}
        </Text>
        {line}
      </Box>
    )
  })

  // The sidebar, drawn as tokenol draws a session: stacked bars, not sparklines.
  // Agents with their diagnosis, then cache growth request by request, then where the money went.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const l: Ledger = normalize(await read($, ledger))
    const at = Math.max(await read($, now), lastEventAt(l))
    const cols = Math.max(28, e.props.bodyColumns || 40)
    const barW = Math.max(8, Math.min(32, cols - 30))
    const verdicts = evaluate(l, at)
    const flagged = new Map<string, Verdict[]>()
    for (const v of verdicts) if (v.threadId) flagged.set(v.threadId, [...(flagged.get(v.threadId) ?? []), v])

    if (l.order.length === 0) {
      return <Text dimColor>Nothing yet: the first request fills this in.</Text>
    }

    const heading = (text: string) => (
      <Text key={`h-${text}`} bold>
        {text}
      </Text>
    )
    const levelColor = (level?: string) => (level === 'alert' ? 'error' : level === 'warn' ? 'warning' : undefined)
    const COLOR: Record<BarKind, 'success' | 'warning' | 'error' | undefined> = {
      read: 'success',
      written: 'warning',
      uncached: 'error',
      output: undefined,
      empty: undefined,
    }
    const bar = (parts: { kind: BarKind; text: string }[], key: string) =>
      parts.map((p, n) => (
        <Text key={`${key}-${n}`} color={COLOR[p.kind]}>
          {p.text}
        </Text>
      ))
    const nameOf = (t: Thread) => (t.id === MAIN ? 'main thread' : t.description || t.type)
    const threads = tree(l)
    const total = totalUsd(l)
    const plan = planOutlook(l, at)
    const est = Object.values(l.threads).reduce((sum, t) => sum + t.usd, 0)
    const all = threads.flatMap(({ t }) => t.samples)
    const sums = {
      read: all.reduce((a, x) => a + x.read, 0),
      written: all.reduce((a, x) => a + x.written, 0),
      uncached: all.reduce((a, x) => a + x.uncached, 0),
      output: all.reduce((a, x) => a + x.output, 0),
    }
    const started = threads.length ? Math.min(...threads.map(({ t }) => t.startedAt)) : at
    const requests = threads.reduce((a, { t }) => a + t.requests, 0)
    const toolCalls = Object.values(l.tools).reduce((a, x) => a + x.calls, 0)
    const toolErrors = Object.values(l.tools).reduce((a, x) => a + x.errors, 0)
    const ctxMax = Math.max(1, ...threads.map(({ t }) => t.samples.at(-1)?.context ?? 0))

    // --- agents: one block each, with what went wrong in words
    const statusGlyph = (t: Thread) => (t.status === 'running' ? '●' : t.status === 'done' ? '✓' : t.status === 'failed' ? '✗' : '○')
    const agentBlock = ({ t, depth }: { t: Thread; depth: number }) => {
      const flags = flagged.get(t.id) ?? []
      const notes = diagnose(l, t, at)
      const last = t.samples.at(-1)
      const rates = hitRates(t.samples)
      const hit = t.samples.length ? t.samples.reduce((a, x) => a + x.read, 0) / Math.max(1, t.samples.reduce((a, x) => a + x.context, 0)) : null
      const err = errorRate(t.calls)
      const end = t.status === 'running' ? at : (t.endedAt ?? at)
      const pad = '  '.repeat(depth)
      const meta = [t.type !== 'main' ? t.type : '', t.model.replace(/^claude-/, ''), t.effort ?? '', `${t.requests} req`, `${t.toolCalls} tools`]
        .filter(Boolean)
        .join(' · ')
      void rates
      return (
        <Box key={`a-${t.id}`} flexDirection="column" marginBottom={1}>
          <Text wrap="truncate-end">
            {pad}
            <Text color={levelColor(flags[0]?.level) ?? (t.status === 'running' ? 'success' : undefined)}>{statusGlyph(t)}</Text>{' '}
            <Text bold>{nameOf(t)}</Text>
            <Text dimColor>
              {' '}
              {minutesText(end - t.startedAt)} · ~{usdText(t.usd)}
              {est > 0 ? ` · ${Math.round((t.usd / est) * 100)}%` : ''}
            </Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {pad}  {meta}
            {err !== null ? ` · ${Math.round(err * 100)}% err` : ''}
          </Text>
          {last ? (
            <Text wrap="truncate-end">
              <Text dimColor>{pad}  ctx </Text>
              {bar(tokenBar(last, ctxMax, barW), `ctx-${t.id}`)}
              <Text dimColor>
                {' '}
                {tokensText(last.context)} ({Math.max(last.context > 0 ? 1 : 0, Math.round((last.context / t.window) * 100))}% of {tokensText(t.window)})
                {hit !== null ? ` · hit ${Math.round(hit * 100)}%` : ''}
              </Text>
            </Text>
          ) : null}
          {t.runningTool ? (
            <Text dimColor wrap="truncate-end">
              {pad}  runs {t.runningTool.name} {minutesText(at - t.runningTool.at)}: {t.runningTool.summary}
            </Text>
          ) : null}
          {flags.map(f => (
            <Text key={`f-${f.id}`} color={levelColor(f.level)} wrap="truncate-end">
              {pad}  ⚠ {f.sentence}
            </Text>
          ))}
          {notes.map((n, k) => (
            <Text key={`n-${t.id}-${k}`} color={n.tone === 'warn' ? 'warning' : undefined} dimColor={n.tone === 'info'} wrap="truncate-end">
              {pad}  {n.tone === 'warn' ? '▲' : '·'} {n.text}
            </Text>
          ))}
        </Box>
      )
    }

    // --- cache growth: each request's input, read / written / uncached, scaled per thread
    const growth = ({ t }: { t: Thread }) => {
      const shown = t.samples.slice(t.id === MAIN ? -8 : -6)
      if (shown.length === 0) return null
      const max = Math.max(1, ...shown.map(x => x.context))
      const firstIndex = t.requests - shown.length + 1
      return (
        <Box key={`g-${t.id}`} flexDirection="column">
          <Text dimColor wrap="truncate-end">
            {nameOf(t)}
          </Text>
          {shown.map((x, k) => {
            const prev = k > 0 ? shown[k - 1] : t.samples[t.samples.length - shown.length - 1]
            const delta = prev ? x.context - prev.context : null
            return (
              <Text key={`g-${t.id}-${k}`} wrap="truncate-end">
                <Text dimColor>{`#${firstIndex + k}`.padStart(4)} </Text>
                {bar(tokenBar(x, max, barW), `g-${t.id}-${k}`)}
                <Text dimColor>
                  {' '}
                  {tokensText(x.context)}
                  {delta !== null ? ` ${delta >= 0 ? '+' : '−'}${tokensText(Math.abs(delta))}` : ''} · {Math.round((x.context ? x.read / x.context : 0) * 100)}%
                  {x.ms ? ` · ${secondsText(x.ms)}` : ''}
                  {isRebuild(x) ? ' rebuilt' : ''}
                </Text>
              </Text>
            )
          })}
        </Box>
      )
    }

    // --- tools: calls (failed in red), time, threads
    const labelW = Math.max(10, Math.min(18, cols - barW - 12))
    const tools = Object.entries(l.tools)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 10)
    const callMax = Math.max(1, ...tools.map(([, x]) => x.calls))
    const tripped = [...l.incidents].reverse().slice(0, 8)
    const clock = (ms: number) => {
      const d = new Date(ms)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    const sessionNotes = verdicts.filter(v => !v.threadId && isEfficiency(v))

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{minutesText(at - started)}</Text>
          <Text dimColor>
            {' '}· {requests} requests · {toolCalls} tool calls{toolErrors ? ` (${toolErrors} failed)` : ''} · {threads.filter(({ t }) => t.id !== MAIN).length} agents
          </Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          tokens: {tokensText(sums.read)} read · {tokensText(sums.written)} written · {tokensText(sums.uncached)} uncached · {tokensText(sums.output)} out
          {sums.read + sums.written + sums.uncached > 0 ? ` · hit ${Math.round((sums.read / (sums.read + sums.written + sums.uncached)) * 100)}%` : ''}
        </Text>
        <Text dimColor wrap="truncate-end">
          {isEstimate(l) ? '~' : ''}
          {usdText(total)}
          {plan ? ` · 5h window ${Math.round(plan.percent)}%` : ''}
          {plan?.resetsInMs != null ? `, resets in ${minutesText(plan.resetsInMs)}` : ''}
          {plan?.outInMs != null ? `, used up in ${minutesText(plan.outInMs)} at this pace` : ''}
        </Text>
        <Text wrap="truncate-end">
          <Text color="success">█</Text>
          <Text dimColor> cache read </Text>
          <Text color="warning">▓</Text>
          <Text dimColor> cache write </Text>
          <Text color="error">░</Text>
          <Text dimColor> uncached </Text>
          <Text>▒</Text>
          <Text dimColor> output</Text>
        </Text>
        <Text> </Text>

        {heading('Agents')}
        {threads.map(agentBlock)}
        {sessionNotes.map(v => (
          <Text key={`e-${v.id}`} color="warning" wrap="truncate-end">
            ▲ {v.sentence}
          </Text>
        ))}

        {heading('Cache growth per request')}
        <Text dimColor wrap="truncate-end">
          input of each request: tokens, growth, share read from the cache
        </Text>
        {threads.map(growth)}
        <Text> </Text>

        {heading('Tools')}
        {tools.length === 0 ? <Text dimColor>No tool calls yet.</Text> : null}
        {tools.map(([name, x]) => (
          <Text key={`tl-${name}`} wrap="truncate-end">
            <Text dimColor>{name.replace(/^mcp__/, '').slice(0, labelW).padEnd(labelW + 1)}</Text>
            <Text color="success">{'■'.repeat(Math.max(1, Math.round(((x.calls - x.errors) / callMax) * barW)))}</Text>
            {x.errors ? <Text color="error">{'■'.repeat(Math.max(1, Math.round((x.errors / callMax) * barW)))}</Text> : null}
            <Text dimColor>
              {' '}
              {x.calls}
              {x.errors ? ` (${x.errors} ✗)` : ''} · {secondsText(x.ms)}
              {x.threads.length > 1 || x.threads[0] !== MAIN ? ` · ${x.threads.length} thread${x.threads.length > 1 ? 's' : ''}` : ''}
            </Text>
          </Text>
        ))}

        {heading('Context and requests')}
        {threads.map(({ t }) => {
          const g = creep(t.samples)
          const ms = t.samples.map(x => x.ms ?? 0).filter(Boolean)
          const slowest = ms.length ? Math.max(...ms) : 0
          const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0
          return (
            <Text key={`cr-${t.id}`} dimColor wrap="truncate-end">
              {nameOf(t).slice(0, labelW).padEnd(labelW + 1)}
              {g !== null ? `${g >= 0 ? '+' : '−'}${tokensText(Math.abs(g))}/req · ` : ''}
              {ms.length ? `avg ${secondsText(avg)}, slowest ${secondsText(slowest)}` : ''}
              {t.toolMs ? ` · tools ${secondsText(t.toolMs)}` : ''}
            </Text>
          )
        })}

        {tripped.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {heading('Tripped')}
            {tripped.map((i, n) => (
              <Text key={`i-${n}-${i.id}`} wrap="truncate-end" dimColor={i.isClosed}>
                <Text color={i.isClosed ? undefined : levelColor(i.level)}>{i.isClosed ? '·' : '⚠'}</Text> {clock(i.at)} {i.cause}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })
}
