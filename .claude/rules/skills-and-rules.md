---
description: How FundX uses the Claude Agent SDK skill and rules system — where files live, how they are loaded, and what to do when adding new ones
---

# Skills and Rules Pattern

## How the Agent SDK loads files
The Agent SDK reads files automatically when `settingSources: ["project"]` is set and `cwd` points
to a directory that contains a `.claude/` folder or `CLAUDE.md`:

- `<cwd>/CLAUDE.md` — static instructions (identity, role, constraints)
- `<cwd>/.claude/skills/<name>/SKILL.md` — invokable capabilities with YAML frontmatter
- `<cwd>/.claude/rules/**/*.md` — behavioral rules, always loaded

## Directory layout

```
~/.fundx/                              # workspace cwd (chat with no fund)
├── CLAUDE.md                          # workspace assistant identity
└── .claude/
    ├── rules/
    │   └── assistant-behavior.md      # fund creation behavioral rules
    └── skills/
        └── create-fund/
            └── SKILL.md               # fund creation skill

~/.fundx/funds/<name>/                 # per-fund cwd (chat with a fund)
├── CLAUDE.md                          # fund AI manager identity (generated from fund_config.yaml)
└── .claude/
    ├── settings.json
    └── skills/
        ├── investment-debate/SKILL.md
        ├── risk-matrix/SKILL.md
        ├── trade-memory/SKILL.md
        ├── market-regime/SKILL.md
        ├── position-sizing/SKILL.md
        └── session-reflection/SKILL.md
```

## SKILL.md format
Every `SKILL.md` must have YAML frontmatter:

```markdown
---
name: skill-dir-name          # must match the directory name
description: One-line description — Claude uses this to decide when to invoke the skill
---

# Skill Title

## When to Use
...

## Technique
...

## Output Format
...
```

## Where skills are defined in code
- `src/skills.ts` — source of truth for all built-in skill content
  - `BUILTIN_SKILLS` — the 6 per-fund trading analysis skills
  - `WORKSPACE_SKILL` — the `create-fund` workspace skill
  - `ensureFundSkillFiles(fundClaudeDir)` — writes fund skills on fund creation
  - `ensureWorkspaceSkillFiles()` — writes workspace skill on `fundx init`

## Where rules are defined in code
- Workspace rules: generated inline in `src/services/init.service.ts` (`ensureWorkspaceRules`)
- Per-fund rules: not yet implemented — could be generated from `fund_config.yaml` custom_rules

## Adding a new fund skill
1. Add a `Skill` object to `BUILTIN_SKILLS` in `src/skills.ts` with a unique `dirName`
2. Include `## When to Use`, `## Technique`, and `## Output Format` sections
3. Add a test case in `tests/skills.test.ts`
4. Existing funds won't get the new skill automatically — run `fundx fund regen <name>` (future feature)
   or delete `.claude/skills/<dirName>/` to force regeneration

## Adding a new workspace rule
Edit `ensureWorkspaceRules()` in `src/services/init.service.ts` or add a new file entry.
Users can also edit `~/.fundx/.claude/rules/` directly after init.

## Never
- Never hardcode skill content as strings inside service functions (use `src/skills.ts`)
- Never embed full skill text inline in CLAUDE.md templates (skills load from `.claude/skills/`)
- Never put skill files in `~/.fundx/shared/skills/` — that directory is not read by the Agent SDK
