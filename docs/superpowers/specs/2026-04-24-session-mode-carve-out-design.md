# Session Mode Carve-Out + Eval Assertion Reshape — Design Spec

**Date:** 2026-04-24
**Status:** Draft → pending user review
**Scope:** Sub-project (3) of the four-part prompt ecosystem initiative. Targeted to the specific gaps surfaced by sub-project (2)'s baseline — does not attempt a broad audit of the prompt ecosystem.

## Motivation

Sub-project (2) closed at 3/5 MVP eval cases passing. The two failing cases failed for **better** reasons than the original bug — they no longer trigger the "use generic tools instead of MCPs" pattern, but their assertions are still measuring mechanism (`must_invoke [specific tool]`) rather than outcome.

Concretely:

- **`mvp-portfolio-review-spanish` 0/3** — assertion exige `must_invoke: [mcp__broker-local__get_positions]`. Post sub-project (2), the agent answers correctly from the injected context without invoking the broker MCP. The assertion is obsolete.
- **`mvp-market-regime-spanish` 0/3** — assertion exige `must_invoke: [mcp__market-data__get_multi_snapshots]`. The agent legitimately uses any of `get_sector_performance`, `get_market_movers`, `get_quote`, `get_economic_calendar`, `get_rss_news`. The assertion arbitrarily prefers one tool.

A second observation from the same baseline: `session-init.md` (a `FUND_RULES` entry) instructs the agent to "Read handoff + portfolio + tracker + session log" in Orient. For autonomous scheduled sessions this is correct. For interactive chat where `buildChatContext` already inlines that state (post sub-project 2, commits `db893aa` + `a1bd4ed`), the Orient sequence is wasteful and produces the very `Read`/`Glob`/`Bash` calls the new `data-access.md` rule discourages. The rule applies indiscriminately to both modes.

A third, smaller, observation: `CLAUDE.md` describes the per-fund skills as "7 trading skills"; there are actually 8 (the count missed `opportunity-screening`).

This spec fixes those three things and only those three things. Broader audits of the other 10 `FUND_RULES`, the 8 `BUILTIN_SKILLS`, the 4 sub-agents in `subagent.ts`, and the per-fund template in `template.ts` are deliberately excluded — no failing eval evidence justifies touching them.

## Non-goals for this spec

- Auditing or modifying any `FUND_RULES` entry other than `session-init.md`
- Auditing or modifying any `BUILTIN_SKILLS` entry
- Modifying `src/subagent.ts`
- Modifying `src/template.ts` (per-fund CLAUDE.md generator)
- Extending the eval harness with OR-logic, glob assertions, response-content assertions, or minimum-token assertions
- Resolving the watchlist `fund` filter omission inherited from sub-project (2) Task 1
- Touching autonomous sessions or the `ask` command (sub-project (4))
- Adding new MVP or backlog eval cases

## Success criteria (locked decision: **C — strict**)

| Case | Pre-spec(3) baseline | Post-spec(3) target |
|---|---|---|
| `mvp-opportunity-spanish` | 3/3 PASS | **hold ≥ 2/3** (zero regression) |
| `mvp-opportunity-english` | 3/3 PASS | **hold ≥ 2/3** |
| `mvp-opportunity-explicit-screener` | 3/3 PASS | **hold ≥ 2/3** |
| `mvp-portfolio-review-spanish` | 0/3 FAIL | **flip to ≥ 2/3** (with reshaped assertions + carve-out) |
| `mvp-market-regime-spanish` | 0/3 FAIL | **flip to ≥ 2/3** (with reshaped assertions + carve-out) |

**Acceptance:** all five cases at ≥ 2/3 simultaneously. Anything less is a fail of the spec — including a regression on a previously-passing case while the new ones flip.

A regression in a passing case during the smoke is a stronger signal than a flip in a failing case: it means the carve-out broke a flow that worked. That is unacceptable; investigate before committing the post-fix baseline.

## Locked architectural decisions (from brainstorming on 2026-04-24)

