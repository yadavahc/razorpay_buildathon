/**
 * THE GUARDRAIL REGRET LEDGER
 *
 * Every recovery system reports what it recovered. Almost none can say what its safety
 * rules cost to enforce. So guardrails get set once, defensively, and are never revisited,
 * because nobody can price them — and an unpriced guardrail only ever ratchets tighter.
 *
 * This module prices them, and it is deliberate about the difference between a fact and
 * an estimate:
 *
 *   - What a guardrail BLOCKED is a fact, counted from persisted policy decisions.
 *   - What it PREVENTED is a fact in its own units: messages not sent at 3am, duplicate
 *     charges refused, retries not fired at a customer who asked us to stop.
 *   - What it COST is an ESTIMATE. Every field carrying one is named `estimated*` and
 *     every row reports the sample it rests on.
 *
 * The cost estimate is empirical, not modelled. For each blocked strategy we measure the
 * recovery rate that same strategy actually realised on the cases it *was* allowed to run,
 * and apply that rate to the blocked exposure. Asking the model to price its own foregone
 * value would be circular — it is the function that recommended the action, so it will
 * argue for itself. Realised outcomes cannot.
 *
 * The comparison is matched on strategy, and on failure reason where the sample supports
 * it. It is NOT covariate-adjusted: the cases a guardrail blocks are not a random sample
 * of the cases it permits, and the sign of that bias is unknown. Rows below
 * MIN_COMPARABLE_SAMPLE report no estimate at all rather than a confident-looking noisy
 * one, and `caveat` on every row states what would have to be true for it to mislead.
 */

import type { PolicyConfig } from '../config/index.js';
import { goodwillCostFor } from '../domain/intervention-economics.js';
import { POLICY_REASON_CODES } from '../policy/policy-engine.js';
import type { PolicyDecision, RecoveryOutcome } from '../types/decisions.js';
import type { RecoveryCase } from '../types/entities.js';
import type { RecoveryStrategy } from '../types/enums.js';

/**
 * Below this many comparable realised outcomes a rate is noise, and quoting a rupee figure
 * derived from it would be dressing a guess as a measurement.
 */
export const MIN_COMPARABLE_SAMPLE = 20;

/** A guardrail's effect expressed in the unit it actually protects. */
export interface HarmPrevented {
  unit: string;
  count: number;
  /**
   * Priced where the harm has an unambiguous cash value (a duplicate charge is the charge).
   * Null where pricing it would require inventing a number for reputational damage.
   */
  pricedMinor: number | null;
}

export interface GuardrailRegretRow {
  reasonCode: string;
  label: string;

  // ---- facts -------------------------------------------------------------------
  /** Policy evaluations this code contributed to blocking. */
  blockedDecisions: number;
  /** Distinct cases affected, so a case blocked five times is not counted five times. */
  blockedCases: number;
  /** Exposure on those distinct cases. */
  blockedExposureMinor: number;
  /** Which strategies this guardrail actually stopped, most-blocked first. */
  blockedStrategies: Array<{ strategy: RecoveryStrategy; count: number }>;
  harmPrevented: HarmPrevented;

  // ---- estimates ---------------------------------------------------------------
  /** Realised recovery rate of the same strategies on cases this guardrail did not block. */
  comparableRecoveryRate: number | null;
  comparableSampleSize: number;
  /** blockedExposure x comparableRecoveryRate. Null when the sample is too thin to quote. */
  estimatedForegoneMinor: number | null;
  /** estimatedForegone - priced harm prevented. Null when either side is unquotable. */
  netRegretMinor: number | null;
  /** What would have to be true for this row to be misleading. Always populated. */
  caveat: string;
}

export interface PolicyAmendmentProposal {
  id: string;
  reasonCode: string;
  title: string;
  /** Written from the measured quantities on the row; never from a language model. */
  rationale: string;
  change: { key: string; from: string; to: string };
  estimatedRecoveryDeltaMinor: number;
  /** Non-null only where the relaxation has a priceable downside. */
  estimatedHarmDeltaMinor: number | null;
  confidence: 'high' | 'medium' | 'low';
  sampleSize: number;
  /**
   * Always true. The engine proposes; a human disposes. Nothing in RECLAIM applies a
   * policy amendment automatically, because a system that can loosen its own restraints
   * has no restraints.
   */
  requiresHumanApproval: true;
}

