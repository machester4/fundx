---
description: FundX architectural conventions — enforce separation of concerns between services, commands, and components
---

# FundX Architecture Rules

## Service / Command separation
- `src/services/` contains pure async business logic with no UI dependencies
- `src/commands/` are thin React/Ink components that call services and render results
- Never import Ink or React inside a service file
- Never put fund/broker/state logic directly in a command component — always extract to a service

## State and paths
- `src/paths.ts` is the only place that knows about `~/.fundx` directory structure — always import paths from there, never construct them inline
- All JSON state reads/writes go through `src/state.ts` — never `fs.writeFile` a state file directly
- State writes must be atomic (write to tmp, rename) — use `writeJsonAtomic` from `state.ts`

## Types and validation
- All Zod schemas and inferred TypeScript types live in `src/types.ts` — single import for any module
- Use `interface` for object shapes, `type` for unions and intersections
- Validate external data (API responses, config files, user input) with Zod at the boundary; trust internal types

## New commands
- Add a `.tsx` file under `src/commands/` — Pastel auto-discovers it via file-based routing
- Export `description`, `args` (Zod), `options` (Zod), and `default function`
- The command component handles only: loading state, rendering, and calling services

## New services
- Add to or create a file in `src/services/`
- Export from `src/services/index.ts` barrel if used across multiple commands
- Services throw typed errors; commands catch and render with `<ErrorMessage>`

## MCP servers
- MCP server files live in `src/mcp/` and are compiled to `dist/mcp/`
- `src/agent.ts` (`buildMcpServers`) is the only place that constructs MCP server configs
- Never hardcode MCP server paths — use `MCP_SERVERS` constants from `src/paths.ts`
