# Session Mode Carve-Out + Eval Assertion Reshape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the two MVP eval cases that closed sub-project (2) at 0/3 (`mvp-portfolio-review-spanish`, `mvp-market-regime-spanish`) by reshaping their assertions to outcome-based, AND prevent the agent from over-applying the autonomous-mode `session-init` Orient sequence in interactive chat by introducing a `Session mode: <chat|autonomous>` prompt prefix and a corresponding `## Applies to` section in the rule.

**Architecture:** A small pure helper `sessionModePrefix(mode)` returns the mode line string. Both `chat.service.ts` (where `textPrompt` is built for fund chat) and `session.service.ts` (where the prompt for autonomous scheduled sessions is built) prepend this string to their existing prompt structure. The `session-init.md` rule gains an `## Applies to` section that reads the prefix and explains what the agent should do in each mode. The 6 numbered steps of the rule are not modified.

**Tech Stack:** TypeScript ESM, Vitest, existing eval harness (`fundx eval`). No new runtime dependencies.

**Prior context:**
- Design spec: `docs/superpowers/specs/2026-04-24-session-mode-carve-out-design.md` (commit `e1f3860`)
- Spec(2) baseline (pre-spec(3)): `reports/2026-04-24-post-fix-baseline.json` (commit `800df17`) — current MVP pass rates: opportunity-spanish 3/3, opportunity-english 3/3, opportunity-explicit-screener 3/3, portfolio-review-spanish 0/3, market-regime-spanish 0/3.
- The spec proposed `buildSessionPrompt({mode, context, message, sessionId})` taking the FULL prompt construction. This plan **deviates** from that with a smaller `sessionModePrefix(mode): string` helper. Reason: the existing `chat.service.ts` fund-branch prompt includes a readonly note, fund display preamble, and a "## User Message" header that the spec's `buildSessionPrompt` would have dropped (regression risk). The simpler helper preserves all caller-side concerns and only DRYs the part actually shared (the mode line). Spec INTENT (testable, no agent-side inference) is preserved.
- Current branch: `main`. User has standing consent for sub-projects (1)–(3).

---

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `tests/session-mode-prefix.test.ts` | Unit tests for the new `sessionModePrefix` helper |
| `reports/2026-04-25-spec3-post-fix.json` | Post-fix MVP baseline committed in Task 6 |

**Modified files:**

| Path | Change |
|---|---|
| `src/services/chat.service.ts` | Add and export `sessionModePrefix(mode)` helper. In the `textPrompt` ternary (line ~509-533), prepend `sessionModePrefix("interactive-chat")` to the fund first-turn branch (the multi-line array). Resumed and workspace branches unchanged. |
| `src/services/session.service.ts` | Import `sessionModePrefix`. In the prompt array (line ~88-105), prepend `sessionModePrefix("autonomous-scheduled")` as the first element, followed by a blank line. |
| `src/skills.ts` | Rewrite the title and add an `## Applies to` section to the `session-init.md` entry of `FUND_RULES` (line ~1373). The 6 numbered steps are unchanged. |
| `tests/skills.test.ts` | Extend with two tests verifying the new `## Applies to` section and the absence of "Mandatory Sequence". |
| `tests/eval/cases/mvp-portfolio-review-spanish.yaml` | Replace `must_invoke: [mcp__broker-local__get_positions]` with `must_not_invoke: [Read, Glob, Bash]`, `max_turns: 5`, `max_tokens_out: 3000`. Update description. |
| `tests/eval/cases/mvp-market-regime-spanish.yaml` | Replace `must_invoke: [mcp__market-data__get_multi_snapshots]` with `must_not_invoke: [Read, Glob, Bash]`, `max_turns: 8`, `max_tokens_out: 4000`. Update description. |
| `CLAUDE.md` | Fix `7 trading skills` → `8 trading skills` (3 locations). Extend the partial listings of `.claude/rules/` and `.claude/skills/` to include all 11 rules and all 8 skills respectively. |

**Files explicitly NOT modified:**

