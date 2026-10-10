import { expect, test } from 'claude-code/testing'

import type { Segment } from './register'
import {
  add,
  bar,
  cellWidth,
  describe,
  describeContext,
  describeTtl,
  fitRow,
  hitRate,
  rateColor,
  toTally,
  tokensText,
  ttlFromTranscript,
  weatherFor,
} from './register'

const text = (segments: Segment[]) => segments.map(one => one.text).join('')

test('hit rate counts read tokens against all input tokens', () => {
  expect(hitRate({ read: 90, written: 5, uncached: 5 })).toBe(0.9)
  expect(hitRate({ read: 0, written: 0, uncached: 0 })).toBe(null)
})

test('a warm cache is sunny and a cold one rains', () => {
  expect(weatherFor(0.95).icon).toBe('☀️')
  expect(weatherFor(0.05).icon).toBe('🌧️')
})

test('the bar fills in eighths and keeps its width', () => {
  expect(bar(1)).toBe('██████████')
  expect(bar(0)).toBe('░░░░░░░░░░')
  expect(bar(0.55)).toBe('█████▌░░░░')
})

test('token counts read as k and M', () => {
  expect(tokensText(950)).toBe('950')
  expect(tokensText(118_600)).toBe('119k')
  expect(tokensText(1_000_000)).toBe('1M')
})

test('the context bar shows the real token count and turns red when full', () => {
  expect(text(describeContext({ tokens: 120_000, window: 1_000_000 }))).toBe('ctx █▎░░░░░░░░ 12% · 120k / 1M')
  expect(describeContext({ tokens: 120_000, window: 1_000_000 })[1]?.color).toBe('success')
  expect(describeContext({ tokens: 850_000, window: 1_000_000 })[1]?.color).toBe('error')
})

test('the row shows the turn rate, the session rate and the context', () => {
  const turn = toTally({
    input_tokens: 10,
    output_tokens: 50,
    cache_read_input_tokens: 980,
    cache_creation_input_tokens: 10,
  })
  const total = add(turn, { read: 0, written: 1000, uncached: 0 })

  expect(describe(turn, total, null)).toEqual([
    { text: '☀️ cache ' },
    { text: '█████████▊', color: 'success' },
    { text: ' 98% · session 49%' },
  ])
  expect(text(describe(turn, total, { tokens: 500_000, window: 1_000_000 }) ?? [])).toContain('   ctx █████░░░░░ 50%')
  expect(describe(null, total, null)).toBe(undefined)
})

test('the TTL is plain text that counts down and then expires', () => {
  const view = { ttl: '1h', refreshedAt: 0, isWorking: false } as const

  expect(text(describeTtl({ ...view, now: 6 * 60_000 }))).toBe('ttl 1h · 54m left')
  expect(text(describeTtl({ ...view, now: 60 * 60_000 }))).toBe('ttl 1h · expired')
  expect(describeTtl({ ...view, now: 60 * 60_000 })[1]?.color).toBe('error')
  expect(text(describeTtl({ ...view, now: 0, isWorking: true }))).toBe('ttl 1h')
})

test('the TTL comes from the newest main-thread response that wrote the cache', () => {
  const line = (ttl: '1h' | '5m' | 'none', isSidechain = false) =>
    JSON.stringify({
      type: 'assistant',
      isSidechain,
      message: {
        usage: {
          cache_creation: {
            ephemeral_1h_input_tokens: ttl === '1h' ? 90 : 0,
            ephemeral_5m_input_tokens: ttl === '5m' ? 90 : 0,
          },
        },
      },
    })
  const transcript = [line('5m'), line('1h'), line('5m', true), line('none'), '{"cut off'].join('\n')

  expect(ttlFromTranscript(transcript)).toBe('1h')
  expect(ttlFromTranscript(line('none'))).toBe(null)
})

test('a response that wrote both lifetimes counts down from the shorter one', () => {
  const mixed = JSON.stringify({
    type: 'assistant',
    message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 9000, ephemeral_5m_input_tokens: 40 } } },
  })

  expect(ttlFromTranscript(mixed)).toBe('5m')
})

test('the bar colour follows the same bands as the sky', () => {
  expect([0.85, 0.65, 0.45, 0.25, 0.05].map(rate => [weatherFor(rate).icon, rateColor(rate)])).toEqual([
    ['☀️', 'success'],
    ['🌤️', 'success'],
    ['☁️', 'warning'],
    ['🌦️', 'error'],
    ['🌧️', 'error'],
  ])
})

test('the row drops detail until it fits the width', () => {
  const turn = { read: 98, written: 1, uncached: 1 }
  const fill = { tokens: 120_000, window: 1_000_000 }
  const ttlSegments = [{ text: 'ttl 1h · ' }, { text: '54m left' }]
  const row = (columns?: number) =>
    text(fitRow(detail => describe(turn, turn, fill, ttlSegments, detail), columns) ?? [])

  expect(row()).toBe('☀️ cache █████████▊ 98% · session 98%   ctx █▎░░░░░░░░ 12% · 120k / 1M   ttl 1h · 54m left')
  expect(row(80)).toBe('☀️ cache █████████▊ 98% · session 98%   ctx █▎░░░░░░░░ 12%   ttl 1h · 54m left')
  expect(row(70)).toBe('☀️ cache █████████▊ 98%   ctx █▎░░░░░░░░ 12%   ttl 1h · 54m left')
  expect(row(40)).toBe('☀️ 98%   ctx 12%   54m left')
  expect(row(10)).toBe('☀️ 98%   ctx 12%   54m left')
})

test('emoji take two cells', () => {
  expect(cellWidth('☀️ a')).toBe(4)
  expect(cellWidth('🌤️')).toBe(2)
})

test('the TTL closes the row', () => {
  const turn = { read: 90, written: 5, uncached: 5 }

  expect(text(describe(turn, turn, null, [{ text: 'ttl 1h' }]) ?? [])).toBe('☀️ cache █████████░ 90% · session 90%   ttl 1h')
})
