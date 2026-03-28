# Prompt Ecosystem Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite all skills, rules, per-fund CLAUDE.md template, sub-agent definitions, and root CLAUDE.md to align with Anthropic's prompting best practices and investment literature.

**Architecture:** Content-only refactor — rewrite prompt strings in `src/skills.ts`, `src/template.ts`, `src/subagent.ts`, and `CLAUDE.md`. No changes to execution flow, state files, CLI commands, or MCP servers. Tests updated to match new content.

**Tech Stack:** TypeScript, Vitest, Claude Agent SDK (AgentDefinition type)

**Spec:** `docs/superpowers/specs/2026-03-28-prompt-ecosystem-overhaul-design.md`

---

### Task 1: Rewrite sub-agent definitions (5 → 3)

**Files:**
- Modify: `src/subagent.ts` (full rewrite of `buildAnalystAgents` function body)
- Test: `tests/subagent.test.ts`

- [ ] **Step 1: Update tests for 3 agents**

Replace the entire test file `tests/subagent.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildAnalystAgents } from "../src/subagent.js";

describe("buildAnalystAgents", () => {
  it("returns 3 agent definitions", () => {
    const agents = buildAnalystAgents("test-fund");
    const keys = Object.keys(agents);
    expect(keys).toHaveLength(3);
    expect(keys).toContain("market-analyst");
    expect(keys).toContain("technical-analyst");
    expect(keys).toContain("risk-guardian");
  });

  it("does not include removed agents", () => {
    const agents = buildAnalystAgents("test-fund");
    const keys = Object.keys(agents);
    expect(keys).not.toContain("macro-analyst");
    expect(keys).not.toContain("sentiment-analyst");
    expect(keys).not.toContain("news-analyst");
    expect(keys).not.toContain("risk-analyst");
  });

  it("each agent has required AgentDefinition fields", () => {
    const agents = buildAnalystAgents("test-fund");
    for (const [, agent] of Object.entries(agents)) {
      expect(agent.description).toBeTruthy();
      expect(agent.prompt).toBeTruthy();
      expect(agent.model).toBe("sonnet");
      expect(agent.maxTurns).toBeGreaterThan(0);
    }
  });

  it("includes fund name in agent prompts", () => {
    const agents = buildAnalystAgents("my-fund");
    for (const [, agent] of Object.entries(agents)) {
      expect(agent.prompt).toContain("my-fund");
    }
  });

  it("market-analyst has market-data MCP", () => {
    const agents = buildAnalystAgents("test-fund");
    expect(agents["market-analyst"].mcpServers).toContain("market-data");
  });

  it("market-analyst covers macro, sentiment, and news domains", () => {
    const agents = buildAnalystAgents("test-fund");
    const prompt = agents["market-analyst"].prompt as string;
    expect(prompt).toContain("Monetary Policy");
    expect(prompt).toContain("Sentiment");
    expect(prompt).toContain("News");
    expect(prompt).toContain("<market_assessment>");
  });

  it("market-analyst has anti-hallucination directive", () => {
    const agents = buildAnalystAgents("test-fund");
    const prompt = agents["market-analyst"].prompt as string;
    expect(prompt).toContain("Never cite");
  });

  it("technical-analyst has market-data MCP", () => {
    const agents = buildAnalystAgents("test-fund");
    expect(agents["technical-analyst"].mcpServers).toContain("market-data");
  });

  it("technical-analyst includes evidence-based guidance", () => {
    const agents = buildAnalystAgents("test-fund");
    const prompt = agents["technical-analyst"].prompt as string;
    expect(prompt).toContain("momentum");
    expect(prompt).toContain("<technical_assessment>");
  });

  it("risk-guardian has broker-alpaca and market-data MCP", () => {
    const agents = buildAnalystAgents("test-fund");
    expect(agents["risk-guardian"].mcpServers).toContain("broker-alpaca");
    expect(agents["risk-guardian"].mcpServers).toContain("market-data");
  });

  it("risk-guardian outputs APPROVED/REJECTED verdict", () => {
    const agents = buildAnalystAgents("test-fund");
    const prompt = agents["risk-guardian"].prompt as string;
    expect(prompt).toContain("APPROVED");
    expect(prompt).toContain("REJECTED");
    expect(prompt).toContain("<risk_validation>");
  });

  it("risk-guardian has lower maxTurns than other agents", () => {
    const agents = buildAnalystAgents("test-fund");
    expect(agents["risk-guardian"].maxTurns).toBeLessThan(agents["market-analyst"].maxTurns!);
  });

  it("assigns tools to each agent", () => {
    const agents = buildAnalystAgents("test-fund");
    for (const [, agent] of Object.entries(agents)) {
      expect(agent.tools).toBeDefined();
      expect(agent.tools!.length).toBeGreaterThan(0);
      expect(agent.tools).toContain("Read");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/subagent.test.ts`
