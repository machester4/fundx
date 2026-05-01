# Rubric: task_completion (1–5)

Score how completely the agent addressed the user's actual request, given
the constraints of the session mode (chat / ask / autonomous).

## Score 1 — Failed to address
Output does not engage with the user's request. Wrong topic, refusal
without explanation, or empty/error response.

> Example: User asked "¿cuál es mi P&L del mes?" → agent answers about
> market regime instead. Score: 1.

## Score 2 — Off-target or vague
Touches the topic but doesn't deliver the requested output. Hand-wavy,
non-specific, or partial.

> Example: User asked for portfolio review → agent says "todo se ve bien"
> without naming positions, P&L, or specific concerns. Score: 2.

## Score 3 — Partial answer
Addresses the core request but misses one substantive component (e.g.,
listed positions but skipped P&L; reviewed positions but no rebalancing
recommendation).

> Example: User asked "review portfolio + suggest rebalancing" → agent
> reviews positions thoroughly but only mentions rebalancing in passing
> ("podría reducir tech"). Score: 3.

## Score 4 — Complete, slightly under-specified
Addresses every component of the request with concrete output. One area
could be more specific or actionable but the answer is usable as-is.

> Example: User asked for new opportunities → agent identifies 3 candidates
> with rationale, but doesn't fully spec entry/stop/target for each.
> Score: 4.

## Score 5 — Complete and actionable
Every component of the request is addressed with specific, actionable
detail. The user could act on the response without follow-up questions.

> Example: User asked for portfolio review → agent walks every position
> with current price/P&L/thesis status, identifies concentration risks
> with specific %, and recommends 2 specific rebalancing actions with
> sizing rationale. Score: 5.