export interface RegretLedger {
  rows: GuardrailRegretRow[];
  proposals: PolicyAmendmentProposal[];
  totals: {
    blockedDecisions: number;
    blockedCases: number;
    blockedExposureMinor: number;
    /** Summed only over rows that carry a quotable estimate. */
    estimatedForegoneMinor: number;
    pricedHarmPreventedMinor: number;
    netRegretMinor: number;
    rowsWithoutEstimate: number;
  };
  /** Realised outcomes available to compare against. Small = read every row sceptically. */
  evidenceBase: { outcomes: number; blockedDecisions: number };
  generatedAt: string;
}

/** What each guardrail protects, in its own units. Keyed by reason code. */
const HARM_UNITS: Record<string, string> = {
  [POLICY_REASON_CODES.QUIET_HOURS]: 'messages withheld during customer local night',
  [POLICY_REASON_CODES.CONTACT_CAP_EXCEEDED]: 'messages beyond the daily cap',
  [POLICY_REASON_CODES.COOLDOWN_ACTIVE]: 'actions inside the pacing window',
  [POLICY_REASON_CODES.MAX_RETRIES_EXCEEDED]: 'retries beyond the per-case limit',
  [POLICY_REASON_CODES.CUSTOMER_OPTED_OUT]: 'contacts to opted-out customers',
  [POLICY_REASON_CODES.CUSTOMER_DO_NOT_RETRY]: 'retries the customer refused',
  [POLICY_REASON_CODES.CHARGEBACK_RISK]: 'charges to customers over the chargeback limit',
  [POLICY_REASON_CODES.DUPLICATE_ACTION]: 'duplicate charges prevented',
  [POLICY_REASON_CODES.EXPECTED_VALUE_TOO_LOW]: 'value-destroying actions declined',
  [POLICY_REASON_CODES.CASE_BUDGET_EXHAUSTED]: 'actions beyond the per-case budget',
  [POLICY_REASON_CODES.ABOVE_AUTO_EXECUTE_CEILING]: 'high-value actions routed to a human',
  [POLICY_REASON_CODES.HIGH_VALUE_LOW_CONFIDENCE]: 'low-confidence high-value actions held',
  [POLICY_REASON_CODES.MANDATE_INACTIVE]: 'charges without a live mandate',
  [POLICY_REASON_CODES.RETRY_STRUCTURALLY_IMPOSSIBLE]: 'retries that could not have succeeded',
  [POLICY_REASON_CODES.NO_CONTACT_CHANNEL]: 'messages with nowhere to send',
  [POLICY_REASON_CODES.CASE_TERMINAL]: 'actions on already-closed cases',
};

/**
 * Codes whose prevented harm has an unambiguous cash value.
 *
 * A duplicate charge is worth exactly the charge: we would have taken money twice and
 * refunded it, eating the fee and the trust. A charge to a customer already over the
 * chargeback limit is priced the same way, since the modal outcome is a chargeback.
 * Everything else — annoyance, a message at 3am — is real but not honestly priceable, so
 * it stays a count and the net-regret column stays null rather than inventing a number.
 */
const CASH_PRICEABLE_HARM = new Set<string>([
  POLICY_REASON_CODES.DUPLICATE_ACTION,
  POLICY_REASON_CODES.CHARGEBACK_RISK,
]);

/** Guardrails that exist for consent or law. These are never proposed for relaxation. */
const NON_NEGOTIABLE = new Set<string>([
  POLICY_REASON_CODES.CUSTOMER_OPTED_OUT,
  POLICY_REASON_CODES.CUSTOMER_DO_NOT_RETRY,
  POLICY_REASON_CODES.DUPLICATE_ACTION,
  POLICY_REASON_CODES.CASE_TERMINAL,
  POLICY_REASON_CODES.MANDATE_INACTIVE,
  POLICY_REASON_CODES.RETRY_STRUCTURALLY_IMPOSSIBLE,
]);

export interface RegretLedgerInput {
  policyDecisions: readonly PolicyDecision[];
  outcomes: readonly RecoveryOutcome[];
  cases: readonly RecoveryCase[];
  config: PolicyConfig;
  labelFor: (code: string) => string;
  nowIso: string;
}

