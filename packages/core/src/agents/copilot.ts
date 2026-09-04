import type { Logger } from '../logging/index.js';
import { noopLogger } from '../logging/index.js';
import type { CopilotEvidence, CopilotOutput, Reasoner } from '../llm/reasoner.js';
import type { ReasonerIdentity } from '../llm/types.js';
import type { AnalyticsService, StrategyPerformance } from '../services/analytics-service.js';
import { formatMinor } from '../types/money.js';
import { newId } from '../util/id.js';
import { formatDuration } from '../util/time.js';

/**
 * THE MERCHANT COPILOT
 *
 * Answers questions about revenue leakage and recovery performance in natural language.
 *
 * The mechanism that makes the answers trustworthy is the order of operations: the agent
 * classifies the question, runs the real analytics queries the question needs, computes
 * the complete answer itself, and only then hands the finished figures to the reasoner to
 * be worded. The reasoner never has an opportunity to produce a number, because every
 * number in the answer already exists before it is called.
 *
 * Each response carries the exact figures it relied on, so the merchant can check any
 * claim against the dashboard rather than taking it on trust.
 */

export type CopilotIntent =
  | 'revenue_at_risk'
  | 'biggest_opportunity'
  | 'revenue_drop'
  | 'prioritisation'
  | 'recovery_performance'
  | 'leakage_breakdown'
  | 'strategy_effectiveness'
  | 'overview';

export interface CopilotAnswer {
  id: string;
  question: string;
  intent: CopilotIntent;
  answer: string;
  citations: Array<{ label: string; value: string }>;
  followUps: string[];
  toolsUsed: string[];
  reasoner: ReasonerIdentity;
  latencyMs: number;
}

interface IntentRule {
  intent: CopilotIntent;
  patterns: RegExp[];
}

/**
 * Intent classification is a keyword matcher rather than a model call. It is fast,
 * free, testable, and — critically — it decides which *real queries* to run. Getting the
 * intent slightly wrong costs an extra query; letting a model decide what data to invent
 * would cost correctness.
 */
const INTENT_RULES: IntentRule[] = [
  {
    intent: 'revenue_drop',
    patterns: [/why.*(drop|down|fall|decline|worse)/i, /revenue.*(drop|down)/i, /what happened/i],
  },
  {
    intent: 'biggest_opportunity',
    patterns: [/biggest|largest|top.*(opportunit|recover)/i, /where.*most.*(money|revenue)/i],
  },
  {
    intent: 'prioritisation',
    patterns: [/prioriti[sz]/i, /what should (we|i) (do|work|focus)/i, /which.*first/i],
  },
  {
    intent: 'revenue_at_risk',
    patterns: [/at risk/i, /how much.*(risk|exposed|outstanding)/i],
  },
  {
    intent: 'recovery_performance',
    patterns: [/recovery rate/i, /how.*(well|much).*recover/i, /performance/i, /how are we doing/i],
  },
  {
    intent: 'leakage_breakdown',
    patterns: [/breakdown|by (reason|method|bank|issuer|segment)/i, /leak/i, /failure reason/i],
  },
  {
    intent: 'strategy_effectiveness',
    patterns: [/strateg/i, /which (action|intervention)/i, /retry vs|link vs/i],
  },
];

export function classifyIntent(question: string): CopilotIntent {
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(question))) return rule.intent;
  }
  return 'overview';
}

export interface CopilotOptions {
  analytics: AnalyticsService;
  reasoner: Reasoner;
  logger?: Logger;
}

export class MerchantCopilot {
  readonly id = 'agent:merchant_copilot';

  private readonly analytics: AnalyticsService;
  private readonly reasoner: Reasoner;
  private readonly logger: Logger;

  constructor(options: CopilotOptions) {
    this.analytics = options.analytics;
    this.reasoner = options.reasoner;
    this.logger = options.logger ?? noopLogger;
  }

