# Rubric: non_duplication (1-5)

Score whether the written lessons avoid repeating content that was already
present in the memory files before the run. The agent is provided the current
memory state in the prompt and must produce genuinely NEW lessons.

## Score 1 — Fully duplicated
All or most written lessons restate existing memory entries verbatim or in
slightly paraphrased form. No new information added.

> Example: Existing entry says "Half-sizing on binary catalysts bounds
> downside." New entry says "Binary events should use half-sizing to limit
> risk." → Same lesson, different words. Score: 1.

## Score 2 — Mostly duplicated
More than half the lessons repeat existing content. A few genuinely new
details appear but they are incidental.

## Score 3 — Mixed
Roughly half the lessons are genuinely new; the other half overlap
significantly with existing entries. Some distinction in framing but core
insight is repeated.

## Score 4 — Mostly new
Most lessons add genuinely new information. At most one minor overlap with
existing content (e.g., a lesson that extends an existing theme with new
data from this batch).

## Score 5 — Fully non-duplicative
Every lesson adds information not present in the pre-run memory. Existing
themes may be referenced for context but the new entries extend them with
fresh data, dates, or mechanisms rather than restating them.

> Example: Existing entry covers regime/sizing correlation in general;
> new entry adds the specific 2026-05-04 regime score (2.1) that triggered
> the 0.7x sizing reduction. New data, same theme — not a duplicate. Score: 5.