- The 10 other `FUND_RULES` entries (`state-consistency.md`, `decision-quality.md`, `analysis-standards.md`, `risk-discipline.md`, `learning-loop.md`, `market-awareness.md`, `self-scheduling.md`, `communication.md`, `session-completion.md`, `data-access.md`)
- The 8 `BUILTIN_SKILLS` entries (Investment Thesis, Risk Assessment, Trade Memory, Market Regime, Position Sizing, Session Reflection, Portfolio Review, Opportunity Screening)
- `src/subagent.ts` (4 sub-agents)
- `src/template.ts` (per-fund CLAUDE.md generator)
- `src/services/eval/*` (harness internals)
- `tests/chat-context.test.ts` (12 tests of `buildChatContext`) — verify they still pass; should be unaffected because the prefix is added BEFORE the context inside the chat.service prompt, not inside `buildChatContext` itself
- The 3 MVP cases that pass (opportunity-spanish, opportunity-english, opportunity-explicit-screener) and 13 backlog cases

**Task numbering and dependency graph:**

```
Task 1: Reshape 2 eval YAMLs              [independent]
Task 2: sessionModePrefix helper + chat.service integration  [foundation]
Task 3: session.service integration       [needs 2]
Task 4: session-init.md content rewrite   [needs 2 (so the rule references match the prefix)]
Task 5: CLAUDE.md off-by-one fix          [independent]
Task 6: Smoke test post-fix + commit baseline   [needs 1+2+3+4+5]
Task 7: Final verification                [needs 6]
```

Use frequent commits — each task ends with a single commit unless explicitly noted.

---

## Task 1: Reshape 2 eval YAMLs

**Why:** Both cases currently fail because their assertions measure mechanism (`must_invoke [specific_tool]`) rather than outcome. The agent now responds correctly from injected context (`portfolio-review-spanish`) or uses any of several reasonable market-data tools (`market-regime-spanish`). Reshape to outcome-based assertions.

**Files:**
- Modify: `tests/eval/cases/mvp-portfolio-review-spanish.yaml`
- Modify: `tests/eval/cases/mvp-market-regime-spanish.yaml`

- [ ] **Step 1.1: Overwrite `tests/eval/cases/mvp-portfolio-review-spanish.yaml`**

```yaml
id: mvp-portfolio-review-spanish
description: Usuario pide revisar el portfolio; con context inyectado debe responder rápido sin Read/Glob/Bash
prompt: "revisá el portfolio y decime cómo están las posiciones"
language: es
fund_state:
  base: runway-full-positions
expect:
  must_not_invoke: [Read, Glob, Bash]
  max_turns: 5
  max_tokens_out: 3000
runs: 3
threshold: 2
```

- [ ] **Step 1.2: Overwrite `tests/eval/cases/mvp-market-regime-spanish.yaml`**

```yaml
id: mvp-market-regime-spanish
description: "Usuario pregunta qué pasa en mercado; debe usar tools de market-data, no Read/Bash genéricos. Tool específica queda a discreción del agente (snapshots, sectors, movers, news son válidos)."
prompt: "qué pasa hoy en mercado, hay algo relevante?"
language: es
fund_state:
  base: runway-empty-cash-only
expect:
  must_not_invoke: [Read, Glob, Bash]
  max_turns: 8
  max_tokens_out: 4000
runs: 3
threshold: 2
```

- [ ] **Step 1.3: Verify the YAMLs load cleanly**

```bash
pnpm build
node --input-type=module -e "import('./dist/services/eval/index.js').then(async ({ loadEvalCases }) => { const c = await loadEvalCases({ casesDir: 'tests/eval/cases', fixturesDir: 'tests/eval/fixtures' }); for (const x of c.filter(x => x.id.startsWith('mvp-'))) console.log(x.id, JSON.stringify({ must_invoke: x.expect.must_invoke, must_not_invoke: x.expect.must_not_invoke, max_turns: x.expect.max_turns, max_tokens_out: x.expect.max_tokens_out })); });"
```

Expected output (5 lines, ordered by id):
```
mvp-market-regime-spanish {"must_invoke":[],"must_not_invoke":["Read","Glob","Bash"],"max_turns":8,"max_tokens_out":4000}
mvp-opportunity-english {"must_invoke":[],"must_not_invoke":["Read","Glob","Bash"],"max_turns":5,"max_tokens_out":3000}
mvp-opportunity-explicit-screener {"must_invoke":["mcp__screener__screen_run"],"must_not_invoke":[],"max_turns":10,"max_tokens_out":5000}
mvp-opportunity-spanish {"must_invoke":[],"must_not_invoke":["Read","Glob","Bash"],"max_turns":5,"max_tokens_out":3000}
mvp-portfolio-review-spanish {"must_invoke":[],"must_not_invoke":["Read","Glob","Bash"],"max_turns":5,"max_tokens_out":3000}
```

