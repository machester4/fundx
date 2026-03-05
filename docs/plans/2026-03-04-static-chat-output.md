# Static Chat Output — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix terminal text overflow by switching chat to static terminal output (like Claude Code) using Ink's `<Static>` component.

**Architecture:** Completed chat messages render via `<Static>` into the terminal's scrollback buffer. Only the streaming response + input stay in the dynamic area at the bottom. The fullscreen dashboard shows until the user sends the first message, then hides to give the chat full terminal output.

**Tech Stack:** TypeScript, React/Ink (`<Static>` component), Pastel CLI framework

---

### Task 1: Add chatActive state to commands/index.tsx

**Files:**
- Modify: `src/commands/index.tsx`

**Step 1: Add chatActive state and pass onChatStart callback**

In `src/commands/index.tsx`, add a `chatActive` state and a callback that ChatView calls when the user sends their first message. When `chatActive` is true, skip the fullscreen layout (panels, border, footer) and render only the ChatView without height/width constraints.

Replace lines 42-45 (beginning of the component) — add `chatActive` state:

```typescript
const [chatActive, setChatActive] = useState(false);
```

Add a stable callback (after `chatOptions` memo, around line 111):

```typescript
const handleChatStart = useCallback(() => setChatActive(true), []);
```

**Step 2: Add the chatActive rendering path**

After the resolving phase check (line 191) and before the REPL section (line 193), add the chat-active branch. When `chatActive` is true, render ChatView in `"static"` mode without any dashboard wrapping:

```tsx
// ── Chat active (static output mode) ─────────────────────────
if (phase.type === "ready" && chatActive) {
  return (
    <ChatView
      key={phase.fundName ?? "__workspace__"}
      fundName={phase.fundName}
      width={columns}
      height={rows}
      mode="static"
      onExit={handleExit}
      onSwitchFund={handleSwitchFund}
      options={chatOptions}
    />
  );
}
```

**Step 3: Pass onChatStart to the inline ChatView**

In the existing REPL section, add `onChatStart` to the ChatView props:

```tsx
<ChatView
  key={phase.fundName ?? "__workspace__"}
  fundName={phase.fundName}
  width={innerWidth}
  height={chatHeight}
  mode="inline"
  onExit={handleExit}
  onSwitchFund={handleSwitchFund}
  onChatStart={handleChatStart}
  options={chatOptions}
/>
```

**Step 4: Verify typecheck**

Run: `cd /Users/michael/Proyectos/fundx && pnpm typecheck`
Expected: Will fail because ChatView doesn't accept `onChatStart` or `mode="static"` yet — that's Task 2.

---

### Task 2: Rewrite ChatView to support static output mode

**Files:**
- Modify: `src/components/ChatView.tsx`

This is the main change. The ChatView needs to:
1. Accept `onChatStart` callback and `mode="static"`
2. When `mode="static"`: render completed messages via `<Static>`, streaming + input as dynamic bottom
3. Remove all the old scroll/estimation logic

**Step 1: Update imports**

Add `Static` to the ink import:

```typescript
import { Box, Text, useInput, Static } from "ink";
```

**Step 2: Update ChatViewProps interface**

Add `onChatStart` and update `mode` type:

```typescript
interface ChatViewProps {
  fundName: string | null;
  width: number;
  height: number;
  onExit?: () => void;
  onSwitchFund?: (fundName: string) => void;
  onChatStart?: () => void;
  options: { model?: string; readonly: boolean; maxBudget?: string };
  mode?: "standalone" | "inline" | "static";
}
```

**Step 3: Remove estimateMessageLines function**

Delete the entire function (lines 29-38):

```typescript
// DELETE THIS:
/** Estimate how many terminal lines a message will occupy. */
function estimateMessageLines(msg: { sender: string; content: string }, width: number): number {
  ...
}
```

**Step 4: Update the component function**

In the component body, make these changes:

a) Add `isStatic` derived variable (after `isInline`):
```typescript
const isStatic = mode === "static";
```

b) Remove `scrollOffset` state (line 72):
```typescript
// DELETE: const [scrollOffset, setScrollOffset] = useState(0);
```

c) Call `onChatStart` when first real message is sent. In `handleSubmit`, right before `addMessage("you", messageText)` (around line 347), add:
```typescript
if (messages.length === 0 && onChatStart) {
  onChatStart();
}
```

d) Remove the scroll-reset useEffect (lines 376-379):
```typescript
// DELETE:
useEffect(() => {
  setScrollOffset(0);
}, [messages.length, streaming.buffer]);
```

e) Remove height calculation block (lines 383-391 — contextBarHeight through messagesAreaHeight):
```typescript
// DELETE all the height calculation variables:
// contextBarHeight, costBarHeight, inputHeight, bottomHeight, messagesAreaHeight
```

f) Remove the entire `visibleMessages` useMemo (lines 393-433):
```typescript
// DELETE the entire visibleMessages computation
```

g) Remove `isScrolledUp` (line 435):
```typescript
// DELETE: const isScrolledUp = scrollOffset > 0;
```

