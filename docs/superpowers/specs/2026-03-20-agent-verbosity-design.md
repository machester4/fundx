# Agent Verbosity Design

## Problem

When the AI agent works during a chat session, the user sees minimal feedback — just "Thinking...", "Tool: name (Ns)...", or "Streaming... (N chars)". There's no visibility into tool inputs, thinking duration, token usage, sub-agent progress, or errors. The user can't tell what the agent is doing or why it's slow.

## Design Decisions

- **Scope:** Chat dashboard only (not daemon sessions)
- **Verbosity level:** Maximum — tool I/O preview, thinking duration, tokens, sub-agent tasks, errors
- **No cost/turn tracking** — user doesn't want pricing or turn counts
- **No emojis** — plain text indicators
- **Always on** — no verbose flag needed, this is the default experience

## Approach

Enrich the existing `useStreaming` hook to capture more data from SDK events, enhance `StreamingIndicator` to render richer real-time status, and add a `TurnSummary` component for post-response metrics.

---

## Section 1: Enriched Streaming State

Extend the `StreamingActivity` interface in `useStreaming.ts` to capture more data from SDK events that are already being processed.

### Current interface (actual code, not simplified)

```typescript
{
  thinking: boolean;
  toolName: string | null;
  toolElapsed: number;
  taskLabel: string | null;
}
```

### New interface (follows existing `| null` pattern)

```typescript
{
  thinking: boolean;
  thinkingStartedAt: number | null;  // Date.now() when thinking started
  toolName: string | null;
  toolElapsed: number;
  toolInput: string | null;          // first ~80 chars, accumulated from input_json_delta
  taskLabel: string | null;
  taskToolCount: number;             // tools used by sub-agent (from task_progress)
  error: string | null;              // last task error (tasks only, not per-tool)
  tokensIn: number;                  // from SDKResultMessage.modelUsage at turn end
  tokensOut: number;                 // from SDKResultMessage.modelUsage at turn end
  toolHistory: Array<{ name: string; elapsed: number }>;  // completed tools
  thinkingTotalMs: number;           // total thinking duration across blocks
  thinkingCount: number;             // number of thinking blocks
}
```

### Data sources (SDK events already processed by useStreaming)

| Field | Source event | How |
|-------|-------------|-----|
| `thinkingStartedAt` | `onThinkingStart` | `Date.now()` |
| `thinkingTotalMs` | `onThinkingEnd` | `+= Date.now() - thinkingStartedAt` |
| `thinkingCount` | `onThinkingEnd` | `+= 1` |
| `toolInput` | `content_block_delta` with `input_json_delta` | Accumulate delta fragments in a buffer, take first 80 chars. **Note:** `content_block_start` for tool_use delivers empty `input: {}` — actual input streams incrementally via `input_json_delta` deltas. |
| `taskToolCount` | `onTaskProgress` | From `SDKTaskProgressMessage.usage.tool_uses` |
| `error` | `onTaskEnd` when `status === 'failed'` | From `SDKTaskNotificationMessage.summary`. **Note:** Individual tool errors are NOT available as SDK events — they surface as text in subsequent assistant messages. Only sub-agent task failures can be captured. |
| `tokensIn/Out` | `SDKResultMessage.modelUsage` at turn end | Aggregate `inputTokens`/`outputTokens` across all model entries. **Note:** These are only available when the turn completes, NOT incrementally during streaming. During execution, both values remain 0. |
| `toolHistory` | `onToolEnd` | Push `{ name, elapsed }` on each tool completion |

### Changes to callbacks

The existing callbacks in `useStreaming` (`onToolStart`, `onToolEnd`, `onThinkingStart`, `onThinkingEnd`, `onTaskProgress`) already fire at the right moments. The changes are:

1. `onToolStart` — reset `toolInput` buffer
2. Tool input accumulation — in `chat.service.ts`, accumulate `input_json_delta` fragments into a buffer, pass first 80 chars to a new `onToolInputDelta` callback that updates `toolInput` on `StreamingActivity`
3. `onToolEnd` — push to `toolHistory`
4. `onThinkingStart/End` — track timestamps and accumulate duration
5. `onTaskProgress` — capture `tool_uses` count
6. `onTaskEnd` — capture error from `summary` when `status === 'failed'`
7. Turn completion — set `tokensIn`/`tokensOut` from `SDKResultMessage.modelUsage`

