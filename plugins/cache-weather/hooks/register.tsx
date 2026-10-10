import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { CacheTally, CacheTtl, ContextFill } from '../types'

const EMPTY: CacheTally = { read: 0, written: 0, uncached: 0 }

const lastTurn = atom({ plugin: 'cache-weather', key: 'lastTurn' } as const, null)
const session = atom({ plugin: 'cache-weather', key: 'session' } as const, EMPTY)
// The context window as the last main-thread response filled it.
const context = atom({ plugin: 'cache-weather', key: 'context' } as const, null)
// The TTL the newest cache write used, read from the transcript or a model switch.
const ttl = atom({ plugin: 'cache-weather', key: 'ttl' } as const, null)
// When the last main-thread request read or wrote the cache, in clock milliseconds.
const refreshedAt = atom({ plugin: 'cache-weather', key: 'refreshedAt' } as const, null)
// Moves on every thirty seconds so the time left counts down while nothing else happens.
const tick = atom({ plugin: 'cache-weather', key: 'tick' } as const, 0)

const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

const BAR_WIDTH = 10
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

const WEATHER = [
  { from: 0.8, icon: '☀️' },
  { from: 0.6, icon: '🌤️' },
  { from: 0.4, icon: '☁️' },
  { from: 0.2, icon: '🌦️' },
  { from: 0, icon: '🌧️' },
] as const

export const toTally = (usage: ModelUsage): CacheTally => ({
  read: usage.cache_read_input_tokens,
  written: usage.cache_creation_input_tokens,
  uncached: usage.input_tokens,
})

export const add = (a: CacheTally, b: CacheTally): CacheTally => ({
  read: a.read + b.read,
  written: a.written + b.written,
  uncached: a.uncached + b.uncached,
})

// The share of input tokens the prompt cache served, or null with no input yet.
export const hitRate = (tally: CacheTally): number | null => {
  const total = tally.read + tally.written + tally.uncached

  return total === 0 ? null : tally.read / total
}

export const weatherFor = (rate: number) =>
  WEATHER.find(w => rate >= w.from) ?? WEATHER[4]

// A bar of BAR_WIDTH cells, filled in eighths of a cell.
export const bar = (share: number): string => {
  const eighths = Math.round(Math.min(1, Math.max(0, share)) * BAR_WIDTH * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8] ?? ''

  return ('█'.repeat(full) + part).padEnd(BAR_WIDTH, '░')
}

const percent = (share: number) => `${Math.round(share * 100)}%`

export const tokensText = (n: number): string =>
  n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

// A run of text and the theme color it is drawn in; no color means dim.
export type Segment = { text: string; color?: 'success' | 'warning' | 'error' }

// A high hit rate is good, so it is green.
export const rateColor = (rate: number): Segment['color'] =>
  rate >= 0.8 ? 'success' : rate >= 0.5 ? 'warning' : 'error'

// A full context window is bad, so the colors run the other way.
export const fillColor = (share: number): Segment['color'] =>
  share < 0.5 ? 'success' : share < 0.8 ? 'warning' : 'error'

export const describeContext = (fill: ContextFill): Segment[] => {
  const share = fill.window === 0 ? 0 : fill.tokens / fill.window

  return [
    { text: 'ctx ' },
    { text: bar(share), color: fillColor(share) },
    { text: ` ${percent(share)} · ${tokensText(fill.tokens)} / ${tokensText(fill.window)}` },
  ]
}

export const minutesText = (ms: number): string => {
  const minutes = Math.ceil(ms / 60_000)

  return minutes >= 60 ? '1h' : `${minutes}m`
}

export type TtlView = { ttl: CacheTtl; refreshedAt: number | null; now: number; isWorking: boolean }

// How long the cache stays warm, counted from the last request that touched it.
export const describeTtl = (view: TtlView): Segment[] => {
  const label = { text: `ttl ${view.ttl} · ` }

  if (view.isWorking || view.refreshedAt === null) {
    return [{ ...label, text: `ttl ${view.ttl}` }]
  }

  const left = TTL_MS[view.ttl] - (view.now - view.refreshedAt)

  return left > 0 ? [label, { text: `${minutesText(left)} left` }] : [label, { text: 'expired', color: 'error' }]
}