  async ask(merchantId: string, question: string): Promise<CopilotAnswer> {
    const started = Date.now();
    const intent = classifyIntent(question);
    const toolsUsed: string[] = [];

    const evidence = await this.gatherEvidence(merchantId, intent, toolsUsed);

    let output: CopilotOutput;
    let identity: ReasonerIdentity;
    try {
      const result = await this.reasoner.answer({
        question,
        dataContext: renderDataContext(evidence),
        evidence,
        toolsUsed,
      });
      output = result.output;
      identity = result.identity;
    } catch (error) {
      this.logger.error('copilot reasoner failed; returning the computed answer verbatim', error);
      output = {
        answer: evidence.headline,
        citations: evidence.figures.map((f) => ({ label: f.label, value: f.value })),
        followUps: [],
      };
      identity = {
        id: 'analytics-only',
        kind: 'deterministic',
        model: 'analytics-only',
        degraded: true,
        degradedReason: 'reasoning layer unavailable; computed answer returned directly',
      };
    }

    return {
      id: newId('cpq'),
      question,
      intent,
      answer: output.answer,
      // The citations are always the computed figures, never the reasoner's echo of them.
      citations: evidence.figures.map((f) => ({ label: f.label, value: f.value })),
      followUps: output.followUps,
      toolsUsed,
      reasoner: identity,
      latencyMs: Date.now() - started,
    };
  }

