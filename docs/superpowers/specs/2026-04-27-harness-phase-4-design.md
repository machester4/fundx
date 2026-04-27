# Phase 4 — Operational Observability (G6)

**Date:** 2026-04-27
**Status:** Stub (full design pending — brainstorm after Phase 3 closes)
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Closes gap:** G6 — no external supervisor, no daily-fund cap, weak operational visibility
**Patterns enforced:** operational layer (above the canonical 12)

---

## Stub-level scope

- Verify and wire `src/services/supervisor.service.ts` (already exists; confirm it is reachable in production startup).
- Telegram alert when `DAEMON_HEARTBEAT` is stale > 3 min.
- **Daily-per-fund aggregate USD cap** (sum of `usd_used` across the day from `session_log.json` history); kill + alert if crossed. Extends Phase 1a's per-session cap to a daily envelope.
- Minimal view in `fundx status`: today's USD consumed per fund + supervisor liveness flag.
- New `docs/operations.md` runbook: how to restart, where to read logs, how to interpret each alert.

---

## Dependencies

- None hard. This phase sits on top of everything earlier and does not change agent behaviour, only observability.
- Phase 1a's `usd_used` field in `session_log.json` is the source of truth for the daily aggregate.

---

## Open questions for the future brainstorming session

- **Where to host the daily counter** — recompute from `session_log.json` on each cron tick (simple, slow) or maintain a denormalised counter file (fast, more state to manage)?
- **What to do on daily cap exceed** — block all new sessions until midnight UTC, or just alert and continue?
- **Supervisor scope** — re-implement in TypeScript (matching the rest of the codebase) or rely on systemd / launchd?
- **Dashboards** — terminal-only via `fundx status`, or also a tiny web UI? Probably terminal-only — out of scope for this phase.

---

## Provisional Definition of Done

- Daemon killed externally → Telegram alert in < 5 min.
- Simulated fund exceeds daily cap → next session is rejected + alert sent.
- `fundx status` shows today's consumption.
- Runbook reviewed and committed.

---

## Provisional effort

2–3 days.
