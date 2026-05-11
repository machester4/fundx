export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  shouldRetry: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

const DEFAULT_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitter: true,
};

function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  if (!jitter) return exp;
  const factor = 0.75 + Math.random() * 0.5;
  return Math.round(exp * factor);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> & Pick<RetryOptions, "shouldRetry">,
): Promise<T> {
  const merged: RetryOptions = { ...DEFAULT_OPTIONS, ...opts };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= merged.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === merged.maxAttempts;
      if (isLast || !merged.shouldRetry(err)) throw err;
      const delay = computeDelay(attempt, merged.baseDelayMs, merged.maxDelayMs, merged.jitter);
      merged.onRetry?.(attempt, err, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
