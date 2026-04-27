# Phase 1b — Qualitative Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Note on plan shape:** Phase 1b is a **methodology-driven audit**, not a TDD code feature. Tasks here mix code edits, manual sessions, and judgment work. Each task still has a clear "expected output" anchor in lieu of unit tests. The Pass 2 spot-check (Task 6) is templated — the implementer instantiates one sub-task per YELLOW component identified in Task 4.

**Goal:** Produce a verdict (KEEP / SIMPLIFY / REMOVE) for each of the 12 high-leverage scaffolding components (4 sub-agents + 8 skills) in the FundX harness, applying Anthropic's assumption-stress-test lens against Opus 4.7. Output drives Phase 2 scope and Phase 3 grader calibration.

**Architecture:** Single audit branch (`audit/run`) keeps experimental disables isolated from production main. A dedicated paper fund (`fundx-audit`) seeded with 6 diversified positions provides realistic state without contaminating real funds. One captured baseline session (full scaffolding enabled) is reused as the comparison reference for all per-YELLOW spot-checks. Pass 2 disables one component at a time, runs 2 sessions, captures artifacts, then re-enables before moving to the next component.

**Tech Stack:** TypeScript / Vitest (existing), pnpm CLI (`fundx fund create`, `fundx session run`), git branching, manual reading + qualitative judgment. No new code (only temporary disables that get reverted).

**Spec:** [`docs/superpowers/specs/2026-04-27-harness-phase-1b-audit-design.md`](../specs/2026-04-27-harness-phase-1b-audit-design.md)

**Operational decisions (locked in pre-plan):**
- **Workflow:** single `audit/run` branch; one component at a time; revert each disable before next.
- **Test fund:** new dedicated `fundx-audit`, seeded rich.
- **Cost ceiling:** $50 hard cap; abort Pass 2 early at $40 if approaching.

**Cost expectation:** setup ~$8, Pass 2 ~$15-25 (5-7 YELLOWs × 2 sessions × ~$2), eval re-run ~$2 → **$25-35 typical, $50 hard cap**.

---

## File Structure

| Path | Type | Responsibility |
|---|---|---|
| Branch `audit/run` | Create | Isolated branch; all disable-enable cycles + artifact archives commit here. |
| Fund `~/.fundx/funds/fundx-audit/` | Create | Dedicated paper fund seeded with 6 diversified positions. Disposable. |
| `~/.fundx/funds/fundx-audit/state/audit-archive/baseline/` | Create | Captured artifacts from the all-enabled baseline session. |
| `~/.fundx/funds/fundx-audit/state/audit-archive/<component>/` | Create per YELLOW | Captured artifacts from disabled-component sessions. |
| `docs/harness-audit.md` | Modify | Existing template (today: scaffolded grid). Becomes the verdict registry. |
| `docs/superpowers/specs/2026-04-27-harness-phase-1b-audit-results.md` | Create | Closing summary: verdicts table, change list, Phase 2 / 3 implications. |
| `src/agent.ts` (per spot-check) | Modify+revert | Comment out one entry in `agents` dict to disable a sub-agent. Revert at end of each spot-check. |
| `src/skills.ts` (per spot-check) | Modify+revert | Comment out one entry in `BUILTIN_SKILLS` to disable a skill. Revert at end of each spot-check. |
| `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md` | Modify | Append status log entry on completion. |

---

## Task 1: Setup audit branch + verify daemon stopped

**Files:**
- Create branch: `audit/run`
- Verify: daemon process not running

- [ ] **Step 1: Verify the FundX daemon is NOT running**

The daemon could fire scheduled sessions on production funds during the audit and contaminate state. Stop it first.

```bash
cd /Users/michael/Proyectos/fundx
pnpm dev -- status
```

Look at the output. If it says daemon is running:

```bash
pnpm dev -- stop
```

Re-verify with `pnpm dev -- status`. Daemon must be stopped before proceeding.

- [ ] **Step 2: Confirm `main` is clean**

```bash
git -C /Users/michael/Proyectos/fundx status
```

Expected: branch `main`, working tree clean (untracked files like `.DS_Store`, `local_cache/`, `research/` are OK — they have always been there). If there are unexpected modified files, stop and report.

- [ ] **Step 3: Create the audit branch from main**

