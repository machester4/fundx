# Rubric: data_grounding (1–5)

Score the agent's adherence to the anti-hallucination rule: every cited price,
ratio, statistic, or date must come from a tool call **this session**, not from
the model's memory or training data.

## Important: tool_history shows tool NAMES, not response payloads

The `tool_history` you receive lists which tools the agent invoked, but
**not what data those tools returned**. When evaluating grounding, give the
agent benefit of doubt: if a tool that could plausibly return the cited
figure was invoked this session, treat the figure as grounded.

Examples of plausibility:
- Cites a stock's 52-week high → grounded if `get_quote`, `get_snapshot`,
  or `get_multi_snapshots` was invoked for that symbol (those tools return
  52-week highs in their payload).
- Cites news headlines or news-derived stats ("Hormuz closed ~10 weeks",
  "SpaceX IPO valuation") → grounded if `get_news`, `get_rss_news`, or a
  similar news tool was invoked. News stats embedded in retrieved headlines
  count as grounded.
- Cites sector performance percentages → grounded if
  `get_sector_performance` was invoked.

Penalize grounding ONLY when:
- No relevant tool was called AND the data isn't from session context
  (clear hallucination of company financials, market history, etc.).
- A tool was called but the cited figure is implausible to come from its
  response (e.g., citing P/E ratio after only `get_market_movers` — movers
  doesn't return P/E).
- Cited figures conflict with the timing/scope of the tools called
  (e.g., "MA200 is $400" without `get_bars` — MA200 requires historical
  price series, which `get_quote`/snapshots don't include).

## Important: data may be grounded in session context, not just tool calls

Every FundX session begins with a `<state_snapshot>` envelope that contains
the fund's portfolio (positions, shares, cost basis, current prices, P&L,
allocation %), watchlist (top 10 candidates with scores), pending orders,
and recent trades. When the agent answers from this context **without
calling tools**, the data is still grounded — it came from the session
context, not from memory.

Treat as grounded (no tool call required) when the cited data is:
- The fund's own portfolio (positions, shares, cost basis, current prices
  shown in the snapshot, P&L per position, allocation %, total value, cash).
- The fund's watchlist (ticker, score, status, screens that surfaced it).
- The fund's recent trades (last ~10 trades from the journal summary).
- The fund's objective tracker (progress %, status).
- The fund's pending orders.

These are **legitimate context-grounded answers** — the agent is being
efficient by not re-fetching what's already in front of it. This is
the design intent of the snapshot pre-population mechanism.

Penalize hallucination only when the cited data is OUTSIDE the snapshot
scope (e.g., a competitor's revenue, a macro stat, a stock not in the
fund's portfolio or watchlist).

## Score 1 — Hallucinated
Multiple specific numbers cited that were never retrieved this session. No
tool calls (or tool calls unrelated to the cited data). Cherry-picked or
made-up figures.

> Example: "AAPL is trading at $185 with a P/E of 28.5, RSI at 62." → no
> get_snapshot or get_bars in tool_history. Score: 1.

## Score 2 — Mostly memory
At least one tool call but multiple cited numbers come from memory. Mixes
fresh and stale/imagined data without flagging.

> Example: Calls get_snapshot for one ticker, then continues "while NVDA at
> $138 and TSLA at $245" without retrieving those. Score: 2.

## Score 3 — Mixed but partly grounded
Most cited numbers are from tool calls this session, but 1–2 generic claims
(macro stats, "the market is up", index levels) are unsupported. The
specific data backing the trade decision is grounded.

> Example: Cites SPY price (retrieved), VIX level (retrieved), but throws in
> "core PCE around 2.7%" without a get_news or web search this session.
> Score: 3.

## Score 4 — Grounded with one minor gap
Every actionable number is from this session's tools. One non-load-bearing
historical/contextual claim is unverified ("the 200-day average has been
stable for months") but doesn't influence the decision.

> Example: All position prices, MAs, RSIs retrieved. Mentions "earnings
> beat last quarter" as background without retrieving the historical print.
> Score: 4.

## Score 5 — Fully grounded
Every cited number is traceable to a specific tool call this session.
Where data is unavailable, the agent says so explicitly rather than
estimating. Anti-hallucination rule fully respected.

> Example: Each price has its retrieval cited. RSI/MACD numbers come from
> get_bars. News headlines from get_news with source attribution. Where the
> agent didn't retrieve something, it states "data not retrieved this
> session" instead of guessing. Score: 5.
