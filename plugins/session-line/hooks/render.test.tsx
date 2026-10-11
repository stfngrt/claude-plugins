import { expect, test } from 'claude-code/testing'

import { baseName, describe } from './register'

const PROPS = { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on' }

test('an empty part is left out of the row', () => {
  expect(describe({ model: 'Opus', dir: 'repo', branch: '' })).toBe('Opus · repo')
  expect(baseName('/home/me/repo/')).toBe('repo')
  expect(baseName('/')).toBe('/')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: model, directory and branch sit above the engine's hint line`, async ($, on) => {
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })
    on('session.cwd', () => ({ value: '/home/me/repo' }))
    on('session.model', () => ({ value: 'Opus' }))
    on('process.run', ($, e) => ({
      value: {
        exitCode: 0,
        stdout: e.argv.includes('--show-current') ? 'main\n' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    on('classic.CwdChanged', () => ({}))
    await $.classic.CwdChanged({ old_cwd: '/home/me', new_cwd: '/home/me/repo' })

    const ui = await $.ui.mount({ plugin: 'session-line', surface, component: 'PromptHint', props: PROPS })
    const drawn = JSON.stringify(await ui.drawn())

    expect(drawn).toContain('Opus · repo · main')
    expect(drawn.indexOf('main')).toBeLessThan(drawn.indexOf('auto mode on'))
  })

  test(`${surface}: before anything is known the engine's line is left alone`, async ($, on) => {
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}</Text>
    })

    const ui = await $.ui.mount({ plugin: 'session-line', surface, component: 'PromptHint', props: PROPS })

    expect(JSON.stringify(await ui.drawn())).not.toContain(' · ')
  })
}