```bash
git -C /Users/michael/Proyectos/fundx checkout -b audit/run
```

Expected: `Switched to a new branch 'audit/run'`. Verify:

```bash
git -C /Users/michael/Proyectos/fundx branch --show-current
```

Output must be `audit/run`.

- [ ] **Step 4: Tag the starting SHA for easy reset**

```bash
git -C /Users/michael/Proyectos/fundx tag audit-base
```

This is a local tag — never pushed. If anything goes wrong during the audit, `git reset --hard audit-base` returns to a known clean state.

- [ ] **Step 5: No commit needed for this task**

Branch creation does not need its own commit. The first commit on `audit/run` will come in Task 2 (fund creation artifacts).

---

## Task 2: Create `fundx-audit` test fund

**Files:**
- Create: `~/.fundx/funds/fundx-audit/` (via `fundx fund create`)

- [ ] **Step 1: Create the fund using the growth template**

Growth fits an audit fund well — modest capital, common objective shape, exercises portfolio-review and risk skills.

```bash
cd /Users/michael/Proyectos/fundx
pnpm dev -- fund create --name fundx-audit --template growth
```

If `--template growth` is not a valid syntax (the CLI may use a different flag or interactive prompt), use the interactive form:

```bash
pnpm dev -- fund create
```

and answer the prompts: name=`fundx-audit`, capital=`10000`, objective type=`growth`, target multiplier=`2`, risk profile=defaults, universe=`sp100` (or whatever preset is offered). Use defaults for everything else — this is a throwaway fund.

- [ ] **Step 2: Verify the fund exists**

```bash
ls ~/.fundx/funds/fundx-audit/
cat ~/.fundx/funds/fundx-audit/fund_config.yaml | head -30
```

Expected: directory exists, fund_config.yaml has `name: fundx-audit`, `capital.initial: 10000`, schedule with `pre_market`, `mid_session`, `post_market` keys.

- [ ] **Step 3: Verify the schedule uses the canonical session_type strings**

Grep for the session keys:

```bash
grep -E 'pre_market|mid_session|post_market' ~/.fundx/funds/fundx-audit/fund_config.yaml
```

Expected: at least 3 matches. If keys are different (e.g., hyphenated), update them in the YAML to underscores so the new `DEFAULTS_BY_SESSION_TYPE` cascade matches.

- [ ] **Step 4: Verify the fund's CLAUDE.md and skills were generated**

```bash
ls ~/.fundx/funds/fundx-audit/CLAUDE.md ~/.fundx/funds/fundx-audit/.claude/skills/
```

Expected: `CLAUDE.md` exists, `.claude/skills/` contains 8 subdirectories (one per `BUILTIN_SKILLS` entry).

- [ ] **Step 5: Commit a marker so the audit branch has its first commit**

There's nothing to commit in the repo (the fund lives in `~/.fundx/`, outside the repo). Create an audit log file in the repo to anchor the branch:

```bash
mkdir -p docs/superpowers/audit-1b/
cat > docs/superpowers/audit-1b/audit-log.md << 'EOF'
# Phase 1b Audit Log

This file logs the audit session for Phase 1b. Started 2026-04-27.

## Setup

- Branch: `audit/run`
- Test fund: `~/.fundx/funds/fundx-audit/` (paper, growth template, $10000 initial)
- Cost ceiling: $50 hard cap

## Sessions executed

(Filled in as Pass 2 progresses.)

## Cost running total

(Updated after each session.)
EOF

git -C /Users/michael/Proyectos/fundx add docs/superpowers/audit-1b/audit-log.md
git -C /Users/michael/Proyectos/fundx commit -m "audit(1b): initialize audit log on audit/run branch"
```

---

## Task 3: Seed `fundx-audit` with 6 diversified positions

**Files:**
- Modify: `~/.fundx/funds/fundx-audit/state/portfolio.json` (via interactive Claude session)

- [ ] **Step 1: Run a directed seeding session**

Use `fundx session run` with a focused prompt to open positions across sectors. The `pre_market` session_type is fine because the fund is empty and we just want trades.

