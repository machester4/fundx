import { useState, useEffect, useCallback, useRef } from "react";

export interface AsyncState<T> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
  retry: () => void;
}

/**
 * Run an async function on mount and track its loading/error/data state.
 * Optionally pass `deps` to re-run when dependencies change.
 */
export function useAsyncAction<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const retry = useCallback(() => setRetryCount((c) => c + 1), []);

  // Serialize deps to a stable string key so useEffect has a fixed-length dep array
  const depsKey = JSON.stringify(deps);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const result = await fnRef.current();
        if (!cancelled) {
          setData(result);
          setIsLoading(false);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [retryCount, depsKey]);

  return { data, isLoading, error, retry };
}