  /** Run the real queries this intent needs and assemble a complete, correct answer. */
  private async gatherEvidence(
    merchantId: string,
    intent: CopilotIntent,
    toolsUsed: string[],
  ): Promise<CopilotEvidence> {
    const overview = await this.analytics.controlTower(merchantId);
    toolsUsed.push('query_recovery_metrics(overview)');

    switch (intent) {
      case 'revenue_drop': {
        const comparison = await this.analytics.periodComparison(merchantId, 7);
        toolsUsed.push('query_recovery_metrics(period_comparison)');
        const direction = comparison.deltas.leakedMinor >= 0 ? 'rose' : 'fell';
        const topDriver = comparison.topRegressions[0];

        return {
          intent,
          headline: `Failed-payment leakage ${direction} by ${formatMinor(Math.abs(comparison.deltas.leakedMinor), { whole: true })} (${(Math.abs(comparison.deltas.leakedPct) * 100).toFixed(1)}%) in the last 7 days versus the 7 days before, from ${formatMinor(comparison.previous.leakedMinor, { whole: true })} to ${formatMinor(comparison.current.leakedMinor, { whole: true })} across ${comparison.current.failures} failed payments.${
            topDriver
              ? ` The largest single contributor is ${topDriver.label}, up ${formatMinor(topDriver.deltaMinor, { whole: true })} to ${formatMinor(topDriver.currentMinor, { whole: true })}.`
              : ''
          }`,
          figures: [
            { label: 'Leakage this period', value: formatMinor(comparison.current.leakedMinor, { whole: true }) },
            { label: 'Leakage previous period', value: formatMinor(comparison.previous.leakedMinor, { whole: true }) },
            { label: 'Change', value: `${comparison.deltas.leakedMinor >= 0 ? '+' : ''}${formatMinor(comparison.deltas.leakedMinor, { whole: true })}` },
            { label: 'Failed payments this period', value: String(comparison.current.failures) },
            { label: 'Recovered this period', value: formatMinor(comparison.current.recoveredMinor, { whole: true }) },
          ],
          breakdown: comparison.topRegressions.map((r) => ({
            label: r.label,
            value: formatMinor(r.currentMinor, { whole: true }),
            share: `+${formatMinor(r.deltaMinor, { whole: true })} vs prior period`,
          })),
          recommendation: topDriver
            ? `Work the ${topDriver.label.toLowerCase()} cohort first — it accounts for the largest increase, and the failure taxonomy gives it a defined optimal retry window.`
            : 'No single failure class regressed materially; the change is spread across the portfolio.',
        };
      }

      case 'biggest_opportunity': {
        const opportunities = await this.analytics.opportunities(merchantId, 10);
        toolsUsed.push('query_recovery_metrics(opportunities)');
        const top = opportunities[0];
        const topTenValue = opportunities.reduce((sum, o) => sum + o.expectedValueMinor, 0);

        return {
          intent,
          headline: top
            ? `The single largest open opportunity is ${formatMinor(top.amountAtRiskMinor, { whole: true })} from ${top.customerName}, at ${(top.recoveryProbability * 100).toFixed(0)}% predicted recovery and ${formatMinor(top.expectedValueMinor)} expected value. The top 10 open cases carry ${formatMinor(topTenValue)} of combined expected value against ${formatMinor(overview.revenueAtRiskMinor, { whole: true })} total revenue at risk.`
            : `There are no open recovery cases right now. Total revenue at risk is ${formatMinor(overview.revenueAtRiskMinor, { whole: true })}.`,
          figures: [
            { label: 'Total revenue at risk', value: formatMinor(overview.revenueAtRiskMinor, { whole: true }) },
            { label: 'Model-weighted recoverable', value: formatMinor(overview.recoverableRevenueMinor, { whole: true }) },
            { label: 'Top 10 expected value', value: formatMinor(topTenValue) },
            { label: 'Open cases', value: String(overview.activeCases) },
          ],
          breakdown: opportunities.slice(0, 5).map((o) => ({
            label: `${o.customerName} — ${(o.failureReason ?? o.sourceType).replace(/_/g, ' ')}`,
            value: formatMinor(o.amountAtRiskMinor, { whole: true }),
            share: `${(o.recoveryProbability * 100).toFixed(0)}% recovery, ${formatMinor(o.expectedValueMinor)} EV`,
          })),
          recommendation: top
            ? `Start with case ${top.caseId}: it has been open ${top.hoursOpen.toFixed(0)} hours and recoverability decays with a roughly 72-hour half-life.`
            : null,
        };
      }

      case 'prioritisation': {
        const opportunities = await this.analytics.opportunities(merchantId, 10);
        toolsUsed.push('query_recovery_metrics(opportunities)');
        const aboveThreshold = opportunities.filter((o) => o.expectedValueMinor > 0);

        return {
          intent,
          headline: `${aboveThreshold.length} of the top ${opportunities.length} open cases have positive expected value and should be worked now, together carrying ${formatMinor(aboveThreshold.reduce((s, o) => s + o.amountAtRiskMinor, 0), { whole: true })} at risk. Cases are ranked by amount at risk multiplied by recovery probability, decayed for how long they have been open.`,
          figures: [
            { label: 'Open cases', value: String(overview.activeCases) },
            { label: 'Worth working now', value: String(aboveThreshold.length) },
            { label: 'Revenue at risk', value: formatMinor(overview.revenueAtRiskMinor, { whole: true }) },
            { label: 'Expected recovery value', value: formatMinor(overview.expectedRecoveryValueMinor, { whole: true }) },
          ],
          breakdown: aboveThreshold.slice(0, 5).map((o, index) => ({
            label: `${index + 1}. ${o.customerName} (${o.segment})`,
            value: formatMinor(o.amountAtRiskMinor, { whole: true }),
            share: `priority ${o.priorityScore.toFixed(0)}, open ${o.hoursOpen.toFixed(0)}h`,
          })),
          recommendation:
            aboveThreshold.length === 0
              ? 'Nothing in the open queue clears the expected-value floor. Stopping on these is the correct call.'
              : 'Work them in the order shown — the ranking already accounts for decay, so the top of the list is where a delay costs the most.',
        };
      }

      case 'recovery_performance': {
        const strategies = await this.analytics.strategyPerformance(merchantId);
        toolsUsed.push('query_recovery_metrics(strategies)');
        return {
          intent,
          headline: `RECLAIM has recovered ${formatMinor(overview.recoveredRevenueMinor, { whole: true })} across ${overview.resolvedCases} resolved cases, a ${(overview.recoveryRate * 100).toFixed(1)}% recovery rate by value. ${overview.interventionsExecuted} interventions were executed, ${overview.interventionsBlocked} were blocked by policy, and ${overview.duplicatesPrevented} duplicate actions were prevented. Average time from detection to recovery is ${formatDuration(overview.averageRecoveryTimeMs)}.`,
          figures: [
            { label: 'Revenue recovered', value: formatMinor(overview.recoveredRevenueMinor, { whole: true }) },
            { label: 'Recovery rate', value: `${(overview.recoveryRate * 100).toFixed(1)}%` },
            { label: 'Resolved cases', value: String(overview.resolvedCases) },
            { label: 'Interventions executed', value: String(overview.interventionsExecuted) },
            { label: 'Blocked by policy', value: String(overview.interventionsBlocked) },
            { label: 'Average recovery time', value: formatDuration(overview.averageRecoveryTimeMs) },
          ],
          breakdown: strategies.slice(0, 5).map((s) => ({
            label: s.strategy.replace(/_/g, ' '),
            value: formatMinor(s.recoveredMinor, { whole: true }),
            share: `${s.succeeded}/${s.attempts} succeeded (${(s.successRate * 100).toFixed(0)}%)`,
          })),
          recommendation: describeCalibration(strategies),
        };
      }

      case 'leakage_breakdown': {
        const leakage = await this.analytics.leakage(merchantId);
        toolsUsed.push('query_recovery_metrics(leakage)');
        const topReason = leakage.byFailureReason[0];
        return {
          intent,
          headline: `Total leakage is ${formatMinor(overview.leakedRevenueMinor, { whole: true })}, a ${(overview.leakageRate * 100).toFixed(1)}% leakage rate against ${formatMinor(overview.grossRevenueMinor, { whole: true })} of captured revenue.${
            topReason
              ? ` The largest single cause is ${topReason.label} at ${formatMinor(topReason.lostAmountMinor, { whole: true })} (${(topReason.share * 100).toFixed(0)}% of all leakage, ${topReason.count} payments).`
              : ''
          }`,
          figures: [
            { label: 'Total leakage', value: formatMinor(overview.leakedRevenueMinor, { whole: true }) },
            { label: 'Leakage rate', value: `${(overview.leakageRate * 100).toFixed(1)}%` },
            { label: 'Captured revenue', value: formatMinor(overview.grossRevenueMinor, { whole: true }) },
            { label: 'Customers affected', value: String(overview.customersAffected) },
          ],
          breakdown: leakage.byFailureReason.slice(0, 6).map((b) => ({
            label: b.label,
            value: formatMinor(b.lostAmountMinor, { whole: true }),
            share: `${(b.share * 100).toFixed(0)}% of leakage, ${(b.recoveryRate * 100).toFixed(0)}% recovered`,
          })),
          recommendation: topReason
            ? `${formatMinor(topReason.openAmountMinor, { whole: true })} of ${topReason.label.toLowerCase()} leakage is still open and actionable today.`
            : null,
        };
      }

      case 'strategy_effectiveness': {
        const strategies = await this.analytics.strategyPerformance(merchantId);
        toolsUsed.push('query_recovery_metrics(strategies)');
        const best = strategies[0];
        return {
          intent,
          headline: best
            ? `${best.strategy.replace(/_/g, ' ')} has recovered the most: ${formatMinor(best.recoveredMinor, { whole: true })} from ${best.succeeded} successes across ${best.attempts} attempts, a ${(best.successRate * 100).toFixed(0)}% success rate against a mean prediction of ${(best.averagePredicted * 100).toFixed(0)}%.`
            : 'No interventions have been executed yet, so there is no strategy performance to report.',
          figures: strategies.slice(0, 6).map((s) => ({
            label: s.strategy.replace(/_/g, ' '),
            value: `${formatMinor(s.recoveredMinor, { whole: true })} recovered`,
          })),
          breakdown: strategies.map((s) => ({
            label: s.strategy.replace(/_/g, ' '),
            value: `${(s.successRate * 100).toFixed(0)}% success`,
            share: `predicted ${(s.averagePredicted * 100).toFixed(0)}%, gap ${(s.calibrationGap * 100).toFixed(1)}pp`,
          })),
          recommendation: describeCalibration(strategies),
        };
      }

      case 'revenue_at_risk':
      case 'overview':
      default:
        return {
          intent,
          headline: `${formatMinor(overview.revenueAtRiskMinor, { whole: true })} is currently at risk across ${overview.activeCases} open cases affecting ${overview.customersAffected} customers. The model expects ${formatMinor(overview.recoverableRevenueMinor, { whole: true })} of that to be recoverable, with ${formatMinor(overview.expectedRecoveryValueMinor, { whole: true })} of net expected value after intervention costs. ${formatMinor(overview.recoveredRevenueMinor, { whole: true })} has already been recovered at a ${(overview.recoveryRate * 100).toFixed(1)}% recovery rate.`,
          figures: [
            { label: 'Revenue at risk', value: formatMinor(overview.revenueAtRiskMinor, { whole: true }) },
            { label: 'Model-weighted recoverable', value: formatMinor(overview.recoverableRevenueMinor, { whole: true }) },
            { label: 'Net expected value', value: formatMinor(overview.expectedRecoveryValueMinor, { whole: true }) },
            { label: 'Already recovered', value: formatMinor(overview.recoveredRevenueMinor, { whole: true }) },
            { label: 'Recovery rate', value: `${(overview.recoveryRate * 100).toFixed(1)}%` },
            { label: 'Open cases', value: String(overview.activeCases) },
          ],
          breakdown: [],
          recommendation:
            overview.activeCases > 0
              ? `Run a batch pass to work the open queue; ${formatMinor(overview.expectedRecoveryValueMinor, { whole: true })} of expected value is sitting unworked.`
              : null,
        };
    }
  }
}