- [ ] **Step 1.4: Commit**

```bash
git add tests/eval/cases/mvp-portfolio-review-spanish.yaml tests/eval/cases/mvp-market-regime-spanish.yaml
git -c commit.gpgsign=false commit -m "test(eval): reshape portfolio-review and market-regime cases to outcome-based"
```

---

## Task 2: `sessionModePrefix` helper + `chat.service.ts` integration

**Why:** This is the structural change that makes the carve-out explicit. The helper produces the mode-line string used by both callers. Adding it to `chat.service.ts` first lets us validate the prompt shape via unit tests before wiring the autonomous side.

**Files:**
- Create: `tests/session-mode-prefix.test.ts`
- Modify: `src/services/chat.service.ts`

- [ ] **Step 2.1: Write the failing test for `sessionModePrefix`**

Create `tests/session-mode-prefix.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sessionModePrefix } from "../src/services/chat.service.js";

describe("sessionModePrefix", () => {
  it("returns the chat-mode line for interactive-chat", () => {
    const out = sessionModePrefix("interactive-chat");
    expect(out).toMatch(/^Session mode: interactive chat\b/);
    expect(out).toContain("context above contains the fund state");
    expect(out).toContain("respond to the user's message directly");
  });

  it("returns the autonomous-mode line for autonomous-scheduled", () => {
    const out = sessionModePrefix("autonomous-scheduled");
    expect(out).toMatch(/^Session mode: autonomous scheduled\b/);
    expect(out).toContain("Follow the session-init rule");
    expect(out).toContain("Orient sequence");
  });

  it("returns a single-line string with no embedded newlines", () => {
    expect(sessionModePrefix("interactive-chat")).not.toContain("\n");
    expect(sessionModePrefix("autonomous-scheduled")).not.toContain("\n");
  });
});
```

- [ ] **Step 2.2: Run the test — expect FAIL**

```bash
pnpm vitest run tests/session-mode-prefix.test.ts
```

Expected: FAIL with `sessionModePrefix is not exported` or module-not-found.

- [ ] **Step 2.3: Add the helper to `src/services/chat.service.ts`**

Open `src/services/chat.service.ts`. Near the top of the file (after the imports, before the first existing exported function), add:

```ts
export type SessionMode = "interactive-chat" | "autonomous-scheduled";

/** Returns the single-line mode prefix prepended to the user prompt for fresh
 * (non-resumed) sessions. The session-init.md FUND_RULE reads this line to
 * decide whether to apply the Orient sequence (autonomous) or skip it (chat).
 */
export function sessionModePrefix(mode: SessionMode): string {
  if (mode === "interactive-chat") {
    return "Session mode: interactive chat. The context above contains the fund state — respond to the user's message directly, calling MCPs only when you need fresher data than the context provides.";
  }
  return "Session mode: autonomous scheduled. Follow the session-init rule's Orient sequence (read handoff + state files + write Session Contract) before any analysis.";
}
```

- [ ] **Step 2.4: Run the unit test — expect PASS**

```bash
pnpm vitest run tests/session-mode-prefix.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 2.5: Wire `sessionModePrefix` into the chat.service fund first-turn prompt**

Find the `textPrompt` ternary in `runChatTurn` (currently around line 509-533). Locate the second branch (fund + first turn — the array starting with `\`You are an interactive chat session for the FundX investment fund "${fundName}".\``).

Modify only that branch — prepend `sessionModePrefix("interactive-chat")` and a blank line as the first two array elements:

**Before:**
```ts
    : fundName
    ? [
        `You are an interactive chat session for the FundX investment fund "${fundName}".`,
        `You have access to MCP tools for market data and broker operations.`,
        `Be concise and helpful. Use specific numbers when available.`,
        readonlyNote,
        "",
        context,
        "",
        `This is your first interaction. The context above already contains current`,
        `portfolio, objective, and watchlist data — use it to orient yourself before`,
        `responding. Only read additional files (e.g. session-handoff.md) if the`,
        `data-freshness block indicates the context is stale or you need narrative detail.`,
        "",
        "## User Message",
        message,
      ].join("\n")
```

