# Phase 1b — Audit Results

**Date:** 2026-04-28 (audit completed; spec dated 2026-04-27)
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Spec:** [phase-1b-audit-design](./2026-04-27-harness-phase-1b-audit-design.md)
**Cost:** ~$25.41 against $50 cap

---

## Verdicts table

| Component | Kind | Initial | Verdict | Reason |
|---|---|---|---|---|
| market-analyst | sub-agent | 🟡 | **SIMPLIFY** | Merge with technical-analyst into `market-research` |
| technical-analyst | sub-agent | 🟡 | **SIMPLIFY** | Merge with market-analyst into `market-research` |
| risk-guardian | sub-agent | 🟢 | KEEP | Canonical evaluator pattern; load-bearing |
| trade-evaluator | sub-agent | 🟢 | KEEP | Canonical evaluator pattern; demonstrably load-bearing (caught GEV anti-hallucination) |
| investment-thesis | skill | 🟢 | KEEP | Pre-mortem (Gary Klein) is unique cognitive intervention |
| risk-assessment | skill | 🟡 | **REMOVE** | ~70% overlap with position-sizing + risk-guardian; unique universe MCP guidance must be relocated |
| trade-memory | skill | 🟢 | KEEP | Without it, trade_journal.sqlite is invisible |
| market-regime | skill | 🟢 | KEEP | Specific quantitative scoring framework with downstream sizing impact |
| position-sizing | skill | 🟡 | KEEP | Load-bearing; spot-check showed Kelly + 2-method discipline only persists here |
| session-reflection | skill | 🟢 | KEEP | Orchestrates entire Reflect phase; handoff format is critical for continuity |
| portfolio-review | skill | 🟢 | KEEP | Survival Question + Barbell Assessment are unique cognitive interventions |
| opportunity-screening | skill | 🟢 | KEEP | Heavy on screener MCP tool guidance; without it MCP is opaque |

**Tally:** 9 KEEP, 2 SIMPLIFY (one merge action), 1 REMOVE (with relocation requirement).

---

## Changes to apply (Task 9 of plan)

### Change A — Merge `market-analyst` + `technical-analyst` into `market-research`

**Files affected:**
- `src/subagent.ts` — replace two `AgentDefinition` entries with one combined `market-research` entry. Combine prompts to cover macro + sentiment + news + TA. Combine output format (`<market_research>` with both market_assessment and technical_assessment subsections). Combine tool list (Read/Write/WebSearch/Bash/Grep/Glob). Keep market-data MCP. Set maxTurns to 30 (between the original 25 and 20).
- `docs/harness-audit.md` — note the merge in the Sub-Agents table.
- Per-fund `CLAUDE.md` template (`src/template.ts`) — if it references `market-analyst` / `technical-analyst` agent names anywhere, update to `market-research`.

**Verification:**
- Run MVP eval suite (`pnpm dev -- eval --filter mvp-`) — must pass post-merge.
- Run one paper session against `prueba` or `fundx-audit` to confirm the merged agent works end-to-end.

### Change B — REMOVE `risk-assessment` skill (with universe MCP guidance relocation)

**Files affected:**
- `src/skills.ts` — delete the `risk-assessment` entry from `BUILTIN_SKILLS`.
- **Universe MCP guidance must be relocated** before deletion. Recommended target: extend the `opportunity-screening` skill's content to absorb the check_universe / list_universe / update_universe sections from risk-assessment. Alternative: create a small new `universe-management` skill. Decision deferred to Task 9 implementation.
- All existing funds: run `pnpm dev -- fund upgrade --all` to remove risk-assessment from disk and update CLAUDE.md.

**Verification:**
- Run MVP eval suite — must pass.
- Run one paper session and verify: agent still applies sizing math (via position-sizing skill) AND the universe MCP guidance is reachable from wherever it was relocated to.

### Change C — None

The remaining 9 components are KEEP. No changes.

---

## Phase 2 implications

- The G1 hook (binding evaluator verdict) was planned to gate `place_order` on a recent APPROVED verdict from `trade-evaluator`. **Trade-evaluator is KEEP** — hook design stands as planned.
- Risk-guardian verdict is also KEEP — parallel gate planned in Phase 2 is unaffected.
- The `market-research` merge does NOT affect the verdict-source pool (those are output-producing analysts, not verdict-issuing evaluators).

**No Phase 2 scope changes required.**

---

## Phase 3 implications

- The LLM-as-judge eval grader (G5) must be calibrated against the post-audit component set:
  - Score `market-research` sub-agent's combined output (not separate market-analyst + technical-analyst).
  - Drop "did the agent apply EV calculation framework" criterion (was risk-assessment-specific). Replace with "did the agent apply two-method sizing per position-sizing skill" — broader and more verifiable.
  - Universe MCP usage criteria stay (relocated content still applies).
- **Phase 3 scope adjustment:** rubric design happens AFTER Task 9 of this plan completes (i.e., after the merge + remove are applied).

---

## Deferred items

None — all 4 YELLOWs spot-checked within budget.

---

## Process improvements for future audits

Lessons from Phase 1b execution:

1. **Use a directive focus that exercises components.** The first baseline session ($0.90, 11 turns, no-trade) produced no analysis files because the agent decided not to trade. The "audit-directive" focus (force market-analyst + technical-analyst invocation, hypothetical candidate evaluation, no execution) gave 24 turns and 13 artifacts — usable for comparison.

2. **Same-day artifact reuse contaminates spot-checks.** The technical-analyst spot-check was contaminated because the agent recognized prior-session artifacts and reused them rather than re-invoking. This actually mirrors production behavior (artifacts persist) so the contamination is informative — but explicit baselines per spot-check (or wiping `analysis/` between runs) would give cleaner signals.

3. **Test inverse pairs to identify load-bearing component.** Two skills that overlap (risk-assessment ↔ position-sizing) need both to be disabled in turn — the one whose absence breaks the math is the load-bearing one. Spot-checks #3 and #4 demonstrated this clearly.

4. **session_log corruption under timeout.** Spot-check #4 (position-sizing) reported `cost: $0 / turns: 0 / status: timeout` despite producing 4 substantive analysis files. Worth investigating whether `runFundSession`'s log-write path silently drops result data when the SDK reports timeout. Out of scope for Phase 1b but flagged for follow-up.