Expected: Multiple failures — tests expect 3 agents but code returns 5.

- [ ] **Step 3: Rewrite `src/subagent.ts` with 3 agents**

Replace the entire `buildAnalystAgents` function body in `src/subagent.ts`. Keep the import and function signature. Replace the return object with 3 agents:

**`market-analyst`** (merges macro + sentiment + news):
- Description: "Senior market strategist — analyzes macro environment, sentiment signals, and news catalysts to assess the market landscape and its impact on the fund's holdings and strategy."
- Tools: `["Read", "WebSearch", "Bash", "Grep", "Glob"]`
- MCP: `["market-data"]`
- Model: `"sonnet"`, maxTurns: `25`
- Prompt covers: Macro (monetary policy, economic cycle, cross-asset, geopolitical), Sentiment (VIX, put/call, breadth, flows, positioning as contrarian signals), News (breaking events, regulatory, upcoming catalysts, insider activity)
- Quality standards with `<example>` tagged good/bad examples
- Anti-hallucination: "Never cite a price, ratio, or statistic without retrieving it from a tool this session."
- Scope boundary: "Do not provide technical price analysis or trade recommendations. Your job is the environment, not the trade."
- Output in `<market_assessment>` XML tags with fields: MARKET_OUTLOOK, CONFIDENCE, REGIME_SCORE, MACRO_DRIVERS, SENTIMENT_SIGNAL, CATALYSTS, RISKS, POSITIONING_IMPLICATION

**`technical-analyst`** (improved):
- Description: "Senior technical analyst — evaluates price action, trend structure, volume patterns, and momentum indicators using evidence-based methods across the fund's holdings and watchlist."
- Tools: `["Read", "Bash", "Grep", "Glob"]`
- MCP: `["market-data"]`
- Model: `"sonnet"`, maxTurns: `20`
- Keep existing focus areas (trend, volume, key levels, momentum, patterns)
- Add evidence-based section: "Focus on methods with academic support: momentum (3-12 month), long-term mean reversion (3-5 year), 200-day MA as trend filter, volume confirmation. Avoid relying on: Fibonacci levels, Elliott Wave, or complex chart patterns without volume and momentum confirmation — these lack consistent empirical support."
- Add "When NOT to analyze": "If a position is held for fundamental/macro reasons with a multi-month horizon, daily technicals are noise, not signal. Focus on weekly/monthly timeframes for such positions."
- Output in `<technical_assessment>` XML tags
- Anti-hallucination directive

**`risk-guardian`** (replaces risk-analyst, guardrail pattern):
- Description: "Risk guardian — validates proposed trades against fund constraints, concentration limits, and drawdown budget. Returns APPROVED or REJECTED. This is a hard gate, not advisory."
- Tools: `["Read", "Bash", "Grep", "Glob"]`
- MCP: `["broker-alpaca", "market-data"]`
- Model: `"sonnet"`, maxTurns: `15`
- Prompt includes: drawdown recovery table, correlation-as-concentration rule (>0.7 = single position), drawdown budget tiers (0-50% normal, 50-75% half sizing, 75%+ no new positions)
- Behavioral directive: "Your job is to find reasons to reject, not to approve. Assume hidden risks until proven otherwise."
- Output in `<risk_validation>` XML tags with fields: VERDICT (APPROVED|REJECTED), CONSTRAINT_STATUS (each limit PASS/FAIL/WARN with numbers), STRESS_SCENARIO, REJECTION_REASONS, WARNINGS

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/subagent.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/subagent.ts tests/subagent.test.ts
git commit -m "refactor(agents): restructure 5 analysts into 3 (market, technical, risk-guardian)

