import type { AgentSpawnInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const USAGE = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 400, cache_read_input_tokens: 48_000, cache_creation_input_tokens: 2_000 }
const PROPS = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

// The engine beneath the plugin: each event answers as a session would.
const engine = (on: On, panes = new Set<string>()) => {
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', (_$, e) => (panes.add(e.id), { value: { isPlaced: true as const } }))
  on('ui.close', (_$, e) => (panes.delete(e.id), { value: undefined }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        {e.props.hint}
        {e.props.tail ? ` | ${e.props.tail}` : ''}
      </Text>
    )
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: USAGE }
  })
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
}

// The Agent tool call that starts the subagent.
const SPAWN: AgentSpawnInput = {
  tool_use_id: 'toolu_1',
  prompt: 'map it',
  description: 'map the repo',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
}

const PANE_PROPS = { title: 'Session watch', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const _ of stream) {
  }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: quiet while normal, a cause row once a subagent stalls`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.agent.spawn(SPAWN)
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
    await drain($.turn.step({ turnId: 's1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' }))
    await $.session.measure({ context: { tokens: 50_000, window: 1_000_000 }, rateLimits: [], cost: { usd: 1.23 }, changed: ['cost'] })

    const ui = await $.ui.mount({ plugin: 'session-watch', surface, component: 'PromptHint', props: PROPS })
    let drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('1/1 agents running')
    expect(drawn).not.toContain('$')
    expect(drawn).not.toContain('⚠')

    // Eleven quiet minutes inside the subagent: red, named, and toasted.
    await clock.advance(11 * 60_000)
    drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('⚠ \\"map the repo\\" quiet 11m')
    expect(drawn).toContain('"error"')
    expect(drawn).toContain('? for shortcuts')
  })

  test(`${surface}: the sidebar draws the agents, cache growth bars, tools and diagnosis`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.agent.spawn(SPAWN)
    for (let i = 0; i < 3; i++) await drain($.turn.step({ turnId: 't1', index: i, model: 'claude-opus-5-5', messageCount: 1 }))
    await drain($.turn.step({ turnId: 's1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' }))
    await $.turn.complete({ turnId: 's1', agentId: 'a1', answer: 'done', durationMs: 10, reason: 'answer', isAborted: false, usage: USAGE })

    const ui = await $.ui.mount({
      plugin: 'session-watch',
      surface,
      component: 'Pane',
      requestId: 'session-watch',
      props: { title: 'Session watch', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    const drawn = JSON.stringify(await ui.drawn())
    for (const part of ['Agents', 'main thread', 'map the repo', 'Explore', 'Cache growth per request', '#3', 'Tools', 'Context and requests', 'cache read']) {
      expect(drawn).toContain(part)
    }
    expect(drawn).toContain('✓')
  })

  test(`${surface}: a session already under way is filled in from its transcript`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    engine(on)
    on('session.id', () => ({ value: 'resumed' }))
    on('session.usage', () => ({ value: { startedAt: 400_000, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 4.56 } } }))
    on('session.messages', (_$, e) => ({
      value: e.agentId === 'a9'
        ? [{ role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'u3', tool: 'Grep', input: {}, text: 'ok' }] }]
        : [
            { role: 'user' as const, text: 'go', toolUses: [] },
            {
              role: 'assistant' as const,
              text: '',
              toolUses: [
                { tool_use_id: 'u1', tool: 'Bash', input: { command: 'ls' }, text: 'boom', isError: true as const },
                { tool_use_id: 'u2', tool: 'Agent', input: { description: 'old survey', subagent_type: 'Explore' }, text: 'done', agentId: 'a9', durationMs: 60_000 },
              ],
            },
          ],
    }))
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'session-watch', surface, component: 'Pane', requestId: 'session-watch', props: PANE_PROPS })
    const drawn = JSON.stringify(await ui.drawn())
    for (const part of ['"3"," tool calls"," (1 failed)"', '"1"," agents"', 'old survey', 'Explore', 'read from the transcript', 'Grep', '$4.56']) {
      expect(drawn).toContain(part)
    }
    // An old failure is counted, not alarmed on.
    expect(drawn).not.toContain('⚠')
  })

  test(`${surface}: the row expands into the sidebar and its button closes it again`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    const panes = new Set<string>()
    engine(on, panes)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.agent.spawn(SPAWN)
    await drain($.turn.step({ turnId: 's1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' }))
    await clock.advance(11 * 60_000)

    const row = await $.ui.mount({ plugin: 'session-watch', surface, component: 'PromptHint', props: PROPS })
    await row.press({ key: 'expand' })
    expect(panes.has('session-watch')).toBe(true)

    const pane = await $.ui.mount({ plugin: 'session-watch', surface, component: 'Pane', requestId: 'session-watch', props: PANE_PROPS })
    await pane.press({ key: 'close' })
    expect(panes.has('session-watch')).toBe(false)
  })

  test(`${surface}: nothing is drawn before the first request`, async ($, on) => {
    mock.clock(on)
    engine(on)
    const ui = await $.ui.mount({ plugin: 'session-watch', surface, component: 'PromptHint', props: PROPS })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('? for shortcuts')
    expect(drawn).not.toContain('$')
  })
}
