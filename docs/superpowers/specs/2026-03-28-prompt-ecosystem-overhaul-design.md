# FundX Prompt Ecosystem Overhaul — Design Spec

**Date:** 2026-03-28
**Scope:** Structural refactor of all skills, rules, per-fund CLAUDE.md template, sub-agent definitions, and root CLAUDE.md prompting conventions
**Approach:** B — Structural Refactor aligned to Anthropic's prompting best practices and investment literature

## Context & Motivation

FundX's AI instruction layer (skills, rules, CLAUDE.md templates, sub-agent prompts) was built incrementally across Phases 1-5. It works, but has accumulated structural issues:

1. **No XML structure** — Dynamic content (portfolio state, constraints, examples) isn't tagged, making it harder for Claude to parse complex prompts
2. **Aggressive trigger language** — "MUST", "ALWAYS", "CRITICAL", "NEVER" throughout, causing overtriggering on Claude 4.6
3. **Duplication** — The same instructions appear in skills, rules, and CLAUDE.md (e.g., regime behavior in both market-awareness rule and Market Regime skill)
4. **Sub-agent overlap** — 5 analysts with significant domain overlap (macro/sentiment/news all analyze the same data)
5. **Missing investment frameworks** — Key quantitative tools (drawdown recovery math, Kelly criterion details, behavioral bias taxonomy, pre-trade checklists) referenced by name but not embedded with specific numbers
6. **No prompting conventions** — No governance for how future skills/rules/prompts should be written

### Research Sources

This design is informed by:
- **Anthropic's Prompting Best Practices** (docs.anthropic.com, March 2026) — XML tags, role definition, example formatting, tool use, Claude 4.6 calibration
- **Anthropic's Building Effective Agents** (anthropic.com/engineering) — workflow patterns, sub-agent architecture, tool definition (ACI), guardrail patterns
- **Investment literature** — CFA curriculum, Fama-French factor research, Kelly criterion, Piotroski F-Score, Van Tharp R-multiples, Howard Marks/Taleb/Dalio principles, behavioral finance research (Kahneman, Gary Klein pre-mortem)

---

## Decision Log

| Question | Decision | Rationale |
|----------|----------|-----------|
| Primary concern | Comprehensive overhaul (all of the above) | No specific pain point — align everything to best practices |
| Autonomy model | Aggressive autonomy in both paper and live | Risk constraints are the guardrail, not human approval gates |
| Sub-agent architecture | Simplify (5→3) + add guardrail | Anthropic's simplicity principle; reduce overlap; add risk-guardian pattern |
| Investment framework depth | Embed specific frameworks with numbers | Maximum precision; token budget well spent on investment decisions |
| Language | English prompts, Spanish communication | Claude's strongest training in English; user interaction in Spanish |

---

## 1. Sub-Agent Restructure (5 → 3)

### Current State
5 analysts: macro-analyst, technical-analyst, sentiment-analyst, news-analyst, risk-analyst

### Proposed State
3 agents with non-overlapping domains:

#### 1.1 `market-analyst` (merges macro + sentiment + news)

**Rationale:** These three agents read the same data sources (news, macro indicators, market sentiment), produce overlapping analysis, and their outputs must be reconciled by the PM anyway. A single market analyst produces one coherent narrative instead of three partial views.

**Domain:**
- Macro environment: monetary policy, economic cycle, cross-asset signals, geopolitical
- Sentiment signals: VIX, put/call ratios, breadth, flows, positioning — framed as contrarian context
- News catalysts: breaking events, regulatory changes, upcoming catalysts, insider activity

**Output format:**
```
<market_assessment>
MARKET_OUTLOOK: risk-on | neutral | risk-off | crisis
CONFIDENCE: 0.0 to 1.0
REGIME_SCORE: composite 1.0-4.0 (volatility 30%, trend 30%, credit 20%, macro 20%)
MACRO_DRIVERS: [3-5 dominant factors with specific data]
SENTIMENT_SIGNAL: none | mild-bullish | mild-bearish | strong-bullish | strong-bearish
CATALYSTS: [upcoming events with dates and expected impact]
RISKS: [what could invalidate this outlook]
POSITIONING_IMPLICATION: [what this means for the fund]
</market_assessment>
```

