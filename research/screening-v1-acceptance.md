# Screening V1 — Acceptance Notes

**Date:** 2026-04-14
**Branch:** `feat/screening-v1`
**Worktree:** `/Users/michael/Proyectos/fundx-screening`

Acceptance tests run after all 13 implementation tasks landed. Objective: verify
the deterministic end-to-end pipeline (CLI → service → watchlist DB) works
against real FMP data.

## What was run

1. `pnpm dev screen run`
2. `pnpm dev screen watchlist --limit 10`
3. `pnpm dev screen trajectory SNDK`
4. `pnpm dev screen tag SNDK rejected --reason "E2E test override"`
5. Re-ran trajectory to verify the manual transition was recorded.
6. Inspected `watchlist_fund_tags` table for fund-compatibility tagging.
7. `pnpm dev fund upgrade --all` (Task 13) to propagate the new skill + rule.

## Observations

**Screen run performance.** 503 S&P 500 constituents scored in 6.8s on a warm
price cache (second run same day). First cold run took longer due to FMP
fetches. Top-10 momentum scores were dominated by NAND/HDD/optical names
(SNDK +2028%, LITE +1043%, WDC +684%, MU +510%, CIEN +478%) — a coherent
cluster given the 2025-2026 AI-memory cycle. Sanity-check passed.

**Watchlist state machine.** After two consecutive runs, top-decile tickers
correctly transitioned `ø → candidate → watching` with the reason
`two_consecutive_passes`. The trajectory view showed two score rows and two
transitions per ticker as expected.

**Manual tag override.** Tagging SNDK `rejected` produced the third transition
`watching → rejected` with reason `manual:cli:E2E test override`. Trajectory
display remains chronological.

**Fund compatibility tagging.** Two of four existing funds (`pm-survivor`,
`runway-metal`) received 50 fund-tag rows each (one per passing ticker), all
with `compatible = 0` — correct, because those funds' `universe` contains
explicit ETF tickers (GDXJ, JNUG, AGQ, UGL, etc.) that don't overlap with the
S&P 500 top-momentum cluster. The other two funds (`Growth`, `prueba`) received
zero fund tags — their universes use `type: sector/strategy/protocol`, which
V1 skips per plan.

**Fund upgrade propagation.** `fundx fund upgrade --all` wrote
`.claude/skills/opportunity-screening/SKILL.md` to all four existing funds and
refreshed `.claude/rules/session-init.md` with step 7 (verified by
`grep watchlist`).

**Daemon cron.** Registered with `0 22 * * 1-5` schedule. Not actually fired
during acceptance (that would require waiting until 22:00 local weekdays).
Code-path smoke test (typecheck + build + daemon start/stop) passed during
Task 11 implementation.

## Deferred acceptance items

The plan's Task 14 originally listed two further manual checks that were not
run today because they require interactive Claude Code sessions:

- **Chat integration** (`fundx` → ask "¿Qué oportunidades hay en el watchlist?")
- **Autonomous session** (`fundx session run --fund <name>` with inspection of
  the session handoff for the Watchlist updates section)

Both code paths exist (screener MCP is registered in `buildMcpServers`, the
opportunity-screening skill and session-init step 7 are in place), but the
observable validation requires a live Claude session that is out-of-scope for a
deterministic acceptance run. Recommend running these as a follow-up when the
merged branch is first exercised interactively.

## Follow-ups identified during the run

1. **`pnpm start` (prod build) is broken.** `tsup` does not emit
   `dist/commands/`, so Pastel fails to load file-based routes at runtime. This
   is a pre-existing issue (not introduced by Phase 2 Screening) and blocks
   `pnpm start` for any command — including `fund upgrade`. `pnpm dev` (tsx
   from source) works fine. A targeted fix for the tsup config (or a custom
   pastel build step that copies `src/commands` → `dist/commands`) should be
   tracked separately.

2. **Fund-tag compatibility meaningful only for ETF-universe funds.** Two of
   four funds have no rows in `watchlist_fund_tags` because their universe is
   declared by sector/strategy/protocol. Plan already documented this as a V1
   scope choice. Post-V1 enhancement: map sector universes to SIC/GICS → ticker
   sets and extend tagging accordingly.

3. **First-run top scores look extreme** (>2000% for SNDK). These are 12-month
   returns, and the underlying FMP data in late 2026 includes the post-2023
   AI-memory supercycle. The numbers are correct; just unusual-looking for a
   naïve reader. CLI display currently formats with `%` — consider adding a
   `× multiplier` column (e.g. "SNDK 2028.76% = 21×") when the screen surfaces
   extreme outliers, to reduce cognitive load. Pure UX polish.

4. **Screen option forwarded but enum has only one value today.** `run.tsx`
   correctly forwards `--screen` through `screenNameSchema`, but the enum only
   permits `momentum-12-1` in V1. Any additional screen (Piotroski, Magic
   Formula, etc.) requires extending `screenNameSchema` in `src/types.ts` and
   adding its scorer to `screening.service.ts`. This is the natural extension
   point for Phase 2.2.

## Verdict

Phase 2 v1 is end-to-end functional on the deterministic path. Chat and
autonomous-session integration are wired but unvalidated today; both should be
exercised on a short feedback loop once the branch is reviewed and merged.
