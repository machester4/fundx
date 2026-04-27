# Autonomous Surface — Lightweight Regression Gate (5.1) — Design Spec

**Date:** 2026-04-27
**Status:** Draft → pending user review
**Scope:** Sub-project (5.1) of the prompt ecosystem initiative. Adds unit-level regression gates around `runFundSession`'s prompt construction and the 4 sub-agents in `src/subagent.ts`, without executing real autonomous cycles. A heavier (5.2) — full-cycle evaluation — is explicitly deferred until evidence justifies the cost.

## Motivation

Sub-projects (1)–(4) covered chat and ask end-to-end with the eval harness, achieving 8/8 MVP cases passing. Three latent bugs were caught in the process — all on those surfaces (`runChatTurn` ignoring context in spec 2, `runAgentQuery` leaking `CLAUDECODE` in spec 4). Autonomous sessions received the language carve-out from spec (3) (`Session mode: autonomous scheduled` prefix + `session-init.md` `## Applies to`) but no automated regression gate.

Full-cycle autonomous evaluation is genuinely expensive: a single run is 30+ turns × 4 sub-agents × ~$1.50–3.00 per run, with K=3 smoke runs costing $15–25. There's no firm evidence today of bugs in the autonomous path, so spending tens of dollars per smoke without a target is poor ROI.

This spec instead delivers the cheap-but-valuable subset: unit tests that fail fast when someone refactors `session.service.ts` in ways that silently degrade autonomous behavior. Specifically, the regression gates close three observable holes:

1. **`runFundSession`'s prompt is constructed inline** (`src/services/session.service.ts:88-105`) and is not testable. If a refactor accidentally drops the `sessionModePrefix("autonomous-scheduled")` line, the chat/ask eval doesn't catch it because those cases never run autonomous.

2. **`buildAnalystAgents` (`src/subagent.ts`) has no shape assertions.** A refactor that drops a tool from a sub-agent's `tools` array (e.g., removes `WebSearch` from market-analyst) survives until the next real cycle, which may be days or weeks later in production.

3. **Sub-agent prompts contain anti-hallucination directives** (per `CLAUDE.md` Prompting Conventions: "Never cite a price ... without retrieving it from a tool this session"). Their removal during a casual edit goes undetected.

## Non-goals for this spec

- Executing autonomous cycles (full or dry-run) with real LLM calls
- Adding autonomous cases to the MVP eval suite
- Extending the eval harness with `surface: autonomous`
- Modifying any `FUND_RULES` (`session-init.md` already received its mode-aware update in spec 3)
- Modifying any `BUILTIN_SKILLS` entry
- Editing `src/subagent.ts` content (only adding tests on it)
- Editing `src/template.ts`
- Validating artifact creation (`analysis/<date>.md`, `state/session-handoff.md`)
- Sub-agent invocation tracking inside cycles
- State-mutation correctness post-trade-execution

All of the above are deferred to sub-project (5.2) — see "Future work" section.

## Success criteria

| Check | Expected |
|---|---|
| ~22 new unit tests pass (`autonomous-prompt.test.ts` + `subagent.test.ts`) | yes |
| Existing 668 tests continue passing (no regression) | yes |
| `pnpm typecheck` clean | yes |
| `pnpm build` clean | yes |
| 8/8 MVP eval cases (chat + ask) still pass | optional sanity smoke (K=1, ~$0.85) |

The optional smoke is recommended but not blocking. The refactor is localized to `src/services/session.service.ts` and shouldn't touch chat/ask paths — but K=1 against the MVP suite (~$0.85) is cheap insurance.

## Locked architectural decisions (from brainstorming on 2026-04-27)

| Decision | Choice | Rationale |
|---|---|---|
| Spec scope | Lightweight unit tests (5.1) only; defer full-cycle eval to (5.2) | No firm evidence of autonomous bugs; full-cycle smoke is $15–25; YAGNI until justified |
| Helper extraction | Factor `buildAutonomousPrompt(input)` out of `session.service.ts`'s inline array | Makes the prompt unit-testable; ~30-50 lines of refactor |
| Helper location | `src/services/session.service.ts` (not chat.service.ts) | The autonomous prompt is session-specific; chat.service already hosts shared helpers (`sessionModePrefix`, `buildFundContext`) |
| Helper inputs | `{fundName, sessionType, focus, universeBlock?, useDebateSkills?, today?}` | Minimum surface to reconstruct the existing prompt; `today` injectable for stable assertions |
| Sub-agent shape tests | Test 4-agent count, names, non-empty descriptions/prompts, tools array shape, maxTurns sanity | Catches accidental tool removal or count drift |
| Sub-agent content tests | Permissive regex assertions — anti-hallucination, risk language, evaluation language | Catches removal of key directives without overspecifying wording |
| Editing `subagent.ts` content | **No** — only tests added | The current sub-agent definitions are working; this spec adds gates, not redesign |

## Architecture

### `buildAutonomousPrompt` helper

**Location:** `src/services/session.service.ts` (added near the top after imports, before `runFundSession`).

**Signature:**

```ts
export interface BuildAutonomousPromptInput {
  fundName: string;
  sessionType: string;
  focus: string;
  universeBlock?: string | null;
  useDebateSkills?: boolean;
  today?: string;
}

export function buildAutonomousPrompt(input: BuildAutonomousPromptInput): string {
  const today = input.today ?? new Date().toISOString().split("T")[0];
  const lines: string[] = [
    sessionModePrefix("autonomous-scheduled"),
    ``,
    `You are running a ${input.sessionType} session for fund '${input.fundName}'.`,
    ``,
    `Focus: ${input.focus}`,
    ``,
  ];
  if (input.universeBlock) {
    lines.push(input.universeBlock, ``);
  }
  if (input.useDebateSkills) {
    lines.push(
      `This session should prioritize thorough analysis. Before any trading decisions,`,
      `apply your Investment Debate and Risk Assessment skills from your CLAUDE.md.`,
      `Use your analyst sub-agents (via the Task tool) to gather data from multiple`,
      `perspectives before making decisions.`,
      ``,
    );
  }
  lines.push(
    `Follow your session-init rule to orient yourself, then proceed with your Session Protocol.`,
    `Write analysis to analysis/${today}_${input.sessionType}.md.`,
  );
  return lines.join("\n");
}
```

