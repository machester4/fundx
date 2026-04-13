import { useState, useCallback, useRef } from "react";
import { runChatTurn } from "../services/chat.service.js";
import type { ChatTurnResult, ChatMcpServers, ImageAttachment } from "../services/chat.service.js";
import { SESSION_EXPIRED_PATTERN } from "../agent.js";

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

interface StreamingState {
  isStreaming: boolean;
  buffer: string;
  charCount: number;
  activity: StreamingActivity;
  result: ChatTurnResult | null;
  error: Error | null;
  lastTurnMetrics: StreamingActivity | null;
}

interface UseStreamingReturn extends StreamingState {
  send: (
    fundName: string | null,
    sessionId: string | undefined,
    message: string,
    context: string,
    opts: {
      model: string;
      maxBudgetUsd?: number;
      readonly: boolean;
      mcpServers: ChatMcpServers;
      images?: ImageAttachment[];
    },
  ) => Promise<ChatTurnResult>;
  cancel: () => void;
  reset: () => void;
}

export function useStreaming(): UseStreamingReturn {
  const [state, setState] = useState<StreamingState>({
    isStreaming: false,
    buffer: "",
    charCount: 0,
    activity: IDLE_ACTIVITY,
    result: null,
    error: null,
    lastTurnMetrics: null,
  });
  const cancelledRef = useRef(false);

  const send = useCallback(
    async (
      fundName: string | null,
      sessionId: string | undefined,
      message: string,
      context: string,
      opts: {
        model: string;
        maxBudgetUsd?: number;
        readonly: boolean;
        mcpServers: ChatMcpServers;
        images?: ImageAttachment[];
      },
    ): Promise<ChatTurnResult> => {
      cancelledRef.current = false;
      setState({
        isStreaming: true,
        buffer: "",
        charCount: 0,
        activity: IDLE_ACTIVITY,
        result: null,
        error: null,
        lastTurnMetrics: null,
      });

      // Extract callbacks so they can be reused in the expired-session retry
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

      try {
        const result = await runChatTurn(fundName, sessionId, message, context, opts, streamCallbacks);

        if (!cancelledRef.current) {
          setState((s) => ({ ...s, isStreaming: false, result }));
        }
        return result;
      } catch (err: unknown) {
        const isExpired = err instanceof Error && SESSION_EXPIRED_PATTERN.test(err.message);

        if (isExpired && sessionId && !cancelledRef.current) {
          // Session expired server-side — retry as a fresh session, reusing streaming callbacks
          try {
            const retryResult = await runChatTurn(
              fundName,
              undefined,
              message,
              context,
              opts,
              streamCallbacks,
            );
            if (!cancelledRef.current) {
              setState((s) => ({ ...s, isStreaming: false, result: retryResult }));
            }
            return retryResult;
          } catch (retryErr: unknown) {
            const retryError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
            if (!cancelledRef.current) {
              setState((s) => ({ ...s, isStreaming: false, error: retryError }));
            }
            throw retryError;
          }
        }

        const error = err instanceof Error ? err : new Error(String(err));
        if (!cancelledRef.current) {
          setState((s) => ({ ...s, isStreaming: false, error }));
        }
        throw error;
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    setState((s) => ({ ...s, isStreaming: false }));
  }, []);

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

  return { ...state, send, cancel, reset };
}
