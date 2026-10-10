# cache-weather

A Claude Code mod that draws one row above the hint line under the prompt:

```
☀️ cache █████████▊ 98% · session 91%   ctx █▎░░░░░░░░ 12% · 120k / 1M   ttl 1h · 54m left
```

The cache bar is the share of the last turn's input tokens that the prompt cache served. That is cache reads divided by cache reads plus cache writes plus uncached input. The weather icon follows the same number: sun from 80%, then sun behind cloud, cloud, showers, and rain below 20%. The session figure is the same rate over every main-thread turn so far. Subagent turns are left out, because they build a cache of their own.

The ctx bar is the context window fill after the last response. Its token count is the real input size of that response, with cached and uncached tokens counted together, out of the model's window. It is green below 50%, yellow below 80%, and red from 80%.

The ttl text is the cache lifetime the last cache write used, `5m` or `1h`. The mod reads it from the session transcript, where every response records which lifetime its cache write used. It counts down from the end of the last turn and shows a red `expired` once the cache has gone cold.

The row appears after the first turn finishes. The first turn of a session usually shows rain, because that turn writes the cache instead of reading it.
