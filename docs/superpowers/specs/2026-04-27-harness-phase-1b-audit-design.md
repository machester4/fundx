# Phase 1b — Qualitative Audit (G7)

**Date:** 2026-04-27
**Status:** Approved (design)
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Closes gap:** G7 — existing scaffolding not stress-tested for Opus 4.7
**Pattern enforced:** Meta-pattern — *"every component encodes an assumption ... worth stress testing"* (Anthropic)

---

## Goal

For each high-leverage scaffolding component (4 sub-agents + 8 skills = **12 components**), produce a verdict **KEEP / SIMPLIFY / REMOVE** by applying the question:

> *"What does this component assume Claude can't do on its own? Is that assumption still true with Opus 4.7?"*

Output feeds the scope of Phase 2 (binding-the-evaluator) and Phase 3 (LLM-judge calibration).

## Non-goals

- **Auditing rules** — they're cheap (loaded once, behavioural not capability), not in scope here. Revisit opportunistically.
- **Quantitative benchmark of variance / pass rate per component** — too costly for the level of decision needed. We follow the same approach Anthropic does in its blog post: read-and-spot-check, not statistical.
- **Re-engineering the surviving components** — output is verdicts, not refactors.

---

## Components in scope

### Sub-agents (`src/subagent.ts`)

1. `market-analyst` — macro / sentiment / news
2. `technical-analyst` — TA: trend, volume, levels, momentum
3. `risk-guardian` — hard-constraints gate
4. `trade-evaluator` — skeptical thesis review

### Skills (`src/skills.ts BUILTIN_SKILLS`)

5. `investment-thesis`
6. `risk-assessment`
7. `trade-memory`
8. `market-regime`
9. `position-sizing`
10. `session-reflection`
11. `portfolio-review`
12. `opportunity-screening`

---

## Methodology — three passes

### Pass 1 — Reading (~1 day)

For each of the 12 components, read its definition with the assumption-question lens, and categorise:

- **🟢 GREEN** — clearly load-bearing. Encodes an assumption Opus 4.7 demonstrably does not satisfy on its own.
- **🟡 YELLOW** — suspicious. Assumption was true historically but may now be obsolete; needs spot-check.
- **🔴 RED** — clearly redundant or duplicated. Mark for removal without spot-check.

Record the initial categorisation in `docs/harness-audit.md` under each component's row. Add a new "Initial Category" column.

### Pass 2 — Spot-check (~1.5–2.5 days, only YELLOW)

For each YELLOW component:

1. Create branch `audit/disable-<component-name>`.
2. **Disable the component:**
   - Sub-agent: comment out its entry in the `agents` dict passed to the SDK in `src/agent.ts`.
   - Skill: comment out its entry in `BUILTIN_SKILLS` in `src/skills.ts`. Run `fundx fund upgrade --name fundx-audit-<component>` against the dedicated test fund to remove the skill from disk.
3. Run **2 paper-mode sessions** on `fundx-audit-<component>` (test fund seeded for this purpose):
   - Session A: `pre-market` type
   - Session B: `mid-session` or `post-market` (whichever exercises the component more)
4. Collect artefacts after each session:
   - `state/session-handoff.md`
   - `state/analysis/*.md`
   - `state/session_log.json`
   - SDK transcript (if accessible from logs)
5. Run **1 baseline session** of the same type on the same fund with the component re-enabled (checkout main / re-enable, run, then re-disable).
6. **Side-by-side reading**: compare baseline vs disabled outputs on the dimensions the component is supposed to deliver:
   - For `market-analyst`: macro coverage breadth, news synthesis quality
   - For `risk-guardian`: did the disabled run violate any hard constraint?
   - For `position-sizing`: did sizing diverge significantly? In which direction?
   - etc.
7. Record evidence as **direct quotes** from the artefacts. Avoid hand-wave summaries.

### Pass 3 — Verdict (~0.5 day)

For each of the 12 components, write 2–3 paragraphs in `docs/harness-audit.md` using this template:

