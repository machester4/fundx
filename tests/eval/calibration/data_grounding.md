# Rubric: data_grounding (1–5)

Score the agent's adherence to the anti-hallucination rule: every cited price,
ratio, statistic, or date must come from a tool call **this session**, not from
the model's memory or training data.

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
