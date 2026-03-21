# Agent Verbosity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show verbose real-time agent activity in the chat dashboard — tool execution with input preview, thinking duration, sub-agent tasks, errors, and a post-response summary with token counts.

**Architecture:** Enrich the existing `useStreaming` hook to accumulate more data from SDK events that are already being processed. Enhance `StreamingIndicator` to render multi-line verbose output. Add a `TurnSummary` component for post-response metrics. Token counts come from `SDKResultMessage.modelUsage` at turn end (not available during streaming).

**Tech Stack:** TypeScript, React/Ink, Claude Agent SDK streaming events

**Spec:** `docs/superpowers/specs/2026-03-20-agent-verbosity-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/components/TurnSummary.tsx` | Post-response metrics line (tokens, tools, thinking) |

### Modified files

| File | Changes |
|------|---------|
| `src/hooks/useStreaming.ts` | Extend `StreamingActivity` with new fields, add `lastTurnMetrics`, enrich callbacks |
| `src/services/chat.service.ts` | Accumulate tool input deltas, pass task usage/error to callbacks, extract token counts from result |
| `src/components/StreamingIndicator.tsx` | Multi-line verbose render with tool input preview, thinking timer, agent tasks, errors |
| `src/components/ChatView.tsx` | Render TurnSummary after agent responses |

---

## Task 1: Extend StreamingActivity and useStreaming Hook

**Files:**
- Modify: `src/hooks/useStreaming.ts`

- [ ] **Step 1: Extend the `StreamingActivity` interface**

Replace the interface and IDLE constant (lines 6-18):

```typescript
export interface StreamingActivity {
  thinking: boolean;
  thinkingStartedAt: number | null;
  toolName: string | null;
  toolElapsed: number;
  toolInput: string | null;
  taskLabel: string | null;
  taskToolCount: number;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  toolHistory: Array<{ name: string; elapsed: number }>;
  thinkingTotalMs: number;
  thinkingCount: number;
}

const IDLE_ACTIVITY: StreamingActivity = {
  thinking: false,
  thinkingStartedAt: null,
  toolName: null,
  toolElapsed: 0,
  toolInput: null,
  taskLabel: null,
  taskToolCount: 0,
  error: null,
  tokensIn: 0,
  tokensOut: 0,
  toolHistory: [],
  thinkingTotalMs: 0,
  thinkingCount: 0,
};
```

- [ ] **Step 2: Add `lastTurnMetrics` to `StreamingState`**

Update the `StreamingState` interface (line 20-27) to add:

```typescript
interface StreamingState {
  isStreaming: boolean;
  buffer: string;
  charCount: number;
  activity: StreamingActivity;
  result: ChatTurnResult | null;
  error: Error | null;
  lastTurnMetrics: StreamingActivity | null;
}
```

Update the initial state in `useState` to include `lastTurnMetrics: null`.

Also update the `setState` call inside `send()` (lines 73-80) to include `lastTurnMetrics: null`:

```typescript
      setState({
        isStreaming: true,
        buffer: "",
        charCount: 0,
        activity: IDLE_ACTIVITY,
        result: null,
        error: null,
        lastTurnMetrics: null,
      });
```

This is required because the setState uses a complete object literal (not a spread), so TypeScript requires all fields.

- [ ] **Step 3: Enrich the streaming callbacks**

Replace the `streamCallbacks` object inside `send()` (lines 83-118):

