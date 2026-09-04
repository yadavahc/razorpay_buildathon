import { ReclaimError, errors, toReclaimError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import { noopLogger } from '../logging/index.js';
import type { Clock } from '../util/time.js';
import { systemClock } from '../util/time.js';

/**
 * Resilience primitives shared by every outbound call in the system: the payment
 * provider, the language model, and Firestore.
 *
 * Two rules govern their use here, and both exist because this code moves money:
 *
 *   1. Only operations that are *safe to repeat* are retried. A payment authorisation is
 *      retried solely because it is guarded upstream by an idempotency key; without that
 *      key it would be attempted exactly once.
 *   2. A circuit breaker fails fast rather than queueing. When a provider is down, the
 *      correct behaviour is to fall back to another intervention or escalate to a human,
 *      not to hold a customer's money in limbo while we retry.
 */

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Multiplier applied per attempt; 2 gives classic exponential backoff. */
  factor: number;
  /** Random proportion of the delay, to stop synchronised clients retrying in lockstep. */
  jitter: number;
  /** Only errors matching this predicate are retried. Defaults to `error.retryable`. */
  isRetryable?: (error: ReclaimError) => boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 4_000,
  factor: 2,
  jitter: 0.25,
};

export interface RetryAttempt {
  attempt: number;
  delayMs: number;
  error: ReclaimError;
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
  history: RetryAttempt[];
  totalDelayMs: number;
}

export function backoffDelay(policy: RetryPolicy, attempt: number, random: () => number): number {
  const exponential = policy.baseDelayMs * policy.factor ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitterRange = capped * policy.jitter;
  return Math.round(capped - jitterRange / 2 + random() * jitterRange);
}

export interface RetryOptions {
  policy?: Partial<RetryPolicy>;
  logger?: Logger;
  label?: string;
  /** Injected for deterministic tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  const policy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
  const logger = options.logger ?? noopLogger;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const isRetryable = policy.isRetryable ?? ((error: ReclaimError) => error.retryable);
  const label = options.label ?? 'operation';

  const history: RetryAttempt[] = [];
  let totalDelayMs = 0;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const value = await operation(attempt);
      return { value, attempts: attempt, history, totalDelayMs };
    } catch (raw) {
      const error = toReclaimError(raw);
      const isLastAttempt = attempt === policy.maxAttempts;

      if (!isRetryable(error) || isLastAttempt) {
        logger.warn(`${label} failed permanently`, {
          attempt,
          code: error.code,
          retryable: error.retryable,
        });
        throw error;
      }

      const delayMs = backoffDelay(policy, attempt, random);
      history.push({ attempt, delayMs, error });
      totalDelayMs += delayMs;
      logger.warn(`${label} failed, retrying`, { attempt, delayMs, code: error.code });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw errors.internal(`${label}: retry loop exited without a result`);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject with a typed timeout rather than hanging on an unresponsive dependency. */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(errors.providerTimeout(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  name: string;
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before allowing a probe request. */
  resetTimeoutMs: number;
  /** Consecutive successes in half-open state before closing again. */
  successThreshold: number;
  clock?: Clock;
  logger?: Logger;
}

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAt: string | null;
  retryAfterMs: number;
  totalTrips: number;
  totalCalls: number;
  totalFailures: number;
  totalShortCircuited: number;
}

/**
 * A standard three-state circuit breaker.
 *
 * `closed` passes calls through; consecutive failures trip it to `open`, which rejects
 * immediately for `resetTimeoutMs`; then a single probe is admitted in `half_open`. Any
 * failure in `half_open` re-opens the circuit rather than waiting for the full threshold
 * again, because a dependency that fails its probe is still down.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAtMs: number | null = null;
  private totalTrips = 0;
  private totalCalls = 0;
  private totalFailures = 0;
  private totalShortCircuited = 0;

  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
  }

  get name(): string {
    return this.options.name;
  }

  snapshot(): CircuitSnapshot {
    this.refreshState();
    return {
      name: this.options.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      openedAt: this.openedAtMs === null ? null : new Date(this.openedAtMs).toISOString(),
      retryAfterMs: this.retryAfterMs(),
      totalTrips: this.totalTrips,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      totalShortCircuited: this.totalShortCircuited,
    };
  }

  private retryAfterMs(): number {
    if (this.state !== 'open' || this.openedAtMs === null) return 0;
    return Math.max(0, this.options.resetTimeoutMs - (this.clock.now() - this.openedAtMs));
  }

  private refreshState(): void {
    if (this.state === 'open' && this.retryAfterMs() === 0) {
      this.state = 'half_open';
      this.consecutiveSuccesses = 0;
      this.logger.info(`circuit ${this.options.name} entering half-open`, {});
    }
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.refreshState();
    this.totalCalls++;

    if (this.state === 'open') {
      this.totalShortCircuited++;
      throw errors.circuitOpen(this.options.name, this.retryAfterMs());
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (raw) {
      this.onFailure(toReclaimError(raw));
      throw raw;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'half_open') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.options.successThreshold) {
        this.state = 'closed';
        this.openedAtMs = null;
        this.logger.info(`circuit ${this.options.name} closed`, {});
      }
    }
  }

  private onFailure(error: ReclaimError): void {
    this.totalFailures++;
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;

    // A probe failure in half-open reopens immediately.
    const shouldTrip =
      this.state === 'half_open' || this.consecutiveFailures >= this.options.failureThreshold;

    if (shouldTrip && this.state !== 'open') {
      this.state = 'open';
      this.openedAtMs = this.clock.now();
      this.totalTrips++;
      this.logger.warn(`circuit ${this.options.name} opened`, {
        consecutiveFailures: this.consecutiveFailures,
        code: error.code,
      });
    }
  }

  /** Force the circuit closed. Used by the demo reset flow and by tests. */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAtMs = null;
  }
}

/** Registry so the ops panel can render every breaker in the process. */
export class CircuitRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  get(name: string, options?: Partial<Omit<CircuitBreakerOptions, 'name'>>): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({
        name,
        failureThreshold: 4,
        resetTimeoutMs: 15_000,
        successThreshold: 1,
        ...options,
      });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  snapshots(): CircuitSnapshot[] {
    return [...this.breakers.values()].map((b) => b.snapshot());
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) breaker.reset();
  }
}