**Tools:** Read, WebSearch, Bash, Grep, Glob
**MCP:** market-data
**Model:** sonnet | **Max turns:** 25

**Prompt structure:**
- Role: "Senior market strategist for fund '{fundName}'"
- Quality standards with `<example>` tagged good/bad examples
- Anti-hallucination: "Never cite data not retrieved this session"
- Explicit scope boundary: "Do not provide technical price analysis or trade recommendations. Your job is the environment, not the trade."

#### 1.2 `technical-analyst` (stays, improved)

**Rationale:** Technical analysis is a genuinely different methodology (price/volume data vs. fundamental/macro). Deserves its own agent.

**Changes from current:**
- Add evidence-based focus: momentum (3-12 month), long-term mean reversion (3-5 year), 200-day MA trend filter, volume confirmation — these have academic support
- Add explicit "what doesn't reliably work" section: most chart patterns, Fibonacci levels, Elliott Wave — to prevent Claude from generating unfalsifiable technical analysis
- Add `<example>` XML tags around good/bad examples
- Add "When NOT to analyze" guidance: "If a position is being held for fundamental/macro reasons with a multi-month horizon, daily technicals are noise, not signal"
- Output wrapped in `<technical_assessment>` tags

**Tools:** Read, Bash, Grep, Glob
**MCP:** market-data
**Model:** sonnet | **Max turns:** 20

#### 1.3 `risk-guardian` (replaces risk-analyst, parallel guardrail)

**Rationale:** Anthropic's guardrail pattern — a separate model instance validates constraints independently from the decision-maker. More reliable than self-policing. The risk-analyst's advisory role was too easily overridden by the PM's conviction.

**Key behavioral shift:** This agent does not advise. It validates. Output is `APPROVED` or `REJECTED` with specific constraint violations. The PM cannot override a `REJECTED`.