```typescript
      const streamCallbacks = {
        onStreamStart: () => {
          if (!cancelledRef.current) setState((s) => ({ ...s, isStreaming: true }));
        },
        onStreamDelta: (text: string, totalChars: number) => {
          if (!cancelledRef.current) {
            setState((s) => ({ ...s, buffer: s.buffer + text, charCount: totalChars }));
          }
        },
        onStreamEnd: () => {
          if (!cancelledRef.current) {
            setState((s) => ({
              ...s,
              isStreaming: false,
              lastTurnMetrics: { ...s.activity },
              activity: IDLE_ACTIVITY,
            }));
          }
        },
        onThinkingStart: () => {
          if (!cancelledRef.current) {
            setState((s) => ({
              ...s,
              activity: { ...s.activity, thinking: true, thinkingStartedAt: Date.now() },
            }));
          }
        },
        onThinkingEnd: () => {
          if (!cancelledRef.current) {
            setState((s) => {
              const elapsed = s.activity.thinkingStartedAt
                ? Date.now() - s.activity.thinkingStartedAt
                : 0;
              return {
                ...s,
                activity: {
                  ...s.activity,
                  thinking: false,
                  thinkingStartedAt: null,
                  thinkingTotalMs: s.activity.thinkingTotalMs + elapsed,
                  thinkingCount: s.activity.thinkingCount + 1,
                },
              };
            });
          }
        },
        onToolStart: (toolName: string) => {
          if (!cancelledRef.current) {
            setState((s) => ({
              ...s,
              activity: { ...s.activity, toolName, toolElapsed: 0, toolInput: null, error: null },
            }));
          }
        },
        onToolInputDelta: (fragment: string) => {
          if (!cancelledRef.current) {
            setState((s) => {
              const current = s.activity.toolInput ?? "";
              if (current.length >= 80) return s;
              const updated = (current + fragment).slice(0, 80);
              return { ...s, activity: { ...s.activity, toolInput: updated } };
            });
          }
        },
        onToolProgress: (toolName: string, elapsedSeconds: number) => {
          if (!cancelledRef.current) {
            setState((s) => ({ ...s, activity: { ...s.activity, toolName, toolElapsed: elapsedSeconds } }));
          }
        },
        onToolEnd: () => {
          if (!cancelledRef.current) {
            setState((s) => {
              const history = s.activity.toolName
                ? [...s.activity.toolHistory, { name: s.activity.toolName, elapsed: s.activity.toolElapsed }]
                : s.activity.toolHistory;
              return {
                ...s,
                activity: { ...s.activity, toolName: null, toolElapsed: 0, toolInput: null, toolHistory: history },
              };
            });
          }
        },
        onTaskStart: (_taskId: string, description: string) => {
          if (!cancelledRef.current) {
            setState((s) => ({ ...s, activity: { ...s.activity, taskLabel: description, taskToolCount: 0 } }));
          }
        },
        onTaskProgress: (_taskId: string, description: string, toolUses?: number) => {
          if (!cancelledRef.current) {
            setState((s) => ({
              ...s,
              activity: {
                ...s.activity,
                taskLabel: description,
                taskToolCount: toolUses ?? s.activity.taskToolCount,
              },
            }));
          }
        },
        onTaskEnd: (_taskId: string, _summary: string, failed?: boolean, errorMsg?: string) => {
          if (!cancelledRef.current) {
            setState((s) => ({
              ...s,
              activity: {
                ...s.activity,
                taskLabel: null,
                taskToolCount: 0,
                error: failed ? (errorMsg ?? "Task failed") : s.activity.error,
              },
            }));
          }
        },
        onTokens: (tokensIn: number, tokensOut: number) => {
          if (!cancelledRef.current) {
            setState((s) => ({
              ...s,
              activity: { ...s.activity, tokensIn, tokensOut },
            }));
          }
        },
      };
```

- [ ] **Step 4: Update `reset()` to also clear `lastTurnMetrics`**

```typescript
  const reset = useCallback(() => {
    cancelledRef.current = false;
    setState({
      isStreaming: false,
      buffer: "",
      charCount: 0,
      activity: IDLE_ACTIVITY,
      result: null,
      error: null,
      lastTurnMetrics: null,
    });
  }, []);
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: Errors in `chat.service.ts` (callback signatures changed) and `StreamingIndicator.tsx` (new fields). These will be fixed in subsequent tasks.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useStreaming.ts
git commit -m "feat(verbosity): extend StreamingActivity with tool input, thinking metrics, token counts"
```

---

## Task 2: Pass Enriched Data from Chat Service

**Files:**
- Modify: `src/services/chat.service.ts`

- [ ] **Step 1: Update the callbacks interface**

In the `runChatTurn` function signature (around line 384-396), update the callbacks to include new ones:

```typescript
  callbacks?: {
    onStreamStart?: () => void;
    onStreamDelta?: (text: string, totalChars: number) => void;
    onStreamEnd?: () => void;
    onThinkingStart?: () => void;
    onThinkingEnd?: () => void;
    onToolStart?: (toolName: string) => void;
    onToolInputDelta?: (fragment: string) => void;
    onToolProgress?: (toolName: string, elapsedSeconds: number) => void;
    onToolEnd?: () => void;
    onTaskStart?: (taskId: string, description: string) => void;
    onTaskProgress?: (taskId: string, description: string, toolUses?: number) => void;
    onTaskEnd?: (taskId: string, summary: string, failed?: boolean, errorMsg?: string) => void;
    onTokens?: (tokensIn: number, tokensOut: number) => void;
  },
```

