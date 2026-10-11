# cache-weather

A Claude Code mod that draws one row above the hint line under the prompt:

```
☀️ cache █████████▏ 91% · turn 98%   ctx █▎░░░░░░░░ 12% · 120k / 1M   ttl 1h · 54m left
```

The cache bar is the share of the session's input tokens that the prompt cache served, over every main-thread turn since the session started or the last `/clear`. That is cache reads divided by cache reads plus cache writes plus uncached input. The weather icon follows the same number: sun from 80%, then sun behind cloud from 60%, cloud from 40%, showers from 20%, and rain below. The bar is green for sun and sun behind cloud, yellow for cloud, and red for showers and rain. The turn figure is the same rate for the last turn alone, which shows a sudden miss the session rate smooths over. Subagent turns are left out, because they build a cache of their own.

The ctx bar is the context window fill after the last response. Its token count is the real input size of that response, with cached and uncached tokens counted together, out of the model's window. It is green below 50%, yellow below 80%, and red from 80%.

The ttl text is the cache lifetime the last cache write used, `5m` or `1h`. The mod reads it from the session transcript, where every response records which lifetime its cache write used. When one response wrote with both, the row shows `5m`, because that part goes cold first. It counts down from when the last request that touched the cache was sent, not from when its answer finished streaming, and shows a red `expired` once the cache has gone cold. A transcript over 4 MiB is read from its last megabyte with `tail`, which needs macOS, Linux or WSL; elsewhere the ttl text keeps its last value.

In a narrow terminal the row drops detail until it fits: first the token counts, then the turn rate, then the bars, down to `☀️ 98%   ctx 12%   54m left`.

The row is there from the start: until the first turn finishes it reads `cache ░░░░░░░░░░ –`, as it does again after `/clear`. A resumed session, from `claude --resume`, `--continue` or `/resume`, reads its figures back from the transcript and shows them at once, the countdown counted from its last response. With caching working, the sky stays sunny nearly all the time, at 90% or more over a session. The first turn of a session can be sunny too, because the system prompt is still cached from an earlier session; it rains when nothing reusable is cached, such as after a long break, a model switch or a changed CLAUDE.md.

MIT licensed, see [LICENSE](LICENSE).
