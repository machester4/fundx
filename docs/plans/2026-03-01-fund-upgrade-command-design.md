# Fund Upgrade Command Design

**Date:** 2026-03-01
**Status:** Approved

## Problem

When new skills are added or existing skill content is updated in `src/skills.ts`, existing funds don't receive the changes. The `ensureSkillFiles()` function is idempotent — it skips files that already exist. Similarly, if `src/template.ts` is improved, existing fund CLAUDE.md files remain stale.

## Solution

New CLI command: `fundx fund upgrade`

```
fundx fund upgrade <name>    # Upgrade a single fund
fundx fund upgrade --all     # Upgrade all funds
```

## What Gets Upgraded

For each fund:

1. **CLAUDE.md** — Regenerated from `fund_config.yaml` via `generateFundClaudeMd(config)`
2. **Skills** — `.claude/skills/` directory wiped and rewritten with all `BUILTIN_SKILLS` from `src/skills.ts`

## What Is NOT Touched

- `fund_config.yaml` — owned by user
- `state/` — portfolio, tracker, journal, active session, chat history
- `analysis/`, `scripts/`, `reports/` — agent-generated content
- `.claude/settings.json` — Agent SDK configuration
- `.claude/rules/` — user-customized rules

## Implementation

### Service: `upgradeFund()` in `src/services/fund.service.ts`

```typescript
async function upgradeFund(fundName: string): Promise<{ fundName: string; skillCount: number }> {
  const config = await loadFundConfig(fundName);
  const paths = fundPaths(fundName);

  // 1. Regenerate CLAUDE.md
  await generateFundClaudeMd(config);

  // 2. Wipe and rewrite skills
  await rm(paths.claudeSkillsDir, { recursive: true, force: true });
  await ensureFundSkillFiles(paths.claudeDir);

  return { fundName, skillCount: BUILTIN_SKILLS.length };
}
```

### Command: `src/commands/fund/upgrade.tsx`

- `args`: optional fund name
- `options`: `--all` flag (boolean, default false)
- Validates fund exists or iterates all with `--all`
- Renders result with `<SuccessMessage>`

### CLI Flow

```
fundx fund upgrade my-fund
  → loadFundConfig("my-fund")
  → generateFundClaudeMd(config)          ✓ CLAUDE.md regenerated
  → rm .claude/skills/
  → ensureFundSkillFiles(.claude/)         ✓ 7 skills written
  → "Fund 'my-fund' upgraded successfully"

fundx fund upgrade --all
  → listFundNames()
  → for each fund: upgradeFund(fund)
  → "Upgraded 3 funds: my-fund, growth-fund, btc-accumulator"
```

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/services/fund.service.ts` | Add `upgradeFund()` function |
| `src/commands/fund/upgrade.tsx` | New Pastel command |
| `tests/fund-upgrade.test.ts` | Unit tests for `upgradeFund()` |
| `src/services/index.ts` | Already re-exports `fund.service.ts` (no change needed) |