Merge macro+sentiment+news into unified market-analyst. Replace advisory
risk-analyst with risk-guardian guardrail pattern (APPROVED/REJECTED).
Add XML-tagged outputs, anti-hallucination directives, evidence-based
technical analysis guidance."
```

---

### Task 2: Rewrite per-fund CLAUDE.md template

**Files:**
- Modify: `src/template.ts` (rewrite `buildClaudeMd` function)
- Test: `tests/template.test.ts`

- [ ] **Step 1: Update tests for new template structure**

Replace the entire test file `tests/template.test.ts`. The new tests verify:
- Template contains `<fund_objective>` XML tags
- Template contains `<hard_constraints>` XML tags
- Template contains `<frameworks>` XML tags
- Template contains new sections: "Investment Frameworks", "Drawdown Recovery", "Pre-Trade Checklist", "Behavioral Bias Watchlist", "Survival Question"
- Template contains 9 mental models (6 original + 3 new: second-level thinking, antifragility, via negativa)
- Template contains 8-step session protocol (orient, analyze, decide, validate, execute, reflect, communicate, follow-up)
- Template contains anti-hallucination directive
- Template contains Spanish communication rule
- Template contains `<default_to_action>` block
- Objective types still render correctly (runway, growth, accumulation, income, custom)
- Risk constraints still render with correct values
- Allowed tickers still appear
- Custom rules appear inside `<hard_constraints>`
- Personality appears in Identity section
- Decision framework appears in Philosophy section
- No inline skills embedded (unchanged)

Key assertions for new content:
```typescript
expect(content).toContain("<fund_objective>");
expect(content).toContain("</fund_objective>");
expect(content).toContain("<hard_constraints>");
expect(content).toContain("</hard_constraints>");
expect(content).toContain("<frameworks>");
expect(content).toContain("</frameworks>");
expect(content).toContain("Drawdown Recovery");
expect(content).toContain("-50% → +100%");
expect(content).toContain("Pre-Trade Checklist");
expect(content).toContain("Behavioral Bias Watchlist");
expect(content).toContain("Survival Question");
expect(content).toContain("risk-guardian");
expect(content).toContain("second-level thinking");
expect(content).toContain("Antifragility");
expect(content).toContain("Via negativa");
expect(content).toContain("Never cite a price");
expect(content).toContain("Spanish");
```

Update section ordering test: new order is Identity → Objective → Philosophy → Frameworks → Constraints → Session Protocol → State Files → Mental Models.

Remove the old test checking `Mental Models` comes before `Session Protocol` — the new order puts Mental Models after State Files.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/template.test.ts`
Expected: Failures on XML tags, frameworks, new mental models, anti-hallucination.

- [ ] **Step 3: Rewrite `buildClaudeMd` in `src/template.ts`**

Replace the `buildClaudeMd` function body. Keep `generateFundClaudeMd`, `describeObjective`, and the imports unchanged.

New template structure (sections in order):

**1. Identity** — Senior PM with personality, Spanish communication rule, anti-hallucination, default_to_action block.

**2. Objective** — Wrapped in `<fund_objective>` tags. Same `describeObjective()` logic.

**3. Philosophy** — From config `decision_framework` (unchanged conditional).

**4. Investment Frameworks** — Wrapped in `<frameworks>` tags. Contains:
- a. Drawdown Recovery Table (the exact numbers: -10%→+11.1%, -20%→+25%, -30%→+42.9%, -40%→+66.7%, -50%→+100%, -60%→+150%)
- b. Decision Hierarchy (5-level priority: risk limits > objective > regime > thesis > timing)
- c. Regime Classification table (Risk-On/Transition/Risk-Off/Crisis with scores, sizing multipliers, cash floors, min conviction)
- d. Position Sizing Flow (formula + dual-method rule)
- e. Pre-Trade Checklist (10 items)
- f. Behavioral Bias Watchlist (10 biases with detection signals and countermeasures)
- g. Survival Question (Taleb)