- [ ] **Step 2: Accumulate tool input deltas**

First, update the event type cast (around line 494-498) to include `partial_json`:

```typescript
      const event = msg.event as {
        type?: string;
        delta?: { type?: string; text?: string; partial_json?: string };
        content_block?: { type?: string; name?: string };
      };
```

Then, in the `content_block_delta` handling (around line 517-521), add the `input_json_delta` branch as an `else if`:

```typescript
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          responseBuffer += event.delta.text;
          charCount += event.delta.text.length;
          callbacks?.onStreamDelta?.(event.delta.text, charCount);
        } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
          callbacks?.onToolInputDelta?.(event.delta.partial_json);
        }
      }
```

- [ ] **Step 3: Pass task usage and error info**

Update the task progress and notification handlers (around lines 543-549):

```typescript
      } else if (msg.subtype === "task_progress") {
        const tp = msg as SDKTaskProgressMessage;
        callbacks?.onTaskProgress?.(tp.task_id, tp.description, tp.usage?.tool_uses);
      } else if (msg.subtype === "task_notification") {
        const tn = msg as SDKTaskNotificationMessage;
        const failed = tn.status === "failed" || tn.status === "stopped";
        callbacks?.onTaskEnd?.(tn.task_id, tn.summary, failed, failed ? tn.summary : undefined);
      }
```

- [ ] **Step 4: Extract token counts from result message**

In the result message handler (around line 552-557), after extracting `costUsd` and `numTurns`, add:

```typescript
    if (msg.type === "result") {
      const result = msg as SDKResultMessage;
      costUsd = result.total_cost_usd;
      numTurns = result.num_turns;
      resultSessionId = result.session_id;

      // Extract token counts from modelUsage (available on both success and error results)
      if (result.modelUsage) {
        let totalIn = 0;
        let totalOut = 0;
        for (const usage of Object.values(result.modelUsage as Record<string, { inputTokens: number; outputTokens: number }>)) {
          totalIn += usage.inputTokens;
          totalOut += usage.outputTokens;
        }
        callbacks?.onTokens?.(totalIn, totalOut);
      }
    }
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (or only StreamingIndicator errors remain — fixed in Task 3)

- [ ] **Step 6: Commit**

```bash
git add src/services/chat.service.ts
git commit -m "feat(verbosity): pass tool input deltas, task errors, and token counts to streaming callbacks"
```

---

## Task 3: Enhanced StreamingIndicator

**Files:**
- Modify: `src/components/StreamingIndicator.tsx`

- [ ] **Step 1: Replace `StreamingIndicator` with multi-line verbose version**

```typescript
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { StreamingActivity } from "../hooks/useStreaming.js";

interface StreamingIndicatorProps {
  charCount: number;
  activity?: StreamingActivity;
}

const DOTS = ["", ".", "..", "..."];

export function StreamingIndicator({ charCount, activity }: StreamingIndicatorProps) {
  const [dotIdx, setDotIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setDotIdx((i) => (i + 1) % DOTS.length);
    }, 200);
    return () => clearInterval(timer);
  }, []);

  const dots = DOTS[dotIdx];
  const lines: React.ReactNode[] = [];

  // Error (persists until next tool starts)
  if (activity?.error) {
    lines.push(
      <Text key="error" color="red">[error] {activity.error}</Text>,
    );
  }

  // Sub-agent task
  if (activity?.taskLabel) {
    const toolInfo = activity.taskToolCount > 0 ? `, ${activity.taskToolCount} tools` : "";
    lines.push(
      <Text key="task" color="cyan">[agent] {activity.taskLabel}{toolInfo}{dots}</Text>,
    );
  }

  // Tool execution
  if (activity?.toolName) {
    const elapsed = activity.toolElapsed > 0 ? ` (${activity.toolElapsed.toFixed(1)}s)` : "";
    lines.push(
      <Text key="tool" color="yellow">
        {activity.taskLabel ? "  " : ""}[tool] {activity.toolName}{elapsed}{dots}
      </Text>,
    );
    if (activity.toolInput) {
      lines.push(
        <Text key="toolInput" dimColor>
          {activity.taskLabel ? "  " : ""}       {activity.toolInput}
        </Text>,
      );
    }
  }

  // Thinking
  if (activity?.thinking) {
    const elapsed = activity.thinkingStartedAt
      ? ((Date.now() - activity.thinkingStartedAt) / 1000).toFixed(1)
      : "0.0";
    lines.push(
      <Text key="thinking" color="magenta">[thinking] {elapsed}s{dots}</Text>,
    );
  }

  // Fallback: streaming text or initial thinking
  if (lines.length === 0) {
    if (charCount > 0) {
      lines.push(
        <Text key="streaming" color="blue">Streaming{dots} ({charCount.toLocaleString()} chars)</Text>,
      );
    } else {
      lines.push(
        <Text key="init" color="blue">Thinking{dots}</Text>,
      );
    }
  }

  return <Box flexDirection="column">{lines}</Box>;
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/StreamingIndicator.tsx
git commit -m "feat(verbosity): multi-line StreamingIndicator with tool input, thinking timer, errors"
```

---

## Task 4: TurnSummary Component and ChatView Integration

**Files:**
- Create: `src/components/TurnSummary.tsx`
- Modify: `src/components/ChatView.tsx`

- [ ] **Step 1: Create `TurnSummary.tsx`**

```typescript
import React from "react";
import { Text } from "ink";
import type { StreamingActivity } from "../hooks/useStreaming.js";

