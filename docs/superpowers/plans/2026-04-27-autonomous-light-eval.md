# Autonomous Surface — Lightweight Regression Gate (5.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add unit-level regression gates around `runFundSession`'s prompt construction and the 4 sub-agents in `src/subagent.ts` — without executing any real autonomous cycle. The gates catch silent regressions (mode prefix removed, sub-agent tools dropped, anti-hallucination directive deleted) before they reach production.

**Architecture:** Factor out a pure `buildAutonomousPrompt(input)` helper in `src/services/session.service.ts` from the existing inline prompt array. Add unit tests on the helper covering all input variants. Add unit tests on `buildAnalystAgents` from `src/subagent.ts` covering shape (count, names, tools, maxTurns) and content (anti-hallucination directives, risk/evaluation language).

**Tech Stack:** TypeScript ESM, Vitest. No new runtime deps. **No LLM tokens spent during implementation** (one optional ~$0.85 sanity smoke at the end).

**Prior context:**
- Design spec: `docs/superpowers/specs/2026-04-27-autonomous-light-eval-design.md` (commit `c9917da`)
- Pre-spec(5.1) state: 668 tests passing, 8/8 MVP eval cases passing post sub-project (4)
- Current shape verified by exploration:
  - `src/services/session.service.ts:88-105` — inline `prompt` array with mode prefix, fund/sessionType/focus, optional universe block, optional debate skills, session-init reference, analysis path
  - `src/subagent.ts:17` — `export function buildAnalystAgents(fundName): Record<string, AgentDefinition>`
  - Anti-hallucination wording present at lines 95, 184, 374 (`market-analyst`, `technical-analyst`, `trade-evaluator`): `"Never cite a price, ratio, or statistic without retrieving it from a tool this session."`. Not present in `risk-guardian` — that one is asserted on different content (risk/constraint/limit language).
- Working directory: `/Users/michael/Proyectos/fundx`. Branch: `main`. User has standing consent.

---

## File Structure

**Modified files:**

| Path | Change |
|---|---|
| `src/services/session.service.ts` | Add export `BuildAutonomousPromptInput` interface and `buildAutonomousPrompt(input): string` helper near the top of the file (after imports). Replace the inline `prompt` array in `runFundSession` (currently lines ~88-105) with a single call to the helper. Body of the helper reproduces the existing array logic byte-equivalent. |

**New files:**

| Path | Responsibility |
|---|---|
| `tests/autonomous-prompt.test.ts` | 11 unit tests on `buildAutonomousPrompt` covering all input variants (mode prefix, fund/sessionType/focus, universe block present/absent, debate skills on/off, default `today`) |
| `tests/subagent.test.ts` | 11 unit tests on `buildAnalystAgents` covering shape (4 agents, names, tools, maxTurns) and content (anti-hallucination directives in 3 of 4 agents, risk/evaluation language) |

**Files explicitly NOT modified:**
- `src/subagent.ts` — only tests added on it; content unchanged
- Any `FUND_RULES` entry in `src/skills.ts`
- Any `BUILTIN_SKILLS` entry
- `src/template.ts`
- The eval harness (`src/services/eval/*`) — no `surface: autonomous` added
- Any case YAML
- `CLAUDE.md`

**Task numbering (3 tasks):**

```
Task 1: buildAutonomousPrompt helper + tests + session.service refactor    [foundation, single commit]
Task 2: subagent.test.ts                                                     [independent of Task 1]
Task 3: Final verification + optional K=1 sanity smoke                       [needs 1+2]
```

Tasks 1 and 2 are independent and could in principle run in parallel; sequential is fine and simpler.

---

## Task 1: Factor `buildAutonomousPrompt` helper + replace callsite

**Why:** The helper makes the autonomous prompt unit-testable. Without it, regressions (e.g., `sessionModePrefix("autonomous-scheduled")` accidentally removed during refactor) would only surface in real cycles.

**Files:**
- Modify: `src/services/session.service.ts`
- Create: `tests/autonomous-prompt.test.ts`