| Decision | Choice | Rationale |
|---|---|---|
| Spec scope | Targeted: eval reshape + session-init carve-out + language calibration of `session-init.md` only + off-by-one fix in CLAUDE.md | YAGNI — no failing-eval evidence for the other rules/skills/sub-agents |
| Carve-out mechanism | Inject `Session mode: <chat\|autonomous>` prefix into the user prompt; `session-init.md` reads the prefix and acts accordingly | Explicit; no agent-side mode inference; minimum mechanical change |
| Carve-out implementation | Extract a pure `buildSessionPrompt({ mode, context, message, sessionId })` helper used by both `chat.service.ts` and `session.service.ts` | DRY; single source of truth; testable without LLM calls |
| Reshape strategy | Outcome-based assertions (`must_not_invoke [Read, Glob, Bash]` + `max_turns`) for both failing cases | Coherent with the 3 MVP cases that already pass; honest about what is being measured |
| Language calibration scope | Minimal rewrite of `session-init.md`: add `## Applies to` section, soften title and first paragraph, keep all 6 numbered steps intact | Surgical; low regression risk; the eval validates outcome |
| `session-init.md` 6-step sequence | **Unchanged** — the steps themselves are correct for autonomous sessions | The complaint is about overreach into chat, not about the steps' correctness |
| OR-logic / glob assertions in harness | **Not added** | YAGNI — when sub-project (4) brings cases that need it, justify then |
| `min_tokens_out` assertion to prevent empty answers passing the new outcome-based gates | **Not added** | Risk acknowledged; mitigation deferred to sub-project (4) if observed |

## Architecture

### Overview

```
                             ┌──────────────────────┐
                             │ buildSessionPrompt() │   pure helper, testable
                             │  pure function       │
                             └──────────┬───────────┘
                                        │
                  ┌─────────────────────┴────────────────────┐
                  │                                          │
        ┌─────────▼──────────┐                  ┌────────────▼────────┐
        │ chat.service.ts    │                  │ session.service.ts  │
        │ runChatTurn()      │                  │ runScheduledSession │
        │ mode: chat         │                  │ mode: autonomous    │
        └────────────────────┘                  └─────────────────────┘
                  │                                          │
                  ▼                                          ▼
        agent SDK query()                          agent SDK query()
                                                       │
                                                       ▼
                                          .claude/rules/session-init.md
                                          (read by SDK from cwd)
                                          contains "## Applies to" section
                                          that distinguishes by mode
```

### `buildSessionPrompt` helper

**Location:** new exported function in `src/services/chat.service.ts` (where the existing prompt-construction logic already lives) or a new file `src/services/session-prompt.ts`. Recommendation: keep it in `chat.service.ts` to avoid file fragmentation; export it for the session.service to import.

**Signature:**

```ts
export interface BuildSessionPromptInput {
  mode: "interactive-chat" | "autonomous-scheduled";
  context: string;       // output of buildChatContext (or the autonomous equivalent)
  message: string;       // user message in chat, or the scheduled task description
  sessionId?: string;    // present for resumed sessions
}

export function buildSessionPrompt(input: BuildSessionPromptInput): string {
  // For resumed sessions, the mode prefix and context were already established
  // on turn 1 — return the message as-is.
  if (input.sessionId) return input.message;

  const modeLine = input.mode === "interactive-chat"
    ? "Session mode: interactive chat. The context above contains the fund state — respond to the user's message directly, calling MCPs only when you need fresher data than the context provides."
    : "Session mode: autonomous scheduled. Follow the session-init rule's Orient sequence (read handoff + state files + write Session Contract) before any analysis.";

  return [modeLine, "", input.context, "", input.message].join("\n");
}
```

**Properties:**

- Pure: no IO, no side effects.
- Idempotent: same inputs → same output.
- Resumed sessions skip the prefix because turn 1 already established the mode and context.

**Tests** (`tests/session-prompt.test.ts` — new file):

```ts
import { describe, it, expect } from "vitest";
import { buildSessionPrompt } from "../src/services/chat.service.js";

describe("buildSessionPrompt", () => {
  it("interactive chat mode prepends the chat-mode hint", () => {
    const p = buildSessionPrompt({ mode: "interactive-chat", context: "ctx", message: "hi" });
    expect(p).toContain("Session mode: interactive chat");
    expect(p).toContain("ctx");
    expect(p).toContain("hi");
    expect(p).not.toContain("Follow the session-init");
  });

  it("autonomous scheduled mode prepends the orient-sequence reminder", () => {
    const p = buildSessionPrompt({ mode: "autonomous-scheduled", context: "ctx", message: "scheduled task" });
    expect(p).toContain("Session mode: autonomous scheduled");
    expect(p).toContain("Follow the session-init");
    expect(p).toContain("scheduled task");
  });

  it("resumed sessions return the message unchanged", () => {
    const p = buildSessionPrompt({
      mode: "interactive-chat", context: "ctx", message: "follow-up", sessionId: "abc",
    });
    expect(p).toBe("follow-up");
    expect(p).not.toContain("Session mode:");
    expect(p).not.toContain("ctx");
  });

  it("interactive chat ordering: mode line, blank, context, blank, message", () => {
    const p = buildSessionPrompt({ mode: "interactive-chat", context: "CTX", message: "MSG" });
    const lines = p.split("\n");
    expect(lines[0]).toMatch(/^Session mode: interactive chat/);
    expect(lines[1]).toBe("");
    expect(lines.slice(2).join("\n")).toContain("CTX");
    expect(lines[lines.length - 1]).toBe("MSG");
  });
});
```