The helper is pure — no IO, no side effects, no time-of-call coupling beyond the optional `today` default. The body reproduces the existing inline array byte-equivalent.

**Callsite update in `runFundSession`** (lines ~88-105):

```ts
// Before
const prompt = [
  sessionModePrefix("autonomous-scheduled"),
  ``,
  `You are running a ${sessionType} session for fund '${fundName}'.`,
  // ... 15+ lines of inline construction ...
].join("\n");

// After
const prompt = buildAutonomousPrompt({
  fundName,
  sessionType,
  focus,
  universeBlock,
  useDebateSkills: options?.useDebateSkills,
  today,
});
```

### `tests/autonomous-prompt.test.ts`

11 tests covering:
- Mode prefix presence at the start (regex `^Session mode: autonomous scheduled`)
- Fund + sessionType in the running header
- Focus line included
- session-init reference present
- Analysis path with date + sessionType
- Universe block when provided
- Universe block omitted when undefined or null
- Debate skills paragraph when `useDebateSkills=true`
- Debate skills paragraph omitted when false or undefined
- Default `today` matches today's date when not injected

Full test code: see plan document.

### `tests/subagent.test.ts`

11 tests covering:
- `buildAnalystAgents(fundName)` returns exactly 4 agents
- Names are `market-analyst`, `technical-analyst`, `risk-guardian`, `trade-evaluator`
- Each agent has non-empty description (>20 chars)
- Each agent has non-empty prompt (>100 chars)
- Each agent's `tools` array contains `Read`
- `market-analyst.tools` contains `WebSearch`
- Each agent's `maxTurns` is positive and ≤ 50
- `market-analyst` prompt mentions "retrieve from a tool" or equivalent (anti-hallucination per `CLAUDE.md` Prompting Conventions)
- `technical-analyst` prompt has substantive length (>200 chars)
- `risk-guardian` prompt mentions risk/constraint/limit
- `trade-evaluator` prompt mentions thesis/evaluation/review/skeptic

Anti-hallucination test uses regex disjunction `/never cite|do not cite|retrieve.+from a tool/i` to be permissive about wording while catching outright removal. The implementer reads `subagent.ts` during execution and adjusts the regex to match the actual phrasing — the *contract* is "the directive must exist", not "the wording must match exactly".

Full test code: see plan document.

## Token + cost forecast

| | Pre-spec(5.1) | Post-spec(5.1) |
|---|---|---|
| Test count | 668 | ~690 |
| `pnpm test` time | 4.5s | ~5s |
| Implementation token spend | n/a | $0 (or ~$0.85 with optional K=1 sanity smoke) |
| Nightly CI cost change | $0 | $0 |
| Monthly cost increase | $0 | $0 |

This is the only sub-project of the initiative that does not increase token spend.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Factor-out produces a prompt that differs from the current inline (whitespace drift) | Unit tests assert on `toContain` of every key line; if drift breaks an assertion, the implementer fixes |
| Helper omits an edge case (universe block undefined vs null) | Tests cover undefined, null, and non-empty cases explicitly |
| Anti-hallucination regex doesn't match the actual prompt wording | Implementer reads `subagent.ts` and adjusts the regex; contract is "directive must exist" |
| Refactor accidentally changes runtime behavior | Optional K=1 sanity smoke catches this for ~$0.85 |
| Sub-agent content tests break when someone intentionally edits a prompt | Test failure is the correct signal — the changeset includes test update, forcing conscious review |

## Future work — sub-project (5.2) deferral

A future sub-project (5.2) would add full-cycle autonomous evaluation. Triggers to invest:

- A bug observed in production autonomous behavior (e.g., daemon runs and a fund cycle stops writing handoff)
- A major refactor to `runFundSession` or `subagent.ts` that the unit-test regime can't cover
- A budget decision allocating tokens to autonomous nightly evaluation

(5.2) would likely use:
- A `dry_run: true` flag on `runFundSession` that skips Execute phase
- 2-3 autonomous MVP cases with assertions on tools + artifact creation
- K=1 nightly or K=3 manual via `workflow_dispatch`
- Estimated cost: $5-15/smoke, $5-25/case-month

For now, (5.1)'s unit gates plus the existing chat/ask MVP coverage provide a reasonable baseline.

## Out-of-scope reminder

Sub-project (5.1) does **not**:
- Execute autonomous cycles (real LLM calls beyond the optional K=1 sanity smoke)
- Modify the 11 `FUND_RULES`
- Modify the 8 `BUILTIN_SKILLS`
- **Modify `src/subagent.ts` content** — only tests added on it
- Modify `src/template.ts`
- Extend the eval harness with `surface: autonomous`
- Add autonomous cases to MVP/backlog suites
- Validate artifact creation, sub-agent invocation tracking, or state-mutation correctness

When the success criteria are met, sub-project (5.1) closes. The initiative as a whole reaches:
- 100% turn-level eval coverage on chat + ask (8/8 MVP cases)
- Unit-level regression gate on autonomous prompt + sub-agent shape
- 3 latent bugs caught and fixed across the journey