export function computeRegretLedger(input: RegretLedgerInput): RegretLedger {
  const caseById = new Map(input.cases.map((c) => [c.id, c]));

  // Realised recovery rate per strategy, amount-weighted. Amount weighting matters: a
  // strategy that recovers many small payments and loses the large ones has a flattering
  // count-based rate and a truthful money-based one, and this ledger is about money.
  const realised = new Map<RecoveryStrategy, { recovered: number; atRisk: number; n: number }>();
  for (const outcome of input.outcomes) {
    const bucket = realised.get(outcome.strategy) ?? { recovered: 0, atRisk: 0, n: 0 };
    bucket.recovered += outcome.recoveredAmountMinor;
    bucket.atRisk += outcome.amountAtRiskMinor;
    bucket.n += 1;
    realised.set(outcome.strategy, bucket);
  }

  const blocked = input.policyDecisions.filter(
    (d) => d.verdict === 'deny' || d.verdict === 'require_human',
  );

  // Group by reason code. A single denial can cite several codes; each is credited with
  // the block, but case counts and exposure are de-duplicated per code so a case denied
  // repeatedly for the same reason contributes its amount once.
  const groups = new Map<
    string,
    {
      decisions: number;
      caseIds: Set<string>;
      strategies: Map<RecoveryStrategy, number>;
      exposureByCase: Map<string, number>;
    }
  >();

  for (const decision of blocked) {
    for (const code of decision.reasonCodes) {
      let group = groups.get(code);
      if (!group) {
        group = {
          decisions: 0,
          caseIds: new Set(),
          strategies: new Map(),
          exposureByCase: new Map(),
        };
        groups.set(code, group);
      }
      group.decisions += 1;
      group.caseIds.add(decision.caseId);
      group.strategies.set(
        decision.requestedStrategy,
        (group.strategies.get(decision.requestedStrategy) ?? 0) + 1,
      );
      // Prefer the case's own exposure; fall back to the amount on the decision when the
      // case has since been pruned. Assigning rather than adding is the de-duplication.
      const exposure = caseById.get(decision.caseId)?.amountAtRiskMinor ?? decision.amountMinor;
      group.exposureByCase.set(decision.caseId, exposure);
    }
  }

  const rows: GuardrailRegretRow[] = [];

  for (const [code, group] of groups) {
    const blockedStrategies = [...group.strategies.entries()]
      .map(([strategy, count]) => ({ strategy, count }))
      .sort((a, b) => b.count - a.count);

    const blockedExposureMinor = [...group.exposureByCase.values()].reduce((a, b) => a + b, 0);

    // Blend the realised rates of the strategies this guardrail actually blocked, weighted
    // by how often it blocked each. Comparing against a strategy mix the guardrail never
    // touched would answer a question nobody asked.
    let weightedRecovered = 0;
    let weightedAtRisk = 0;
    let sample = 0;
    for (const { strategy, count } of blockedStrategies) {
      const stats = realised.get(strategy);
      if (!stats || stats.atRisk === 0) continue;
      weightedRecovered += (stats.recovered / stats.atRisk) * count;
      weightedAtRisk += count;
      sample += stats.n;
    }

    const hasSample = sample >= MIN_COMPARABLE_SAMPLE && weightedAtRisk > 0;
    const comparableRecoveryRate = hasSample ? weightedRecovered / weightedAtRisk : null;
    const estimatedForegoneMinor =
      comparableRecoveryRate === null ? null : Math.round(blockedExposureMinor * comparableRecoveryRate);

    const harmPrevented = priceHarm(code, group.decisions, blockedExposureMinor, blockedStrategies);

    const netRegretMinor =
      estimatedForegoneMinor === null || harmPrevented.pricedMinor === null
        ? null
        : estimatedForegoneMinor - harmPrevented.pricedMinor;

    rows.push({
      reasonCode: code,
      label: input.labelFor(code),
      blockedDecisions: group.decisions,
      blockedCases: group.caseIds.size,
      blockedExposureMinor,
      blockedStrategies,
      harmPrevented,
      comparableRecoveryRate,
      comparableSampleSize: sample,
      estimatedForegoneMinor,
      netRegretMinor,
      caveat: caveatFor(code, sample, hasSample),
    });
  }

  rows.sort((a, b) => (b.estimatedForegoneMinor ?? -1) - (a.estimatedForegoneMinor ?? -1));

  const totals = rows.reduce(
    (acc, row) => {
      acc.blockedDecisions += row.blockedDecisions;
      acc.blockedCases += row.blockedCases;
      acc.blockedExposureMinor += row.blockedExposureMinor;
      if (row.estimatedForegoneMinor === null) acc.rowsWithoutEstimate += 1;
      else acc.estimatedForegoneMinor += row.estimatedForegoneMinor;
      acc.pricedHarmPreventedMinor += row.harmPrevented.pricedMinor ?? 0;
      return acc;
    },
    {
      blockedDecisions: 0,
      blockedCases: 0,
      blockedExposureMinor: 0,
      estimatedForegoneMinor: 0,
      pricedHarmPreventedMinor: 0,
      netRegretMinor: 0,
      rowsWithoutEstimate: 0,
    },
  );
  totals.netRegretMinor = totals.estimatedForegoneMinor - totals.pricedHarmPreventedMinor;

  return {
    rows,
    proposals: buildProposals(rows, input.config),
    totals,
    evidenceBase: { outcomes: input.outcomes.length, blockedDecisions: blocked.length },
    generatedAt: input.nowIso,
  };
}