### `session-init.md` changes

**Located at:** `src/skills.ts` line ~1373, in the `FUND_RULES` array entry with `fileName: "session-init.md"`.

**Change scope:** rewrite ONLY the title, the first procedural sentence, and add a new `## Applies to` section before the steps. The 6 numbered steps remain intact byte-for-byte.

**Before** (current):

```markdown
# Session Initialization — Mandatory Sequence

Before ANY analysis or action, complete these steps IN ORDER:

1. **Read handoff** — Read `state/session-handoff.md`. Understand what the last session did,
   what positions are open, and what was deferred.
2. **Read state files** — ...
[... 4 more steps ...]
```

**After:**

```markdown
# Session Initialization

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
   what positions are open, and what was deferred.
2. **Read state files** — ...
[... 4 more steps unchanged ...]
```

**Concrete diff:**

- Title: `# Session Initialization — Mandatory Sequence` → `# Session Initialization`
- New `## Applies to` paragraph (8 lines) inserted between title and sequence
- New `## Sequence (autonomous mode)` heading inserted before the procedural sentence
- Procedural sentence: `Before ANY analysis or action, complete these steps IN ORDER:` → `Before any analysis or action, complete these steps in order:`
- Steps 1–6: **no edits**

Net: ~10 lines added.

### Caller integration

**`src/services/chat.service.ts`** — locate the prompt-construction block where the post-spec(2) context-injection lives (commit `a1bd4ed`). Replace the inline construction with a call to `buildSessionPrompt`:

```ts
// Before (illustrative; current shape)
const userPrompt = sessionId
  ? message
  : `${context}\n\n[context-injection notice]\n\n${message}`;

// After
const userPrompt = buildSessionPrompt({
  mode: "interactive-chat",
  context,
  message,
  sessionId,
});
```

**`src/services/session.service.ts`** — locate the prompt-construction block for autonomous scheduled sessions. Without seeing the file, the implementer should grep for callers of `runChatTurn` (or the SDK `query()`) inside that file and inject the helper at the same entry point:

```ts
const sessionPrompt = buildSessionPrompt({
  mode: "autonomous-scheduled",
  context,
  message: scheduledTaskDescription,
  // No sessionId — autonomous sessions are always fresh starts of the SDK turn loop
});
```

The implementer must read `src/services/session.service.ts` first to confirm where prompt construction lives. If the structure differs from the assumption, report `NEEDS_CONTEXT` rather than guessing.

### Eval case reshape

**`tests/eval/cases/mvp-portfolio-review-spanish.yaml`:**

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

**`tests/eval/cases/mvp-market-regime-spanish.yaml`:**

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

The 3 other MVP YAMLs (`mvp-opportunity-spanish`, `mvp-opportunity-english`, `mvp-opportunity-explicit-screener`) and the 13 backlog cases are unchanged.

### Off-by-one fix in `CLAUDE.md`

Three locations touched:

1. Architecture/Directory Structure — `7 trading skills` → `8 trading skills` in the comment line `└── skills/             # 7 trading skills (generated on fund creation)`.
2. Skills and Rules Pattern — the partial listing of `.claude/skills/` is extended to include `opportunity-screening/SKILL.md`. The partial listing of `.claude/rules/` is extended to include all 11 entries (current ones plus `data-access.md` from sub-project (2)). Out-of-date partial listings actively mislead future agents reading the doc.
3. "Where skills are defined" — `BUILTIN_SKILLS (7 fund skills)` → `BUILTIN_SKILLS (8 fund skills)`.

A `grep -n "7 trading\|7 skills\|7 fund skills" CLAUDE.md` should return zero matches after the edits.