**Domain:**
- Hard constraint validation (position size, drawdown, forbidden assets, stop-loss presence)
- Concentration analysis (single position, sector, correlated positions)
- Stress scenario (what happens in -5% SPY, -10% correction, rates shock)
- Drawdown budget status (how much of the max_drawdown_pct has been consumed)
- Objective risk (is current trajectory on track for the fund's goal)

**Output format:**
```
<risk_validation>
VERDICT: APPROVED | REJECTED
CONSTRAINT_STATUS:
  - max_position_pct: PASS | FAIL (current: X%, limit: Y%)
  - max_drawdown_pct: PASS | FAIL (current: X%, limit: Y%)
  - stop_loss_defined: PASS | FAIL
  - asset_universe: PASS | FAIL
  - sector_concentration: PASS | WARN (sector: X%, threshold: 30%)
  - correlation_concentration: PASS | WARN (correlated group: X%)
  - drawdown_budget: GREEN | YELLOW | RED (consumed: X% of limit)
  - daily_loss_limit: PASS | FAIL
STRESS_SCENARIO: "In a [worst reasonable scenario], portfolio loses $X (-Y%)"
REJECTION_REASONS: [if REJECTED, specific violations with numbers]
WARNINGS: [if APPROVED, risks to monitor]
</risk_validation>
```

**Tools:** Read, Bash, Grep, Glob
**MCP:** broker-alpaca, market-data
**Model:** sonnet | **Max turns:** 15

**Prompt includes:**
- Full drawdown recovery table
- Correlation-as-concentration rule (>0.7 = single position)
- Drawdown budget tiers (0-50% → normal, 50-75% → half sizing, 75%+ → no new positions)
- "Your job is to find reasons to reject, not to approve. Assume hidden risks until proven otherwise."

---

## 2. Per-Fund CLAUDE.md Template Restructure

### Current Structure
Identity → Objective → Philosophy → Mental Models → Standards → Risk Constraints → Session Protocol → State Files → Trading Rules

### Proposed Structure (follows Anthropic's optimal ordering)

```
1. ROLE & IDENTITY
   - Senior PM identity with personality
   - Communication rule (Spanish for user interaction, English for analysis/journal)
   - Anti-hallucination directive
   - <default_to_action> block (act decisively, constraints are the guardrail)

2. OBJECTIVE
   <fund_objective>
   Dynamic from config — same objective generation logic
   </fund_objective>

3. PHILOSOPHY (from config decision_framework)

4. INVESTMENT FRAMEWORKS
   <frameworks>
   a. Drawdown Recovery Table
      -10% → +11.1% | -20% → +25% | -30% → +42.9% | -40% → +66.7% | -50% → +100% | -60% → +150%
      Why this matters: a 50% drawdown makes most fund objectives mathematically unreachable.

   b. Decision Hierarchy
      1. Hard risk limits (absolute, never override)
      2. Fund objective alignment
      3. Market regime appropriateness
      4. Thesis quality and conviction
      5. Timing and execution

   c. Regime Classification (quick reference)
      | Regime | Score | Sizing | Cash Floor | Min Conviction |
      | Risk-On | 1.0-1.5 | 1.0x | Per fund min | 1 |
      | Transition | 1.5-2.5 | 0.7x | +10% | 3 |
      | Risk-Off | 2.5-3.5 | 0.5x | +20% | 4 |
      | Crisis | 3.5-4.0 | 0.25x | +40% | No new longs |

   d. Position Sizing Flow
      final_pct = min(conviction_base × fund_adj × regime_mult, half_kelly, max_position_pct)
      Rule: use at least TWO sizing methods and take the SMALLER.

   e. Pre-Trade Checklist (condensed)
      1. Written thesis with one-sentence summary?
      2. EV calculation positive?
      3. Trade journal consulted for same ticker/setup?
      4. Risk-guardian validation passed?
      5. Position size within all limits?
      6. Stop-loss defined and entered with order?
      7. Post-trade cash above regime-adjusted floor?
      8. No major event within 24h (or thesis accounts for it)?
      9. Not a FOMO or revenge trade?
      10. Pre-mortem done? ("Assume this lost 20% in 12 months — why?")

   f. Behavioral Bias Watchlist
      | Bias | Detection Signal | Countermeasure |
      | Anchoring | Fixated on past price/target | Re-derive from current data |
      | Confirmation | Only sought supporting evidence | Write the bear case first |
      | Loss aversion | Holding past stop hoping for recovery | Mechanical stop execution |
      | Recency | Overweighting today's move | Zoom out to thesis horizon |
      | FOMO | Chasing after missing entry | Missed trades cost zero |
      | Sunk cost | Averaging down without new thesis | Each add is a new trade |
      | Overconfidence | Conviction-size > 2× Kelly-size | Trust Kelly over gut |
      | Disposition effect | Selling winners early, holding losers | Review vs. thesis target |
      | Narrative fallacy | Compelling story without data | Demand specific numbers |
      | Herding | "Everyone is buying X" | Contrarian check — crowded = risky |

   g. Survival Question (Taleb)
      "If I am completely wrong about everything — every thesis, every regime call,
      every macro view — does the fund survive?" If the answer is no, reduce risk
      until the answer is yes.
   </frameworks>

5. RISK CONSTRAINTS
   <hard_constraints>
   - Max drawdown: {max_drawdown_pct}%
   - Max position size: {max_position_pct}%
   - Stop loss: {stop_loss_pct}% per position
   - Allowed assets: {universe}
   - Forbidden: {forbidden}
   - {custom_rules}

   Drawdown budget tiers:
   - 0-50% of limit consumed → normal operations
   - 50-75% consumed → reduce all new position sizes by half
   - 75-100% consumed → no new positions, trim existing

   Correlation rule: positions with >0.7 correlation count as one position for concentration.
   In Risk-Off/Crisis, assume all equity correlations are 0.8.

   Before executing any trade, verify ALL constraints. Any violation → abort and log reason.
   </hard_constraints>

6. SESSION PROTOCOL
   1. Orient — Read state files AND memory/ files. Know positions, P&L, last session, learned patterns.
   2. Analyze — Classify market regime. Launch market-analyst and technical-analyst via Task tool.
      Write analysis to analysis/{date}_{session}.md.
   3. Decide — Apply pre-trade checklist. If conviction < medium, document reasoning and do not trade.
   4. Validate — Before placing any order, invoke the risk-guardian sub-agent via the Task tool with the proposed trade details. If the risk-guardian returns REJECTED, abort the trade and log the rejection reason. This is a hard gate, not advisory.
   5. Execute — Place trades, set stop-losses, update all state files.
   6. Reflect — Run Session Reflection skill. Update journal, grade decisions, check biases.
   7. Communicate — Send Telegram notification for trades and insights (in Spanish).
   8. Follow-up — Schedule follow-up sessions if needed via state/pending_sessions.json.

7. STATE FILES (reference list — same as current)

8. MENTAL MODELS
   Current 6 models kept, plus:
   7. Second-level thinking (Howard Marks) — "What is the consensus, and why might it be wrong?
      The market is a second-level game — first-level thinking ('good company → buy') is already priced in."
   8. Antifragility (Taleb) — "Prefer positions that benefit from volatility and disorder.
      The barbell: essential positions (low risk, protect capital) + asymmetric bets (limited
      downside, large upside). Avoid the fragile middle."
   9. Via negativa — "What to avoid matters more than what to do. Avoiding large losses is
      more important than finding large gains. Remove bad trades before seeking great ones."
```

### Token Budget Estimate
Current template: ~1,200 tokens
Proposed template: ~2,800 tokens (frameworks section adds ~1,600 tokens)

The frameworks section is heavy but justified by the user's choice to embed specific numbers. This is read once per session and governs every decision.

---

## 3. Skills Rewrite (7 fund skills)

### Systemic Changes (all skills)

1. Add `## When NOT to Use` section — prevents Claude 4.6 overtriggering
2. Wrap good/bad examples in `<example>` XML tags
3. Soften description language: "Use when..." not "Must use when..."
4. Output sections wrapped in skill-specific XML tags
5. Keep skills focused on HOW (technique) — remove duplicated rules/constraints

### Per-Skill Changes

#### 3.1 Investment Thesis
- Add `<example>` tags around good/bad thesis examples
- Add "When NOT to Use": mechanical stop exits, scheduled rebalances, trims under 2% of portfolio
- Add pre-mortem technique: "Assume 12 months from now this trade lost 20%. Write one paragraph explaining why. This is the single most effective debiasing exercise (Gary Klein)."
- Add Historical Parallel guidance: "First trades in a new sector/asset class deserve minimum sizing regardless of conviction"

#### 3.2 Risk Assessment — streamlined
- Remove content that now lives in CLAUDE.md `<hard_constraints>` and risk-guardian agent
- Keep: EV calculation, order specification steps
- Add: full drawdown recovery table as inline reference
- Add: "Use at least TWO sizing methods (conviction-based AND Kelly) and take the SMALLER" rule
- Add: "When NOT to Use": pure exit/trim decisions where risk is being reduced

#### 3.3 Trade Memory — enhanced
- Add `<example>` tags around SQL query patterns
- Add R-multiple framework: "Normalize all trades as multiples of initial risk. 1R = amount risked. A 3R winner = gained 3× the risk. This makes trades comparable across position sizes."
- Add guidance on FTS5 search keywords: "Search by: sector, catalyst type (earnings, FDA, FOMC), regime at entry, strategy name (breakout, mean-reversion, momentum)"
- Unchanged: decision rules, output format

#### 3.4 Market Regime — significant enhancement
- Replace qualitative-only assessment with composite scoring:
  ```
  Regime Score = Volatility (30%) + Trend (30%) + Credit (20%) + Macro (20%)
  Each component: 1 = risk-on signal, 2 = neutral, 3 = risk-off signal, 4 = crisis signal
  Composite: 1.0-1.5 = Risk-On | 1.5-2.5 = Transition | 2.5-3.5 = Risk-Off | 3.5-4.0 = Crisis
  ```
- Add specific indicators per component:
  - Volatility: VIX level, term structure, realized vs. implied spread
  - Trend: SPX vs. 50d/200d MA, advance/decline, % above 200d
  - Credit: IG/HY spreads, OAS widening/tightening
  - Macro: yield curve shape, DXY, LEI trend
- Add regime transition signals: "A regime change is signaled when 2+ components shift by ≥1 point in the same direction within 5 trading days"
- Add regime-dependent strategy constraints:
  - Risk-On: momentum, breakout strategies appropriate
  - Transition: mean-reversion, quality factor preferred
  - Risk-Off: defensive, income, short-duration
  - Crisis: cash, treasuries, gold only
- Add Dalio's warning: "In stress, correlations converge to 1.0. Apparent diversification is illusory when you need it most."

#### 3.5 Position Sizing — enhanced
- Keep current 6-step flow (already good)
- Add dual-method rule: "Always compute both conviction-based size AND Kelly-optimal size. Use the smaller."
- Add Piotroski F-Score reference: "For individual equities, prefer F-Score ≥ 6 (9-point quality scale). Academic evidence: stocks with F-Score ≥ 8 outperformed by 7.5%/year over 20 years."
- Add anti-overconfidence check: "If conviction-size > 2× Kelly-size, your conviction is likely miscalibrated. Use Kelly."
- Add "When NOT to Use": exits, stop-loss triggers, full-position closes (these don't need sizing calculations)

#### 3.6 Session Reflection — enhanced
- Add calibration score tracking: "Over the last 20 predictions, compare predicted probability to actual hit rate. If you predict 70% and win 40%, you are systematically overconfident. Adjust future conviction scores down by the gap."
- Expand bias checklist from 6 to 10 (add overconfidence, disposition effect, narrative fallacy, herding — from the full taxonomy in CLAUDE.md)
- Make "What will I do differently?" a mandatory output field (not just guidance)
- Add R-multiple tracking in journal updates: "Record risk (R) for every trade at entry. At exit, compute P&L as multiple of R."

#### 3.7 Portfolio Review — enhanced with goal-based lens
- Add objective-specific review criteria:
  - **Runway:** months remaining vs. target, burn rate sustainability, cash runway calculation
  - **Growth:** required return rate to reach target, pace assessment, anti-revenge-trading check at fund level
  - **Income:** yield sustainability, diversification across 10+ income sources, coverage ratio
  - **Accumulation:** cost basis trend, DCA vs. lump sum analysis, target completion percentage
- Add Taleb's survival question: "If I am completely wrong about everything, does the fund survive?"
- Add barbell assessment: "Classify each position as Essential (protect capital, low risk) or Asymmetric (limited downside, large upside). A healthy portfolio has both. A portfolio of only 'medium risk' positions is fragile."

---

## 4. Rules Rewrite (8 existing + 1 new = 9)

### Systemic Changes
- Add WHY context to every rule (one sentence explaining motivation)
- Remove duplication with skills and CLAUDE.md
- Keep rules concise — they load on every session

### Per-Rule Changes

#### 4.1 `state-consistency.md` — unchanged
Already concise and specific. No changes.

#### 4.2 `decision-quality.md` — trimmed
- Keep: decision hierarchy, red flags list
- Remove: "written thesis required" and "positive EV" sections (now in Investment Thesis and Risk Assessment skills)
- Add: "When analysts disagree, weight the one with more specific data. Vague concerns do not override quantified analysis."
- Add WHY: "This hierarchy exists because emotional overrides of systematic rules are the primary cause of preventable losses."

#### 4.3 `analysis-standards.md` — trimmed
- Keep: good/bad examples (add `<example>` tags), forbidden patterns list
- Remove: overlap with CLAUDE.md Standards section
- Merge best content into CLAUDE.md; keep only the forbidden patterns and examples here
- Add WHY: "Vague analysis leads to vague decisions. Specificity forces intellectual honesty."

#### 4.4 `risk-discipline.md` — enhanced
- Keep everything (most important rule file)
- Add: drawdown recovery table reference ("See CLAUDE.md frameworks section")
- Add: "In Risk-Off/Crisis, recalculate all concentration limits assuming 0.8 correlation between equity positions"
- Add WHY to header: "A 50% drawdown requires 100% gain to recover — math that makes most fund objectives unreachable."

#### 4.5 `learning-loop.md` — unchanged
Already strong. No changes.

#### 4.6 `market-awareness.md` — trimmed
- Keep: Calendar Awareness table, correlation awareness section
- Remove: regime behavior constraints (moved to Market Regime skill as single source of truth)
- Add WHY: "Calendar events create binary risk that sizing alone cannot manage."

#### 4.7 `self-scheduling.md` — unchanged
Already concise and specific.

#### 4.8 `memory-usage.md` — unchanged
Already concise.

#### 4.9 `communication.md` — NEW
```markdown
# Communication

Communicate with the user in Spanish via Telegram notifications and chat interactions.
Analysis files, trade journal entries, and session reports remain in English for
consistency and searchability.

Why: The user operates in Spanish. Technical financial content stays in English because
market terminology, ticker symbols, and financial ratios are universally expressed in English.

## Rules
- Telegram messages: Spanish
- Chat responses: Spanish
- analysis/*.md files: English
- Trade journal entries (reasoning, lessons_learned): English
- Session reports: English
- When quoting financial data in Spanish messages, keep ticker symbols and
  numbers in their original form (e.g., "AAPL subio 3.2% a $185.40")
```

---

## 5. Root CLAUDE.md — New Prompting Conventions Section

Add a new `## Prompting Conventions` section after `## Development Conventions`. This governs all future modifications to the AI instruction layer.

```markdown
## Prompting Conventions

Rules for writing and maintaining the AI instruction layer (skills, rules,
per-fund CLAUDE.md, sub-agent prompts). Based on Anthropic's official prompting
best practices (March 2026) and investment domain research.

### Prompt Structure
- Follow Anthropic's optimal ordering: role > context > constraints > frameworks > instructions > examples > task
- Place long-form dynamic data (portfolio state, journal entries) near the top of session prompts
- Place the actual task/question at the end for best retrieval performance
- Wrap dynamic content in descriptive XML tags: <fund_objective>, <hard_constraints>,
  <portfolio_state>, <recent_trades>, <market_assessment>

### Language Calibration (Claude 4.6+)
- Use natural language, not command language. "Use this when..." not "You MUST ALWAYS use..."
- Reserve aggressive modifiers (MUST, NEVER, CRITICAL) for genuine hard constraints (risk limits)
- Remove over-prompting for tool/skill triggering — Claude 4.6 triggers appropriately without "if in doubt, use X"
- If Claude needs to be cautious, use explicit behavioral instructions, not emphasis/shouting
- When in doubt, match the tone of a clear senior colleague explaining expectations to a competent new hire

### Skill Authoring
- Every SKILL.md requires: When to Use, When NOT to Use, Technique, Output Format
- Wrap good/bad examples in <example> XML tags
- Descriptions: one line, precise, differentiate from other skills
- Skills own the HOW — technique and methodology. Don't duplicate in rules or CLAUDE.md
- Test new/modified skills by running a paper-mode session after `fundx fund upgrade --all`

### Rule Authoring
- Rules are concise behavioral constraints (what to do / not do), not instruction manuals
- Every rule includes a **Why:** line explaining the motivation (helps Claude generalize)
- Rules never duplicate skill technique or CLAUDE.md framework content
- Rules load on every session — keep them short to conserve token budget
- One clear, non-overlapping scope per rule file

### Sub-Agent Authoring
- Each agent has a clear, non-overlapping domain boundary
- Descriptions precisely differentiate agents for correct routing
- Prompts include quality standards with good/bad examples in <example> tags
- Output format uses structured fields wrapped in XML tags for reliable parsing
- Limit tool access to what the agent needs (principle of least privilege)
- Set reasonable maxTurns to prevent runaway costs

### Anti-Hallucination
- Any prompt analyzing market data must include: "Never cite a price, ratio, or statistic
  without retrieving it from a tool this session. If data is unavailable, state that explicitly."
- Sub-agents with market-data MCP access get this instruction
- Session prompts require Orient phase (read state files) before any analysis
- Prefer structured output formats for data that can be validated programmatically

### Prompt Testing
- After modifying any skill, rule, or template in src/skills.ts or src/template.ts:
  1. Run `pnpm build` to compile
  2. Run `fundx fund upgrade --all` to propagate changes to existing funds
  3. Run a test session in paper mode to verify behavior
- Check for overtriggering: skills should activate when relevant, not on every session
```

### Other Root CLAUDE.md Updates
- Architecture section: update sub-agent description from "5 analysts (macro, technical, sentiment, risk, news)" to "3 agents (market-analyst, technical-analyst, risk-guardian)"
- Skills and Rules Pattern section: update counts to "7 skills + 9 rules"
- Directory layout: add `communication.md` to per-fund rules listing
- Source Structure: update `subagent.ts` description to "3 agent definitions (market, technical, risk-guardian)"
- Source Structure: note that `subagent.ts` now includes guardrail pattern

---

## 6. Files to Modify

| File | Change Type | Scope |
|------|------------|-------|
| `src/skills.ts` | Rewrite | All 7 BUILTIN_SKILLS content, add communication rule to FUND_RULES |
| `src/template.ts` | Rewrite | Complete `buildClaudeMd()` restructure |
| `src/subagent.ts` | Rewrite | Replace 5 agents with 3 |
| `CLAUDE.md` (root) | Edit | Add Prompting Conventions section, update architecture references |
| `.claude/rules/architecture.md` | Edit | Update sub-agent references |

### Files NOT modified (but affected by `fundx fund upgrade --all`)
- `~/.fundx/funds/*/CLAUDE.md` — regenerated from template
- `~/.fundx/funds/*/.claude/skills/*/SKILL.md` — regenerated from skills.ts
- `~/.fundx/funds/*/.claude/rules/*.md` — regenerated from skills.ts

---

## 7. Migration

After implementation:
1. `pnpm build` — compile changes
2. `fundx fund upgrade --all` — propagate to all existing funds
3. Run a paper-mode test session to verify:
   - CLAUDE.md renders correctly with XML tags and frameworks
   - Market-analyst invoked (not old macro/sentiment/news separately)
   - Risk-guardian validates trades
   - Communication in Spanish
   - No overtriggering of skills

---

## 8. What This Does NOT Change

- **Session execution flow** (`session.service.ts`, `chat.service.ts`, `agent.ts`) — the Agent SDK invocation, MCP server setup, streaming, and session resumption are unchanged
- **State files format** — portfolio.json, objective_tracker.json, etc. are unchanged
- **CLI commands** — no command changes
- **MCP servers** — broker-alpaca, market-data, telegram-notify are unchanged
- **Workspace CLAUDE.md and skills** — the create-fund flow is unchanged
- **Fund config schema** — fund_config.yaml is unchanged
