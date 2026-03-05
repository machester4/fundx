# Static Chat Output — Design Document

**Date:** 2026-03-04
**Goal:** Fix terminal text overflow/overlap by switching chat to static terminal output mode (like Claude Code)

## Problem

When Claude generates long responses in the FundX chat view, text overlaps on screen. Root cause: the fullscreen dashboard consumes 19 of 24 terminal rows for panels, leaving only ~3 rows for chat. Ink's `overflowY="hidden"` clips content silently. The manual scroll (arrow keys + PageUp/Down) uses `estimateMessageLines()` which is off by 10-30%.

## Solution: Static Output Mode

Use Ink's `<Static>` component to render completed chat messages into the terminal's scrollback buffer. This is the same pattern Claude Code uses — past messages scroll up naturally, only the active response and input stay on screen.

### Mode Transition

1. **Before first message (fullscreen dashboard)**: Show panels + inline chat input. Existing layout unchanged.
2. **After first message (static output)**: Hide panels. Remove height constraint. Completed messages render via `<Static>` into scrollback. Streaming response + input stay in the dynamic (bottom) section.

### Components Changed

| File | Change |
|------|--------|
| `commands/index.tsx` | Add `chatActive` state. When true, render `ChatView` without panels or height constraint. |
| `ChatView.tsx` | Add static rendering path: `<Static>` for completed messages, dynamic bottom for streaming + input. Remove `estimateMessageLines`, `scrollOffset`, `visibleMessages`, `overflowY="hidden"`. |

### What Gets Removed
- `estimateMessageLines()` — inaccurate, no longer needed
- `scrollOffset` state and arrow-key/PageUp/Down handlers
- `visibleMessages` memoized computation
- `overflowY="hidden"` on messages container
- `messagesAreaHeight` calculation

### UX Details
- Terminal's native scroll (mouse wheel, Shift+PageUp) handles scrolling
- Streaming response shows at bottom with spinner
- Input prompt pinned at bottom
- Cost tracker shows below input
- `/q` exits, `/clear` resets conversation, `/fund` switches fund
- Pressing Ctrl+C during streaming cancels the response
