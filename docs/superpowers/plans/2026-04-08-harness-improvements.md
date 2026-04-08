# Harness Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 7 session harness improvements for better continuity, decision quality, and maintainability across autonomous and interactive sessions.

**Architecture:** Changes are additive to the existing session harness. New rules and an extended skill are defined in `src/skills.ts`, a new sub-agent in `src/subagent.ts`, a new state path in `src/paths.ts`, plain-text read/write helpers in `src/state.ts`, simplified session prompt in `src/services/session.service.ts`, updated Session Protocol in `src/template.ts`, and analysis cleanup in `src/services/daemon.service.ts`. The harness audit document is a standalone markdown file.

**Tech Stack:** TypeScript, Vitest, Node.js fs/promises

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/paths.ts` | Modify | Add `sessionHandoff` to `fundPaths()` return |
| `src/state.ts` | Modify | Add `readSessionHandoff()` and `writeSessionHandoff()` |
| `src/skills.ts` | Modify | Add 2 new rules to `FUND_RULES`; extend session-reflection skill with contract eval + handoff generation |
| `src/subagent.ts` | Modify | Add `trade-evaluator` agent; add file-write instructions to all 3 existing agents |
| `src/template.ts` | Modify | Update Orient step and Validate step in Session Protocol; add `session-handoff.md` to State Files list |
| `src/services/session.service.ts` | Modify | Simplify session prompt |
| `src/services/daemon.service.ts` | Modify | Add analysis file cleanup to daily cron |
| `docs/harness-audit.md` | Create | Harness evolution audit framework |
| `tests/paths.test.ts` | Modify | Test new `sessionHandoff` path |
| `tests/state.test.ts` | Modify | Test handoff read/write |
| `tests/skills.test.ts` | Modify | Test new rules and extended skill |
| `tests/subagent.test.ts` | Modify | Test trade-evaluator agent and file-write instructions |
| `tests/template.test.ts` | Modify | Test updated Session Protocol |
| `tests/session.test.ts` | Modify | Test simplified prompt |

---

### Task 1: Add sessionHandoff path to paths.ts

**Files:**
- Modify: `src/paths.ts:82-94` (state object in `fundPaths()`)
- Test: `tests/paths.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/paths.test.ts`:

```typescript
it("includes sessionHandoff in state paths", () => {
  const paths = fundPaths("test-fund");
  expect(paths.state.sessionHandoff).toBe(
    join(FUNDS_DIR, "test-fund", "state", "session-handoff.md"),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/paths.test.ts --reporter=verbose`
Expected: FAIL — `sessionHandoff` does not exist on the state object.

- [ ] **Step 3: Add sessionHandoff path**

In `src/paths.ts`, inside the `state` object returned by `fundPaths()`, after line 93 (`sessionCounts`), add:

```typescript
      sessionHandoff: join(root, "state", "session-handoff.md"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/paths.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts tests/paths.test.ts
git commit -m "feat: add sessionHandoff path to fundPaths"
```

---

### Task 2: Add readSessionHandoff / writeSessionHandoff to state.ts

**Files:**
- Modify: `src/state.ts:237-255` (after Session Counts section)
- Test: `tests/state.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/state.test.ts` (following the existing pattern that mocks `fs`):

```typescript
describe("Session Handoff", () => {
  it("reads handoff markdown from the correct path", async () => {
    mockedReadFile.mockResolvedValueOnce("# Session Handoff — 2026-04-08 pre-market\n\n## Session Contract\n> Orient complete.");
    const content = await readSessionHandoff("test-fund");
    expect(content).toContain("# Session Handoff");
    expect(mockedReadFile).toHaveBeenCalledWith(
      expect.stringContaining("session-handoff.md"),
      "utf-8",
    );
  });

  it("returns null when handoff file does not exist", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedReadFile.mockRejectedValueOnce(err);
    const content = await readSessionHandoff("test-fund");
    expect(content).toBeNull();
  });

  it("writes handoff markdown to the correct path", async () => {
    await writeSessionHandoff("test-fund", "# Handoff content");
    expect(mockedMkdir).toHaveBeenCalled();
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("session-handoff.md"),
      "# Handoff content",
      "utf-8",
    );
  });
});
```

Also add `readSessionHandoff` and `writeSessionHandoff` to the import from `../src/state.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/state.test.ts --reporter=verbose`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement readSessionHandoff and writeSessionHandoff**

In `src/state.ts`, after the Session Counts section (after line 255), add:

```typescript
// ── Session Handoff ──────────────────────────────────────────

export async function readSessionHandoff(fundName: string): Promise<string | null> {
  const paths = fundPaths(fundName);
  try {
    return await readFile(paths.state.sessionHandoff, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeSessionHandoff(fundName: string, content: string): Promise<void> {
  const paths = fundPaths(fundName);
  await mkdir(dirname(paths.state.sessionHandoff), { recursive: true });
  await writeFile(paths.state.sessionHandoff, content, "utf-8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/state.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: add session handoff read/write to state.ts"
```

---

### Task 3: Add session-init and session-completion rules to FUND_RULES

**Files:**
- Modify: `src/skills.ts:1204` (end of `FUND_RULES` array, before the closing `];`)
- Test: `tests/skills.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/skills.test.ts`, in the imports, add `ensureFundRules` if not already imported. Then add a new describe block:

```typescript
describe("FUND_RULES", () => {
  it("includes session-init rule", async () => {
    await ensureFundRules("/test/fund/.claude");
    const calls = mockedWriteFile.mock.calls.map((c) => c[0] as string);
    expect(calls.some((p) => p.endsWith("session-init.md"))).toBe(true);
    const initCall = mockedWriteFile.mock.calls.find((c) => (c[0] as string).endsWith("session-init.md"));
    const content = initCall![1] as string;
    expect(content).toContain("Session Initialization");
    expect(content).toContain("Read handoff");
    expect(content).toContain("session-handoff.md");
    expect(content).toContain("Session Contract");
    expect(content).toContain("Session-Type Priorities");
    expect(content).toContain("pre-market");
    expect(content).toContain("post-market");
    expect(content).toContain("catch-up");
  });

  it("includes session-completion rule", async () => {
    await ensureFundRules("/test/fund/.claude");
    const calls = mockedWriteFile.mock.calls.map((c) => c[0] as string);
    expect(calls.some((p) => p.endsWith("session-completion.md"))).toBe(true);
    const completionCall = mockedWriteFile.mock.calls.find((c) => (c[0] as string).endsWith("session-completion.md"));
    const content = completionCall![1] as string;
    expect(content).toContain("Session Completion");
    expect(content).toContain("Verification Required");
    expect(content).toContain("Data-backed claims");
    expect(content).toContain("Handoff written");
    expect(content).toContain("session-handoff.md");
    expect(content).toContain("Reflection completed");
    expect(content).toContain("Contract evaluated");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/skills.test.ts --reporter=verbose`
Expected: FAIL — no `session-init.md` or `session-completion.md` files written.

- [ ] **Step 3: Add the two new rules to FUND_RULES**

In `src/skills.ts`, inside the `FUND_RULES` array, before the closing `];` (after the `communication.md` entry ending at line 1203), add two new rule objects:

```typescript
  {
    fileName: "session-init.md",
    content: `# Session Initialization — Mandatory Sequence

Before ANY analysis or action, complete these steps IN ORDER:

1. **Read handoff** — Read \`state/session-handoff.md\`. Understand what the last session did,
   what it deferred, and what it recommended for this session. If missing or stale (>24h),
   note this and proceed — you will rely more heavily on state files.

2. **Read state** — Read \`state/portfolio.json\` and \`state/objective_tracker.json\`.
   Know current positions, cash, total value, and objective progress.

3. **Read session log** — Read \`state/session_log.json\`. Check last session status, cost,
   timing. If the last session errored, investigate why before proceeding.

4. **Check pending** — Read \`state/pending_sessions.json\`. Was this session self-scheduled?
   If so, the reason is in the pending entry — address it.

5. **Verify state integrity** — Portfolio cash + sum(position market_values) should
   approximate total_value (within 2%). If not, investigate before trading.

6. **Write Session Contract** — Write a minimal handoff to \`state/session-handoff.md\` with
   your session contract:

   > Orient complete. Portfolio: $[cash] cash, [N] positions, [X]% toward objective.
   > Last session: [type] on [date], status [ok/error].
   > This session intent: [what you plan to do and why].

   This serves two purposes: confirms you completed Orient, and ensures the next session
   has context even if this session is interrupted.

Only after completing all 6 steps, proceed with analysis.

## Session-Type Priorities

After Orient, prioritize based on session type:

- **pre-market**: Overnight developments, regime check, plan today's actions, set alerts
- **mid-session**: Verify morning thesis still valid, check price levels, execute if triggers hit
- **post-market**: Close-of-day review, full reflection, comprehensive handoff for tomorrow
- **catch-up**: Understand what was missed, compressed analysis, flag anything urgent
- **pending (self-scheduled)**: Address the specific reason this session was scheduled
- **chat (interactive)**: Read handoff for context, then respond to user's needs

## Analysis Reuse

After Orient, before launching sub-agents, check \`analysis/\` for assessments from
the last 4 hours. If a market-assessment exists from today and conditions have not changed
materially, you may reference it instead of re-running the market-analyst. This saves turns
and cost.

Reuse criteria: same trading day, no major news since assessment, regime has not shifted.
`,
  },
  {
    fileName: "session-completion.md",
    content: `# Session Completion — Verification Required

Before ending any session, verify ALL of the following:

1. **Data-backed claims**: Every recommendation or assessment made this session has
   supporting data retrieved from a tool call THIS session. No claims from memory or
   prior sessions without fresh verification.

2. **Trade integrity**: If trades were executed, verify:
   - \`portfolio.json\` reflects the trades (read it back)
   - Trade journal entry exists with thesis, stop-loss, and R-value
   - Telegram notification was sent

3. **Analysis quality**: If analysis was written to \`analysis/\`, verify it contains
   specific numbers, dates, and sources. Flag and fix any vague language.

4. **Handoff written**: \`state/session-handoff.md\` has been updated with the full
   handoff (not just the contract from Orient).

5. **Reflection completed**: Session Reflection skill has been run. Even "nothing
   happened" sessions require reflection on why inaction was chosen and whether
   it was correct.

6. **Objective tracker current**: \`state/objective_tracker.json\` reflects current
   portfolio value and progress.

7. **Contract evaluated**: The Session Contract from Orient has been compared against
   actual outcomes in the reflection.

If any check fails, address it before ending. Do not skip checks because "the session
is running low on turns" — an incomplete handoff costs more than an extra turn.
`,
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/skills.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills.ts tests/skills.test.ts
git commit -m "feat: add session-init and session-completion fund rules"
```

---

### Task 4: Extend Session Reflection skill with contract evaluation and handoff generation

**Files:**
- Modify: `src/skills.ts:490-593` (the Session Reflection skill in `BUILTIN_SKILLS`)
- Test: `tests/skills.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the existing "includes Session Reflection skill" test in `tests/skills.test.ts`:

```typescript
  it("Session Reflection skill includes contract evaluation section", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Session Reflection");
    expect(skill!.content).toContain("Contract Evaluation");
    expect(skill!.content).toContain("Stated intent");
    expect(skill!.content).toContain("Actual outcome");
    expect(skill!.content).toContain("deviation justified");
  });

  it("Session Reflection skill includes handoff generation section", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Session Reflection");
    expect(skill!.content).toContain("Session Handoff");
    expect(skill!.content).toContain("session-handoff.md");
    expect(skill!.content).toContain("What I Did");
    expect(skill!.content).toContain("Open Concerns");
    expect(skill!.content).toContain("Deferred Decisions");
    expect(skill!.content).toContain("Next Session Should");
    expect(skill!.content).toContain("Market Context Snapshot");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/skills.test.ts --reporter=verbose`
Expected: FAIL — skill content doesn't contain the new sections.

- [ ] **Step 3: Extend the Session Reflection skill**

In `src/skills.ts`, find the Session Reflection skill's `content` string (starts around line 496). Before the closing backtick of the content (around line 593, after the Follow-Up Scheduling section), add two new sections:

Locate the line:
```
See \`.claude/rules/self-scheduling.md\` for the format.
```

After it, add:

```

### 6. Contract Evaluation
Compare your Session Contract (written during Orient) against actual outcomes:

- **Stated intent**: [copy the contract verbatim from session start]
- **Actual outcome**: [what actually happened]
- **Deviation**: [if any, describe what changed and why]
- **Was the deviation justified?**: [yes/no + reasoning]

This closes the feedback loop between session planning and execution. Patterns of unjustified
deviation signal a problem with either planning or discipline.

### 7. Session Handoff
Write the full handoff to \`state/session-handoff.md\`. This file is read by the NEXT session
(whether cron or interactive chat) to maintain continuity. The handoff replaces the minimal
contract you wrote during Orient with the complete version.

Format:

\`\`\`markdown
# Session Handoff — {date} {session_type}

## Session Contract
> [Copy original contract from Orient]

## What I Did
- [Concrete actions taken, decisions made, trades executed]

## Open Concerns
- [Issues identified but not resolved]

## Deferred Decisions
- [Decisions postponed with reasoning and timeline]

## Next Session Should
- [Specific priorities for the next session]

## Market Context Snapshot
- Regime: [classification + score]
- VIX: [level]
- Key events next 48h: [calendar items]
\`\`\`

This handoff is critical — every session type (cron, chat, catch-up, pending) reads it.
An incomplete handoff breaks the continuity chain.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/skills.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills.ts tests/skills.test.ts
git commit -m "feat: extend session-reflection skill with contract eval + handoff"
```

---

### Task 5: Add trade-evaluator agent to subagent.ts

**Files:**
- Modify: `src/subagent.ts:17-296`
- Test: `tests/subagent.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/subagent.test.ts`:

```typescript
  it("returns exactly 4 agent definitions", () => {
    expect(keys).toHaveLength(4);
  });

  it("contains the trade-evaluator agent", () => {
    expect(keys).toContain("trade-evaluator");
  });
```

And add a new describe block:

```typescript
  describe("trade-evaluator", () => {
    const agent = agents["trade-evaluator"];

    it("has market-data MCP server", () => {
      expect(agent.mcpServers).toContain("market-data");
    });

    it("has skepticism-tuned prompt", () => {
      expect(agent.prompt).toMatch(/skeptical/i);
      expect(agent.prompt).toMatch(/find reasons NOT to/i);
    });

    it("checks for cognitive biases", () => {
      expect(agent.prompt).toMatch(/confirmation bias/i);
      expect(agent.prompt).toMatch(/FOMO/i);
      expect(agent.prompt).toMatch(/anchoring/i);
      expect(agent.prompt).toMatch(/recency bias/i);
    });

    it("checks journal consultation", () => {
      expect(agent.prompt).toMatch(/journal/i);
      expect(agent.prompt).toMatch(/consulted/i);
    });

    it("outputs <trade_evaluation> XML", () => {
      expect(agent.prompt).toContain("<trade_evaluation>");
      expect(agent.prompt).toContain("SCORE");
      expect(agent.prompt).toContain("RECOMMENDATION");
      expect(agent.prompt).toContain("PROCEED");
      expect(agent.prompt).toContain("RECONSIDER");
      expect(agent.prompt).toContain("REJECT");
    });

    it("has maxTurns of 15", () => {
      expect(agent.maxTurns).toBe(15);
    });

    it("includes fund name in prompt", () => {
      const namedAgents = buildAnalystAgents("my-fund");
      expect(namedAgents["trade-evaluator"].prompt).toContain("my-fund");
    });
  });
```

Also update the existing test "returns exactly 3 agent definitions" to expect 4, and add `"trade-evaluator"` to the "contains the new agent names" test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/subagent.test.ts --reporter=verbose`
Expected: FAIL — no `trade-evaluator` agent, count is 3 not 4.

- [ ] **Step 3: Add trade-evaluator agent definition**

In `src/subagent.ts`, inside the return object of `buildAnalystAgents()`, after the `"risk-guardian"` entry (after line 294), add:

```typescript
    "trade-evaluator": {
      description:
        "Skeptical reviewer of proposed trades — evaluates thesis quality, checks for cognitive biases, and validates timing rationale. Invoke after forming a trade thesis but before risk-guardian.",
      tools: ["Read", "Bash", "Grep", "Glob"],
      prompt: [
        `You are the Trade Evaluator for fund '${fundName}'.`,
        ``,
        `Your default stance is skeptical. Your job is to find reasons NOT to do this trade.`,
        ``,
        `You receive a proposed trade with its thesis. Evaluate:`,
        ``,
        `## 1. Thesis Strength (1-5)`,
        `Is the thesis specific and falsifiable? Does it have a clear invalidation trigger?`,
        `Is the evidence from this session's data, not assumed from memory?`,
        ``,
        `## 2. Bias Check`,
        `Does the proposal show signs of:`,
        `- **Confirmation bias** — only supporting evidence cited`,
        `- **FOMO** — chasing a move after missing entry`,
        `- **Anchoring** — fixated on a past price or round number`,
        `- **Recency bias** — overweighting today's price action`,
        ``,
        `## 3. Journal Consultation`,
        `Was the trade journal queried for similar setups? If so, what was the historical`,
        `hit rate? If not, this is a concern — the journal exists to prevent repeated mistakes.`,
        ``,
        `## 4. Timing Rationale`,
        `Why now? Is there a catalyst within the thesis timeframe? Are there upcoming events`,
        `(FOMC, earnings, CPI) that could invalidate the thesis before it plays out?`,
        ``,
        `## 5. Contrarian Test`,
        `What is the consensus view? Has the thesis accounted for why consensus might be right?`,
        ``,
        `## Quality Standards`,
        ``,
        `<example type="good">`,
        `"SCORE: 2/5. RECONSIDER. Thesis claims GDXJ is oversold, but RSI was not retrieved`,
        `this session — the claim is unverified. Journal shows 3 prior GDXJ mean-reversion`,
        `trades with 33% win rate. FOMC in 18 hours not accounted for in thesis. Recommend`,
        `waiting until post-FOMC or reducing size by 50%."`,
        `</example>`,
        ``,
        `<example type="bad">`,
        `"The thesis sounds reasonable and the trade makes sense."`,
        `</example>`,
        ``,
        `## Anti-Hallucination`,
        ``,
        `Never cite a price, ratio, or statistic without retrieving it from a tool this session.`,
        `If you cannot verify a claim made in the thesis, flag it as unverified.`,
        ``,
        `Use market-data MCP tools to cross-check any data cited in the thesis.`,
        ``,
        `## Output Format`,
        ``,
        `Wrap your evaluation in <trade_evaluation> tags:`,
        ``,
        `<trade_evaluation>`,
        `SCORE: [1-5]`,
        `THESIS_STRENGTH: [1-5 with one-line justification]`,
        `BIAS_FLAGS: [list or "none detected"]`,
        `JOURNAL_CHECK: [consulted/not consulted + historical context]`,
        `TIMING: [justified/questionable + reasoning]`,
        `CONCERNS: [numbered list]`,
        `RECOMMENDATION: [PROCEED / RECONSIDER / REJECT]`,
        `</trade_evaluation>`,
        ``,
        `## Rules`,
        ``,
        `- Score below 3 = RECONSIDER. Score below 2 = REJECT.`,
        `- If you identify an issue but feel inclined to approve anyway, that inclination is wrong.`,
        `  State the concern clearly.`,
        `- "The thesis sounds compelling" is not a valid reason to override concerns.`,
        `- If the journal was not consulted, that alone warrants RECONSIDER.`,
      ].join("\n"),
      model: "sonnet",
      mcpServers: ["market-data"],
      maxTurns: 15,
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/subagent.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/subagent.ts tests/subagent.test.ts
git commit -m "feat: add trade-evaluator skepticism-tuned sub-agent"
```

---

### Task 6: Add file-write instructions to existing sub-agents

**Files:**
- Modify: `src/subagent.ts` (market-analyst, technical-analyst, risk-guardian prompts)
- Test: `tests/subagent.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to each existing agent's describe block in `tests/subagent.test.ts`:

```typescript
  // In describe("market-analyst")
  it("instructs agent to write analysis to file", () => {
    const agent = agents["market-analyst"];
    expect(agent.prompt).toContain("analysis/");
    expect(agent.prompt).toContain("_market-assessment.md");
  });

  // In describe("technical-analyst")
  it("instructs agent to write analysis to file", () => {
    const agent = agents["technical-analyst"];
    expect(agent.prompt).toContain("analysis/");
    expect(agent.prompt).toContain("_technical-");
  });

  // In describe("risk-guardian")
  it("instructs agent to write validation to file", () => {
    const agent = agents["risk-guardian"];
    expect(agent.prompt).toContain("analysis/");
    expect(agent.prompt).toContain("_risk-validation-");
  });
```

Also add for trade-evaluator:

```typescript
  // In describe("trade-evaluator")
  it("instructs agent to write evaluation to file", () => {
    const agent = agents["trade-evaluator"];
    expect(agent.prompt).toContain("analysis/");
    expect(agent.prompt).toContain("_trade-evaluation-");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/subagent.test.ts --reporter=verbose`
Expected: FAIL — agents don't contain file-write instructions.

- [ ] **Step 3: Add file-write instructions to each agent**

In `src/subagent.ts`, add the following paragraph to each agent's prompt array, right before the `## Output Format` section:

**market-analyst** (before `## Output Format` around line 107):

```typescript
        `## Persist Your Analysis`,
        ``,
        `After completing your assessment, write the full output to`,
        `analysis/{today}_market-assessment.md using the Write tool,`,
        `where {today} is today's date in YYYY-MM-DD format.`,
        `This persists your analysis for reuse by later sessions.`,
        ``,
```

**technical-analyst** (before `## Output Format` around line 183):

```typescript
        `## Persist Your Analysis`,
        ``,
        `After completing your assessment, write the full output for each ticker to`,
        `analysis/{today}_technical-{TICKER}.md using the Write tool,`,
        `where {today} is today's date in YYYY-MM-DD format.`,
        `This persists your analysis for reuse by later sessions.`,
        ``,
```

**risk-guardian** (before `## Output Format` around line 274):

```typescript
        `## Persist Your Validation`,
        ``,
        `After completing your validation, write the full output to`,
        `analysis/{today}_risk-validation-{TICKER}.md using the Write tool,`,
        `where {today} is today's date in YYYY-MM-DD format.`,
        `This persists your validation for audit trail purposes.`,
        ``,
```

**trade-evaluator** (already has the prompt — add before `## Output Format`):

```typescript
        `## Persist Your Evaluation`,
        ``,
        `After completing your evaluation, write the full output to`,
        `analysis/{today}_trade-evaluation-{TICKER}.md using the Write tool,`,
        `where {today} is today's date in YYYY-MM-DD format.`,
        `This persists your evaluation for audit trail purposes.`,
        ``,
```

Also add `"Write"` to the `tools` array for all four agents (it's not currently included):

```typescript
tools: ["Read", "Write", "Bash", "Grep", "Glob"],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/subagent.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/subagent.ts tests/subagent.test.ts
git commit -m "feat: add file-write instructions to all sub-agents"
```

---

### Task 7: Update Session Protocol in template.ts

**Files:**
- Modify: `src/template.ts:145-161`
- Test: `tests/template.test.ts`

- [ ] **Step 1: Write the failing tests**

Update existing tests and add new ones in `tests/template.test.ts`:

```typescript
  it("Orient step references session-init rule", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);
    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("session-init");
    expect(content).toContain("Session Contract");
  });

  it("Validate step references trade-evaluator and risk-guardian (two gates)", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);
    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("trade-evaluator");
    expect(content).toContain("risk-guardian");
    expect(content).toContain("Two gates");
  });

  it("State Files section includes session-handoff.md", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);
    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("session-handoff.md");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/template.test.ts --reporter=verbose`
Expected: FAIL — content doesn't contain "session-init", "trade-evaluator", "Two gates", or "session-handoff.md".

- [ ] **Step 3: Update template.ts Session Protocol and State Files**

In `src/template.ts`, replace lines 145-161 (Session Protocol + State Files):

```typescript
## Session Protocol
1. **Orient** — Follow the \`session-init\` rule in \`.claude/rules/\`. Complete all 6 steps and write your Session Contract before proceeding.
2. **Analyze** — Classify the current market regime. Launch market-analyst and technical-analyst via the Task tool. Write your analysis to \`analysis/{date}_{session}.md\`.
3. **Decide** — Apply the pre-trade checklist. If conviction is below medium, document the reasoning and do not trade.
4. **Validate** — Two gates before execution:
   a. Invoke trade-evaluator via Task tool. Address any CONCERNS raised. If REJECT, do not proceed. If RECONSIDER, strengthen thesis or abandon.
   b. Invoke risk-guardian via Task tool. If the trade is REJECTED, do not execute (hard gate).
5. **Execute** — Place trades via the \`broker-local\` MCP tool (\`place_order\`). This updates \`portfolio.json\` and the trade journal automatically. Set stop-losses as position metadata — the daemon monitors them. Update \`objective_tracker.json\`.
6. **Reflect** — Run the Session Reflection skill. Update the trade journal, grade past decisions, evaluate your Session Contract, and write the full handoff to \`state/session-handoff.md\`.
7. **Communicate** — Send a Telegram notification in Spanish for any trade or significant insight.
8. **Follow-up** — If you need to check something later (price level, order fill, event outcome), schedule a follow-up session by writing to \`state/pending_sessions.json\`. See the self-scheduling rule in \`.claude/rules/self-scheduling.md\`.

## State Files
- \`state/session-handoff.md\` — Rich handoff context for the next session (you read at Orient, write at Reflect)
- \`state/portfolio.json\` — Current holdings, cash balance, and market values
- \`state/objective_tracker.json\` — Progress toward the fund objective
- \`state/session_log.json\` — Metadata from the last session
- \`state/trade_journal.sqlite\` — All past trades with reasoning, outcomes, and lessons (FTS5-indexed)
- \`state/pending_sessions.json\` — Self-scheduled follow-up sessions (you write, daemon executes)
- \`analysis/\` — Archive of your past analysis reports (sub-agents also write here)
```

Note: this replaces the old step 1 (detailed Orient) with a delegation to the session-init rule, updates step 4 with two gates, updates step 6 to mention contract evaluation and handoff, and adds `session-handoff.md` to State Files.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/template.test.ts --reporter=verbose`
Expected: Some existing tests may need updating. The test "8-step session protocol with risk-guardian" still expects `8. **Follow-up**` — this is unchanged. The test for "Orient" still expects the word "Orient" — this is unchanged. Fix any tests that check for the old Orient detail (like checking for `portfolio.json` in the Orient line — it now says "session-init rule" instead).

If the test `"contains 8-step session protocol with risk-guardian"` fails because it checks for specific old content in Orient, update it:

```typescript
  it("contains 8-step session protocol with two-gate validation", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);
    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("## Session Protocol");
    expect(content).toContain("Orient");
    expect(content).toContain("session-init");
    expect(content).toContain("Analyze");
    expect(content).toContain("Decide");
    expect(content).toContain("Validate");
    expect(content).toContain("trade-evaluator");
    expect(content).toContain("Execute");
    expect(content).toContain("Reflect");
    expect(content).toContain("Communicate");
    expect(content).toContain("Follow-up");
    expect(content).toContain("8. **Follow-up**");
  });
```

Run: `pnpm test -- tests/template.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/template.ts tests/template.test.ts
git commit -m "feat: update session protocol with init rule, two-gate validation, handoff"
```

---

### Task 8: Simplify session prompt in session.service.ts

**Files:**
- Modify: `src/services/session.service.ts:48-71`
- Test: `tests/session.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/session.test.ts`, the existing test at line 125 checks `opts.prompt` content. Add a new test and update the existing one:

```typescript
  it("prompt references session-init rule", async () => {
    await runFundSession("test-fund", "pre_market");
    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.prompt).toContain("session-init rule");
    expect(opts.prompt).toContain("Session Protocol");
  });
```

Also update the existing test at line 125 — it currently expects `opts.prompt` to contain `"pre_market session"` and `"Analyze overnight developments."`. The first will still pass (unchanged). The second will still pass (focus is still included).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/session.test.ts --reporter=verbose`
Expected: FAIL — prompt doesn't contain "session-init rule".

- [ ] **Step 3: Simplify the prompt**

In `src/services/session.service.ts`, replace lines 48-71 (the prompt construction):

```typescript
  const prompt = [
    `You are running a ${sessionType} session for fund '${fundName}'.`,
    ``,
    `Focus: ${focus}`,
    ``,
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/session.test.ts --reporter=verbose`
Expected: PASS (update any tests that checked for the old prompt content like "Remember to:" or the numbered list of instructions)

- [ ] **Step 5: Commit**

```bash
git add src/services/session.service.ts tests/session.test.ts
git commit -m "feat: simplify session prompt to delegate to session-init rule"
```

---

### Task 9: Add analysis file cleanup to daemon

**Files:**
- Modify: `src/services/daemon.service.ts:668-676` (near the existing daily cleanup cron)
- Test: `tests/daemon-integration.test.ts` (or inline verification)

- [ ] **Step 1: Write the failing test**

This is a cron addition. Add a test that verifies the cleanup function exists and works:

```typescript
import { cleanOldAnalysisFiles } from "../src/services/daemon.service.js";

describe("cleanOldAnalysisFiles", () => {
  it("is exported and callable", () => {
    expect(typeof cleanOldAnalysisFiles).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/daemon-integration.test.ts --reporter=verbose`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement cleanOldAnalysisFiles and add to daily cron**

In `src/services/daemon.service.ts`, add a new exported function (near other utility functions):

```typescript
import { readdir, stat, unlink } from "node:fs/promises";

/** Remove analysis files older than 30 days from all fund analysis/ directories */
export async function cleanOldAnalysisFiles(): Promise<void> {
  const fundNames = await listFundNames();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const name of fundNames) {
    const analysisDir = fundPaths(name).analysis;
    try {
      const files = await readdir(analysisDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = join(analysisDir, file);
        const stats = await stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      }
    } catch {
      // analysis dir may not exist for new funds
    }
  }
}
```

Then in the daily cleanup cron (around line 669), add:

```typescript
  // Daily cleanup of old news articles and analysis files
  cron.schedule("0 0 * * *", async () => {
    try {
      await cleanOldArticles();
      await log("[news] Old articles cleaned up");
    } catch (err) {
      await log(`[news] Cleanup error: ${err}`);
    }
    try {
      await cleanOldAnalysisFiles();
      await log("[analysis] Old analysis files cleaned up");
    } catch (err) {
      await log(`[analysis] Cleanup error: ${err}`);
    }
  });
```

Ensure `listFundNames` and `fundPaths` are imported (they may already be — check existing imports).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/daemon-integration.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/daemon.service.ts tests/daemon-integration.test.ts
git commit -m "feat: add 30-day analysis file cleanup to daemon daily cron"
```

---

### Task 10: Create harness evolution audit document

**Files:**
- Create: `docs/harness-audit.md`

- [ ] **Step 1: Create the document**

Write `docs/harness-audit.md`:

```markdown
# Harness Evolution Audit

## Purpose

Every harness component encodes an assumption about what the model can't do on its own.
As models improve, these assumptions go stale. This document tracks each component's
hypothesis and how to test it.

## Audit Schedule

Review after each major Claude model release or quarterly, whichever comes first.

## Component Inventory

### Sub-Agents

| Agent | Hypothesis | Test Method | Last Tested | Verdict |
|-------|-----------|-------------|-------------|---------|
| market-analyst | Main agent can't do thorough macro analysis in-context | Run 5 sessions without agent, compare macro coverage | - | - |
| technical-analyst | Main agent lacks systematic technical analysis | Run 5 sessions without agent, compare TA quality | - | - |
| risk-guardian | Main agent won't self-enforce hard risk limits | Run 5 sessions without gate, check for limit violations | - | - |
| trade-evaluator | Main agent has self-evaluation bias on trade quality | Run 5 sessions without evaluator, compare thesis quality | - | - |

### Skills

| Skill | Hypothesis | Test Method | Last Tested | Verdict |
|-------|-----------|-------------|-------------|---------|
| investment-thesis | Without structured thesis, agent makes poorly-reasoned trades | Compare thesis quality with/without skill | - | - |
| risk-assessment | Without EV calc + position sizing formula, agent sizes incorrectly | Check sizing accuracy with/without skill | - | - |
| trade-memory | Without journal lookup prompt, agent repeats past mistakes | Check journal query rate with/without skill | - | - |
| market-regime | Without regime framework, agent misclassifies conditions | Compare regime calls with/without skill | - | - |
| position-sizing | Without formula, agent over/under-sizes | Compare sizing to Kelly with/without skill | - | - |
| session-reflection | Without reflection prompt, agent skips end-of-session review | Check reflection rate with/without skill | - | - |
| portfolio-review | Without review framework, agent misses portfolio-level risks | Compare review depth with/without skill | - | - |

### Rules

| Rule | Hypothesis | Test Method | Last Tested | Verdict |
|------|-----------|-------------|-------------|---------|
| session-init | Without init sequence, agent skips state reading | Check file-read rate in first 5 turns | - | - |
| session-completion | Without completion guard, agent ends prematurely | Check handoff quality with/without rule | - | - |
| state-consistency | Without schema enforcement, agent writes malformed state | Check state file validity with/without rule | - | - |
| decision-quality | Without hierarchy, agent ignores risk limits for thesis | Check decision ordering with/without rule | - | - |
| analysis-standards | Without standards, agent writes vague analysis | Compare specificity with/without rule | - | - |
| risk-discipline | Without discipline rule, agent widens stops | Check stop-loss adherence with/without rule | - | - |
| learning-loop | Without loop, agent doesn't query journal | Check journal query rate with/without rule | - | - |
| market-awareness | Without awareness, agent misses calendar events | Check event awareness with/without rule | - | - |
| communication | Without rule, agent mixes languages | Check language consistency with/without rule | - | - |
| self-scheduling | Without format spec, agent writes malformed pending sessions | Check pending session validity with/without rule | - | - |

## How to Run an Audit

1. Select component to test
2. Create a test fund with identical config
3. Run 5 paper-mode sessions WITH the component
4. Run 5 paper-mode sessions WITHOUT the component (remove skill/rule/agent)
5. Compare outputs on the relevant metric
6. Record results and verdict: **KEEP** / **SIMPLIFY** / **REMOVE**
7. If REMOVE: delete from `src/skills.ts` + run `fundx fund upgrade --all`
```

- [ ] **Step 2: Commit**

```bash
git add docs/harness-audit.md
git commit -m "docs: add harness evolution audit framework"
```

---

### Task 11: Run full test suite and verify build

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `pnpm test --reporter=verbose`
Expected: All tests pass. Pay attention to tests in:
- `tests/skills.test.ts` — BUILTIN_SKILLS count is still 7
- `tests/subagent.test.ts` — agent count is now 4
- `tests/template.test.ts` — session protocol content updated
- `tests/session.test.ts` — prompt content updated

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 4: Run lint**

Run: `pnpm lint`
Expected: No lint errors.

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address test/lint issues from harness improvements"
```

---

### Task 12: Propagation note

This is a reminder, not code:

After deploying the updated `fundx` binary, existing funds need rule/skill updates:

```bash
fundx fund upgrade --all
```

This will:
- Regenerate each fund's `CLAUDE.md` (new Session Protocol)
- Rewrite all skills (extended Session Reflection)
- Rewrite all rules (new session-init + session-completion)