h) Simplify the `useInput` handler — remove all scroll handling (arrow keys, PageUp/Down):
```typescript
useInput((input, key) => {
  if (!isInline && !isStatic && key.escape && phase !== "streaming") {
    onExit?.();
  }
  if (input === "c" && key.ctrl && streaming.isStreaming) {
    streaming.cancel();
    setPhase("ready");
  }
  if (input === "q" && !isStreaming) {
    onExit?.();
  }
});
```

**Step 5: Add the static rendering path**

Before the existing return statement (line 476), add the static mode rendering:

```tsx
if (isStatic) {
  const isStreaming = phase === "streaming";

  return (
    <>
      {/* Completed messages — written permanently to terminal scrollback */}
      <Static items={messages}>
        {(msg) => (
          <Box key={msg.id} paddingX={1}>
            <ChatMessage
              sender={msg.sender}
              content={msg.content}
              timestamp={msg.timestamp}
              cost={msg.cost}
              turns={msg.turns}
            />
          </Box>
        )}
      </Static>

      {/* Dynamic bottom section — re-renders as streaming progresses */}
      <Box flexDirection="column">
        {isStreaming && (
          <Box paddingX={1} flexDirection="column">
            {streaming.buffer ? (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text bold color="blue">claude</Text>
                  <StreamingIndicator charCount={streaming.charCount} activity={streaming.activity} />
                </Box>
                <MarkdownView content={streaming.buffer} />
              </Box>
            ) : (
              <StreamingIndicator charCount={0} activity={streaming.activity} />
            )}
          </Box>
        )}

        {phase === "error" && (
          <Box paddingX={1}>
            <Text color="red">Error: {errorMsg}</Text>
          </Box>
        )}

        {costTracker.messages > 0 && (
          <Box paddingX={1}>
            <Text dimColor>
              ${costTracker.total_cost_usd.toFixed(4)} | {costTracker.messages} msgs | {costTracker.total_turns} turns | /help
            </Text>
          </Box>
        )}

        {!isStreaming && phase !== "error" && (
          <Box paddingX={1}>
            <Text color="green">{"❯ "}</Text>
            <TextInput
              placeholder="Message... (/help for commands)"
              onSubmit={handleSubmit}
            />
          </Box>
        )}
      </Box>
    </>
  );
}
```

**Step 6: Clean up the existing inline/standalone return**

In the existing return block (the one that remains for `inline` and `standalone` modes), update the messages rendering to use `messages` directly instead of `visibleMessages`:

Replace `{visibleMessages.map((msg) => (` with `{messages.map((msg) => (`.

Remove the `{isScrolledUp && ...}` block (lines 517-521).

Remove the `!isScrolledUp` condition from the streaming display (line 502 — change `{isStreaming && !isScrolledUp && (` to `{isStreaming && (`).

**Step 7: Verify typecheck**

Run: `cd /Users/michael/Proyectos/fundx && pnpm typecheck`
Expected: Pass

**Step 8: Verify build**

Run: `cd /Users/michael/Proyectos/fundx && pnpm build`
Expected: Pass

---

### Task 3: Run tests and fix any failures

**Step 1: Run all tests**

Run: `cd /Users/michael/Proyectos/fundx && pnpm test -- --run`

Fix any test failures caused by:
- Removed `estimateMessageLines` (if imported or tested elsewhere)
- Changed ChatView props interface
- Changed mode types

**Step 2: Verify all green**

Run: `cd /Users/michael/Proyectos/fundx && pnpm test -- --run`
Expected: All tests pass

---

### Task 4: Manual verification and commit

**Step 1: Run the app to verify visually**

Run: `cd /Users/michael/Proyectos/fundx && pnpm dev`

Verify:
1. Dashboard panels show on startup
2. Type a message — dashboard panels disappear, chat switches to static output
3. Long responses scroll naturally in the terminal (no overlap)
4. Streaming shows at the bottom with spinner
5. After response completes, it moves to scrollback
6. `/clear`, `/help`, `/q` still work

**Step 2: Run full verification**

Run: `cd /Users/michael/Proyectos/fundx && pnpm typecheck && pnpm test -- --run && pnpm build`
Expected: All pass

**Step 3: Commit**

```bash
git add src/commands/index.tsx src/components/ChatView.tsx docs/plans/2026-03-04-static-chat-output-design.md docs/plans/2026-03-04-static-chat-output.md
git commit -m "Switch chat to static terminal output mode (like Claude Code)

Completed chat messages now render via Ink's <Static> component into the
terminal's scrollback buffer. Only the streaming response and input prompt
stay in the dynamic area at the bottom. The fullscreen dashboard shows
until the first message is sent, then hides to give chat the full terminal.

This fixes the text overlap issue where long Claude responses were clipped
by overflowY='hidden' in the constrained fullscreen layout (only ~3 rows
available for chat on a standard 24-row terminal).

Removed: estimateMessageLines(), scrollOffset state, visibleMessages
computation, arrow-key/PageUp/Down scroll handlers — all replaced by
native terminal scrolling.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
