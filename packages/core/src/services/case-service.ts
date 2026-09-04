import { errors } from '../errors/index.js';
import { priorityScore } from '../graph/opportunity-graph.js';
import type { CaseTimelineEntry, RecoveryCase } from '../types/entities.js';
import type { CaseSourceType, CaseStatus, FailureReason, PaymentMethod } from '../types/enums.js';
import { TERMINAL_CASE_STATUSES } from '../types/enums.js';
import type { DataStore } from '../store/types.js';
import { newId } from '../util/id.js';
import { addHours, hoursBetween } from '../util/time.js';

/**
 * Recovery-case lifecycle.
 *
 * A case is the unit of work in RECLAIM: one revenue-loss event, tracked from detection
 * through to a measured outcome. This service owns its state machine and its timeline,
 * and it is the only place case status is allowed to change — which is what keeps the
 * "recovered" counter on the dashboard tied to something real.
 */

/**
 * Legal transitions. Anything not listed here is rejected.
 *
 * `recovered` is reachable from every non-terminal state, and that is deliberate: a
 * retry that succeeds on the very first action captures the money immediately, without
 * ever passing through an intermediate waiting state. An earlier version of this table
 * omitted `investigating -> recovered`, which meant the provider took the money and the
 * case then failed to record it — money captured, nothing booked. A state machine that
 * cannot represent the happy path is worse than no state machine.
 *
 * Terminal states have no outgoing edges at all. That is what makes the recovered total
 * monotonic: nothing can reopen a closed case and bank the same rupees twice.
 */
const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  detected: ['investigating', 'awaiting_action', 'in_progress', 'recovered', 'escalated', 'stopped', 'unrecoverable'],
  investigating: ['awaiting_action', 'in_progress', 'recovered', 'escalated', 'stopped', 'unrecoverable'],
  awaiting_action: ['investigating', 'in_progress', 'recovered', 'escalated', 'stopped', 'unrecoverable'],
  in_progress: ['in_progress', 'awaiting_action', 'recovered', 'escalated', 'stopped', 'unrecoverable'],
  escalated: ['in_progress', 'recovered', 'stopped', 'unrecoverable'],
  recovered: [],
  stopped: [],
  unrecoverable: [],
};

export interface CreateCaseInput {
  merchantId: string;
  customerId: string;
  sourceType: CaseSourceType;
  sourceId: string;
  amountAtRiskMinor: number;
  method: PaymentMethod;
  failureReason: FailureReason | null;
  detectedAt: string;
  summary: string;
}

export class CaseService {
  constructor(private readonly store: DataStore) {}

  /**
   * Create a case, or return the existing one for the same source event.
   *
   * De-duplication is by `(merchantId, sourceId)`: a webhook delivered twice, a batch
   * re-run, or a replayed event must never produce two cases competing to recover the
   * same rupees.
   */
  async createCase(input: CreateCaseInput): Promise<{ recoveryCase: RecoveryCase; created: boolean }> {
    const existing = await this.store.cases.list({
      where: [
        { field: 'merchantId', op: '==', value: input.merchantId },
        { field: 'sourceId', op: '==', value: input.sourceId },
      ],
      limit: 1,
    });
    if (existing.length > 0) return { recoveryCase: existing[0]!, created: false };

    const recoveryCase: RecoveryCase = {
      id: newId('case'),
      merchantId: input.merchantId,
      customerId: input.customerId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      amountAtRiskMinor: input.amountAtRiskMinor,
      currency: 'INR',
      status: 'detected',
      failureReason: input.failureReason,
      method: input.method,
      recoveryProbability: null,
      expectedValueMinor: null,
      priorityScore: null,
      selectedStrategy: null,
      attemptCount: 0,
      notificationCount: 0,
      recoveredAmountMinor: 0,
      detectedAt: input.detectedAt,
      updatedAt: input.detectedAt,
      lastActionAt: null,
      cooldownUntil: null,
      resolvedAt: null,
      escalationReason: null,
      timeline: [
        {
          at: input.detectedAt,
          kind: 'detected',
          summary: input.summary,
          refId: input.sourceId,
          amountMinor: input.amountAtRiskMinor,
        },
      ],
    };

    await this.store.cases.put(recoveryCase);
    await this.store.appendAudit({
      merchantId: input.merchantId,
      actor: { kind: 'system', id: 'ingestion' },
      event: 'case.detected',
      trigger: `${input.sourceType}:${input.sourceId}`,
      caseId: recoveryCase.id,
      customerId: input.customerId,
      amountMinor: input.amountAtRiskMinor,
      at: input.detectedAt,
      metadata: { sourceType: input.sourceType, failureReason: input.failureReason },
    });

    return { recoveryCase, created: true };
  }

  async get(caseId: string): Promise<RecoveryCase> {
    const found = await this.store.cases.get(caseId);
    if (!found) throw errors.notFound('recovery_case', caseId);
    return found;
  }

  /** Append a timeline entry and bump `updatedAt` in one write. */
  async appendTimeline(
    caseId: string,
    entry: Omit<CaseTimelineEntry, 'refId' | 'amountMinor'> &
      Partial<Pick<CaseTimelineEntry, 'refId' | 'amountMinor'>>,
  ): Promise<RecoveryCase> {
    const recoveryCase = await this.get(caseId);
    const timeline = [
      ...recoveryCase.timeline,
      { refId: null, amountMinor: null, ...entry } satisfies CaseTimelineEntry,
    ];
    return this.store.cases.patch(caseId, { timeline, updatedAt: entry.at });
  }