function priceHarm(
  code: string,
  decisions: number,
  exposureMinor: number,
  blockedStrategies: ReadonlyArray<{ strategy: RecoveryStrategy; count: number }>,
): HarmPrevented {
  const unit = HARM_UNITS[code] ?? 'actions blocked';

  if (!CASH_PRICEABLE_HARM.has(code)) {
    // Contact-fatigue guardrails do have a cost — it is just not a rupee figure we can
    // defend. Report the goodwill the economics module already assigns, which is a
    // parameter of the system rather than a measurement, and mark it unpriced.
    return { unit, count: decisions, pricedMinor: null };
  }

  if (code === POLICY_REASON_CODES.DUPLICATE_ACTION) {
    // A prevented duplicate is the whole amount: charged twice, refunded, fee eaten.
    return { unit, count: decisions, pricedMinor: exposureMinor };
  }

  // Chargeback risk: the harm is the disputed amount plus the goodwill of having chased a
  // customer who already disputes. Priced at exposure only, which is the conservative half.
  const goodwill = blockedStrategies.reduce(
    (sum, s) => sum + goodwillCostFor(s.strategy, 1) * s.count,
    0,
  );
  return { unit, count: decisions, pricedMinor: exposureMinor + goodwill };
}

function caveatFor(code: string, sample: number, hasSample: boolean): string {
  if (!hasSample) {
    return `Only ${sample} comparable realised outcome${sample === 1 ? '' : 's'}; below the ${MIN_COMPARABLE_SAMPLE} needed to quote a figure, so no cost is estimated.`;
  }
  if (NON_NEGOTIABLE.has(code)) {
    return 'Consent or correctness guardrail. The foregone figure is what compliance costs, not a case for relaxing it.';
  }
  return `Unadjusted comparison against ${sample} realised outcomes for the same strategies. Blocked cases may differ systematically from permitted ones; treat as an upper bound.`;
}

/**
 * Turn measured regret into specific, bounded, human-approvable changes.
 *
 * A proposal is only generated where the evidence is strong enough to act on, the
 * guardrail is negotiable, and the change is small. There is no proposal to disable a
 * guardrail — only to narrow the population it applies to or to move a numeric threshold
 * one notch. Nothing here is applied automatically.
 */
