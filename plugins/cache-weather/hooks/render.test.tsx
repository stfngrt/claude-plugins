import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, model: 'test' }

const PROPS = { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on' }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the bar sits on its own row above the engine's hint line`, async ($, on) => {
    mock.clock(on)
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })
    on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, reason: 'answer', isAborted: false, usage: USAGE })

    const ui = await $.ui.mount({ plugin: 'cache-weather', surface, component: 'PromptHint', props: PROPS })
    const drawn = JSON.stringify(await ui.drawn())

    expect(drawn).toContain('cache ')
    expect(drawn).toContain('"success"')
    expect(drawn.indexOf('cache ')).toBeLessThan(drawn.indexOf('auto mode on'))
  })

  test(`${surface}: before any turn the row waits above the engine's line`, async ($, on) => {
    mock.clock(on)
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })

    const ui = await $.ui.mount({ plugin: 'cache-weather', surface, component: 'PromptHint', props: PROPS })
    const drawn = JSON.stringify(await ui.drawn())

    expect(drawn).toContain('cache ░░░░░░░░░░ –')
    expect(drawn).toContain('auto mode on')
  })
}

const TRANSCRIPT = '/tmp/session.jsonl'

const writeLine = (ttl: '1h' | '5m') =>
  JSON.stringify({
    type: 'assistant',
    message: {
      usage: {
        cache_creation: { ephemeral_1h_input_tokens: ttl === '1h' ? 90 : 0, ephemeral_5m_input_tokens: ttl === '5m' ? 90 : 0 },
      },
    },
  })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the TTL counts down from the request and turns red once expired`, async ($, on) => {
    const clock = mock.clock(on)
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })
    on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
    on('classic.Stop', () => ({}))
    on('fs.stat', () => ({ value: { kind: 'file', size: 100, mtimeMs: 0, isLink: false } }))
    on('fs.read', () => ({ value: writeLine('5m') }))
    // The response takes 30 seconds to stream after the request reached the cache.
    on('turn.step', async function* ($, e) {
      await clock.sleep(30_000)

      return { turnId: e.turnId, index: e.index, answer: 'done', toolUses: [], stopReason: 'end_turn', usage: USAGE }
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    // Starts the timer that redraws the countdown.
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const step = $.turn.step({ turnId: 't1', index: 0, model: 'test', messageCount: 1 })
    const drained = (async () => {
      for await (const _ of step) {
      }
    })()
    await clock.advance(30_000)
    await drained
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 30_000, reason: 'answer', isAborted: false, usage: USAGE })
    await $.classic.Stop({ transcript_path: TRANSCRIPT, stop_hook_active: false })

    const ui = await $.ui.mount({ plugin: 'cache-weather', surface, component: 'PromptHint', props: PROPS })

    expect(JSON.stringify(await ui.drawn())).toContain('5m left')

    // Five minutes after the request was sent, not after the answer ended.
    await clock.advance(4.5 * 60_000)

    const drawn = JSON.stringify(await ui.drawn())

    expect(drawn).toContain('expired')
    expect(drawn).toContain('"error"')
  })

  test(`${surface}: a narrow terminal gets the bare row`, async ($, on) => {
    mock.clock(on)
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })
    on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, reason: 'answer', isAborted: false, usage: USAGE })

    const ui = await $.ui.mount({
      plugin: 'cache-weather',
      surface,
      component: 'PromptHint',
      props: PROPS,
      viewport: { columns: 20, rows: 20 },
    })
    const drawn = JSON.stringify(await ui.drawn())

    expect(drawn).not.toContain('cache ')
    expect(drawn).toContain('90%')
  })

  test(`${surface}: a /clear empties the row until the next turn`, async ($, on) => {
    mock.clock(on)
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })
    on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, reason: 'answer', isAborted: false, usage: USAGE })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

    const ui = await $.ui.mount({ plugin: 'cache-weather', surface, component: 'PromptHint', props: PROPS })
    const drawn = JSON.stringify(await ui.drawn())

    expect(drawn).toContain('cache ░░░░░░░░░░ –')
    expect(drawn).not.toContain('%')
  })

  test(`${surface}: a resumed session shows its transcript's figures at once`, async ($, on) => {
    mock.clock(on)
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })
    on('classic.SessionStart', () => ({}))
    on('fs.stat', () => ({ value: { kind: 'file', size: 100, mtimeMs: 0, isLink: false } }))
    on('fs.read', () => ({
      value: [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'm1',
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 90,
              cache_creation_input_tokens: 0,
              cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
            },
          },
        }),
        writeLine('1h'),
      ].join('\n'),
    }))
    await $.classic.SessionStart({ source: 'resume', transcript_path: TRANSCRIPT, seconds_since_last_response: 600 })

    const ui = await $.ui.mount({ plugin: 'cache-weather', surface, component: 'PromptHint', props: PROPS })
    const drawn = JSON.stringify(await ui.drawn())

    expect(drawn).toContain('cache ')
    expect(drawn).toContain('%')
    expect(drawn).toContain('ttl 1h')
    expect(drawn).toContain('50m left')
  })
}
