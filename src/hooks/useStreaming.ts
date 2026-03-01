import { useState, useCallback, useRef } from "react";
import { runChatTurn } from "../services/chat.service.js";
import type { ChatTurnResult } from "../services/chat.service.js";
import { SESSION_EXPIRED_PATTERN } from "../agent.js";

interface StreamingState {
  isStreaming: boolean;
  buffer: string;
  charCount: number;
  result: ChatTurnResult | null;
  error: Error | null;
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
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
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
    result: null,
    error: null,
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
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      },
    ): Promise<ChatTurnResult> => {
      cancelledRef.current = false;
      setState({
        isStreaming: true,
        buffer: "",
        charCount: 0,
        result: null,
        error: null,
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
          if (!cancelledRef.current) setState((s) => ({ ...s, isStreaming: false }));
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
      result: null,
      error: null,
    });
  }, []);

  return { ...state, send, cancel, reset };
}
