import { useEffect, useRef } from "react";

/** Repeatedly call `callback` every `intervalMs` milliseconds. Pass `null` to pause. */
export function useInterval(callback: () => void, intervalMs: number | null) {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => savedCallback.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
