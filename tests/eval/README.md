# Eval harness

The FundX eval harness runs YAML-defined cases against the agent's chat REPL
or `ask` command. See `src/services/eval/` for the runner, assertions, report
modules, and `src/types.ts` for schemas.

## LLM-judge layer (Phase 3b, 2026-05-01)

Cases can opt into an LLM-as-judge quality grader by adding a `judge:` block
to their `expect:` section:

```yaml
expect:
  must_invoke: ["..."]
  judge:
    dims:
      data_grounding: 4    # threshold (1-5)
      task_completion: 4
```

The judge runs **after** mechanism asserts (`must_invoke`, etc.) and **only**
when the run did not error. It calls Opus 4.7 with calibrated rubrics from
`tests/eval/calibration/<dim>.md`. Scores below threshold emit
`judge_below_threshold` failures with the dim, threshold, actual score, and
the judge's rationale.

### Available dimensions

- **`data_grounding`** — adherence to anti-hallucination (every cited number
  from a tool call this session, not memory).
- **`task_completion`** — how completely the agent addressed the user's
  actual request.

### Adding new dimensions

1. Add to the `judgeDimSchema` enum in `src/types.ts`.
2. Create `tests/eval/calibration/<new_dim>.md` with 5 score examples (1, 2,
   3, 4, 5).
3. Cases can now declare `<new_dim>: <threshold>` in their judge block.

### Updating calibration

Edit `tests/eval/calibration/<dim>.md` directly. The grader reads calibration
fresh on every invocation (no caching), so a fresh `pnpm test` or
`pnpm dev -- eval` picks up changes immediately. The first MVP eval run
after a calibration change should be reviewed manually for unexpected score
shifts.

### Cost

Each judge call costs ~$0.40-0.50 with Opus 4.7 + 2 dims. The MVP eval suite
with 3 opt-in cases × 3 runs adds ~$2-3 in judge cost on top of the ~$1.70
agent cost (total ~$4-5 per full MVP run). Track via `total_judge_cost_usd`
in the JSON report.
