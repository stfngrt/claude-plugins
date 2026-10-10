#!/usr/bin/env python3
"""Replays past Claude Code transcripts through session-watch's detectors.

Reads ~/.claude/projects/**/*.jsonl (the main thread and each subagent's sidechain),
dedupes repeated lines on message.id + requestId, prices every request, and reports
per session which signals would have fired and when, plus the distribution of each
measure across all sessions, so the thresholds can be picked from real data.

    python3 -I replay.py [--root ~/.claude/projects] [--json out.json]

Standard library only. Prices are USD per million tokens, checked against
https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-10.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

# input, 5m write, 1h write, cache read, output
PRICES: list[tuple[str, tuple[float, float, float, float, float]]] = [
    (r"fable-5-1|mythos-5-1", (10, 12.5, 20, 0.25, 50)),
    (r"fable|mythos", (10, 12.5, 20, 1, 50)),
    (r"opus-5-5", (4, 5, 8, 0.20, 20)),
    (r"opus-4(?:-[01])?(?:-\d{8})?(?![-\d])", (15, 18.75, 30, 1.5, 75)),
    (r"opus", (5, 6.25, 10, 0.5, 25)),
    (r"sonnet-5-5", (2, 2.5, 4, 0.10, 10)),
    (r"sonnet-5", (2, 2.5, 4, 0.20, 10)),
    (r"sonnet", (3, 3.75, 6, 0.30, 15)),
    (r"haiku-5-5", (0.10, 0.125, 0.20, 0.01, 0.50)),
    (r"haiku-4-5", (1, 1.25, 2, 0.10, 5)),
    (r"haiku", (0.8, 1, 1.6, 0.08, 4)),
]
HAIKU55_LONG = (0.50, 0.625, 1, 0.05, 2.50)


def price_of(model: str) -> tuple[float, float, float, float, float] | None:
    for pattern, p in PRICES:
        if re.search(pattern, model):
            return p
    return None


def window_of(model: str) -> int:
    return 200_000 if "haiku-4" in model else 1_000_000


@dataclass
class Request:
    at: datetime
    agent: str  # "main" or the subagent's id
    model: str
    uncached: int
    read: int
    write5m: int
    write1h: int
    output: int
    cost: float
    tools: list[tuple[str, str, str]] = field(default_factory=list)  # (id, name, args key)
    # The transcript kept only the usage from the start of the stream (no stop_reason on any
    # line), so output is a few tokens instead of the real count. Live turn.step results do not
    # have this problem; the replay leaves these out of output-based ratios.
    partial: bool = True

    @property
    def context(self) -> int:
        return self.uncached + self.read + self.write5m + self.write1h


def cost_of(model: str, u: dict) -> tuple[float, int, int, int, int, int]:
    uncached = u.get("input_tokens") or 0
    read = u.get("cache_read_input_tokens") or 0
    output = u.get("output_tokens") or 0
    created = u.get("cache_creation_input_tokens") or 0
    split = u.get("cache_creation") or {}
    w1h = split.get("ephemeral_1h_input_tokens") or 0
    w5m = split.get("ephemeral_5m_input_tokens") or 0
    if w1h + w5m != created:
        w5m = max(0, created - w1h)  # no split recorded: charge the rest as 5m writes
    p = price_of(model)
    if p is None:
        return 0.0, uncached, read, w5m, w1h, output
    if "haiku-5-5" in model and uncached + read + w5m + w1h > 100_000:
        p = HAIKU55_LONG
    i, c5, c1, r, o = p
    usd = (uncached * i + w5m * c5 + w1h * c1 + read * r + output * o) / 1e6
    if u.get("speed") == "fast":
        usd *= 2
    return usd, uncached, read, w5m, w1h, output


def args_key(name: str, args: dict) -> str:
    """The whole call, so two edits of one file with different text are two calls."""
    if name == "Bash":
        return str(args.get("command", ""))
    return json.dumps({k: v for k, v in args.items() if k != "description"}, sort_keys=True)


def ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


@dataclass
class Agent:
    id: str
    type: str = "main"
    description: str = ""
    requests: list[Request] = field(default_factory=list)
    calls: list[tuple[datetime, str, str, bool]] = field(default_factory=list)  # (at, tool, args, is_error)

    @property
    def cost(self) -> float:
        return sum(r.cost for r in self.requests)


@dataclass
class Session:
    id: str
    project: str
    agents: dict[str, Agent] = field(default_factory=dict)
    compacts: list[tuple[datetime, int, int]] = field(default_factory=list)  # (at, pre, post)
    host_cost: float | None = None

    def all_requests(self) -> list[Request]:
        return sorted((r for a in self.agents.values() for r in a.requests), key=lambda r: r.at)

    @property
    def cost(self) -> float:
        return sum(a.cost for a in self.agents.values())


def read_file(path: Path, session: Session, default_agent: str, seen: set) -> None:
    results: dict[str, bool] = {}
    pending: list[tuple[datetime, str, str, str, str]] = []  # (at, agent, tool_use_id, name, args)
    by_key: dict[tuple, Request] = {}
    for line in path.open(encoding="utf-8", errors="replace"):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = d.get("type")
        if t == "cost-state" and default_agent == "main":
            session.host_cost = d.get("totalCostUSD", session.host_cost)
        elif t == "system" and d.get("subtype") == "compact_boundary":
            m = d.get("compactMetadata") or {}
            session.compacts.append((ts(d["timestamp"]), m.get("preTokens") or 0, m.get("postTokens") or 0))
        elif t == "user":
            content = (d.get("message") or {}).get("content")
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_result":
                        results[c.get("tool_use_id", "")] = bool(c.get("is_error"))
        elif t == "assistant":
            m = d.get("message") or {}
            model = m.get("model") or ""
            if model == "<synthetic>" or "usage" not in m:
                continue
            agent = d.get("agentId") or default_agent
            key = (m.get("id"), d.get("requestId"))
            req = by_key.get(key)
            if req is not None and (m["usage"].get("output_tokens") or 0) > req.output:
                # A response spans one line per content block; the later lines carry the final output count.
                req.cost, req.uncached, req.read, req.write5m, req.write1h, req.output = cost_of(model, m["usage"])
            if req is None:
                if key in seen:
                    continue
                seen.add(key)
                usd, unc, rd, w5, w1, out = cost_of(model, m["usage"])
                req = Request(ts(d["timestamp"]), agent, model, unc, rd, w5, w1, out, usd)
                by_key[key] = req
                session.agents.setdefault(agent, Agent(agent)).requests.append(req)
            if m.get("stop_reason") is not None:
                req.partial = False
            for c in m.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_use":
                    name = c.get("name", "")
                    a = args_key(name, c.get("input") or {})
                    req.tools.append((c.get("id", ""), name, a))
                    pending.append((req.at, agent, c.get("id", ""), name, a))
    for at, agent, tid, name, a in pending:
        session.agents.setdefault(agent, Agent(agent)).calls.append((at, name, a, results.get(tid, False)))


def load(root: Path) -> list[Session]:
    sessions = []
    for main in sorted(root.glob("*/*.jsonl")):
        s = Session(main.stem, main.parent.name.replace("-Users-stefan-Developer-", ""))
        seen: set = set()
        read_file(main, s, "main", seen)
        sub = main.parent / main.stem / "subagents"
        for f in sorted(sub.glob("agent-*.jsonl")) if sub.is_dir() else []:
            aid = f.stem.removeprefix("agent-")
            meta = f.with_suffix(".meta.json")
            agent = s.agents.setdefault(aid, Agent(aid))
            if meta.exists():
                try:
                    mj = json.loads(meta.read_text())
                    agent.type, agent.description = mj.get("agentType", "?"), mj.get("description", "")
                except json.JSONDecodeError:
                    pass
            read_file(f, s, aid, seen)
        for a in s.agents.values():
            a.requests.sort(key=lambda r: r.at)
            a.calls.sort(key=lambda c: c[0])
            if a.id != "main" and a.type == "main":
                a.type = "subagent"
        if any(a.requests for a in s.agents.values()):
            sessions.append(s)
    return sessions


# ---------------------------------------------------------------------------
# Measures: each returns a list of (time, value, note) samples for one session.

def burn_samples(s: Session, minutes: int = 10) -> list[tuple[datetime, float]]:
    """$/hr over the trailing window, sampled at each request once the session has run a full window."""
    reqs = s.all_requests()
    out, lo, acc = [], 0, 0.0
    span = timedelta(minutes=minutes)
    for hi, r in enumerate(reqs):
        acc += r.cost
        while reqs[lo].at < r.at - span:
            acc -= reqs[lo].cost
            lo += 1
        if r.at - reqs[0].at >= span:
            out.append((r.at, acc * 60 / minutes))
    return out


def ctx_per_output(a: Agent, n: int = 10) -> list[tuple[datetime, float]]:
    """tokenol's Ctx: cache reads per output token, over the last n requests with a final usage."""
    done = [r for r in a.requests if not r.partial]
    out = []
    for i in range(n - 1, len(done)):
        w = done[i - n + 1 : i + 1]
        o = sum(r.output for r in w)
        if o:
            out.append((w[-1].at, sum(r.read for r in w) / o))
    return out