```bash
cd /Users/michael/Proyectos/fundx
pnpm dev -- session run fundx-audit pre_market --focus "Open exactly 6 paper positions to build a diversified seed portfolio for an audit. Sectors: 1 large-cap tech (e.g. AAPL or MSFT), 1 financial (e.g. JPM or BAC), 1 energy (e.g. XOM or CVX), 1 healthcare (e.g. JNJ or UNH), 1 consumer (e.g. KO or WMT), 1 commodity ETF (e.g. GLD or IAU). Use ~12% of capital per position with appropriate stops. After buying all 6, write a brief portfolio review to state/analysis/<today>_seed.md and end the session — do not start additional analysis."
```

This is a single guided session. Cost expectation: $2-4 (6 buys + a brief writeup). Budget cap of $5 (pre_market default) prevents runaway.

- [ ] **Step 2: Verify the portfolio**

```bash
pnpm dev -- portfolio fundx-audit
```

Expected: 6 positions across the 6 sectors. If fewer (e.g., agent only opened 4), re-run the session with a more directive focus mentioning the missing tickers explicitly. Do not exceed 1 retry — if 2 attempts can't produce 6 positions, accept what you have and proceed (the audit needs realistic state, not perfection).

- [ ] **Step 3: Update audit log with cost**

Read `~/.fundx/funds/fundx-audit/state/session_log.json`, find the latest entry, note `cost_usd`. Append to `docs/superpowers/audit-1b/audit-log.md`:

```markdown

### 2026-04-27 setup — seed positions

- Session: pre_market
- Cost: $X.XX
- Positions opened: 6 (or N — reason for discrepancy)
- Running total: $X.XX
```

- [ ] **Step 4: Commit the audit log update**

```bash
cd /Users/michael/Proyectos/fundx
git add docs/superpowers/audit-1b/audit-log.md
git commit -m "audit(1b): seed fundx-audit with 6 diversified positions"
```

---

## Task 4: Pass 1 — Read & categorize all 12 components

**Files:**
- Modify: `docs/harness-audit.md` (currently template-only; populate with categorizations)

This task is judgment-heavy. The implementer reads each component and decides 🟢 / 🟡 / 🔴 based on the assumption-stress-test lens. No sessions are run.

- [ ] **Step 1: Read the existing audit template**

```bash
cat docs/harness-audit.md
```

Familiarize yourself with the template structure (4 sub-agents + 7 skills + 11 rules). Note: the template lists 7 skills; `BUILTIN_SKILLS` actually contains 8 (see `src/skills.ts`). Add the missing entry (`opportunity-screening`) to the template before proceeding.

- [ ] **Step 2: Read all 4 sub-agents and assign initial categories**

For each sub-agent, read its definition in `src/subagent.ts`:

| Sub-agent | Lines | What to look for |
|---|---|---|
| `market-analyst` | 21–131 | Macro/sentiment/news synthesis. Anti-hallucination. Quality standards. |
| `technical-analyst` | 133–211 | Trend, volume, levels, momentum. TA framework. |
| `risk-guardian` | 213–314 | Hard-constraints gate. "Find reasons to reject" directive. |
| `trade-evaluator` | 316–411 | Skeptical thesis review. Bias check. |

For each, ask:
- *What does this sub-agent assume Opus 4.7 can't do alone?*
- *Is the quality standard / structured output something Opus 4.7 produces unprompted?*
- *Does the cost (separate context window, dedicated prompt, ~25 turns) buy meaningful capability over an inline `Task` invocation?*

Assign 🟢 / 🟡 / 🔴 based on:
- 🟢 GREEN if the sub-agent encodes domain-specific judgment (skeptical reviewer pattern, hard-gate pattern) the model would not self-impose.
- 🟡 YELLOW if the value is in the structured output format or quality standards — Opus 4.7 might produce these in-line with good prompting.
- 🔴 RED if the sub-agent's output is trivially producible by the main agent without separation.

Record your categorization. Note expected: per the spec's a-priori, `risk-guardian` and `trade-evaluator` are likely 🟢 (canonical evaluator pattern); `market-analyst` and `technical-analyst` may be 🟡 (potential merge into one `market-research`).

- [ ] **Step 3: Read all 8 skills and assign initial categories**

For each skill, read its definition in `src/skills.ts` (`BUILTIN_SKILLS` array entries by `dirName`):

