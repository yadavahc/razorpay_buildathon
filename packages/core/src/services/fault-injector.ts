import { ReclaimError, errors } from '../errors/index.js';
import type { FaultKind } from '../types/enums.js';

/**
 * THE FAILURE LAB
 *
 * A recovery engine that has only ever been observed on the happy path is not a recovery
 * engine, it is a demo. This module lets an operator arm a specific fault and watch the
 * system meet it: the timeout that becomes a fallback, the duplicate request that the
 * idempotency ledger absorbs, the model outage that degrades the reasoner instead of
 * stalling the case.
 *
 * Faults are armed against a target subsystem, fire a bounded number of times, and then
 * disarm themselves. That boundedness matters — an injected fault must not leak into the
 * next demo, and every arm/fire event lands in the audit trail.
 */

export interface ArmedFault {
  id: string;
  kind: FaultKind;
  /** Subsystem the fault applies to: `payments`, `llm`, `store`, or `*` for all. */
  target: string;
  /** Remaining times this fault will fire before disarming. */
  remaining: number;
  armedAt: string;
  note: string;
}

export interface FaultEvent {
  at: string;
  kind: FaultKind;
  target: string;
  operation: string;
  remaining: number;
}

export const FAULT_DESCRIPTIONS: Record<FaultKind, { label: string; expected: string }> = {
  payment_timeout: {
    label: 'Payment timeout',
    expected:
      'The provider call exceeds its deadline. The executor retries with exponential backoff, and if the deadline keeps passing it falls back to the next strategy in the chain rather than leaving the case in limbo.',
  },
  duplicate_request: {
    label: 'Duplicate request',
    expected:
      'The same action is submitted twice with the same idempotency key. The second submission is rejected before it reaches the provider and is recorded as a prevented duplicate, not as a failure.',
  },
  gateway_failure: {
    label: 'Gateway failure',
    expected:
      'The provider returns a hard 5xx. Repeated failures trip the circuit breaker, which fails subsequent calls fast and pushes affected cases down the fallback chain.',
  },
  invalid_transaction: {
    label: 'Invalid transaction',
    expected:
      'The provider rejects the request as malformed. This is not retryable, so the executor stops immediately, records the error and escalates rather than burning the retry budget.',
  },
  policy_violation: {
    label: 'Policy violation',
    expected:
      'An action is attempted that the guardrails forbid. The policy engine denies it, the executor records the denial with its reason codes, and the suggested alternative is taken instead.',
  },
  ai_unavailable: {
    label: 'AI unavailable',
    expected:
      'The language model cannot be reached. The reasoner falls back to the deterministic engine, every decision it produces is flagged as degraded, and the case proceeds — the model was never authorising anything.',
  },
  external_api_failure: {
    label: 'External API failure',
    expected:
      'A downstream dependency errors. The call is retried within its budget, then surfaces as a typed error that the executor converts into a fallback or an escalation.',
  },
};

export class FaultInjector {
  private readonly faults = new Map<string, ArmedFault>();
  private readonly log: FaultEvent[] = [];
  private counter = 0;

  arm(input: { kind: FaultKind; target?: string; count?: number; note?: string }): ArmedFault {
    this.counter += 1;
    const fault: ArmedFault = {
      id: `fault_${this.counter}`,
      kind: input.kind,
      target: input.target ?? '*',
      remaining: Math.max(1, input.count ?? 1),
      armedAt: new Date().toISOString(),
      note: input.note ?? FAULT_DESCRIPTIONS[input.kind].expected,
    };
    this.faults.set(fault.id, fault);
    return fault;
  }

  disarm(id: string): boolean {
    return this.faults.delete(id);
  }

  disarmAll(): void {
    this.faults.clear();
  }

  armed(): ArmedFault[] {
    return [...this.faults.values()];
  }

  events(limit = 50): FaultEvent[] {
    return this.log.slice(-limit);
  }

  /** True when any fault of this kind is armed for the target, without consuming it. */
  isArmed(kind: FaultKind, target: string): boolean {
    for (const fault of this.faults.values()) {
      if (fault.kind === kind && (fault.target === '*' || fault.target === target)) return true;
    }
    return false;
  }

  /**
   * Consume one firing of a matching fault. Returns true when the caller should fail.
   * Decrements the counter and disarms the fault once exhausted, so an armed fault
   * affects exactly the number of operations the operator asked for.
   */
  shouldFail(kind: FaultKind, target: string, operation: string): boolean {
    for (const fault of this.faults.values()) {
      if (fault.kind !== kind) continue;
      if (fault.target !== '*' && fault.target !== target) continue;

      fault.remaining -= 1;
      this.log.push({
        at: new Date().toISOString(),
        kind,
        target,
        operation,
        remaining: fault.remaining,
      });
      if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
      if (fault.remaining <= 0) this.faults.delete(fault.id);
      return true;
    }
    return false;
  }

  /** Throw the error a given fault kind is supposed to produce. */
  raise(kind: FaultKind, target: string): never {
    switch (kind) {
      case 'payment_timeout':
        throw errors.providerTimeout(target, 8_000);
      case 'gateway_failure':
        throw errors.providerError(target, 'gateway returned 502 Bad Gateway', { injected: true });
      case 'invalid_transaction':
        throw new ReclaimError({
          code: 'VALIDATION_FAILED',
          message: `${target}: transaction rejected as invalid by the provider`,
          retryable: false,
          details: { injected: true },
        });
      case 'external_api_failure':
        throw errors.providerUnavailable(target);
      case 'ai_unavailable':
        throw errors.aiUnavailable(`${target}: reasoning provider unreachable`);
      case 'duplicate_request':
        throw errors.duplicate('injected-duplicate-key');
      case 'policy_violation':
        throw errors.policyDenied(['INJECTED_POLICY_VIOLATION']);
    }
  }

  /** Convenience used by providers: check and raise in one call. */
  maybeFail(kind: FaultKind, target: string, operation: string): void {
    if (this.shouldFail(kind, target, operation)) this.raise(kind, target);
  }
}

/**
 * The process-wide injector. A single instance is intentional: the failure lab arms a
 * fault through the API and the very next request must observe it.
 */
export const faultInjector = new FaultInjector();