**After:**
```ts
    : fundName
    ? [
        sessionModePrefix("interactive-chat"),
        "",
        `You are an interactive chat session for the FundX investment fund "${fundName}".`,
        `You have access to MCP tools for market data and broker operations.`,
        `Be concise and helpful. Use specific numbers when available.`,
        readonlyNote,
        "",
        context,
        "",
        "## User Message",
        message,
      ].join("\n")
```

Two changes:
- Prepend `sessionModePrefix("interactive-chat")` and `""` as the first two elements.
- Remove the 4-line `This is your first interaction...` block (lines 520-523 in the current source). The mode prefix already says "respond to the user's message directly, calling MCPs only when you need fresher data" which subsumes the removed block. Removing it avoids redundancy and reduces token usage.

The other two branches (`sessionId` resumed; `fundName === null` workspace) are unchanged.

- [ ] **Step 2.6: Verify the existing `tests/chat-context.test.ts` still passes**

```bash
pnpm vitest run tests/chat-context.test.ts
```

Expected: 12 tests PASS (the prefix is added inside `runChatTurn`, not inside `buildChatContext`, so context tests are unaffected).

- [ ] **Step 2.7: Search for any test that asserts on the full prompt sent to the SDK**

```bash
grep -rn "first interaction\|already contains current\|This is your first" tests/ src/
```

Expected: zero matches. If matches exist, those tests assumed the removed text — update or remove the assertion.

- [ ] **Step 2.8: Run the full suite, typecheck, build**

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: all green, no regressions.

- [ ] **Step 2.9: Commit**

```bash
git add src/services/chat.service.ts tests/session-mode-prefix.test.ts
git -c commit.gpgsign=false commit -m "feat(chat-service): sessionModePrefix helper + interactive-chat prefix injection"
```

---

## Task 3: `session.service.ts` integration

**Why:** Mirror change on the autonomous side. The existing prompt at `src/services/session.service.ts:88-105` already says "Follow your session-init rule to orient yourself" in plain text — adding the explicit `Session mode: autonomous scheduled` prefix line tells the agent which branch of `## Applies to` to follow.

**Files:**
- Modify: `src/services/session.service.ts`

- [ ] **Step 3.1: Read the current prompt construction**

```bash
sed -n '85,110p' src/services/session.service.ts
```

Confirm the array shape matches the assumption (starts with `\`You are running a ${sessionType}...\``). If the structure has changed, abort and report `NEEDS_CONTEXT` — do not guess at where to insert the prefix.

- [ ] **Step 3.2: Add the import**

At the top of `src/services/session.service.ts`, add to the existing import from `chat.service.js` (or create a new import line):

```ts
import { sessionModePrefix } from "./chat.service.js";
```

Verify with `grep -n "from \"./chat.service.js\"" src/services/session.service.ts` — if there is already an import from that module, extend its destructuring instead of duplicating.

- [ ] **Step 3.3: Prepend the mode prefix to the prompt array**

Modify the `prompt` array (around line 88-105). Insert two elements at the top:

**Before:**
```ts
  const prompt = [
    `You are running a ${sessionType} session for fund '${fundName}'.`,
    ``,
    `Focus: ${focus}`,
    ...
```

**After:**
```ts
  const prompt = [
    sessionModePrefix("autonomous-scheduled"),
    ``,
    `You are running a ${sessionType} session for fund '${fundName}'.`,
    ``,
    `Focus: ${focus}`,
    ...
```

Do not modify any other array elements (universe block, debate-skills paragraph, "Follow your session-init rule" line, analysis output line). Those continue to do their existing work.

- [ ] **Step 3.4: Run the full suite, typecheck, build**

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: green, no regressions. Existing session-related tests (if any) should still pass — the mode prefix is additive at the start of the prompt.

- [ ] **Step 3.5: Verify the build artifact contains both prefix variants**

```bash
grep -c "Session mode: interactive chat" dist/index.js
grep -c "Session mode: autonomous scheduled" dist/index.js
```

Both should return ≥ 1.

- [ ] **Step 3.6: Commit**

