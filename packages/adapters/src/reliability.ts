import type { AdapterRunResult } from "./types";

type CircuitState = {
  failureCount: number;
  openedAt: number | null;
};

const circuitStates = new Map<string, CircuitState>();

const DEFAULT_OPTIONS: Required<Omit<ReliabilityOptions, "sleep">> = {
  maxRetries: 2,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  jitterMs: 100,
  failureThreshold: 3,
  cooldownMs: 30_000
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type ResolvedOptions = Required<Omit<ReliabilityOptions, "sleep">> & {
  sleep: (ms: number) => Promise<void>;
};

export type ReliabilityOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class RetryableAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableAdapterError";
  }
}

export class FatalAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalAdapterError";
  }
}

export function resetCircuitBreakerState(): void {
  circuitStates.clear();
}

export async function executeAdapterRunWithReliability(
  adapterKey: string,
  action: () => Promise<AdapterRunResult>,
  options?: ReliabilityOptions
): Promise<AdapterRunResult> {
  const cfg = resolveOptions(options);
  const state = getCircuitState(adapterKey);

  const now = Date.now();
  if (state.openedAt && now - state.openedAt < cfg.cooldownMs) {
    return {
      ok: false,
      detail: `Circuit breaker is open for adapter ${adapterKey}.`
    };
  }

  if (state.openedAt && now - state.openedAt >= cfg.cooldownMs) {
    state.openedAt = null;
    state.failureCount = 0;
  }

  let lastDetail = `Adapter ${adapterKey} run failed.`;
  const attempts = Math.max(1, cfg.maxRetries + 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await action();
      if (result.ok) {
        resetCircuit(state);
        return result;
      }

      lastDetail = result.detail ?? lastDetail;
      if (!(result.retryable ?? false)) {
        resetCircuit(state);
        return result;
      }

      recordFailure(state, cfg);
    } catch (error) {
      const err = error as Error;
      lastDetail = err.message || lastDetail;
      if (err instanceof FatalAdapterError) {
        resetCircuit(state);
        return { ok: false, detail: err.message };
      }
      recordFailure(state, cfg);
    }

    if (state.openedAt) {
      break;
    }

    if (attempt < attempts) {
      await cfg.sleep(calculateDelay(attempt, cfg));
    }
  }

  return {
    ok: false,
    detail: lastDetail
  };
}

function resolveOptions(options?: ReliabilityOptions): ResolvedOptions {
  const { sleep, ...rest } = options ?? {};
  return {
    ...DEFAULT_OPTIONS,
    ...rest,
    sleep: sleep ?? defaultSleep
  };
}

function getCircuitState(adapterKey: string): CircuitState {
  let state = circuitStates.get(adapterKey);
  if (!state) {
    state = { failureCount: 0, openedAt: null };
    circuitStates.set(adapterKey, state);
  }
  return state;
}

function recordFailure(state: CircuitState, cfg: ResolvedOptions): void {
  state.failureCount += 1;
  if (!state.openedAt && state.failureCount >= cfg.failureThreshold) {
    state.openedAt = Date.now();
  }
}

function resetCircuit(state: CircuitState): void {
  state.failureCount = 0;
  state.openedAt = null;
}

function calculateDelay(attempt: number, cfg: ResolvedOptions): number {
  const baseDelay = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (attempt - 1));
  const jitter = cfg.jitterMs > 0 ? Math.floor(Math.random() * cfg.jitterMs) : 0;
  return baseDelay + jitter;
}
