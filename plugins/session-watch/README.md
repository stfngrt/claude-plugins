# session-watch

A Claude Code mod that watches a session, subagents included, for the moment something runs against a wall. It says nothing while all is normal.

## Under the prompt

While all is normal, the figures ride dim at the end of the hint line, so they take no row of their own and cache-weather's row keeps its place:

```
? for shortcuts  2/3 agents running · ctx 18% · 41 tools, 2 failed · 5h 34% (2h 45m left)
```

When something drifts, it gets a row above the hint line that names the cause, yellow or red:

```
⚠ "fix tests" looping on Bash · ⚠ "map the repo" quiet 11m · 3 agents
```

A narrow terminal drops the detail first. Each incident that turns red also raises one toast. The desktop app has no hint-line tail, so there the figures always get a dim row.

That row ends in a **Details** button that opens the sidebar. The quiet tail on the terminal has no room for one, so there `/session-watch` opens it.

## The sidebar: `/session-watch`

`/session-watch` opens and closes it, and so do the **Details** button under the prompt and the **Close** button at the top of the sidebar (the desktop app draws it as its own close control; `q` presses it while the sidebar has the focus). The sidebar covers this session only; overall spend is left to an external tool. It draws stacked bars the way tokenol does, with a legend: `█` read from the cache, `▓` written to it, `░` uncached, `▒` output.

- **Header:** the session's time, requests, tool calls and failures, agents, and its tokens split into read, written, uncached and output with the overall hit rate. Below that, the 5h plan window: how full it is, when it resets, and when it would run out at this pace.
- **Agents:** the main thread and every subagent as a tree, nested subagents under their parent. Each block shows:
  - status, type, model and effort, request and tool counts, and error rate;
  - its current context as a stacked bar, with the share of its window and its hit rate;
  - the tool it is running, and for how long;
  - wall warnings (`⚠`), then a diagnosis in words (`·` notes, `▲` problems):
    - a cold start and how much of the agent's cost it was;
    - agents started together that each wrote the same prefix, so none could reuse another's cache;
    - setup that outweighed the work ("too small to delegate");
    - cache rebuilds mid-run;
    - most of its time spent waiting on tools;
    - failed calls;
    - most of its cost going to cache writes.
- **Cache growth per request:** the last 8 requests of the main thread and the last 6 of each agent, one stacked bar each. Beside each bar: the input size, its growth since the previous request, the share read from the cache, how long the request took, and `rebuilt` where the cache was written over.
- **Tools:** calls per tool, failures in red, the time each tool ran, and how many threads used it.
- **Context and requests:** for each thread, context growth per request, average and slowest request time, and total tool time.
- **Tripped:** what turned yellow or red, and when.

## What it looks for

| Signal | Yellow | Red |
| --- | --- | --- |
| Stalled: running, nothing in flight | 5 min quiet | 10 min |
| A tool that hangs | 15 min | 30 min |
| Wall: a response stopped at `max_tokens` or the context window | | at once |
| Loop: the same tool with the same arguments in the last 10 calls | a failing call retried | 3 times |
| Tool error storm: failed calls among the last 10 (a refused permission doesn't count) | over 20% | 50% |
| Context ceiling: requests in a row at 90% of the window or more | 1 | 20 |
| Context creep: 2k tokens or more of growth per request, once past 500k | ✓ | |
| Re-inflation: back to 80% of the size before compacting, within 30 requests | ✓ | |
| Plan window: the five-hour window runs out at this pace before it resets | ✓ | within 30 min |

These only show in the sidebar, among the diagnosis:

- context read per output token above 400:1;
- cache reuse under 20 reads per write;
- subagents above 40% of the cost;
- a subagent costing more than 2× the median of its siblings.

They describe how a session spends, not whether it is stuck.

The thresholds are fixed and there are no settings. Most come from tokenol. The rest were checked against a replay of past sessions (below). The mod keeps nothing between sessions.

## A session already under way

When the mod starts watching a conversation it has not seen (it was enabled partway through, or the session was resumed), it reads the transcript once through `$.session.messages()`, main thread and subagents. That fills in the tool calls, failures and agents from before. Claude Code's own cost, the plan window and the context size come from `$.session.usage()` and are complete anyway. The transcript has no tokens and no times, so the cache bars and timings start when the mod started watching, and the sidebar says so. The older calls are counted, but they never reach the windows the alarms read, so an old loop raises nothing.

## Cost figures

They are small on purpose, since overall spend belongs in a tool built for it:

- **The session total** in the header is Claude Code's own figure from `session.measure`. A figure marked `~` is an estimate.
- **Per-agent costs** (`~`) are tokens times a built-in price table, checked against [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-10. They serve the diagnosis, for example "the cold start was 91% of its cost".
- **Cache writes:** the engine doesn't say which lifetime a write used. Claude Code writes the main thread's with 1h and a subagent's with 5m, and they are priced that way.

The mod makes no network requests.

## Replay

`replay/replay.py` reads your past transcripts (`~/.claude/projects/**/*.jsonl`, main threads and subagents, repeated lines deduped on `message.id` + `requestId`). It reports the distribution of each measure, and per session which signals would have fired and when:

```
python3 -I plugins/session-watch/replay/replay.py [--json findings.json]
```

Two things it found about transcripts:

- About one response in six is saved with the usage from the start of its stream, so its output count is only a few tokens. The replay leaves those out of output-based ratios.
- Transcripts miss the Haiku side calls. So the replay's cost comes out a median of 91% of Claude Code's own figure, and as low as 64%.

The live mod has neither problem.

## Beside savvy-progress

savvy-progress (`/agents-info`) shows the flow's plan, progress and crew. session-watch shows whether the session is healthy. The two run side by side and share no pane. session-watch's agent rows carry flags and trajectories, not savvy's progress bars.

## Credits

The signals borrow ideas, not code, from two MIT-licensed tools that read the logs after the fact:

- [ccusage](https://github.com/ryoppippi/ccusage) by ryoppippi: the plan window's time left and projection, and preferring Claude Code's own cost figure over a computed one.
- [tokenol](https://github.com/farhanferoz/tokenol) by farhanferoz: context read per output token, cache reuse, context creep, the tool error storm, subagent share, the context ceiling plateau, re-inflation after compaction, and splitting cost across tool calls.

Install instructions are in the [repository README](../../README.md).