/** Compare observed success against mean prediction — an honest read of model health. */
function describeCalibration(strategies: readonly StrategyPerformance[]): string | null {
  const measured = strategies.filter((s) => s.attempts >= 5);
  if (measured.length === 0) return null;

  const worst = measured.reduce((a, b) =>
    Math.abs(b.calibrationGap) > Math.abs(a.calibrationGap) ? b : a,
  );
  if (Math.abs(worst.calibrationGap) < 0.08) {
    return 'Predicted and observed success rates agree within 8 percentage points across every strategy, so the expected-value rankings can be trusted as they stand.';
  }
  return `${worst.strategy.replace(/_/g, ' ')} is ${worst.calibrationGap > 0 ? 'outperforming' : 'underperforming'} its prediction by ${Math.abs(worst.calibrationGap * 100).toFixed(0)} percentage points, which is worth retraining the model on.`;
}

function renderDataContext(evidence: CopilotEvidence): string {
  const lines = ['FIGURES (verbatim, do not recompute):'];
  for (const figure of evidence.figures) {
    lines.push(`- ${figure.label}: ${figure.value}${figure.hint ? ` (${figure.hint})` : ''}`);
  }
  if (evidence.breakdown.length > 0) {
    lines.push('', 'BREAKDOWN:');
    for (const row of evidence.breakdown) {
      lines.push(`- ${row.label}: ${row.value}${row.share ? ` — ${row.share}` : ''}`);
    }
  }
  if (evidence.recommendation) {
    lines.push('', `SUGGESTED NEXT STEP: ${evidence.recommendation}`);
  }
  return lines.join('\n');
}