### Test updates beyond the new file

**`tests/skills.test.ts`** — extend with two assertions on the rewritten `session-init.md` content:

```ts
it("session-init.md has the Applies to section distinguishing chat from autonomous", () => {
  const entry = FUND_RULES.find((r) => r.fileName === "session-init.md")!;
  expect(entry.content).toContain("## Applies to");
  expect(entry.content).toContain("Session mode: interactive chat");
  expect(entry.content).toContain("Session mode: autonomous scheduled");
});

it("session-init.md no longer uses 'Mandatory Sequence' in the title", () => {
  const entry = FUND_RULES.find((r) => r.fileName === "session-init.md")!;
  expect(entry.content).not.toContain("Mandatory Sequence");
});
```

**Existing tests to verify do not break:**

- `tests/chat-context.test.ts` (12 tests of `buildChatContext`) — the prefix is *outside* `buildChatContext`, so its output is unaffected.
- Any test that asserts on the full prompt sent to the SDK — search with `grep -rn "Follow your session-init\|read handoff, state files, write" tests/`. If matches exist, they must be updated to the new prefix shape.

### Smoke test workflow (Task 4 in the plan)

1. **Sanity check the build** — `pnpm build` and confirm `dist/index.js` contains the new strings:
   ```bash
   grep -c "Session mode: interactive chat" dist/index.js
   grep -c "Session mode: autonomous scheduled" dist/index.js
   grep -c "Applies to" dist/index.js
   ```
   All three should return ≥ 1.

2. **Single-run diagnostic** — `pnpm dev -- eval --case mvp-portfolio-review-spanish --runs 1 --json /tmp/eval-spec3-single.json`. Inspect `tool_history` and `passed`.

3. **Full MVP suite** — `pnpm dev -- eval --filter mvp- --json reports/2026-04-24-spec3-post-fix.json`. Expected ~3-5 min, ~$1.50-2.50.

4. **Side-by-side comparison** with `reports/2026-04-24-post-fix-baseline.json` (the spec(2) baseline).

5. **Apply success criteria C** — must be 5/5 PASS with zero regressions; otherwise BLOCKER.

6. **Commit baseline** with a descriptive message (template provided in the plan).

7. **Cleanup** any leftover `fundx-eval-*` ephemeral fund dirs.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| The mode prefix confuses the model and causes regression in a passing case | Pure-helper unit tests validate prompt shape; the smoke test catches behavior regressions before commit |
| `session-init.md`'s "Applies to" text is ignored because the rule is still long | If observed, escalate to a stronger language-calibration pass (deferred from Option B/C in brainstorming) |
| `session.service.ts` does not have the structure assumed by this spec | Implementer reads the file first; reports `NEEDS_CONTEXT` if the prompt-construction site is different |
| The reshaped `market-regime-spanish` case allows empty/lazy answers to pass | Risk acknowledged. Mitigation deferred to sub-project (4) (`min_tokens_out` assertion or response-content check) |
| Listing all 11 rules + 8 skills in CLAUDE.md generates manual maintenance debt | Accept the cost in v1; a future spec can generate the listing programmatically |
| The build artifact does not include the new rule content (stale dist) | Sanity step #1 in the smoke test catches this |

## Token + cost forecast

| | Pre-spec(3) | Post-spec(3) estimated |
|---|---|---|
| Per-turn input | ~4750 tokens | ~4800 (+~50 for the mode prefix) |
| Per-turn output (reshaped cases) | ~1500–3000 | ~1000–2500 (more direct with context awareness) |
| Full MVP suite cost | $1.61 | ~$1.50–2.50 |
| Full MVP suite wall clock | 204s | ~180–220s |

Net: comparable to pre-spec(3); the marginal input increase is offset by reduced turns in the two flipped cases.

## Out-of-scope reminder

This spec does **not**:

- Modify any `FUND_RULES` entry except `session-init.md`
- Modify any `BUILTIN_SKILLS` entry
- Modify `src/subagent.ts` or `src/template.ts`
- Extend the eval harness (no new assertion types, no OR-logic, no `min_tokens_out`)
- Resolve the watchlist `fund` filter omission
- Touch autonomous sessions or the `ask` command beyond the prompt prefix
- Add new MVP or backlog cases

When the smoke test is committed showing 5/5 MVP PASS and zero regressions, this spec is done. Sub-project (4) — extension to `ask` and autonomous sessions — picks up next.