**5. Risk Constraints** — Wrapped in `<hard_constraints>` tags. Dynamic values from config + drawdown budget tiers + correlation rule.

**6. Session Protocol** — 8 steps: Orient (+ memory files), Analyze (+ Task tool for market-analyst and technical-analyst), Decide (+ pre-trade checklist), Validate (risk-guardian via Task tool, hard gate), Execute, Reflect (Session Reflection skill), Communicate (Spanish Telegram), Follow-up.

**7. State Files** — Same as current.

**8. Mental Models** — 9 models: original 6 + Second-level thinking (Howard Marks), Antifragility (Taleb), Via negativa.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/template.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/template.ts tests/template.test.ts
git commit -m "refactor(template): restructure per-fund CLAUDE.md with investment frameworks

New structure follows Anthropic optimal ordering. Adds XML tags for dynamic
content, embedded investment frameworks (drawdown recovery, bias watchlist,
pre-trade checklist), 8-step session protocol with risk-guardian gate,
anti-hallucination directive, Spanish communication rule."
```

---

### Task 3: Rewrite BUILTIN_SKILLS (7 fund skills)

**Files:**
- Modify: `src/skills.ts` (rewrite all 7 `BUILTIN_SKILLS` content strings)
- Test: `tests/skills.test.ts`

- [ ] **Step 1: Update tests for new skill content**

Update `tests/skills.test.ts`. Keep all structural tests (count=7, required fields, dirNames). Update content assertions:

Add new assertion for ALL skills — "When NOT to Use" section:
```typescript
it("each trading skill has When NOT to Use section", () => {
  for (const skill of BUILTIN_SKILLS) {
    expect(skill.content).toContain("## When NOT to Use");
  }
});
```

Update per-skill tests:

**Investment Thesis:** Add assertions for `pre-mortem`, `<example>` tags.
```typescript
expect(skill!.content).toContain("pre-mortem");
expect(skill!.content).toContain("<example>");
```

**Risk Assessment:** Add assertions for drawdown recovery table, dual-method rule.
```typescript
expect(skill!.content).toContain("-50%");
expect(skill!.content).toContain("+100%");
expect(skill!.content).toContain("TWO sizing methods");
```

**Trade Memory:** Add assertion for R-multiple.
```typescript
expect(skill!.content).toContain("R-multiple");
```

**Market Regime:** Add assertions for composite scoring, regime transition, strategy constraints.
```typescript
expect(skill!.content).toContain("Regime Score");
expect(skill!.content).toContain("Volatility (30%)");
expect(skill!.content).toContain("regime transition");
expect(skill!.content).toContain("correlations converge");
```

**Position Sizing:** Add assertions for dual-method, Piotroski, anti-overconfidence.
```typescript
expect(skill!.content).toContain("Piotroski");
expect(skill!.content).toContain("two methods");
```

**Session Reflection:** Add assertions for calibration, R-multiple tracking, expanded bias list.
```typescript
expect(skill!.content).toContain("calibration");
expect(skill!.content).toContain("R-multiple");
expect(skill!.content).toContain("Narrative fallacy");
expect(skill!.content).toContain("What will I do differently");
```

**Portfolio Review:** Add assertions for objective-specific criteria, survival question, barbell.
```typescript
expect(skill!.content).toContain("Runway:");
expect(skill!.content).toContain("Growth:");
expect(skill!.content).toContain("Income:");
expect(skill!.content).toContain("Accumulation:");
expect(skill!.content).toContain("Survival Question");
expect(skill!.content).toContain("barbell");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/skills.test.ts`
Expected: Failures on "When NOT to Use", pre-mortem, R-multiple, composite scoring, calibration, barbell, etc.

- [ ] **Step 3: Rewrite all 7 BUILTIN_SKILLS content strings**

In `src/skills.ts`, rewrite the `content` field of each skill in the `BUILTIN_SKILLS` array. Keep the `name`, `dirName`, and `description` fields — only update `description` to soften language (remove "must", use "Use when...").

For each skill, apply these systemic changes:
- Add `## When NOT to Use` section after `## When to Use`
- Wrap good/bad examples in `<example>` XML tags
- Soften description language

