/**
 * A single error taxonomy for the whole system. Every failure that crosses a boundary is
 * one of these, which is what makes centralised handling, retry classification and the
 * failure lab possible without string matching on messages.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'DUPLICATE_ACTION'
  | 'POLICY_DENIED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'CIRCUIT_OPEN'
  | 'AI_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INVALID_STATE'
  | 'CONFIG_ERROR'
  | 'INTERNAL';

export interface ReclaimErrorOptions {
  code: ErrorCode;
  message: string;
  /** True when a bounded retry has a realistic chance of succeeding. */
  retryable?: boolean;
  httpStatus?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class ReclaimError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(opts: ReclaimErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ReclaimError';
    this.code = opts.code;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE.has(opts.code);
    this.httpStatus = opts.httpStatus ?? DEFAULT_STATUS[opts.code];
    this.details = opts.details ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

const DEFAULT_RETRYABLE = new Set<ErrorCode>([
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'AI_UNAVAILABLE',
]);

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  DUPLICATE_ACTION: 409,
  POLICY_DENIED: 422,
  PROVIDER_ERROR: 502,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_UNAVAILABLE: 503,
  CIRCUIT_OPEN: 503,
  AI_UNAVAILABLE: 503,
  MODEL_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  INVALID_STATE: 409,
  CONFIG_ERROR: 500,
  INTERNAL: 500,
};

export const errors = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new ReclaimError({ code: 'VALIDATION_FAILED', message, details }),
  notFound: (resource: string, id: string) =>
    new ReclaimError({ code: 'NOT_FOUND', message: `${resource} not found: ${id}`, details: { resource, id } }),
  unauthorized: (message = 'authentication required') =>
    new ReclaimError({ code: 'UNAUTHORIZED', message }),
  forbidden: (message: string, details?: Record<string, unknown>) =>
    new ReclaimError({ code: 'FORBIDDEN', message, details }),
  duplicate: (key: string, existingRef?: string) =>
    new ReclaimError({
      code: 'DUPLICATE_ACTION',
      message: `action already executed for idempotency key ${key}`,
      details: { key, existingRef: existingRef ?? null },
    }),
  policyDenied: (reasonCodes: string[]) =>
    new ReclaimError({
      code: 'POLICY_DENIED',
      message: `policy denied action: ${reasonCodes.join(', ')}`,
      details: { reasonCodes },
    }),
  providerTimeout: (provider: string, ms: number) =>
    new ReclaimError({
      code: 'PROVIDER_TIMEOUT',
      message: `${provider} timed out after ${ms}ms`,
      details: { provider, ms },
      retryable: true,
    }),
  providerError: (provider: string, message: string, details?: Record<string, unknown>) =>
    new ReclaimError({ code: 'PROVIDER_ERROR', message: `${provider}: ${message}`, details }),
  providerUnavailable: (provider: string) =>
    new ReclaimError({
      code: 'PROVIDER_UNAVAILABLE',
      message: `${provider} is unavailable`,
      details: { provider },
      retryable: true,
    }),
  circuitOpen: (name: string, retryAfterMs: number) =>
    new ReclaimError({
      code: 'CIRCUIT_OPEN',
      message: `circuit breaker open for ${name}`,
      details: { name, retryAfterMs },
    }),
  aiUnavailable: (message: string) =>
    new ReclaimError({ code: 'AI_UNAVAILABLE', message, retryable: true }),
  invalidState: (message: string, details?: Record<string, unknown>) =>
    new ReclaimError({ code: 'INVALID_STATE', message, details }),
  config: (message: string) => new ReclaimError({ code: 'CONFIG_ERROR', message }),
  internal: (message: string, cause?: unknown) =>
    new ReclaimError({ code: 'INTERNAL', message, cause }),
};

export function isReclaimError(value: unknown): value is ReclaimError {
  return value instanceof ReclaimError;
}

export function toReclaimError(value: unknown): ReclaimError {
  if (isReclaimError(value)) return value;
  if (value instanceof Error) {
    return new ReclaimError({ code: 'INTERNAL', message: value.message, cause: value });
  }
  return new ReclaimError({ code: 'INTERNAL', message: String(value) });
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