def creep(a: Agent, n: int = 10, floor: int = 0) -> list[tuple[datetime, float]]:
    """Average context growth per request over the last n requests, compactions excluded,
    sampled only once the context holds at least `floor` tokens (tokenol gates on 500k)."""
    out = []
    for i in range(n, len(a.requests)):
        w = a.requests[i - n : i + 1]
        deltas = [b.context - x.context for x, b in zip(w, w[1:])]
        if min(deltas) < -20_000 or w[-1].context < floor:  # a compaction in the window, or still small
            continue
        out.append((w[-1].at, statistics.mean(deltas)))
    return out


def plateau(a: Agent, share: float = 0.9) -> int:
    best = run = 0
    for r in a.requests:
        run = run + 1 if r.context >= share * window_of(r.model) else 0
        best = max(best, run)
    return best


def error_windows(a: Agent, n: int = 10) -> list[tuple[datetime, float]]:
    out = []
    for i in range(n - 1, len(a.calls)):
        w = a.calls[i - n + 1 : i + 1]
        out.append((w[-1][0], sum(c[3] for c in w) / n))
    return out


def loops(a: Agent, n: int = 10) -> list[tuple[datetime, int, str, str, bool]]:
    """At each call: the most repeated (tool, args) in the last n calls, and whether it failed every time."""
    out = []
    for i in range(len(a.calls)):
        w = a.calls[max(0, i - n + 1) : i + 1]
        cnt = Counter((c[1], c[2]) for c in w)
        (tool, args), k = cnt.most_common(1)[0]
        failing = all(c[3] for c in w if (c[1], c[2]) == (tool, args))
        out.append((w[-1][0], k, tool, args, failing))
    return out