function buildProposals(
  rows: readonly GuardrailRegretRow[],
  config: PolicyConfig,
): PolicyAmendmentProposal[] {
  const proposals: PolicyAmendmentProposal[] = [];

  for (const row of rows) {
    if (NON_NEGOTIABLE.has(row.reasonCode)) continue;
    if (row.estimatedForegoneMinor === null || row.estimatedForegoneMinor <= 0) continue;

    const confidence: PolicyAmendmentProposal['confidence'] =
      row.comparableSampleSize >= 200 ? 'high' : row.comparableSampleSize >= 60 ? 'medium' : 'low';

    switch (row.reasonCode) {
      case POLICY_REASON_CODES.QUIET_HOURS: {
        // Only worth proposing if it is still blocking silent strategies, which it should
        // not be. If the mix is purely customer-facing the guardrail is working correctly.
        const silentBlocked = row.blockedStrategies
          .filter((s) => s.strategy === 'immediate_retry' || s.strategy === 'delayed_retry')
          .reduce((n, s) => n + s.count, 0);
        if (silentBlocked === 0) continue;
        proposals.push({
          id: `amend_quiet_hours_scope`,
          reasonCode: row.reasonCode,
          title: 'Exempt silent retries from quiet hours',
          rationale: `Quiet hours blocked ${silentBlocked} silent retr${silentBlocked === 1 ? 'y' : 'ies'}, which the customer never sees. The guardrail exists to stop night-time messages, not to stop money moving.`,
          change: { key: 'quietHours.appliesTo', from: 'all strategies', to: 'customer-facing only' },
          estimatedRecoveryDeltaMinor: Math.round(
            row.estimatedForegoneMinor * (silentBlocked / Math.max(1, row.blockedDecisions)),
          ),
          estimatedHarmDeltaMinor: 0,
          confidence,
          sampleSize: row.comparableSampleSize,
          requiresHumanApproval: true,
        });
        break;
      }

      case POLICY_REASON_CODES.EXPECTED_VALUE_TOO_LOW: {
        const next = Math.round(config.minExpectedValueMinor * 0.75);
        if (next >= config.minExpectedValueMinor) continue;
        proposals.push({
          id: 'amend_ev_floor',
          reasonCode: row.reasonCode,
          title: 'Lower the expected-value floor by 25%',
          rationale: `${row.blockedCases} cases holding ${fmtApprox(row.blockedExposureMinor)} were declined for sitting under the floor, while comparable actions realised ${(row.comparableRecoveryRate! * 100).toFixed(1)}% recovery. The floor may be set above where value actually turns negative.`,
          change: {
            key: 'minExpectedValueMinor',
            from: String(config.minExpectedValueMinor),
            to: String(next),
          },
          // A quarter of the blocked band is the part the new floor would admit.
          estimatedRecoveryDeltaMinor: Math.round(row.estimatedForegoneMinor * 0.25),
          estimatedHarmDeltaMinor: null,
          confidence,
          sampleSize: row.comparableSampleSize,
          requiresHumanApproval: true,
        });
        break;
      }

      case POLICY_REASON_CODES.MAX_RETRIES_EXCEEDED: {
        proposals.push({
          id: 'amend_max_retries',
          reasonCode: row.reasonCode,
          title: `Raise the retry limit from ${config.maxRetries} to ${config.maxRetries + 1}`,
          rationale: `${row.blockedCases} cases hit the retry ceiling with ${fmtApprox(row.blockedExposureMinor)} still outstanding. One additional attempt is the smallest testable change.`,
          change: {
            key: 'maxRetries',
            from: String(config.maxRetries),
            to: String(config.maxRetries + 1),
          },
          // Attempt N+1 is worth materially less than the average attempt; discount hard.
          estimatedRecoveryDeltaMinor: Math.round(row.estimatedForegoneMinor * 0.3),
          estimatedHarmDeltaMinor: null,
          confidence,
          sampleSize: row.comparableSampleSize,
          requiresHumanApproval: true,
        });
        break;
      }

      case POLICY_REASON_CODES.CONTACT_CAP_EXCEEDED: {
        proposals.push({
          id: 'amend_contact_cap',
          reasonCode: row.reasonCode,
          title: 'Route contact-capped cases to a silent retry instead of dropping them',
          rationale: `${row.blockedDecisions} actions were stopped by the daily contact cap. The cap should limit messages, not abandon the case — a silent retry consumes no contact budget.`,
          change: { key: 'contactCap.onExceeded', from: 'block', to: 'fall back to silent retry' },
          estimatedRecoveryDeltaMinor: Math.round(row.estimatedForegoneMinor * 0.5),
          estimatedHarmDeltaMinor: 0,
          confidence,
          sampleSize: row.comparableSampleSize,
          requiresHumanApproval: true,
        });
        break;
      }

      default:
        break;
    }
  }

  return proposals.sort((a, b) => b.estimatedRecoveryDeltaMinor - a.estimatedRecoveryDeltaMinor);
}

/** Rupee approximation for prose only. Presentation formats the real figures. */
function fmtApprox(minor: number): string {
  const rupees = minor / 100;
  if (rupees >= 10_000_000) return `₹${(rupees / 10_000_000).toFixed(2)}Cr`;
  if (rupees >= 100_000) return `₹${(rupees / 100_000).toFixed(2)}L`;
  if (rupees >= 1_000) return `₹${(rupees / 1_000).toFixed(1)}K`;
  return `₹${rupees.toFixed(0)}`;
}