Per-skill content changes (as specified in the design spec sections 3.1-3.7):

**Investment Thesis:** Add pre-mortem technique (Gary Klein), `<example>` tags, "When NOT to Use" (mechanical stops, rebalances, trims <2%). Add "First trades in a new sector deserve minimum sizing regardless of conviction."

**Risk Assessment:** Streamline — remove content now in CLAUDE.md `<hard_constraints>` and risk-guardian. Keep EV calculation and order specification. Add drawdown recovery table inline. Add dual-method rule. Add "When NOT to Use" (exits, trims, stop triggers).

**Trade Memory:** Add `<example>` tags around SQL examples. Add R-multiple framework paragraph. Add FTS5 keyword guidance. Add "When NOT to Use" (no journal exists yet — skip and note it).

**Market Regime:** Significant rewrite. Add composite scoring system (Volatility 30%, Trend 30%, Credit 20%, Macro 20%, each scored 1-4). Add specific indicators per component. Add regime transition signals. Add regime-dependent strategy constraints. Add Dalio's correlation warning. Keep regime table. Add "When NOT to Use" (intraday scalping, mechanical DCA).

**Position Sizing:** Keep 6-step flow. Add dual-method rule. Add Piotroski F-Score ≥6 reference. Add anti-overconfidence check (conviction > 2× Kelly → trust Kelly). Add "When NOT to Use" (exits, stop triggers, full closes).

**Session Reflection:** Add calibration score tracking. Expand bias checklist from 6 to 10. Make "What will I do differently?" mandatory output field. Add R-multiple tracking in journal. Add "When NOT to Use" (emergency sessions focused on a single action).

**Portfolio Review:** Add objective-specific review criteria (Runway, Growth, Income, Accumulation). Add survival question. Add barbell assessment. Add "When NOT to Use" (first session of a new fund with no positions).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/skills.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/skills.ts tests/skills.test.ts
git commit -m "refactor(skills): rewrite 7 fund skills with investment frameworks and XML tags

Add When NOT to Use sections, XML-tagged examples, pre-mortem technique,
R-multiples, composite regime scoring, Piotroski F-Score, calibration
tracking, goal-based portfolio review, survival question, barbell assessment.
Soften trigger language for Claude 4.6 compatibility."
```

---

### Task 4: Rewrite FUND_RULES + add communication rule

**Files:**
- Modify: `src/skills.ts` (rewrite `FUND_RULES` array entries, add communication.md)

- [ ] **Step 1: Rewrite FUND_RULES in `src/skills.ts`**

In the `FUND_RULES` array, modify these entries:

**`state-consistency.md`** — No changes.

**`decision-quality.md`** — Trim: remove "Written thesis required" section and "Positive expected value" section (now in skills). Keep decision hierarchy and red flags. Add WHY line at top: "Why: Emotional overrides of systematic rules are the primary cause of preventable losses." Add: "When analysts disagree, weight the one with more specific data. Vague concerns do not override quantified analysis."

**`analysis-standards.md`** — Trim: remove "Required Standards" subsections that duplicate CLAUDE.md Standards. Keep only the "Forbidden Patterns" section and good/bad examples (wrap in `<example>` tags). Add WHY: "Why: Vague analysis leads to vague decisions. Specificity forces intellectual honesty."

**`risk-discipline.md`** — Keep everything. Add WHY to header: "Why: A 50% drawdown requires 100% gain to recover — math that makes most fund objectives unreachable." Add after Portfolio-Level Rules: "In Risk-Off/Crisis, recalculate all concentration limits assuming 0.8 correlation between equity positions." Add reference: "See the Drawdown Recovery Table in CLAUDE.md frameworks section."

**`learning-loop.md`** — No changes.

**`market-awareness.md`** — Trim: remove "Regime Respect" section (moved to Market Regime skill). Keep Calendar Awareness table and correlation awareness. Add WHY: "Why: Calendar events create binary risk that sizing alone cannot manage."

**`self-scheduling.md`** — No changes.

**`memory-usage.md`** — No changes (this is in `MEMORY_USAGE_RULE`, not `FUND_RULES`).

**Add new entry** to `FUND_RULES`:
```typescript
{
  fileName: "communication.md",
  content: `# Communication

Why: The user operates in Spanish. Technical financial content stays in English because
market terminology, ticker symbols, and financial ratios are universally expressed in English.

Communicate with the user in Spanish via Telegram notifications and chat interactions.
Analysis files, trade journal entries, and session reports remain in English for
consistency and searchability.

## Rules
- Telegram messages: Spanish
- Chat responses: Spanish
- analysis/*.md files: English
- Trade journal entries (reasoning, lessons_learned): English
- Session reports: English
- When quoting financial data in Spanish messages, keep ticker symbols and
  numbers in their original form (e.g., "AAPL subio 3.2% a $185.40")
`,
},
```

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS. The `getFundRuleCount()` function is not tested for an exact count (verify this — if it is, update the test).

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/skills.ts
git commit -m "refactor(rules): trim duplicated rules, add WHY context, add communication rule

Deduplicate decision-quality and analysis-standards with skills/CLAUDE.md.
Add WHY motivation to risk-discipline, analysis-standards, market-awareness,
decision-quality. Add communication.md rule for Spanish user interaction.
Trim regime behavior from market-awareness (now in Market Regime skill)."
```