def gaps(a: Agent) -> list[float]:
    """Minutes between consecutive requests of one subagent."""
    return [(b.at - x.at).total_seconds() / 60 for x, b in zip(a.requests, a.requests[1:])]


def reinflation(s: Session) -> list[tuple[datetime, float, int]]:
    """For each compaction: how far the main thread grew back toward the pre-compaction size, and in how many requests."""
    main = s.agents.get("main")
    if not main:
        return []
    out = []
    for at, pre, post in s.compacts:
        after = [r for r in main.requests if r.at > at]
        if not after or not pre:
            continue
        peak_i = max(range(min(len(after), 30)), key=lambda i: after[i].context)
        # tokenol: re-inflation when it climbs back to >= 80% of the peak before compacting
        out.append((at, after[peak_i].context / pre, peak_i + 1))
    return out


def blocks(sessions: list[Session]) -> list[tuple[datetime, float, float]]:
    """ccusage-style 5-hour blocks over all sessions: start floored to the hour; a gap of 5h starts a new one."""
    reqs = sorted((r for s in sessions for r in s.all_requests()), key=lambda r: r.at)
    out: list[list] = []
    for r in reqs:
        if not out or r.at >= out[-1][0] + timedelta(hours=5) or r.at - out[-1][2] >= timedelta(hours=5):
            out.append([r.at.replace(minute=0, second=0, microsecond=0), 0.0, r.at])
        out[-1][1] += r.cost
        out[-1][2] = r.at
    return [(b[0], b[1], (b[2] - b[0]).total_seconds() / 3600) for b in out]


