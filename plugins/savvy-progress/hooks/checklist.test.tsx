import { expect, mock, test } from 'claude-code/testing'

const PLAN = {
  title: 'Flashy README',
  phase: 'delegate',
  done: 1,
  tasks: [
    { title: 'Check the attribution', tier: 'careful' },
    { title: 'Write the README', tier: 'medium', after: [1] },
  ],
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a plan with tasks draws a checklist instead of the bar`, async ($, on) => {
    mock.clock(on)
    on('tool.call', ($, e) => ({ result: String(e.tool) }))
    // A plan with tasks opens the agents panel once; nothing draws it here.
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface in this test' } }))
    await $.tool.call({ tool: 'mcp__savvy-progress__progress', tool_use_id: 'p1', ...PLAN } as never)

    const ui = await $.ui.mount({ plugin: 'savvy-progress', surface, component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } as never })
    const drawn = JSON.stringify(await ui.drawn())

    expect(drawn).toContain('☑')
    expect(drawn).toContain('Check the attribution')
    expect(drawn).toContain('☐')
    expect(drawn).toContain('Write the README')
    expect(drawn).not.toContain('░')
  })
}

const BAR = { title: 'Flashy README', phase: 'delegate', total: 3, done: 1 }

const drawBar = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) => {
  mock.clock(on)
  on('tool.call', ($, e) => ({ result: String(e.tool) }))
  await $.tool.call({ tool: 'mcp__savvy-progress__progress', tool_use_id: 'p1', ...BAR } as never)

  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } as never })

  return JSON.stringify(await ui.drawn())
}

test('desktop: the bar is text by default', async ($, on) => {
  expect(await drawBar($, on)).not.toContain('"Svg"')
})

test('desktop: the svg option brings the picture back', { options: { svg: true } }, async ($, on) => {
  expect(await drawBar($, on)).toContain('"Svg"')
})
