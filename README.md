<div align="center">

# claude-plugins

**Mods for the Claude Code terminal, drawn right around your prompt.**

![Claude Code mods](https://img.shields.io/badge/Claude_Code-mods-D97757?style=for-the-badge)
![Function hooks](https://img.shields.io/badge/built_on-function_hooks-8f8cf4?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-888780?style=for-the-badge)

```
●  Flashy README  Review 2/3  ×3  ✕
  ☑ Check the attribution
  ☑ Write the README
  ☐ Validate the repo
> _
☀️ cache █████████▊ 98% · session 91%   ctx █▎░░░░░░░░ 12% · 120k / 1M   ttl 1h · 54m left
⏵⏵ auto mode on (shift+tab to cycle)
```

</div>

Each plugin here is a Claude Code mod. A mod is one TypeScript hooks module (`hooks/register.tsx`) that the engine loads and calls on its own events. The repository is also a plugin marketplace, so Claude Code installs straight from this folder.

## The plugins

| Plugin | What you get | Author |
| --- | --- | --- |
| [**cache-weather**](plugins/cache-weather) | A weather report for the prompt cache, a gauge for the context window and the time the cache has left, in one row under the prompt. | Stefan Engert |
| [**savvy-progress**](plugins/savvy-progress) | A progress bar above the prompt and a live panel of every subagent. | [johnnyvizz](https://github.com/johnnyvizz) |
| [**session-watch**](plugins/session-watch) | Speaks up when the session or a subagent runs against a wall, with a sidebar on this session's agents, cache growth and tools. | Stefan Engert |

## cache-weather

The prompt cache decides how much of each request Claude Code pays for in full. cache-weather turns that into a forecast, one row above the hint line.

```
☀️ cache █████████▊ 98% · session 91%   ctx █▎░░░░░░░░ 12% · 120k / 1M   ttl 1h · 54m left
   └ last turn's hit rate     └ every turn   └ real input tokens of     └ time until the
                                               the last response          cache goes cold
```

| Hit rate | Sky | What it means |
| --- | --- | --- |
| 80% and up | ☀️ | The cache served almost everything. |
| 60% to 79% | 🌤️ | Mostly cached. |
| 40% to 59% | ☁️ | About half was paid in full. |
| 20% to 39% | 🌦️ | The cache missed more than it hit. |
| Below 20% | 🌧️ | Cold cache. Expect it after a long break, a model switch or a changed CLAUDE.md. |

The cache bar's colour follows the sky: green for ☀️ and 🌤️, yellow for ☁️, red for 🌦️ and 🌧️. The ctx bar runs the other way, because a full window is the bad case, so it turns yellow at 50% and red at 80%. The ttl text is the cache lifetime the last cache write used, `5m` or `1h`, read from the session transcript; when a response wrote with both, it shows the shorter. It counts down from when the last request that touched the cache was sent, not from when its answer finished, and turns red at `expired`, the point where the next prompt writes the cache again. Subagent turns are left out of all of it, because a subagent builds a cache of its own.

With caching working, the sky stays sunny nearly all the time: a session that keeps its cache reads 98% or more per turn. Even the first turn of a new session can be sunny, because the system prompt is still cached from an earlier one. The row is worth a look when it drops.

In a narrow terminal the row drops the token counts, then the session rate, then the bars, so it stays on one line. After `/clear` or a resume it starts over with the new conversation.

## savvy-progress

savvy-progress puts a checklist above the prompt as soon as something reports a plan to it, and keeps a panel of subagents one command away.

```
●  Flashy README  Review 2/3  ×3  ✕
  ☑ Check the attribution
  ☑ Write the README
  ◐ Validate the repo
```

- **The checklist** shows the flow's title, its phase and every planned task. A task is ticked when its subagent finished, or, with no subagent to go by, once the orchestrator counted it as accepted. `◐` marks a task whose subagent is still running. The `×3` button opens the panel, and `✕` dismisses the list. A plan reported without tasks gets a progress bar instead.
- **The panel** (`/agents-info`) lists running, finished and planned subagents with model, effort, context, an estimated cost and time.
- **Two tools** feed it. `progress` takes the plan, the phase and the accepted tasks. `step` lets a worker subagent report its own steps.

It was made for johnnyvizz's [savvy-flow](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-flow) skill, which drives the bar on its own. That skill is not part of this repository. Without it the panel still tracks every subagent, and a session can call the `progress` tool itself. This README was written that way, with the list ticking off its three steps.

## session-watch

session-watch stays quiet while a session runs normally. Its figures ride dim at the end of the hint line. When the main thread or a subagent runs against a wall, a row above the hint line names it, yellow or red, and a red one raises a toast once:

```
⚠ "fix tests" looping on Bash · ⚠ "map the repo" quiet 11m · 3 agents
```

What it looks for:

- **Stalls and hangs:** a thread quiet for 5 minutes, or a tool still running after 15.
- **Hard stops:** a response stopped at the output limit or the context window.
- **Loops:** the same call 3 times in the last 10.
- **Error storms:** more than 20% failed calls in the last 10.
- **Context trouble:** stuck at the ceiling, creeping toward it, or growing back after a compaction.
- **The plan window:** projected to run out before it resets.

`/session-watch` opens a sidebar about the current session, drawn with tokenol-style stacked bars (`█` cache read, `▓` written, `░` uncached):

- every agent with its context bar and a diagnosis in words, for example "cold start: wrote a 20k prefix, 91% of its cost" or "too small to delegate";
- cache growth request by request;
- calls, failures and time for each tool;
- request times;
- a log of what tripped.

The signals borrow ideas from [ccusage](https://github.com/ryoppippi/ccusage) and [tokenol](https://github.com/farhanferoz/tokenol). `replay/replay.py` runs the same detectors over your past transcripts. Details are in [its README](plugins/session-watch/README.md).

## Install

Add this folder as a marketplace once, then install the plugins you want:

```
claude plugin marketplace add ~/Developer/claude/claude-plugins
claude plugin install cache-weather@stefan-claude-plugins
claude plugin install savvy-progress@stefan-claude-plugins
claude plugin install session-watch@stefan-claude-plugins
```

A plugin installed from a folder marketplace is read from that folder, not from a copy. After an edit here, `/reload-plugins` in a running session loads the change.

## Develop

```
claude plugin validate plugins/<name>   # manifest, hooks module and state contract
claude plugin test plugins/<name>       # the plugin's *.test.ts files
claude plugin validate .                # the marketplace file
```

```
.claude-plugin/marketplace.json   the catalog the marketplace reads
plugins/<name>/
  .claude-plugin/plugin.json      the manifest
  hooks/hooks.json                points at the hooks module
  hooks/register.tsx              the mod itself
  types/index.d.ts                its $.state contract
```

Claude Code writes the API's type declarations into `plugins/<name>/.claude-plugin/types/` when it loads a mod from a development folder. Git ignores that folder, because each machine gets its own.

## Credits and licenses

**savvy-progress** is by [johnnyvizz](https://github.com/johnnyvizz), copied from [johnnyvizz/claude-kit](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) at commit `272a877f39b6971690e087b16a7cc3951b811e39` under the MIT license. Its copyright notice and license are in `plugins/savvy-progress/LICENSE`. The pixel crabs in its panel are, as its source says, Pixel Clawd from DockCrab (Clawdy).

This copy differs from upstream in these ways, and its version, `1.2.0+stefan.1`, says it is not upstream's `1.2.0`:

1. The Claude Code desktop app drew the bar's SVG picture as an empty box, so only the two buttons showed. The text drawing the terminal uses is now the default on every surface. A new `svg` option in `.claude-plugin/plugin.json` brings the SVG pictures back (`/plugin configure savvy-progress@stefan-claude-plugins`).
2. A plan with tasks is drawn as a checklist instead of a progress bar.
3. The bookkeeping in the `Agent` tool and `agent.spawn` hooks can no longer fail a subagent launch. A failure there now only costs the panel one update.
4. Its README links to savvy-flow on GitHub and documents the `svg` option.

`hooks/checklist.test.tsx` is new and tests the checklist and the `svg` option. Every other file matches upstream.

**cache-weather** is by Stefan Engert, under the MIT license in [`LICENSE`](LICENSE).

**session-watch** is by Stefan Engert, under the MIT license in [`plugins/session-watch/LICENSE`](plugins/session-watch/LICENSE). Its signals take ideas, not code, from [ccusage](https://github.com/ryoppippi/ccusage) by ryoppippi and [tokenol](https://github.com/farhanferoz/tokenol) by farhanferoz, both MIT-licensed.