```bash
git add src/services/session.service.ts
git -c commit.gpgsign=false commit -m "feat(session-service): autonomous-scheduled prefix injection"
```

---

## Task 4: `session-init.md` rewrite

**Why:** The rule must teach the agent how to interpret the mode prefix. The new `## Applies to` section explicitly distinguishes chat (skip the steps) from autonomous (follow them). The 6 numbered steps remain — they are correct for autonomous mode.

**Files:**
- Modify: `src/skills.ts`
- Modify: `tests/skills.test.ts`

- [ ] **Step 4.1: Write the failing test**

Open `tests/skills.test.ts`. Append to the existing `describe` block (or add a new `describe`):

```ts
describe("FUND_RULES session-init.md mode-aware revision", () => {
  it("session-init.md has the Applies to section distinguishing chat from autonomous", () => {
    const entry = FUND_RULES.find((r) => r.fileName === "session-init.md")!;
    expect(entry.content).toContain("## Applies to");
    expect(entry.content).toContain("Session mode: interactive chat");
    expect(entry.content).toContain("Session mode: autonomous scheduled");
  });

  it("session-init.md no longer uses 'Mandatory Sequence' in the title", () => {
    const entry = FUND_RULES.find((r) => r.fileName === "session-init.md")!;
    expect(entry.content).not.toContain("Mandatory Sequence");
    expect(entry.content).toMatch(/^# Session Initialization\s*$/m);
  });

  it("session-init.md keeps the 6 numbered steps", () => {
    const entry = FUND_RULES.find((r) => r.fileName === "session-init.md")!;
    // The 6 steps are well-formed, numbered, and present
    for (let i = 1; i <= 6; i++) {
      expect(entry.content).toMatch(new RegExp(`^${i}\\.\\s+\\*\\*`, "m"));
    }
  });
});
```

- [ ] **Step 4.2: Run the test — expect FAIL**

```bash
pnpm vitest run tests/skills.test.ts -t "session-init.md mode-aware"
```

Expected: 3 tests FAIL — current content has "Mandatory Sequence" and lacks "## Applies to".

- [ ] **Step 4.3: Modify the `session-init.md` content in `src/skills.ts`**

Locate the `FUND_RULES` entry with `fileName: "session-init.md"` (currently line ~1373). Modify only the title, the first procedural sentence, and insert the new `## Applies to` and `## Sequence (autonomous mode)` sections.

**Before** (the relevant top of the content template literal):

```ts
    fileName: "session-init.md",
    content: `# Session Initialization — Mandatory Sequence

Before ANY analysis or action, complete these steps IN ORDER:

1. **Read handoff** — Read \`state/session-handoff.md\`. Understand what the last session did,
```

**After:**

```ts
    fileName: "session-init.md",
    content: `# Session Initialization

## Applies to

This sequence applies to **autonomous scheduled sessions**. The prompt prefix
will tell you which mode you are in: \`Session mode: autonomous scheduled\`
means follow the steps below; \`Session mode: interactive chat\` means the
context above already contains the fund state this sequence would gather —
skip ahead to the user's message and call MCPs only when the data-freshness
block indicates the context is stale.

## Sequence (autonomous mode)

Before any analysis or action, complete these steps in order:

1. **Read handoff** — Read \`state/session-handoff.md\`. Understand what the last session did,
```

The rest of the content (steps 1 through 6 and any text after them, up to the closing template-literal backtick) is unchanged.

The escapes (`\``) are required because the content is a template literal — verify the existing entry already uses this pattern, and copy carefully.

- [ ] **Step 4.4: Run the test — expect PASS**

```bash
pnpm vitest run tests/skills.test.ts -t "session-init.md mode-aware"
```

Expected: 3 tests PASS.

- [ ] **Step 4.5: Run the full skills test file + full suite**

```bash
pnpm vitest run tests/skills.test.ts
pnpm test
pnpm typecheck
pnpm build
```

Expected: all green.

- [ ] **Step 4.6: Verify the build artifact contains the new content**

```bash
grep -c "## Applies to" dist/index.js
grep -c "Mandatory Sequence" dist/index.js
```

Expected: first ≥ 1, second 0.

- [ ] **Step 4.7: Commit**

```bash
git add src/skills.ts tests/skills.test.ts
git -c commit.gpgsign=false commit -m "feat(skills): session-init.md applies-to section + mode-aware language"
```