- [ ] **Step 1.1: Write the failing test file `tests/autonomous-prompt.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildAutonomousPrompt } from "../src/services/session.service.js";

const baseInput = {
  fundName: "test-fund",
  sessionType: "pre-market",
  focus: "Review overnight news, check positions, identify rebalancing needs.",
  today: "2026-04-27",
};

describe("buildAutonomousPrompt", () => {
  it("starts with the autonomous-scheduled mode prefix", () => {
    const out = buildAutonomousPrompt(baseInput);
    expect(out).toMatch(/^Session mode: autonomous scheduled/);
  });

  it("includes the fund name and session type in the running header", () => {
    const out = buildAutonomousPrompt(baseInput);
    expect(out).toContain("running a pre-market session for fund 'test-fund'");
  });

  it("includes the focus line", () => {
    const out = buildAutonomousPrompt(baseInput);
    expect(out).toContain("Focus: Review overnight news, check positions, identify rebalancing needs.");
  });

  it("references the session-init rule", () => {
    const out = buildAutonomousPrompt(baseInput);
    expect(out).toContain("Follow your session-init rule");
  });

  it("specifies the analysis output path with the injected date and sessionType", () => {
    const out = buildAutonomousPrompt(baseInput);
    expect(out).toContain("Write analysis to analysis/2026-04-27_pre-market.md");
  });

  it("includes the universe block when provided", () => {
    const out = buildAutonomousPrompt({
      ...baseInput,
      universeBlock: "## Universe\n- SPY\n- QQQ",
    });
    expect(out).toContain("## Universe");
    expect(out).toContain("- SPY");
  });

  it("omits universe block when undefined or null", () => {
    const withUndefined = buildAutonomousPrompt({ ...baseInput, universeBlock: undefined });
    const withNull = buildAutonomousPrompt({ ...baseInput, universeBlock: null });
    expect(withUndefined).not.toContain("## Universe");
    expect(withNull).not.toContain("## Universe");
  });

  it("includes debate skills paragraph when useDebateSkills=true", () => {
    const out = buildAutonomousPrompt({ ...baseInput, useDebateSkills: true });
    expect(out).toContain("prioritize thorough analysis");
    expect(out).toContain("Investment Debate and Risk Assessment skills");
    expect(out).toContain("analyst sub-agents (via the Task tool)");
  });

  it("omits debate skills paragraph when useDebateSkills=false or undefined", () => {
    const withFalse = buildAutonomousPrompt({ ...baseInput, useDebateSkills: false });
    const withUndefined = buildAutonomousPrompt(baseInput);
    expect(withFalse).not.toContain("prioritize thorough analysis");
    expect(withUndefined).not.toContain("prioritize thorough analysis");
  });

  it("uses today's date by default when `today` is not provided", () => {
    const out = buildAutonomousPrompt({ ...baseInput, today: undefined });
    const expectedDate = new Date().toISOString().split("T")[0];
    expect(out).toContain(`analysis/${expectedDate}_pre-market.md`);
  });
});
```

- [ ] **Step 1.2: Run the test — expect FAIL**

```bash
pnpm vitest run tests/autonomous-prompt.test.ts
```

Expected: FAIL — `buildAutonomousPrompt` is not exported from `src/services/session.service.ts` yet.

- [ ] **Step 1.3: Add the helper to `src/services/session.service.ts`**

Open `src/services/session.service.ts`. Confirm the existing import of `sessionModePrefix` (it should be there post sub-project 3):

```bash
grep -n "sessionModePrefix" src/services/session.service.ts
```

Expected: at least one match (existing import + usage in `runFundSession`).

Insert the new helper near the top of the file, after the imports and constants, before the existing `runFundSession` function. The helper is purely additive:

```ts
export interface BuildAutonomousPromptInput {
  fundName: string;
  sessionType: string;
  focus: string;
  universeBlock?: string | null;
  useDebateSkills?: boolean;
  today?: string;
}

/** Pure helper: builds the prompt for an autonomous scheduled session.
 *
 *  The prompt prefix tells the model it's in autonomous mode (so the
 *  session-init rule's `## Applies to` section directs it to follow the
 *  Orient sequence). Factored out from `runFundSession`'s inline array
 *  to make the prompt unit-testable.
 */
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

The helper signature uses `string | null | undefined` for `universeBlock` because the existing callsite passes `universeBlock` which is the result of `renderUniverseBlock(universeResolution)` — that function may return null when no universe is resolvable.

- [ ] **Step 1.4: Run the test — expect PASS**

```bash
pnpm vitest run tests/autonomous-prompt.test.ts
```

Expected: 11 tests PASS.

- [ ] **Step 1.5: Replace the inline `prompt` array in `runFundSession` with a call to the helper**

Find the existing prompt construction (currently around lines 88-105):