  /**
   * Move a case to a new status, refusing illegal transitions.
   *
   * Terminal statuses have no outgoing edges at all: once a case is recovered, stopped or
   * written off, no later action can reopen it. That is what makes the recovered total
   * monotonic and auditable.
   */
  async transition(
    caseId: string,
    next: CaseStatus,
    opts: { at: string; summary: string; reason?: string | null },
  ): Promise<RecoveryCase> {
    const recoveryCase = await this.get(caseId);
    if (recoveryCase.status === next) return recoveryCase;

    const allowed = TRANSITIONS[recoveryCase.status];
    if (!allowed.includes(next)) {
      throw errors.invalidState(
        `cannot move case ${caseId} from ${recoveryCase.status} to ${next}`,
        { from: recoveryCase.status, to: next, allowed },
      );
    }

    const isTerminal = TERMINAL_CASE_STATUSES.includes(next);
    const updated = await this.store.cases.patch(caseId, {
      status: next,
      updatedAt: opts.at,
      resolvedAt: isTerminal ? opts.at : recoveryCase.resolvedAt,
      escalationReason: next === 'escalated' ? (opts.reason ?? null) : recoveryCase.escalationReason,
      timeline: [
        ...recoveryCase.timeline,
        {
          at: opts.at,
          kind:
            next === 'escalated' ? 'escalated' : isTerminal ? 'closed' : ('note' as const),
          summary: opts.summary,
          refId: null,
          amountMinor: null,
        },
      ],
    });

    await this.store.appendAudit({
      merchantId: recoveryCase.merchantId,
      actor: { kind: 'system', id: 'case_service' },
      event: `case.${next}`,
      trigger: opts.summary,
      caseId,
      customerId: recoveryCase.customerId,
      amountMinor: recoveryCase.amountAtRiskMinor,
      at: opts.at,
      metadata: { from: recoveryCase.status, to: next, reason: opts.reason ?? null },
    });

    return updated;
  }

  /** Record the model output and derived ranking on the case. */
  async recordPrediction(
    caseId: string,
    input: {
      probability: number;
      expectedValueMinor: number;
      isSubscriber: boolean;
      lifetimeValueMinor: number;
      at: string;
    },
  ): Promise<RecoveryCase> {
    const recoveryCase = await this.get(caseId);
    const score = priorityScore({
      amountAtRiskMinor: recoveryCase.amountAtRiskMinor,
      recoveryProbability: input.probability,
      hoursSinceDetection: Math.max(0, hoursBetween(recoveryCase.detectedAt, input.at)),
      isSubscriber: input.isSubscriber,
      lifetimeValueMinor: input.lifetimeValueMinor,
    });

    return this.store.cases.patch(caseId, {
      recoveryProbability: input.probability,
      expectedValueMinor: input.expectedValueMinor,
      priorityScore: score,
      updatedAt: input.at,
    });
  }

  /** Apply the bookkeeping that follows a successfully executed action. */
  async recordActionTaken(
    caseId: string,
    input: {
      strategy: RecoveryCase['selectedStrategy'];
      at: string;
      cooldownHours: number;
      isRetry: boolean;
      isContact: boolean;
    },
  ): Promise<RecoveryCase> {
    const recoveryCase = await this.get(caseId);
    return this.store.cases.patch(caseId, {
      selectedStrategy: input.strategy,
      attemptCount: recoveryCase.attemptCount + (input.isRetry ? 1 : 0),
      notificationCount: recoveryCase.notificationCount + (input.isContact ? 1 : 0),
      lastActionAt: input.at,
      cooldownUntil: addHours(input.at, input.cooldownHours),
      updatedAt: input.at,
    });
  }

  async markRecovered(caseId: string, recoveredAmountMinor: number, at: string): Promise<RecoveryCase> {
    const recoveryCase = await this.get(caseId);
    await this.store.cases.patch(caseId, {
      recoveredAmountMinor: recoveryCase.recoveredAmountMinor + recoveredAmountMinor,
    });
    return this.transition(caseId, 'recovered', {
      at,
      summary: `Recovered ${(recoveredAmountMinor / 100).toFixed(2)} INR.`,
    });
  }

  /** Cases eligible for the next decisioning pass, highest opportunity first. */
  async listWorkQueue(
    merchantId: string,
    opts: { limit?: number; statuses?: CaseStatus[] } = {},
  ): Promise<RecoveryCase[]> {
    const statuses = opts.statuses ?? ['detected', 'investigating', 'awaiting_action', 'in_progress'];
    const cases = await this.store.cases.list({
      where: [{ field: 'merchantId', op: '==', value: merchantId }],
    });
    return cases
      .filter((c) => statuses.includes(c.status))
      .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
      .slice(0, opts.limit ?? 50);
  }

  /** True when the case can still be worked. Cheap guard used before every action. */
  static isActionable(recoveryCase: RecoveryCase): boolean {
    return !TERMINAL_CASE_STATUSES.includes(recoveryCase.status);
  }
}