def pct(xs: list[float], qs=(50, 75, 90, 95, 99)) -> str:
    if not xs:
        return "n/a"
    xs = sorted(xs)
    parts = []
    for q in qs:
        k = min(len(xs) - 1, max(0, math.ceil(q / 100 * len(xs)) - 1))
        parts.append(f"p{q} {xs[k]:,.2f}")
    return f"n={len(xs):,}  min {xs[0]:,.2f}  " + "  ".join(parts) + f"  max {xs[-1]:,.2f}"


def hist(xs: list[float], edges: list[float], unit: str = "") -> str:
    rows, total = [], len(xs) or 1
    for lo, hi in zip(edges, edges[1:] + [math.inf]):
        k = sum(lo <= x < hi for x in xs)
        label = f"{lo:g}–{hi:g}{unit}" if hi != math.inf else f"≥{lo:g}{unit}"
        rows.append(f"    {label:>14} {k:6,}  {'█' * round(40 * k / total)}")
    return "\n".join(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path.home() / ".claude/projects"))
    ap.add_argument("--json", help="also write the per-session findings here")
    ap.add_argument("--stall-min", type=float, default=5)
    opts = ap.parse_args()

    sessions = load(Path(opts.root))
    p = print
    p(f"# session-watch replay: {len(sessions)} sessions under {opts.root}\n")

    # --- cost calibration against Claude Code's own figure
    pairs = [(s.cost, s.host_cost) for s in sessions if s.host_cost]
    if pairs:
        ratios = [c / h for c, h in pairs if h > 0.01]
        p("## Cost estimate vs Claude Code's own figure (cost-state lines)")
        p(f"  sessions with both: {len(pairs)}; estimate/host ratio: {pct(ratios, (10, 50, 90))}")
        p("  (the host figure stops at the last cost-state line and may miss subagents or later requests)\n")

    all_burn = [v for s in sessions for _, v in burn_samples(s)]
    per_session_median = [statistics.median([v for _, v in b]) for s in sessions if (b := burn_samples(s))]
    usual = statistics.median(per_session_median) if per_session_median else 0
    p("## Burn rate, $/hr over the trailing 10 minutes (sampled at every request)")
    p("  " + pct(all_burn))
    p(hist(all_burn, [0, 1, 2, 5, 10, 20, 40, 80], " $/h"))
    p(f"  'usual' rate = median of per-session medians: ${usual:.2f}/hr")
    for k in (2, 3, 5, 8):
        n = sum(any(v >= k * usual for _, v in burn_samples(s)) for s in sessions)
        p(f"  sessions that ever hit {k}× usual (${k * usual:.2f}/hr): {n}/{len(sessions)}")
    p("")

    p("## 5-hour blocks (all sessions on one timeline)")
    bl = blocks(sessions)
    for start, usd, hrs in sorted(bl, key=lambda b: -b[1])[:8]:
        p(f"  {start:%Y-%m-%d %H:%M}  ${usd:7.2f}  active {hrs:.1f}h")
    p(f"  blocks: {len(bl)}; {pct([b[1] for b in bl], (50, 90))}\n")

    rq_all = [r for s in sessions for r in s.all_requests()]
    p(f"## Context read per output token (cache reads / output, 10 complete requests, every thread)")
    p(f"  responses saved without their final usage (left out): {sum(r.partial for r in rq_all)}/{len(rq_all)}")
    cpo = [v for s in sessions for a in s.agents.values() for _, v in ctx_per_output(a)]
    p("  " + pct(cpo))
    p(hist(cpo, [0, 100, 200, 400, 800, 1600, 3200], ":1"))
    for k in (400, 800, 1600):
        n = sum(any(v > k for _, v in ctx_per_output(a)) for s in sessions for a in s.agents.values())
        p(f"  threads ever above {k}:1: {n}")
    p("")

    p("## Cache reuse (reads per write, per session)")
    reuse = []
    for s in sessions:
        rq = s.all_requests()
        w = sum(r.write5m + r.write1h for r in rq)
        if w:
            reuse.append(sum(r.read for r in rq) / w)
    p("  " + pct(reuse, (10, 25, 50, 75)))
    p(f"  sessions under 50:1: {sum(x < 50 for x in reuse)}/{len(reuse)}; under 20:1: {sum(x < 20 for x in reuse)}\n")

    threads = [a for s in sessions for a in s.agents.values() if a.requests]
    p("## Context creep: mean growth per request over 10 requests (k tokens)")
    for floor in (0, 100_000, 200_000, 500_000):
        cr = [v / 1000 for a in threads for _, v in creep(a, floor=floor)]
        p(f"  context ≥{floor // 1000}k: " + pct(cr, (50, 90, 99)))
        p("      threads ever ≥2k/≥3k/≥4k per request: " + " / ".join(
            str(sum(any(v >= k * 1000 for _, v in creep(a, floor=floor)) for a in threads)) for k in (2, 3, 4)) + f" of {len(threads)}")
    p(f"  largest context seen: {max(r.context for r in rq_all):,} tokens")
    p("")

    p("## Context ceiling: longest run of requests at ≥90% / ≥70% of the window")
    pl90 = [plateau(a) for s in sessions for a in s.agents.values()]
    pl70 = [plateau(a, 0.7) for s in sessions for a in s.agents.values()]
    p(f"  ≥90%: threads with any: {sum(x > 0 for x in pl90)}, with ≥20: {sum(x >= 20 for x in pl90)}; max run {max(pl90, default=0)}")
    p(f"  ≥70%: threads with any: {sum(x > 0 for x in pl70)}, with ≥20: {sum(x >= 20 for x in pl70)}; max run {max(pl70, default=0)}\n")

    p("## Re-inflation after compaction (peak in the next 30 requests / size before compacting)")
    ri = [x for s in sessions for x in reinflation(s)]
    p(f"  compactions: {len(ri)}; " + pct([x[1] for x in ri], (50, 90)) + f"; ≥80% of the old size: {sum(x[1] >= 0.8 for x in ri)}" if ri else "  no compactions")
    p("")

    p("## Tool error rate in 10-call windows (per thread)")
    ew = [v for s in sessions for a in s.agents.values() for _, v in error_windows(a)]
    p("  " + pct(ew, (50, 90, 95, 99)))
    tl = [(sum(c[3] for c in a.calls), len(a.calls)) for s in sessions for a in s.agents.values() if len(a.calls) >= 10]
    p(f"  tokenol verdict (≥10 calls, >30% errors over the whole thread): {sum(e / n > 0.3 for e, n in tl)}/{len(tl)} threads; whole-thread rates: " + pct([e / n for e, n in tl], (50, 90)))
    for k in (0.2, 0.3, 0.4, 0.5):
        n = sum(any(v > k for _, v in error_windows(a)) for s in sessions for a in s.agents.values())
        p(f"  threads ever above {k:.0%}: {n}")
    p("")

    p("## Repeated calls: same tool + same arguments within the last 10 calls")
    lp = [(s, a, x) for s in sessions for a in s.agents.values() for x in loops(a)]
    for k in (2, 3, 4, 5):
        n = len({(s.id, a.id) for s, a, x in lp if x[1] >= k})
        nf = len({(s.id, a.id) for s, a, x in lp if x[1] >= k and x[4]})
        p(f"  threads with a repeat ≥{k}×: {n} (all failing: {nf})")
    worst = Counter()
    for s, a, x in lp:
        if x[1] >= 3:
            worst[(s.id[:8], a.id[:10], x[2], x[3][:90], x[4])] = max(worst[(s.id[:8], a.id[:10], x[2], x[3][:90], x[4])], x[1])
    for (sid, aid, tool, args, failing), k in worst.most_common(12):
        p(f"    {sid} {aid:<10} {k}× {tool}{' (failing)' if failing else ''}: {args}")
    p("")

    p("## Subagents")
    subs = [(s, a) for s in sessions for a in s.agents.values() if a.id != "main" and a.requests]
    p(f"  subagent runs: {len(subs)} in {len({s.id for s, _ in subs})} sessions")
    shares = [sum(a.cost for a in s.agents.values() if a.id != "main") / s.cost for s in sessions if s.cost and len(s.agents) > 1]
    p("  share of session cost: " + pct([x * 100 for x in shares], (50, 75, 90)) + " (%)")
    p(f"  sessions with subagent share >40%: {sum(x > 0.4 for x in shares)}/{len(shares)}")
    g = [x for _, a in subs for x in gaps(a)]
    p("  minutes between a subagent's consecutive requests: " + pct(g, (50, 90, 99)))
    for k in (2, 5, 10):
        p(f"    gaps ≥{k} min: {sum(x >= k for x in g)} in {len({(s.id, a.id) for s, a in subs if any(x >= k for x in gaps(a))})} runs")
    exp = []
    for s in sessions:
        sib = [a for a in s.agents.values() if a.id != "main" and a.requests]
        if len(sib) >= 3:
            med = statistics.median(a.cost for a in sib)
            exp += [(s, a, a.cost / med) for a in sib if med]
    p(f"  runs costing >2× the median of their siblings (sessions with ≥3 subagents): {sum(x[2] > 2 for x in exp)}/{len(exp)}")
    for s, a, k in sorted(exp, key=lambda x: -x[2])[:6]:
        p(f"    {s.id[:8]} {a.type:<16} {k:4.1f}× ${a.cost:.2f} {a.description[:50]}")
    p("")

    # --- per-session timeline of what would have fired with the starting thresholds
    p("## Per session: what would have fired (starting thresholds)")
    p(f"  burn ≥3×/5× usual · ctx:out >400 · error >20%/10 calls · repeat ≥3 · creep ≥2k/req · plateau 20@90% · sub share >40% · stall ≥{opts.stall_min:g} min")
    findings = []
    for s in sorted(sessions, key=lambda s: -s.cost):
        f: list[tuple[datetime, str]] = []
        for at, v in burn_samples(s):
            lvl = "red" if v >= 5 * usual else "yellow" if v >= 3 * usual else None
            if lvl:
                f.append((at, f"burn {lvl} ${v:.2f}/hr"))
        for a in s.agents.values():
            name = "main" if a.id == "main" else f"{a.type}:{a.description[:24]}"
            first = lambda xs: xs[0] if xs else None
            if (x := first([t for t, v in ctx_per_output(a) if v > 400])):
                f.append((x, f"{name} ctx:out >400"))
            if (x := first([t for t, v in error_windows(a) if v > 0.2])):
                f.append((x, f"{name} error storm"))
            if (x := first([(t, tool) for t, k, tool, _, _ in loops(a) if k >= 3])):
                f.append((x[0], f"{name} repeat ≥3 on {x[1]}"))
            if (x := first([t for t, v in creep(a, floor=200_000) if v >= 2000])):
                f.append((x, f"{name} creep ≥2k/req past 200k"))
            if plateau(a) >= 20:
                f.append((a.requests[-1].at, f"{name} ceiling plateau"))
            if a.id != "main":
                for (x, b) in zip(a.requests, a.requests[1:]):
                    if (b.at - x.at).total_seconds() >= opts.stall_min * 60:
                        f.append((x.at, f"{name} quiet {(b.at - x.at).total_seconds() / 60:.0f} min"))
                        break
        if s.cost and len(s.agents) > 1:
            share = sum(a.cost for a in s.agents.values() if a.id != "main") / s.cost
            if share > 0.4:
                f.append((s.all_requests()[-1].at, f"subagent share {share:.0%}"))
        # Collapse: keep the first time each kind fired, plus a count.
        kinds: dict[str, list[datetime]] = defaultdict(list)
        for at, what in f:
            kinds[re.sub(r"\$[\d.]+/hr", "", what).strip()].append(at)
        start = s.all_requests()[0].at
        dur = (s.all_requests()[-1].at - start).total_seconds() / 60
        host = f" (Claude Code: ${s.host_cost:.2f})" if s.host_cost else ""
        p(f"\n  {s.id[:8]} {s.project[:28]:<28} ${s.cost:6.2f}{host}  {dur:5.0f} min  {len(s.agents) - 1} subagents")
        for kind, ats in sorted(kinds.items(), key=lambda kv: kv[1][0]):
            p(f"     +{(ats[0] - start).total_seconds() / 60:5.0f}m  {kind}{f'  (×{len(ats)})' if len(ats) > 1 else ''}")
        findings.append({"session": s.id, "project": s.project, "cost": s.cost, "host_cost": s.host_cost,
                         "signals": {k: [t.isoformat() for t in v] for k, v in kinds.items()}})

    if opts.json:
        Path(opts.json).write_text(json.dumps({"usual_per_hour": usual, "sessions": findings}, indent=1))


if __name__ == "__main__":
    sys.exit(main())