```ts
// Before
const prompt = [
  sessionModePrefix("autonomous-scheduled"),
  ``,
  `You are running a ${sessionType} session for fund '${fundName}'.`,
  ``,
  `Focus: ${focus}`,
  ``,
  ...(universeBlock ? [universeBlock, ``] : []),
  ...(options?.useDebateSkills
    ? [
        `This session should prioritize thorough analysis. Before any trading decisions,`,
        `apply your Investment Debate and Risk Assessment skills from your CLAUDE.md.`,
        `Use your analyst sub-agents (via the Task tool) to gather data from multiple`,
        `perspectives before making decisions.`,
        ``,
      ]
    : []),
  `Follow your session-init rule to orient yourself, then proceed with your Session Protocol.`,
  `Write analysis to analysis/${today}_${sessionType}.md.`,
].join("\n");
```

Replace with:

```ts
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

The `today` variable already exists locally (line ~75: `const today = new Date().toISOString().split("T")[0];`) — pass it through. The other variables (`fundName`, `sessionType`, `focus`, `universeBlock`, `options`) are all in scope at this point.

- [ ] **Step 1.6: Run the full test suite — expect no regressions**

```bash
pnpm test
```

Expected: 679+ tests pass (previous 668 + 11 new). No existing tests should break — the refactor produces a byte-equivalent prompt to the inline array.

- [ ] **Step 1.7: Typecheck and build**

```bash
pnpm typecheck
pnpm build
```

Both clean.

- [ ] **Step 1.8: Verify the build artifact contains both the helper and the autonomous mode prefix**

```bash
grep -rl "buildAutonomousPrompt" dist/ | head -3
grep -rl "Session mode: autonomous scheduled" dist/ | head -3
```

Both should return ≥ 1.

- [ ] **Step 1.9: Commit**

```bash
git add src/services/session.service.ts tests/autonomous-prompt.test.ts
git -c commit.gpgsign=false commit -m "feat(session-service): factor buildAutonomousPrompt helper + unit tests"
```

---

## Task 2: `tests/subagent.test.ts` — shape and content gates on `buildAnalystAgents`

**Why:** Without these gates, a refactor that drops a tool from `market-analyst` (e.g., removes `WebSearch`) or removes the anti-hallucination directive from one of the prompts would only surface in a real autonomous cycle — days or weeks later. Unit tests catch it instantly, at $0 cost.

**Files:**
- Create: `tests/subagent.test.ts`

- [ ] **Step 2.1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { buildAnalystAgents } from "../src/subagent.js";

const FUND = "test-fund";

describe("buildAnalystAgents shape", () => {
  it("returns exactly 4 agents", () => {
    const agents = buildAnalystAgents(FUND);
    expect(Object.keys(agents)).toHaveLength(4);
  });

  it("includes the four expected sub-agent names", () => {
    const agents = buildAnalystAgents(FUND);
    expect(agents).toHaveProperty("market-analyst");
    expect(agents).toHaveProperty("technical-analyst");
    expect(agents).toHaveProperty("risk-guardian");
    expect(agents).toHaveProperty("trade-evaluator");
  });

  it("each agent has a non-empty description (>20 chars)", () => {
    const agents = buildAnalystAgents(FUND);
    for (const [name, agent] of Object.entries(agents)) {
      expect(agent.description, `${name} description`).toBeTruthy();
      expect(agent.description.length, `${name} description length`).toBeGreaterThan(20);
    }
  });

  it("each agent has a non-empty prompt (>100 chars)", () => {
    const agents = buildAnalystAgents(FUND);
    for (const [name, agent] of Object.entries(agents)) {
      expect(agent.prompt, `${name} prompt`).toBeTruthy();
      expect(agent.prompt.length, `${name} prompt length`).toBeGreaterThan(100);
    }
  });

  it("each agent's tools array contains Read", () => {
    const agents = buildAnalystAgents(FUND);
    for (const [name, agent] of Object.entries(agents)) {
      expect(agent.tools, `${name} tools`).toContain("Read");
    }
  });

  it("market-analyst has WebSearch enabled in tools", () => {
    const agents = buildAnalystAgents(FUND);
    expect(agents["market-analyst"].tools).toContain("WebSearch");
  });

  it("each agent has a positive maxTurns within sane range (1..50)", () => {
    const agents = buildAnalystAgents(FUND);
    for (const [name, agent] of Object.entries(agents)) {
      expect(agent.maxTurns, `${name} maxTurns`).toBeGreaterThan(0);
      expect(agent.maxTurns, `${name} maxTurns`).toBeLessThanOrEqual(50);
    }
  });
});

describe("sub-agent prompt content", () => {
  it("market-analyst includes anti-hallucination directive", () => {
    const agents = buildAnalystAgents(FUND);
    const prompt = agents["market-analyst"].prompt;
    expect(prompt).toMatch(/never cite|do not cite|retrieving it from a tool/i);
  });

  it("technical-analyst includes anti-hallucination directive", () => {
    const agents = buildAnalystAgents(FUND);
    const prompt = agents["technical-analyst"].prompt;
    expect(prompt).toMatch(/never cite|do not cite|retrieving it from a tool/i);
  });

  it("trade-evaluator includes anti-hallucination directive and references thesis/evaluation framework", () => {
    const agents = buildAnalystAgents(FUND);
    const prompt = agents["trade-evaluator"].prompt;
    expect(prompt).toMatch(/never cite|do not cite|retrieving it from a tool/i);
    expect(prompt).toMatch(/thesis|evaluation|review|skeptic/i);
  });

  it("risk-guardian references hard constraints language", () => {
    const agents = buildAnalystAgents(FUND);
    const prompt = agents["risk-guardian"].prompt;
    expect(prompt).toMatch(/risk|constraint|limit/i);
  });
});
```

