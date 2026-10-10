import { expect, test } from 'claude-code/testing'

import type { Segment } from './register'
import { add, bar, describe, describeContext, hitRate, toTally, tokensText, weatherFor } from './register'

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