| Skill | dirName | What to look for |
|---|---|---|
| Investment Thesis | `investment-thesis` | Bull/bear/devil's advocate framework |
| Risk Assessment | `risk-assessment` | EV check, position sizing, universe awareness, stop-loss validation |
| Trade Memory | `trade-memory` | Journal queries, R-multiple framework |
| Market Regime | `market-regime` | Risk-On/Off classification, composite scoring |
| Position Sizing | `position-sizing` | Conviction + Kelly + regime multiplier |
| Session Reflection | `session-reflection` | Decision audit, bias check, handoff writing |
| Portfolio Review | `portfolio-review` | Position-by-position thesis validation |
| Opportunity Screening | `opportunity-screening` | Screener + watchlist orchestration |

For each, ask:
- *Does this skill encode a framework the model needs to be told (Kelly criterion, R-multiple, regime classification, F-Score gate)?*
- *Or is it a checklist the model would naturally follow with good system prompt + CLAUDE.md?*

Skills are typically **higher value-density than sub-agents** — they're cheap (loaded once, no separate context) and frame domain reasoning. Bias is toward 🟢 unless you find clear duplication or trivially-derivable framework.

Note expected per spec a-priori: `position-sizing` + `risk-assessment` may overlap → 🟡; `market-regime` may be 🟡; others probably 🟢.

- [ ] **Step 4: Update `docs/harness-audit.md` with categorizations**

Add an "Initial Category" column to each table. Fill in 🟢 / 🟡 / 🔴 per component. For each YELLOW, also write a one-line "Why YELLOW" reason in the row.

- [ ] **Step 5: Identify and list YELLOW components for Pass 2**

At the bottom of the sub-agents and skills tables in `docs/harness-audit.md`, add a section:

```markdown
## Pass 2 Targets (YELLOW components needing spot-check)

- [ ] component-name-1 — why
- [ ] component-name-2 — why
- ...
```

Count: there should be 0–7 YELLOWs total. If more than 7, your bar for YELLOW is too low — re-categorize the borderline cases as 🟢 (default to KEEP). If 0, Pass 2 is empty and you skip directly to Pass 3.

- [ ] **Step 6: Commit Pass 1 results**

```bash
cd /Users/michael/Proyectos/fundx
git add docs/harness-audit.md
git commit -m "audit(1b): pass 1 — categorize 12 components (N YELLOW for spot-check)"
```

(Replace `N` with the actual YELLOW count.)

---

## Task 5: Capture all-enabled baseline session

**Files:**
- Create: `~/.fundx/funds/fundx-audit/state/audit-archive/baseline/`

This baseline runs against `audit/run` branch with **all components enabled** (no disables yet). The artifacts captured here serve as the comparison reference for every per-YELLOW spot-check in Task 6.

- [ ] **Step 1: Verify no source modifications**

```bash
git -C /Users/michael/Proyectos/fundx status
```

Expected: clean working tree on `audit/run`. If `src/agent.ts` or `src/skills.ts` are modified (leftover from a previous spot-check), revert before proceeding:

```bash
git -C /Users/michael/Proyectos/fundx checkout -- src/agent.ts src/skills.ts
```

- [ ] **Step 2: Run the baseline session**

```bash
cd /Users/michael/Proyectos/fundx
pnpm dev -- session run fundx-audit pre_market
```

This uses the regular fund schedule and full scaffolding. Cost expectation: $3-5 (pre_market default cap is $5).

- [ ] **Step 3: Archive the baseline artifacts**

```bash
mkdir -p ~/.fundx/funds/fundx-audit/state/audit-archive/baseline
cp ~/.fundx/funds/fundx-audit/state/session-handoff.md ~/.fundx/funds/fundx-audit/state/audit-archive/baseline/session-handoff.md
cp -r ~/.fundx/funds/fundx-audit/state/analysis ~/.fundx/funds/fundx-audit/state/audit-archive/baseline/analysis 2>/dev/null || true
tail -n 50 ~/.fundx/funds/fundx-audit/state/session_log.json > ~/.fundx/funds/fundx-audit/state/audit-archive/baseline/session_log_tail.json
```

(`tail -n 50` captures the most recent log entries; the full file may be JSON-array shaped — copying the whole file is also fine if smaller.)

- [ ] **Step 4: Update audit log**