The first `describe` block (7 tests) covers shape. The second (4 tests) covers content. Total: 11 tests.

The anti-hallucination regex `/never cite|do not cite|retrieving it from a tool/i` is permissive about wording. The actual current wording in `src/subagent.ts` (lines 95, 184, 374) is:

> `Never cite a price, ratio, or statistic without retrieving it from a tool this session.`
> `Never cite a price, indicator value, or date without retrieving it from a tool this session.`
> `Never cite a price, ratio, or statistic without retrieving it from a tool this session.`

These all match the regex. If a future edit changes the wording substantively (e.g., "always verify prices via tools"), the regex may need an update — but the contract ("the directive must exist") survives.

The risk-guardian assertion is intentionally on different content (`/risk|constraint|limit/i`) because — verified during planning — risk-guardian does NOT contain the anti-hallucination directive. It's a different concern. If you find risk-guardian DOES include "Never cite ..." after reading its prompt, you can keep both assertions on it; otherwise, the current test only asserts on risk language.

- [ ] **Step 2.2: Run the test — expect FAIL**

```bash
pnpm vitest run tests/subagent.test.ts
```

Expected: FAIL — module not found, or some assertions fail because they're new.

If the failures are because some assertion is *wrong* (e.g., `risk-guardian` actually does NOT use any of `risk|constraint|limit` in its prompt — implausible but possible), read the actual prompt content with:

```bash
sed -n '210,240p' src/subagent.ts
```

And adjust the regex to match the actual wording. The contract is "the directive must exist somehow"; the regex is the implementation of that contract.

- [ ] **Step 2.3: Verify the tests pass against the current `subagent.ts`**

The tests should pass once the file is created — `subagent.ts` is unchanged. Run:

```bash
pnpm vitest run tests/subagent.test.ts
```

Expected: 11 tests PASS.

If any test fails, the failure indicates either:
- The regex doesn't match the actual wording → adjust the regex (the contract is what matters, not the exact regex)
- The shape assertion is incorrect (e.g., `maxTurns > 50` for some agent) → adjust the bounds

In either case, the implementer reads `src/subagent.ts` content (lines 17-414 contain the full definitions) and adjusts the test to fit the current reality. The TEST is the new gate; the SUBAGENT is the truth source.

- [ ] **Step 2.4: Run the full test suite — expect no regressions**

```bash
pnpm test
```

Expected: 690+ tests pass (previous 679 + 11 new from this task).

- [ ] **Step 2.5: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 2.6: Commit**

```bash
git add tests/subagent.test.ts
git -c commit.gpgsign=false commit -m "test(subagent): shape and content gates on buildAnalystAgents"
```

---

## Task 3: Final verification + optional sanity smoke

**Why:** Confirm the full sub-project (5.1) is green and (optionally) that the refactor didn't accidentally affect chat/ask behavior at runtime.

**Files:** None new; verification only.

- [ ] **Step 3.1: Verify clean tree and full test suite passes**

```bash
git status
pnpm test
pnpm typecheck
pnpm build
```

Expected: no unstaged changes other than pre-existing untracked files (`.DS_Store`, etc.). Tests at ~690+ pass. Typecheck and build clean.

- [ ] **Step 3.2: Verify the commit log**

```bash
git log --oneline c9917da..HEAD
```

Expected (in reverse chronological order, with the spec commit `c9917da` at base):