---

## Task 5: `CLAUDE.md` off-by-one fix and listing completeness

**Why:** `CLAUDE.md` describes "7 trading skills" — there are 8 (the count was made before `opportunity-screening` was added). The partial listings of `.claude/rules/` and `.claude/skills/` in the same doc are similarly outdated. Documentation that lies to readers (including future AI assistants) actively misleads them.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 5.1: Find all stale references**

```bash
grep -nE "7 trading|7 skills|7 fund skills|7 trading skills" CLAUDE.md
```

Note all line numbers reported. Typical locations: the directory-structure block in the Architecture section, and the `BUILTIN_SKILLS (7 fund skills)` mention in the "Skills and Rules Pattern" section.

- [ ] **Step 5.2: Replace each stale "7" with "8"**

Use individual `Edit` operations or `sed -i ''` (macOS) to change each occurrence. After the replacements, re-run:

```bash
grep -nE "7 trading|7 skills|7 fund skills" CLAUDE.md
```

Expected: zero matches.

- [ ] **Step 5.3: Find the partial `.claude/skills/` listing in CLAUDE.md**

```bash
grep -n "investment-thesis/SKILL.md" CLAUDE.md
```

Locate the surrounding block — it lists 7 skills. Add `        ├── opportunity-screening/SKILL.md` and `        └── portfolio-review/SKILL.md` (or adjust the tree characters so the last entry is `└──` not `├──`).

The complete listing should be (8 skills):

```
    └── skills/
        ├── investment-thesis/SKILL.md
        ├── risk-assessment/SKILL.md
        ├── trade-memory/SKILL.md
        ├── market-regime/SKILL.md
        ├── position-sizing/SKILL.md
        ├── session-reflection/SKILL.md
        ├── portfolio-review/SKILL.md
        └── opportunity-screening/SKILL.md
```

- [ ] **Step 5.4: Find the partial `.claude/rules/` listing in CLAUDE.md**

```bash
grep -n "state-consistency.md" CLAUDE.md
```

Locate the rules listing. Currently lists ~4 rules. Replace with all 11 (in the order they appear in `FUND_RULES`):

```
    ├── rules/
    │   ├── state-consistency.md       # config ↔ state sync
    │   ├── decision-quality.md        # decision hierarchy and standards
    │   ├── analysis-standards.md      # specificity and intellectual honesty
    │   ├── risk-discipline.md         # hard risk limits
    │   ├── learning-loop.md           # journal-driven knowledge compounding
    │   ├── market-awareness.md        # calendar and correlation awareness
    │   ├── self-scheduling.md         # follow-up session triggers
    │   ├── communication.md           # English persisted artifacts; chat mirrors user
    │   ├── session-init.md            # autonomous Orient sequence (chat skips it)
    │   ├── session-completion.md      # end-of-session verification
    │   └── data-access.md             # prefer MCPs over Read/Bash/Glob for fund state
```

Adjust the surrounding tree characters so the listing is consistent with the rest of the diagram.

- [ ] **Step 5.5: Verify no other stale references**

```bash
grep -nE "7 (rules|fund rules|trading)" CLAUDE.md
grep -c "data-access.md\|opportunity-screening" CLAUDE.md
```

Expected: first command zero matches; second command ≥ 2 (each name appears in the listing).

- [ ] **Step 5.6: Commit**

```bash
git add CLAUDE.md
git -c commit.gpgsign=false commit -m "docs(CLAUDE.md): fix 7→8 trading skills count + complete rule/skill listings"
```

---

## Task 6: Smoke test post-fix

**Why:** Validate the spec's success criterion C — all 5 MVP cases at ≥ 2/3 with zero regressions on the 3 cases that were passing.

**Prerequisites:** `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` exported.

**Files:**
- Create: `reports/2026-04-25-spec3-post-fix.json`

- [ ] **Step 6.1: Sanity check — build artifact**

```bash
pnpm build
grep -c "Session mode: interactive chat" dist/index.js
grep -c "Session mode: autonomous scheduled" dist/index.js
grep -c "## Applies to" dist/index.js
```

All three should return ≥ 1. If any returns 0, the build is stale or the changes from prior tasks did not land.

