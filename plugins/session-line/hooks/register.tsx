import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Line } from '../types'

const line = atom({ plugin: 'session-line', key: 'line' } as const, null)

export const describe = (one: Line): string => [one.model, one.dir, one.branch].filter(part => part !== '').join(' · ')

// The last name of a path; the root stays "/".
export const baseName = (path: string): string => path.split('/').filter(part => part !== '').pop() ?? '/'

// The checked-out branch, or nothing outside a repository and on a detached HEAD.
async function readBranch($: EngineInterface, cwd: string): Promise<string> {
  try {
    const git = await $.process.run(['git', '--no-optional-locks', 'branch', '--show-current'], { cwd })

    return git.exitCode === 0 ? git.stdout.trim() : ''
  } catch {
    return ''
  }
}

async function refresh($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const found: Line = { model: await $.session.model(), dir: baseName(cwd), branch: await readBranch($, cwd) }

  await update($, line, () => found)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)

    return started
  })

  // A turn may have switched the branch or moved the session. These hooks only
  // listen, so a failure lets the event go on.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await refresh($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostModelSwitch', async ($, e, next) => {
    await refresh($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.CwdChanged', async ($, e, next) => {
    await refresh($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // The row sits above the engine's hint line.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineLine = await next(e)
    const known = await read($, line)

    if (known === null) {
      return engineLine
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text dimColor>{describe(known)}</Text>
        {engineLine}
      </Box>
    )
  })
}