```
<sha2>  test(subagent): shape and content gates on buildAnalystAgents
<sha1>  feat(session-service): factor buildAutonomousPrompt helper + unit tests
```

(Plus the plan commit if it was committed before execution — otherwise the plan goes in a third commit at the end.)

- [ ] **Step 3.3 (OPTIONAL): K=1 sanity smoke against the MVP eval suite (~$0.85)**

If `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set, run a quick K=1 sanity smoke to verify the refactor in `session.service.ts` didn't accidentally affect chat/ask behavior at runtime:

```bash
echo "auth: ${CLAUDE_CODE_OAUTH_TOKEN:+set}${ANTHROPIC_API_KEY:+set}"
ls ~/.fundx/funds/ | grep -E "^fundx-eval-" || echo "clean"
mkdir -p reports
pnpm dev -- eval --filter mvp- --runs 1 --json /tmp/spec5-1-sanity.json
jq '.cases[] | {id, passed, passing_runs: 1, total_runs: 1}' /tmp/spec5-1-sanity.json
```

Expected: 8/8 cases PASS at K=1. Cost: ~$0.85.

If any case fails, inspect the JSON:

```bash
jq '.cases[] | select(.passed == false) | {id, runs: [.runs[] | {tool_history: [.tool_history[].name], num_turns, error}]}' /tmp/spec5-1-sanity.json
```

A failure here means the refactor inadvertently affected something. Likely cause: the helper produces a slightly different string than the inline array (whitespace, line break drift). Compare:

```bash
node --input-type=module -e "
  import('./dist/services/session.service.js').then(({ buildAutonomousPrompt }) => {
    console.log(JSON.stringify(buildAutonomousPrompt({
      fundName: 'demo',
      sessionType: 'pre-market',
      focus: 'demo focus',
      universeBlock: '## Universe\n- SPY',
      useDebateSkills: true,
      today: '2026-04-27',
    })));
  });
"
```

Inspect the output for unexpected line breaks or missing content. The expected string starts with `Session mode: autonomous scheduled` and ends with `Write analysis to analysis/2026-04-27_pre-market.md`.

If this step is skipped (token budget reasons or not reachable from the current environment), the spec is still considered complete based on the unit test pass — the refactor's scope is small enough that "tests pass + byte-equivalent helper + no chat/ask path touched" is reasonable confidence.

- [ ] **Step 3.4 (if smoke ran): Cleanup**

```bash
ls ~/.fundx/funds/ | grep -E "^fundx-eval-" && for d in ~/.fundx/funds/fundx-eval-*; do rm -rf "$d"; done || echo "clean"
```

- [ ] **Step 3.5: Sub-project (5.1) close-out**

Sub-project (5.1) is closed when:
1. Tasks 1 and 2 complete with their commits
2. ~22 new unit tests pass
3. `pnpm test`, `pnpm typecheck`, `pnpm build` all green
4. (Optional) K=1 sanity smoke shows 8/8 PASS

The initiative as a whole reaches:
- 100% turn-level eval coverage on chat + ask (8/8 MVP cases)
- Unit-level regression gate on autonomous prompt + sub-agent shape
- 3 latent bugs caught and fixed across the journey (`runChatTurn` context ignore in spec 2, `pnpm dev -- eval --flag` swallowing in spec 2, `runAgentQuery` CLAUDECODE leak in spec 4)

Sub-project (5.2) — full-cycle autonomous evaluation — remains documented as a deferred follow-up triggered by:
- A bug observed in production autonomous behavior
- A major refactor to `runFundSession` or `subagent.ts`
- A budget allocation decision

---

## Self-review log (fill in during execution)

- [ ] No deviations
- [ ] Deviations (list below)

Notes from planning:
- The `risk-guardian` prompt was verified during planning to NOT contain the anti-hallucination directive at line 374's location. The test asserts on `/risk|constraint|limit/i` for risk-guardian instead. If a Step 2.2 dry-run shows risk-guardian DOES contain anti-hallucination wording (the file is large, not all lines were read during planning), keeping both assertions on it is fine — extend the test rather than restrict it.
- Step 1.5 callsite update assumes the existing local `today` variable (line ~75 of `session.service.ts`) is in scope. If the variable name is different post any prior refactor, find the equivalent: `grep -n "new Date()" src/services/session.service.ts`.
- The optional Step 3.3 K=1 smoke is the only token spend in this entire spec.

---

**End of plan.** When complete, sub-project (5.1) closes the initiative's last gap with a $0 (or ~$0.85) regression gate on autonomous behavior.