- [ ] **Step 6.2: Sanity check — auth and clean fund dir**

```bash
echo "auth: ${CLAUDE_CODE_OAUTH_TOKEN:+set}${ANTHROPIC_API_KEY:+set}"
ls ~/.fundx/funds/ | grep -E "^fundx-eval-" || echo "clean"
```

Expected: `auth: set` and `clean`. If leftover eval funds, remove them.

- [ ] **Step 6.3: Single-run diagnostic on `mvp-portfolio-review-spanish` (~$0.02)**

```bash
pnpm dev -- eval --case mvp-portfolio-review-spanish --runs 1 --json /tmp/eval-spec3-single.json
jq '.cases[0] | {id, passed, num_turns: .runs[0].num_turns, tokens_out: .runs[0].tokens_out, tool_history: [.runs[0].tool_history[].name]}' /tmp/eval-spec3-single.json
```

Expected: `passed: true` with no `Read`/`Glob`/`Bash` in the tool history. If FAIL:
- If `Read`/`Glob`/`Bash` appear → the carve-out did not deliver. Inspect: did the build pick up the new `session-init.md`? Was the chat.service prefix actually wired?
- If `max_turns` exceeded with only MCP tools → the agent is conversational; consider whether the case's `max_turns: 5` is too tight (do not adjust here without re-running and seeing the pattern across K=3).

- [ ] **Step 6.4: Single-run diagnostic on `mvp-market-regime-spanish` (~$0.02)**

```bash
pnpm dev -- eval --case mvp-market-regime-spanish --runs 1 --json /tmp/eval-spec3-market.json
jq '.cases[0] | {id, passed, num_turns: .runs[0].num_turns, tool_history: [.runs[0].tool_history[].name]}' /tmp/eval-spec3-market.json
```

Expected: `passed: true`. The agent is allowed to use any market-data tool — no `Read`/`Glob`/`Bash` is the new bar.

- [ ] **Step 6.5: Full MVP suite (K=3, ~$1.50–2.50, ~3–5 minutes)**

```bash
pnpm dev -- eval --filter mvp- --json reports/2026-04-25-spec3-post-fix.json
jq '.summary' reports/2026-04-25-spec3-post-fix.json
jq '.cases[] | {id, passed, passing_runs, total_runs}' reports/2026-04-25-spec3-post-fix.json
jq '{total_cost_usd, total_duration_ms}' reports/2026-04-25-spec3-post-fix.json
```

- [ ] **Step 6.6: Side-by-side comparison with the spec(2) baseline**

```bash
echo "=== Pre-spec(3) baseline ==="
jq '.cases[] | {id, passing_runs, total_runs}' reports/2026-04-24-post-fix-baseline.json
echo "=== Post-spec(3) ==="
jq '.cases[] | {id, passing_runs, total_runs}' reports/2026-04-25-spec3-post-fix.json
```

- [ ] **Step 6.7: Apply success criteria (locked: C — strict)**

For each of the 5 MVP cases:

| Case | Pre-spec(3) | Required post-spec(3) |
|---|---|---|
| `mvp-opportunity-spanish` | 3/3 | ≥ 2/3 (zero regression) |
| `mvp-opportunity-english` | 3/3 | ≥ 2/3 |
| `mvp-opportunity-explicit-screener` | 3/3 | ≥ 2/3 |
| `mvp-portfolio-review-spanish` | 0/3 | ≥ 2/3 (FLIP) |
| `mvp-market-regime-spanish` | 0/3 | ≥ 2/3 (FLIP) |

If any of the three "hold" cases regresses below 2/3: BLOCKER. Investigate before committing the baseline. Likely causes:
- The mode prefix interferes with the existing chat preamble (token order issue) — inspect the failed run's prompt via JSON
- The `## Applies to` section in `session-init.md` confused the agent in chat mode — escalate to a stronger language fix as a follow-up commit

If a flip case still fails:
- Inspect tool_history of failed runs
- If `Read`/`Glob`/`Bash` still appear despite both rules being loaded, the rules are being ignored — escalate to reinforcing the prefix message or adding a stronger negative directive in `data-access.md`

If 5/5 PASS with zero regressions: full win, proceed.

- [ ] **Step 6.8: Commit the baseline (only if criteria pass)**

Fill the placeholders with actual numbers from the JSON before committing:

