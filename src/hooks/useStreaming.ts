import { useState, useCallback, useRef } from "react";
import { runChatTurn } from "../services/chat.service.js";
import type { ChatTurnResult } from "../services/chat.service.js";

interface StreamingState {
  isStreaming: boolean;
  buffer: string;
  charCount: number;
  result: ChatTurnResult | null;
  error: Error | null;
}

interface UseStreamingReturn extends StreamingState {
  send: (
    fundName: string,
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
      fundName: string,
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

      try {
        const result = await runChatTurn(fundName, sessionId, message, context, opts, {
          onStreamStart: () => {
            if (!cancelledRef.current) {
              setState((s) => ({ ...s, isStreaming: true }));
            }
          },
          onStreamDelta: (text, totalChars) => {
            if (!cancelledRef.current) {
              setState((s) => ({
                ...s,
                buffer: s.buffer + text,
                charCount: totalChars,
              }));
            }
          },
          onStreamEnd: () => {
            if (!cancelledRef.current) {
              setState((s) => ({ ...s, isStreaming: false }));
            }
          },
        });

        if (!cancelledRef.current) {
          setState((s) => ({ ...s, isStreaming: false, result }));
        }
        return result;
      } catch (err: unknown) {
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
