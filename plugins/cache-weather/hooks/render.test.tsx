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

  test(`${surface}: before any turn the engine's line is left alone`, async ($, on) => {
    mock.clock(on)
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })

    const ui = await $.ui.mount({ plugin: 'cache-weather', surface, component: 'PromptHint', props: PROPS })

    expect(JSON.stringify(await ui.drawn())).not.toContain('cache ')
  })
}
