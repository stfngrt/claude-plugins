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
// When the last main-thread request that read or wrote the cache was sent, in clock milliseconds.
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

// A high hit rate is good, so it is green: sun and sun behind cloud are green,
// cloud is yellow, and showers and rain are red, so the bar and the sky agree.
export const rateColor = (rate: number): Segment['color'] =>
  rate >= 0.6 ? 'success' : rate >= 0.4 ? 'warning' : 'error'

// A full context window is bad, so the colors run the other way.
export const fillColor = (share: number): Segment['color'] =>
  share < 0.5 ? 'success' : share < 0.8 ? 'warning' : 'error'

// How much of the row to draw: everything, then without token counts, then
// without the session rate, then without bars, so the row fits narrow terminals.
export const DETAILS = ['full', 'short', 'shorter', 'bare'] as const

export type Detail = (typeof DETAILS)[number]

export const describeContext = (fill: ContextFill, detail: Detail = 'full'): Segment[] => {
  const share = fill.window === 0 ? 0 : fill.tokens / fill.window

  if (detail === 'bare') {
    return [{ text: 'ctx ' }, { text: percent(share), color: fillColor(share) }]
  }

  const counts = detail === 'full' ? ` · ${tokensText(fill.tokens)} / ${tokensText(fill.window)}` : ''

  return [{ text: 'ctx ' }, { text: bar(share), color: fillColor(share) }, { text: ` ${percent(share)}${counts}` }]
}

export const minutesText = (ms: number): string => {
  const minutes = Math.ceil(ms / 60_000)

  return minutes >= 60 ? '1h' : `${minutes}m`
}

export type TtlView = { ttl: CacheTtl; refreshedAt: number | null; now: number; isWorking: boolean }

// How long the cache stays warm, counted from when the last request that touched it was sent.
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
  detail: Detail = 'full',
): Segment[] | undefined => {
  const turnRate = turn === null ? null : hitRate(turn)

  if (turnRate === null) {
    return undefined
  }

  const totalRate = hitRate(total)
  const hasSession = totalRate !== null && (detail === 'full' || detail === 'short')
  const sessionText = hasSession ? ` · session ${percent(totalRate)}` : ''
  const icon = weatherFor(turnRate).icon
  const cache: Segment[] =
    detail === 'bare'
      ? [{ text: `${icon} ` }, { text: percent(turnRate), color: rateColor(turnRate) }]
      : [
          { text: `${icon} cache ` },
          { text: bar(turnRate), color: rateColor(turnRate) },
          { text: ` ${percent(turnRate)}${sessionText}` },
        ]
  // Bare keeps only the time left, or the TTL itself while a turn runs.
  const ttlShown = detail === 'bare' ? ttlSegments.slice(-1) : ttlSegments

  return [
    ...cache,
    ...(fill === null ? [] : [{ text: '   ' }, ...describeContext(fill, detail)]),
    ...(ttlShown.length === 0 ? [] : [{ text: '   ' }, ...ttlShown]),
  ]
}

// Terminal cells a text takes: emoji take two, a variation selector none.
export const cellWidth = (text: string): number => {
  let cells = 0

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    cells += code === 0xfe0f ? 0 : code >= 0x1f000 || (code >= 0x2600 && code <= 0x26ff) ? 2 : 1
  }

  return cells
}

// The most detailed row that fits the width, or the barest one when none does.
export const fitRow = (draw: (detail: Detail) => Segment[] | undefined, columns: number | undefined) => {
  for (const detail of DETAILS) {
    const segments = draw(detail)

    if (segments === undefined || columns === undefined || cellWidth(segments.map(one => one.text).join('')) <= columns) {
      return segments
    }
  }

  return draw('bare')
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
// A response that wrote both lifetimes answers 5m: that part goes cold first, and
// the next prompt after it pays to write it again even though the 1h prefix still hits.
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

    if ((creation?.ephemeral_5m_input_tokens ?? 0) > 0) {
      return '5m'
    }

    if ((creation?.ephemeral_1h_input_tokens ?? 0) > 0) {
      return '1h'
    }
  }

  return null
}

// $.fs.read refuses files over 4 MiB, so a longer transcript is read from its end.
const READ_LIMIT = 4 * 1024 * 1024
const TAIL_BYTES = '1000000'

// Reads the transcript, or the last megabyte of a long one, by bytes rather than
// lines, since one tool result can fill many lines' worth on its own.
async function readTtl($: EngineInterface, transcriptPath: string): Promise<CacheTtl | null> {
  const { size } = await $.fs.stat(transcriptPath)

  if (size <= READ_LIMIT) {
    return ttlFromTranscript(await $.fs.read(transcriptPath))
  }

  const tail = await $.process.run(['tail', '-c', TAIL_BYTES, transcriptPath])

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

  // A /clear or a resume moves the process to another conversation, whose cache
  // and counts start over, so the row goes until that one's first turn ends.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, lastTurn, () => null)
      await update($, session, () => EMPTY)
      await update($, context, () => null)
      await update($, ttl, () => null)
      await update($, refreshedAt, () => null)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The cache lifetime starts over when a request reaches it, not when its answer
  // has finished streaming, so the clock is read before each main-thread request.
  on('turn.step', async function* ($, e, next) {
    const sentAt = e.agentId === undefined ? await $.clock.now() : null
    const result = yield* next(e)
    const usage = result.usage

    // The step's result is already the model's; a failed write here must not fail it.
    if (sentAt !== null && usage !== null && usage.cache_read_input_tokens + usage.cache_creation_input_tokens > 0) {
      try {
        await update($, refreshedAt, () => sentAt)
      } catch {
        // The countdown keeps the previous request's time.
      }
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    // Subagent turns run on their own cache prefix, so only the main thread counts.
    if (e.agentId === undefined && e.usage !== undefined) {
      const tally = toTally(e.usage)
      await update($, lastTurn, () => tally)
      await update($, session, sum => add(sum, tally))
      await readContext($)
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
    const [turn, total, fill] = [await read($, lastTurn), await read($, session), await read($, context)]
    const segments = fitRow(detail => describe(turn, total, fill, ttlSegments, detail), e.viewport?.columns)

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
