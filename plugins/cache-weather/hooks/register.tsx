import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { CacheTally, ContextFill } from '../types'

const EMPTY: CacheTally = { read: 0, written: 0, uncached: 0 }

const lastTurn = atom({ plugin: 'cache-weather', key: 'lastTurn' } as const, null)
const session = atom({ plugin: 'cache-weather', key: 'session' } as const, EMPTY)
// The context window as the last main-thread response filled it.
const context = atom({ plugin: 'cache-weather', key: 'context' } as const, null)

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

export const describe = (
  turn: CacheTally | null,
  total: CacheTally,
  fill: ContextFill | null,
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Earlier versions pinned the bar as a status line; clear any that is left.
    $.ui.status(undefined)
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
    }

    return next(e)
  })

  // The bars get a row of their own, drawn above the engine's hint line.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineLine = await next(e)
    const segments = describe(await read($, lastTurn), await read($, session), await read($, context))

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