### Modified files

- `src/hooks/useStreaming.ts` — extend `StreamingActivity`, enrich callbacks
- `src/services/chat.service.ts` — pass tool input to `onToolStart` callback from SDK event data

---

## Section 2: Enhanced StreamingIndicator

Replace the single-line spinner with a multi-line verbose display during agent execution.

### Render examples

**Tool executing:**
```
[tool] alpaca_get_positions (3.2s)
       get_account_positions { fund: "growth" }
[thinking] 2.1s
```

**Sub-agent active:**
```
[agent] macro-analyst (12s, 3 tools)
  [tool] market_data_get_quote (1.5s)
```

**Tool error:**
```
[error] alpaca_submit_order — Insufficient buying power
```

**Just thinking (no tool):**
```
[thinking] 4.2s
```

**Note:** Token counts are NOT available during streaming — only at turn end via `SDKResultMessage.modelUsage`. The `[tokens]` line is therefore NOT shown in the real-time indicator. Tokens are shown exclusively in the post-response `TurnSummary`.

### Rendering rules

- Each active state renders on its own line
- Tool line: `[tool] <name> (<elapsed>s)` — yellow
- Tool input line (indented): first 80 chars, dimColor — only shown if toolInput available
- Thinking line: `[thinking] <duration>s` — magenta
- Agent/task line: `[agent] <label> (<elapsed>, <toolCount> tools)` — cyan
- Error line: `[error] <message>` — red, persists until next tool starts
- No token line in real-time indicator (tokens only available at turn end — shown in TurnSummary)
- All prefixes in brackets, no emojis

### Modified files

- `src/components/StreamingIndicator.tsx` — new multi-line render using enriched `StreamingActivity`

---

## Section 3: Post-Response Turn Summary

After each agent response in the chat, show a compact dimColor summary line with session metrics.

### Format

When tools and thinking were used:
```
tokens: 2,450 in / 1,200 out | tools: alpaca_get_positions(2), market_data_get_quote(1) | thinking: 3 blocks, 8.4s
```

When no tools or thinking (simple text response):
```
tokens: 340 in / 120 out
```

### Implementation

New component `TurnSummary.tsx` that receives the final `StreamingActivity` metrics and renders the summary line. Rendered in `ChatView.tsx` after the agent's response message.

The `toolHistory` array is aggregated into tool name counts (e.g., `alpaca_get_positions` called twice → `alpaca_get_positions(2)`).

### Data flow

1. `useStreaming` accumulates metrics during the turn in `StreamingActivity`
2. Token counts (`tokensIn`/`tokensOut`) are set from `SDKResultMessage.modelUsage` when the turn completes
3. Before `send()` resets activity to `IDLE_ACTIVITY` (which it already does on stream end), it stores the final snapshot in a new `lastTurnMetrics: StreamingActivity | null` field on the streaming state
4. `ChatView` renders `<TurnSummary metrics={streaming.lastTurnMetrics} />` after the agent's response message
5. `lastTurnMetrics` persists until the next `send()` call replaces it

**Note:** There is no existing `resetActivity()` function. The existing `reset()` function resets the entire streaming state. The new `lastTurnMetrics` field avoids the snapshot-before-reset timing issue by capturing metrics inside `send()` before the activity is cleared.

### Modified files

- `src/components/TurnSummary.tsx` — new component
- `src/components/ChatView.tsx` — render TurnSummary after agent responses

---

## Files Summary

### New files

| File | Purpose |
|------|---------|
| `src/components/TurnSummary.tsx` | Post-response metrics line (tokens, tools, thinking) |

### Modified files

| File | Changes |
|------|---------|
| `src/hooks/useStreaming.ts` | Extend `StreamingActivity` with new fields, enrich callbacks |
| `src/services/chat.service.ts` | Pass tool input to `onToolStart` callback |
| `src/components/StreamingIndicator.tsx` | Multi-line verbose render |
| `src/components/ChatView.tsx` | Render TurnSummary after agent responses |

### Unchanged

- `src/agent.ts` — no changes needed (events already flow through onMessage)
- `src/services/session.service.ts` — daemon sessions unchanged
- `src/services/daemon.service.ts` — unchanged