Append to `docs/superpowers/audit-1b/audit-log.md`:

```markdown

### 2026-04-27 baseline — all components enabled

- Session: pre_market
- Cost: $X.XX
- Artifacts: ~/.fundx/funds/fundx-audit/state/audit-archive/baseline/
- Running total: $Y.YY
```

(Read the cost from `session_log.json` latest entry. Update the running total = previous total + this cost.)

- [ ] **Step 5: Commit audit log update**

```bash
cd /Users/michael/Proyectos/fundx
git add docs/superpowers/audit-1b/audit-log.md
git commit -m "audit(1b): capture all-enabled baseline session"
```

---

## Task 6: Pass 2 — Spot-check each YELLOW component

This task is a **loop**. The implementer instantiates one sub-task instance per YELLOW component identified in Task 4 step 5. Each sub-task uses the same template below.

**Stopping conditions** (check before each new sub-task instance):
- All YELLOWs from Task 4 done → proceed to Task 7.
- Running total cost ≥ $40 → stop, document remaining YELLOWs in `docs/harness-audit.md` as "spot-check deferred (budget cap)", default to KEEP for remaining, proceed to Task 7.

### Sub-task template — repeat per YELLOW component

Replace `<COMPONENT>` everywhere with the actual component name (e.g., `market-analyst` for sub-agents, `position-sizing` for skills).

Replace `<KIND>` with `subagent` or `skill`.

- [ ] **Step 1: Confirm working tree is clean**

```bash
git -C /Users/michael/Proyectos/fundx status
```

Must be clean on `audit/run`. If not, `git checkout -- src/agent.ts src/skills.ts` to revert any leftover edit.

- [ ] **Step 2: Disable `<COMPONENT>`**

For a **sub-agent** (e.g., `market-analyst`):

Open `src/subagent.ts` in your editor. Find the entry `"<COMPONENT>": { ... }` in the `agents` dict returned by `buildAnalystAgents`. Comment out the entire entry block (from `"<COMPONENT>":` to the closing `},` after that entry).

For a **skill** (e.g., `position-sizing`):

Open `src/skills.ts`. In the `BUILTIN_SKILLS` array, find the entry with `dirName: "<COMPONENT>"`. Comment out the entire object literal for that entry (from the opening `{` to the closing `},`).

Then rebuild the per-fund skill files on disk:

```bash
cd /Users/michael/Proyectos/fundx
pnpm dev -- fund upgrade --name fundx-audit
```