```markdown
## <component-name>

**Original hypothesis:** <what it assumes the model can't do alone>

**Initial category:** 🟢 GREEN / 🟡 YELLOW / 🔴 RED

**Evidence:**
- (For YELLOW): direct quote from disabled-session artefact, direct quote from baseline.
- (For GREEN/RED): brief justification from reading.

**Verdict:** **KEEP** | **SIMPLIFY (<what changes>)** | **REMOVE**

**Phase 2 dependency:** <does this affect the binding-evaluator hook design? if so, how>
```

---

## A-priori expectations (calibration only — actual verdicts come from the passes)

| Component | A-priori | Risk of obsolescence in Opus 4.7 |
|---|---|---|
| `market-analyst` + `technical-analyst` | Possible SIMPLIFY (merge into one `market-research`) | Medium |
| `risk-guardian` | KEEP probable (canonical evaluator pattern #3) | Low |
| `trade-evaluator` | KEEP probable (same reasoning) | Low |
| `position-sizing` + `risk-assessment` | Possible SIMPLIFY (overlap on sizing logic) | Medium |
| `session-reflection` | KEEP probable (orchestrates handoff, pattern #1) | Low |
| `market-regime` | YELLOW — Opus 4.7 may classify regime in-context with good prompts | Medium |
| Other 4 skills | KEEP probable (domain-specific frameworks) | Low |

**Honest prediction:** 1–3 SIMPLIFY verdicts and 0–1 REMOVE. The harness is well-built; the value of this exercise is (a) validating assumptions, (b) any REMOVE saves tokens forever, (c) blocks Phase 2 from hardening soon-removed components.

---

## Output artefacts

1. **`docs/harness-audit.md`** — fully populated for the 12 components (today it is template-only).
2. **`docs/superpowers/specs/2026-04-27-harness-phase-1b-audit-results.md`** — closing summary doc, written at the end of Pass 3:
   - Verdicts table (one row per component)
   - List of changes (REMOVE, SIMPLIFY) with file paths
   - **Phase 2 implications**: which planned hooks change scope, which sub-agents disappear from the verdict-source pool
   - **Phase 3 implications**: should the LLM-judge be calibrated against the simplified or original component set?
3. **(If applicable) PR for REMOVE / SIMPLIFY** — separate, mechanical, mergeable independently of the rest of this roadmap. Eval suite must pass post-merge.

---

## Definition of Done

1. All 12 components have a verdict in `docs/harness-audit.md` with hypothesis, evidence, verdict, and Phase 2 dependency note.
2. Every YELLOW has at least one spot-check session pair (disabled + baseline) with quoted evidence.
3. Audit-results doc exists and is committed.
4. If REMOVE / SIMPLIFY verdicts exist:
   - PR with the changes is opened.
   - `fundx fund upgrade --all` is executed against at least one active fund.
   - MVP eval suite (`pnpm dev -- eval --filter mvp-`) is green post-merge.
5. The roadmap doc is updated with Phase 1b status = Done and a one-line summary of verdicts (e.g., "11 KEEP, 1 SIMPLIFY (merge market-analyst + technical-analyst), 0 REMOVE").

---

## Risks

| Risk | Mitigation |
|---|---|
| Spot-check sessions are inconclusive (no clear difference) | Default to KEEP. Bias toward retaining scaffolding when unsure. |
| Spot-check is biased by single-fund seed | Use `fundx-audit-<component>` with a varied portfolio (≥ 5 positions, mixed sectors) to maximise coverage opportunity. |
| Disabling a sub-agent during audit causes a real-money-equivalent (paper) loss in the test fund | Test fund is paper-only. The financial state is sandboxed by definition. |
| Audit takes longer than 4 days | Hard cap: if Pass 2 isn't done in 2.5 days, stop, default remaining YELLOWs to KEEP, document the deferral, proceed to Pass 3. |

---

## Effort

2.5–4 days, distributed as: 1 day reading + 1.5–2.5 days spot-checks + 0.5 day writeup.