interface TurnSummaryProps {
  metrics: StreamingActivity | null;
}

export function TurnSummary({ metrics }: TurnSummaryProps) {
  if (!metrics) return null;

  const parts: string[] = [];

  // Tokens
  if (metrics.tokensIn > 0 || metrics.tokensOut > 0) {
    parts.push(`tokens: ${metrics.tokensIn.toLocaleString()} in / ${metrics.tokensOut.toLocaleString()} out`);
  }

  // Tools (aggregate by name with count)
  if (metrics.toolHistory.length > 0) {
    const counts = new Map<string, number>();
    for (const t of metrics.toolHistory) {
      counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    }
    const toolStr = Array.from(counts.entries())
      .map(([name, count]) => count > 1 ? `${name}(${count})` : name)
      .join(", ");
    parts.push(`tools: ${toolStr}`);
  }

  // Thinking
  if (metrics.thinkingCount > 0) {
    const secs = (metrics.thinkingTotalMs / 1000).toFixed(1);
    parts.push(`thinking: ${metrics.thinkingCount} block${metrics.thinkingCount > 1 ? "s" : ""}, ${secs}s`);
  }

  if (parts.length === 0) return null;

  return <Text dimColor>{parts.join(" | ")}</Text>;
}
```

- [ ] **Step 2: Integrate TurnSummary into ChatView**

In `src/components/ChatView.tsx`:

Add import:
```typescript
import { TurnSummary } from "./TurnSummary.js";
```

Find where agent messages are rendered (the `messages.map(...)` block). After each claude message rendering, add the TurnSummary. The simplest approach: store `lastTurnMetrics` alongside each claude message in the messages array, or render `streaming.lastTurnMetrics` after the most recent claude message.

The cleanest approach: after the streaming buffer block (where `streaming.buffer` is rendered with `MarkdownView`), and after the last claude message in the list, render:

```typescript
{!streaming.isStreaming && streaming.lastTurnMetrics && (
  <TurnSummary metrics={streaming.lastTurnMetrics} />
)}
```

Place this in BOTH render paths in ChatView:
1. **Static mode** (around line 416) — after the streaming block inside the `isStatic` branch
2. **Standalone mode** (around line 495) — after the streaming block inside the standalone branch

In both cases, place it right after the `StreamingIndicator` + `MarkdownView` section. It shows the summary once the agent finishes responding and persists until the next `send()` clears `lastTurnMetrics`.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TurnSummary.tsx src/components/ChatView.tsx
git commit -m "feat(verbosity): add TurnSummary post-response metrics in chat"
```

---

## Task 5: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 4: Manual smoke test**

```bash
pnpm dev -- --fund prueba
# Type a question that triggers tool use (e.g., "show me my portfolio")
# Verify:
#   - [tool] line appears with name and elapsed seconds
#   - Tool input preview appears indented below
#   - [thinking] line appears with live duration counter
#   - [agent] line appears if sub-agents are invoked
#   - After response: dimColor summary line with tokens, tools, thinking
```

- [ ] **Step 5: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix(verbosity): integration fixes"
```