(This re-renders `~/.fundx/funds/fundx-audit/.claude/skills/` from the current `BUILTIN_SKILLS` — the disabled skill's directory will be removed.)

For sub-agents, no `fund upgrade` is needed (the disabled-agents dict is rebuilt on every `runFundSession` from `src/subagent.ts` in process).

- [ ] **Step 3: Verify the disable took effect**

For a sub-agent:
```bash
grep -A 1 '"<COMPONENT>"' /Users/michael/Proyectos/fundx/src/subagent.ts | head -5
```
Must show the entry is commented out (`// "<COMPONENT>":`) or absent.

For a skill:
```bash
ls ~/.fundx/funds/fundx-audit/.claude/skills/ | grep -E '<COMPONENT>'
```
Must return empty (skill directory was removed by `fund upgrade`).

- [ ] **Step 4: Run two sessions on `fundx-audit` with the component disabled**

Session A (`pre_market`):
```bash
cd /Users/michael/Proyectos/fundx
pnpm dev -- session run fundx-audit pre_market
```

Session B (`mid_session`):
```bash
pnpm dev -- session run fundx-audit mid_session
```

Cost expectation: $4-6 total for both ($2-3 each).

If session A burns much more than $3, **stop after session A** to conserve budget. One disabled session is enough evidence for most YELLOWs.

- [ ] **Step 5: Archive the disabled-session artifacts**

```bash
ARCHIVE=~/.fundx/funds/fundx-audit/state/audit-archive/<COMPONENT>
mkdir -p $ARCHIVE
cp ~/.fundx/funds/fundx-audit/state/session-handoff.md $ARCHIVE/session-handoff-after-B.md
cp -r ~/.fundx/funds/fundx-audit/state/analysis $ARCHIVE/analysis 2>/dev/null || true
tail -n 100 ~/.fundx/funds/fundx-audit/state/session_log.json > $ARCHIVE/session_log_tail.json
```

- [ ] **Step 6: Re-enable `<COMPONENT>` (revert the disable edit)**

```bash
cd /Users/michael/Proyectos/fundx
git checkout -- src/subagent.ts src/skills.ts
```

For skills, also re-render the skill files on disk:
```bash
pnpm dev -- fund upgrade --name fundx-audit
```

Verify revert:
```bash
git -C /Users/michael/Proyectos/fundx status
```
Must show clean working tree.

- [ ] **Step 7: Side-by-side comparison and evidence capture**

Read both archives and compare on the dimensions the component is supposed to deliver:

```bash
# Open in two views
cat ~/.fundx/funds/fundx-audit/state/audit-archive/baseline/session-handoff.md
cat ~/.fundx/funds/fundx-audit/state/audit-archive/<COMPONENT>/session-handoff-after-B.md
ls ~/.fundx/funds/fundx-audit/state/audit-archive/baseline/analysis/
ls ~/.fundx/funds/fundx-audit/state/audit-archive/<COMPONENT>/analysis/
```

Comparison dimensions per component:

- **`market-analyst`**: macro coverage breadth (number of factors mentioned), news synthesis quality, tool usage (did the agent use FMP news?).
- **`technical-analyst`**: TA dimensions covered (trend, volume, levels, momentum), specificity of levels (numbers vs. hand-wave).
- **`risk-guardian`**: did the disabled run violate any hard constraint (over-position, missing stop-loss, correlation > 0.7)?
- **`trade-evaluator`**: did the disabled run open trades the baseline rejected? Did the disabled thesis miss the bear case?
- **`investment-thesis`**: thesis structure (bull/bear/devil's advocate present?), specificity vs. vagueness.
- **`risk-assessment`**: EV calculation present? Position size justified by formula?
- **`trade-memory`**: did the agent query the journal? Did it reference past trades?
- **`market-regime`**: regime classification present? Composite scoring used?
- **`position-sizing`**: Kelly check present? Conviction-based sizing? Regime multiplier?
- **`session-reflection`**: handoff structured (Session Contract, What I Did, Open Concerns, Next Session Should)? Decision audit present?
- **`portfolio-review`**: position-by-position thesis review present?
- **`opportunity-screening`**: screener invoked? watchlist queried?

For each dimension, write a 1-2 sentence finding in `docs/harness-audit.md` under the component's row, citing direct quotes from both artifacts.

Verdict (preliminary — finalized in Task 7):
- **KEEP** if the disabled run measurably degraded on the dimension (missing data, vaguer language, skipped reasoning).
- **SIMPLIFY** if the disabled run produced equivalent quality but with less structure / less consistent format.
- **REMOVE** if the disabled run produced equivalent or better output (very rare).

- [ ] **Step 8: Update audit log with cost + verdict**

Append to `docs/superpowers/audit-1b/audit-log.md`:

```markdown

### 2026-04-27 spot-check — <COMPONENT>

- Sessions: pre_market, mid_session (or just pre_market if budget conservation triggered)
- Cost: $X.XX
- Preliminary verdict: KEEP | SIMPLIFY | REMOVE — one-line reason
- Artifacts: ~/.fundx/funds/fundx-audit/state/audit-archive/<COMPONENT>/
- Running total: $Y.YY
```

- [ ] **Step 9: Commit the spot-check evidence**

```bash
cd /Users/michael/Proyectos/fundx
git add docs/harness-audit.md docs/superpowers/audit-1b/audit-log.md
git commit -m "audit(1b): spot-check <COMPONENT> — preliminary verdict <VERDICT>"
```

- [ ] **Step 10: Check budget gate before next sub-task**

Read the running total from `docs/superpowers/audit-1b/audit-log.md`. If total ≥ $40, **stop the loop**, document remaining YELLOWs as "spot-check deferred (budget cap)" in `docs/harness-audit.md`, default them to KEEP, and proceed to Task 7.

Otherwise, return to Step 1 with the next YELLOW component.

---

## Task 7: Pass 3 — Write final verdicts

**Files:**
- Modify: `docs/harness-audit.md` (consolidate per-component verdicts with hypothesis, evidence, Phase 2 dependency)

- [ ] **Step 1: For each of the 12 components, write a verdict block**

Use this template per component (replace `<COMPONENT>` and fill in):

```markdown
## <COMPONENT>

**Original hypothesis:** <what it assumes the model can't do alone — 1-2 sentences>

**Initial category:** 🟢 GREEN / 🟡 YELLOW / 🔴 RED

**Evidence:**
- (For YELLOW with spot-check completed): direct quote from disabled-session artifact, direct quote from baseline. 2-4 quotes total.
- (For YELLOW with spot-check deferred due to budget): note "deferred — defaulted to KEEP per protocol".
- (For GREEN/RED): brief justification from Pass 1 reading. 1-2 sentences.

**Verdict:** **KEEP** | **SIMPLIFY (<what changes>)** | **REMOVE**

**Phase 2 dependency:** <does removing or simplifying this affect the binding-evaluator hook design planned for Phase 2? if so, how>
```

Place these blocks below the existing tables in `docs/harness-audit.md`.

- [ ] **Step 2: Sanity check the verdict distribution**

Per the spec's honest prediction: 1-3 SIMPLIFY, 0-1 REMOVE expected. If your verdicts are dramatically different (e.g., 5+ REMOVE, or 0 KEEP), revisit your reading bar. The harness was deliberately designed; aggressive REMOVE without strong evidence likely indicates a too-optimistic stance toward Opus 4.7's capabilities.

- [ ] **Step 3: Commit Pass 3 results**

```bash
cd /Users/michael/Proyectos/fundx
git add docs/harness-audit.md
git commit -m "audit(1b): pass 3 — final verdicts for all 12 components"
```

---

## Task 8: Write closing summary doc

**Files:**
- Create: `docs/superpowers/specs/2026-04-27-harness-phase-1b-audit-results.md`

- [ ] **Step 1: Write the summary doc**

Create `docs/superpowers/specs/2026-04-27-harness-phase-1b-audit-results.md` with this structure:

```markdown
# Phase 1b — Audit Results

**Date:** 2026-04-27
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Spec:** [phase-1b-audit-design](./2026-04-27-harness-phase-1b-audit-design.md)
**Cost:** $X.XX (against $50 cap)

---

## Verdicts table

| Component | Kind | Initial | Verdict | Reason |
|---|---|---|---|---|
| market-analyst | sub-agent | 🟡 | KEEP / SIMPLIFY / REMOVE | one-line |
| technical-analyst | sub-agent | 🟡 | ... | ... |
| ... (all 12 rows) |

---

## Changes to apply

- (List any SIMPLIFY actions: file paths + 1-line description)
- (List any REMOVE actions: file paths + 1-line description)
- If empty: "No changes — all components verdict KEEP."

---

## Phase 2 implications

(For each removed or simplified component, note how the planned Phase 2 hooks change scope. E.g., "If trade-evaluator REMOVED, the G1 hook needs a new verdict source — possibly risk-guardian's verdict, or no verdict gate at all.")

---

## Phase 3 implications

(Should the LLM-judge grader be calibrated against the simplified or original component set? Note any scope adjustment.)

---

## Deferred items

(Any YELLOWs whose spot-check was deferred due to budget cap. Listed for follow-up.)
```

Fill in every section based on Task 7 verdicts and Task 6 evidence.

- [ ] **Step 2: Commit the summary doc**

```bash
cd /Users/michael/Proyectos/fundx
git add docs/superpowers/specs/2026-04-27-harness-phase-1b-audit-results.md
git commit -m "audit(1b): closing summary with verdicts table + Phase 2/3 implications"
```

---

## Task 9: Apply REMOVE / SIMPLIFY changes (if any)

**Skip this task entirely if all 12 verdicts are KEEP.**

- [ ] **Step 1: Read the changes list from the summary doc**

```bash
cat docs/superpowers/specs/2026-04-27-harness-phase-1b-audit-results.md
```

Look at the "Changes to apply" section. If it lists no changes, mark this task complete and proceed to Task 10.

- [ ] **Step 2: Apply each REMOVE / SIMPLIFY change**

For each change:
- **REMOVE a sub-agent:** delete its entry from `src/subagent.ts` (NOT comment out — actual deletion). Run `pnpm test` and `pnpm typecheck` to verify nothing references it.
- **REMOVE a skill:** delete its entry from `BUILTIN_SKILLS` in `src/skills.ts`. Run `pnpm dev -- fund upgrade --all` to remove from existing funds' disk state. Run `pnpm test` and `pnpm typecheck`.
- **SIMPLIFY (e.g., merge two sub-agents):** edit per the verdict's specific instruction. Update tests. Verify build.

Apply changes one at a time, committing each separately:

```bash
cd /Users/michael/Proyectos/fundx
git add <changed files>
git commit -m "audit(1b): apply <VERDICT> for <COMPONENT> per audit results"
```

- [ ] **Step 3: Run the MVP eval suite to verify no regression**

```bash
cd /Users/michael/Proyectos/fundx
pnpm dev -- eval --filter mvp-
```

Expected: PASS — all 8 cases green. If any case fails, the removal broke a depended-on signal. Investigate, possibly revert that specific change, document in audit-log.

- [ ] **Step 4: Run `fund upgrade --all` against active funds**

```bash
pnpm dev -- fund upgrade --all
```

This propagates skill/rule changes to existing fund directories. Verify it succeeds for `prueba`, `Growth`, `pm-survivor`, `runway-metal`.

- [ ] **Step 5: Update audit log with eval result**

Append to `docs/superpowers/audit-1b/audit-log.md`:

```markdown

### 2026-04-27 — apply audit changes

- Changes applied: <list>
- MVP eval: PASS / FAIL details
- fund upgrade --all: success / details
- Final running cost: $X.XX
```

```bash
git add docs/superpowers/audit-1b/audit-log.md
git commit -m "audit(1b): document change application + eval verification"
```

---

## Task 10: Merge audit branch and update roadmap

**Files:**
- Modify: `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md` (status log)
- Merge: `audit/run` → `main`

- [ ] **Step 1: Switch to main and merge the audit branch**

```bash
cd /Users/michael/Proyectos/fundx
git checkout main
git merge audit/run --no-ff -m "Merge phase 1b audit: $(git log audit/run --pretty=format:'%s' | head -1 | cut -c -50)"
```

(The `--no-ff` keeps the audit branch's commits visible as a group.)

- [ ] **Step 2: Update the roadmap status log**

Edit `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md`. Find the "Status log" table at the bottom. Append a new row:

```markdown
| 2026-04-27 | Phase 1b complete: <N> KEEP, <M> SIMPLIFY, <K> REMOVE. Spot-checked <Y> YELLOW components for $<COST>. Phase 2 implications: <one-line>. Audit branch merged. |
```

- [ ] **Step 3: Commit roadmap update**

```bash
cd /Users/michael/Proyectos/fundx
git add docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md
git commit -m "docs(roadmap): mark phase 1b complete with audit summary"
```

- [ ] **Step 4: Clean up `fundx-audit` fund**

The fund served its purpose. Optional but recommended cleanup:

```bash
pnpm dev -- fund delete fundx-audit
```

Confirm when prompted. The fund directory is removed; running cost is no longer tracked against it.

- [ ] **Step 5: Delete the local `audit-base` tag and `audit/run` branch**

```bash
cd /Users/michael/Proyectos/fundx
git tag -d audit-base
git branch -d audit/run
```

(Use `-d` not `-D` — the safety check refuses to delete unmerged commits, which is good. If you intentionally want to drop the branch even if unmerged, use `-D`.)

---

## Self-Review Checklist (before marking phase complete)

After Task 10:

- [ ] `pnpm test` is green on `main`.
- [ ] `pnpm typecheck` is clean.
- [ ] `git log --oneline main` shows audit commits properly merged.
- [ ] `docs/harness-audit.md` has a verdict for all 12 components.
- [ ] `docs/superpowers/specs/2026-04-27-harness-phase-1b-audit-results.md` exists and lists Phase 2 / 3 implications.
- [ ] Roadmap status log has a Phase 1b completion entry.
- [ ] If REMOVE/SIMPLIFY: MVP eval suite was re-run post-change and is green.
- [ ] Total cost from audit log is below $50 cap.

If any of these is not true, the phase is **not** done. Do not mark Phase 1b as complete in the roadmap.