```bash
git add reports/2026-04-25-spec3-post-fix.json
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
test(eval): post-fix MVP run — validates sub-project (3)

Pre-spec(3) → Post-spec(3) per case (pass rate out of 3):
- mvp-opportunity-spanish:          3/3 → <X>/3
- mvp-opportunity-english:          3/3 → <X>/3
- mvp-opportunity-explicit-screener: 3/3 → <X>/3
- mvp-portfolio-review-spanish:     0/3 → <X>/3 (reshaped + carve-out)
- mvp-market-regime-spanish:        0/3 → <X>/3 (reshaped + carve-out)

Full MVP suite: $<cost> / <wall_clock>s
Pre-spec(3) baseline: reports/2026-04-24-post-fix-baseline.json
EOF
)"
```

- [ ] **Step 6.9: Cleanup leftover eval funds**

```bash
ls ~/.fundx/funds/ | grep -E "^fundx-eval-" && for d in ~/.fundx/funds/fundx-eval-*; do rm -rf "$d"; done || echo "clean"
```

---

## Task 7: Final verification

**Why:** Confirm the tree is clean, all tests pass, and document the sub-project (3) close-out.

**Files:** None new; verification only.

- [ ] **Step 7.1: Verify clean tree and all tests pass**

```bash
git status
pnpm test
pnpm typecheck
pnpm build
```

Expected: no unstaged changes (other than pre-existing untracked files like `.DS_Store` etc.). Tests at ~660+ pass. Typecheck and build clean.

- [ ] **Step 7.2: Verify the commit log shows all sub-project (3) commits**

```bash
git log --oneline e1f3860..HEAD
```

Expected (in reverse chronological order):
```
<sha7>  test(eval): post-fix MVP run — validates sub-project (3)
<sha6>  docs(CLAUDE.md): fix 7→8 trading skills count + complete rule/skill listings
<sha5>  feat(skills): session-init.md applies-to section + mode-aware language
<sha4>  feat(session-service): autonomous-scheduled prefix injection
<sha3>  feat(chat-service): sessionModePrefix helper + interactive-chat prefix injection
<sha2>  test(eval): reshape portfolio-review and market-regime cases to outcome-based
```

(6 commits, plus the spec commit `e1f3860` itself, plus the plan commit which will be `<sha1>` if this plan was committed before execution.)

- [ ] **Step 7.3: Migration reminder for users with existing funds**

Existing funds on disk still have the OLD `session-init.md`. They should run:

```bash
fundx fund upgrade --all
```

once after this lands, so their `.claude/rules/session-init.md` is regenerated with the new `## Applies to` section. The migration note added in sub-project (2)'s Task 5 already documents this in `CLAUDE.md` under "Migration when FUND_RULES change" — no further docs change required.

The eval harness ephemeral funds are unaffected — they re-render rules on each seed.

- [ ] **Step 7.4: Sub-project (3) close-out — no commit needed**

Sub-project (3) is closed when:
1. All 7 tasks above are complete
2. `reports/2026-04-25-spec3-post-fix.json` shows 5/5 PASS with zero regressions
3. Test suite is green and the tree is clean

Sub-project (4) (extension to `ask` and autonomous sessions) can begin with this baseline.

---

## Self-review log (fill in during execution)

- [ ] No deviations
- [ ] Deviations (list below)

Notes from planning:
- Plan deviates from spec section 3 by using a smaller `sessionModePrefix(mode): string` helper instead of `buildSessionPrompt({mode, context, message, sessionId})`. Reason: preserves the existing `chat.service.ts` readonly note and fund preamble, which the spec's helper would have dropped (regression risk). Spec INTENT (testable, no agent inference) preserved.
- The 4-line `This is your first interaction. The context above already contains current portfolio, objective, and watchlist data...` block from `chat.service.ts:520-523` is REMOVED in Task 2 because the new `sessionModePrefix("interactive-chat")` line subsumes its content (both say "context above contains state, respond directly, MCP only for fresher data"). Removing it avoids redundancy and saves ~50 tokens per chat turn.

---

**End of plan.** When complete, sub-project (3) closes with the 5 MVP cases passing, the prompt ecosystem unchanged outside `session-init.md`, and the eval harness still serving as the regression gate for sub-project (4).