export const describe = (
  turn: CacheTally | null,
  total: CacheTally,
  fill: ContextFill | null,
  ttlSegments: Segment[] = [],
): Segment[] | undefined => {
  const turnRate = turn === null ? null : hitRate(turn)

  if (turnRate === null) {
    return undefined
  }

  const totalRate = hitRate(total)
  const sessionText = totalRate === null ? '' : ` · session ${percent(totalRate)}`

  return [
    { text: `${weatherFor(turnRate).icon} cache ` },
    { text: bar(turnRate), color: rateColor(turnRate) },
    { text: ` ${percent(turnRate)}${sessionText}` },
    ...(fill === null ? [] : [{ text: '   ' }, ...describeContext(fill)]),
    ...(ttlSegments.length === 0 ? [] : [{ text: '   ' }, ...ttlSegments]),
  ]
}

// Copies the status line's context figures into state, where the drawing reads them.
async function readContext($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const { tokens, window } = usage.context

  if (tokens !== undefined) {
    await update($, context, () => ({ tokens, window }))
  }
}

const isTtl = (value: unknown): value is CacheTtl => value === '5m' || value === '1h'

// The TTL of the newest main-thread response that wrote to the cache, read from
// transcript lines. A response that only read the cache says nothing, so it is skipped.
export const ttlFromTranscript = (text: string): CacheTtl | null => {
  for (const line of text.split('\n').reverse()) {
    let entry: {
      type?: string
      isSidechain?: boolean
      message?: { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } }
    }

    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (entry?.type !== 'assistant' || entry.isSidechain === true) {
      continue
    }

    const creation = entry.message?.usage?.cache_creation

    if ((creation?.ephemeral_1h_input_tokens ?? 0) > 0) {
      return '1h'
    }

    if ((creation?.ephemeral_5m_input_tokens ?? 0) > 0) {
      return '5m'
    }
  }

  return null
}

// Reads the end of the transcript, which is enough to hold the last few responses.
async function readTtl($: EngineInterface, transcriptPath: string): Promise<CacheTtl | null> {
  const tail = await $.process.run(['tail', '-n', '60', transcriptPath])

  return tail.exitCode === 0 ? ttlFromTranscript(tail.stdout) : null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Earlier versions pinned the bar as a status line; clear any that is left.
    $.ui.status(undefined)
    $.clock.every(30_000, () => update($, tick, n => (n + 1) % 1000))
    const started = await next(e)
    await readContext($)

    return started
  })

  on('turn.complete', async ($, e, next) => {
    // Subagent turns run on their own cache prefix, so only the main thread counts.
    if (e.agentId === undefined && e.usage !== undefined) {
      const tally = toTally(e.usage)
      await update($, lastTurn, () => tally)
      await update($, session, sum => add(sum, tally))
      await readContext($)

      if (tally.read + tally.written > 0) {
        const now = await $.clock.now()
        await update($, refreshedAt, () => now)
      }
    }

    return next(e)
  })

  // The transcript records which TTL each response wrote its cache with.
  // This hook only listens, so a failure lets the turn end as usual.
  on('classic.Stop', async ($, e, next) => {
    const found = await readTtl($, e.transcript_path)

    if (found !== null) {
      await update($, ttl, () => found)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A model switch names the TTL too. These hooks only listen, so a failure lets the switch go on.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (isTtl(e.cache_ttl)) {
      await update($, ttl, () => e.cache_ttl)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The bars get a row of their own, drawn above the engine's hint line.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineLine = await next(e)
    const known = await read($, ttl)
    await read($, tick)
    const ttlSegments =
      known === null
        ? []
        : describeTtl({
            ttl: known,
            refreshedAt: await read($, refreshedAt),
            now: await $.clock.now(),
            isWorking: e.props.isWorking,
          })
    const segments = describe(await read($, lastTurn), await read($, session), await read($, context), ttlSegments)

    if (segments === undefined) {
      return engineLine
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text>
          {segments.map(one =>
            one.color === undefined ? <Text dimColor>{one.text}</Text> : <Text color={one.color}>{one.text}</Text>,
          )}
        </Text>
        {engineLine}
      </Box>
    )
  })
}