---

### Task 5: Update root CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.claude/rules/architecture.md`

- [ ] **Step 1: Add Prompting Conventions section to CLAUDE.md**

Insert a new `## Prompting Conventions` section after the `### Configuration` subsection (before `### Skills and Rules Pattern`). Content as specified in design spec section 5 — the full Prompting Conventions section with subsections: Prompt Structure, Language Calibration, Skill Authoring, Rule Authoring, Sub-Agent Authoring, Anti-Hallucination, Prompt Testing.

- [ ] **Step 2: Update architecture references in CLAUDE.md**

Find and replace these strings in `CLAUDE.md`:

1. Line containing "analyst sub-agents via the Task tool (macro, technical, sentiment, risk, news)" → replace with "analyst sub-agents via the Task tool (market, technical, risk-guardian)"

2. Line containing `subagent.ts           # Analyst AgentDefinitions for the Task tool (macro, technical, sentiment, risk, news)` → replace with `subagent.ts           # Agent definitions for the Task tool (market-analyst, technical-analyst, risk-guardian)`

3. Line containing `Analyst AgentDefinitions via Task tool (\`subagent.ts\`) — macro, technical, sentiment, risk, news` → replace with `Agent definitions via Task tool (\`subagent.ts\`) — market-analyst, technical-analyst, risk-guardian`

- [ ] **Step 3: Update Skills and Rules Pattern section**

In the per-fund rules directory layout, add `communication.md` after `state-consistency.md`:
```
    ├── rules/
    │   ├── state-consistency.md       # config ↔ state sync rules
    │   └── communication.md           # Spanish interaction, English analysis
```

Update the text "8 per-fund behavioral rules" references if any exist (search for "8 per-fund" or similar counts).

- [ ] **Step 4: Update `.claude/rules/architecture.md`**

Find the line mentioning MCP servers or agents and ensure it references the new 3-agent structure. Specifically, if there's any reference to "5 analysts" or the old agent names, update them.

- [ ] **Step 5: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: All pass. CLAUDE.md changes are content-only, no code impact.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md .claude/rules/architecture.md
git commit -m "docs: add Prompting Conventions, update architecture for 3-agent structure

Add comprehensive prompting conventions section governing future skill/rule/
prompt authoring. Update all references from 5 analysts to 3 agents
(market-analyst, technical-analyst, risk-guardian). Add communication.md
to rules directory layout."
```

---

### Task 6: Build and verify

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors.

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: Clean build, no errors.

- [ ] **Step 4: Verify CLAUDE.md template output**

Run a quick TypeScript check to verify the template renders correctly. Create a temporary script or use the test helper `makeConfig()` pattern to call `buildClaudeMd` and inspect the output contains all expected XML tags and sections.

Run: `pnpm test -- tests/template.test.ts -v`
Expected: All template tests pass with verbose output showing section assertions.

- [ ] **Step 5: Commit (if any fixes needed)**

If any fixes were required during verification, commit them.
