import { clamp, round } from '../util/collections.js';
import type {
  CopilotOutput,
  CopilotRequest,
  DiagnosisOutput,
  DiagnosisRequest,
  Reasoner,
  RecommendationOutput,
  RecommendationRequest,
  ToolPlanOutput,
  ToolPlanRequest,
} from './reasoner.js';
import type { ReasonerIdentity } from './types.js';

/**
 * THE DETERMINISTIC REASONER
 *
 * This is what runs when no model API key is configured, and it is the honest answer to
 * "what does an AI product do when the AI is unavailable?"
 *
 * It is not a stub and it does not fabricate. Every sentence it produces is composed from
 * quantities that were actually measured by the pipeline — the taxonomy's own account of
 * the failure class, the model's probability, the expected values the strategy engine
 * computed, the graph features derived from the customer's real history. What a hosted
 * model would add here is fluency and the ability to notice an unusual combination of
 * facts; what it would not add is a single new number.
 *
 * The application badges every decision with the reasoner that produced it, so a viewer
 * always knows which of the two wrote the text in front of them.
 */

const IDENTITY: ReasonerIdentity = {
  id: 'reclaim-deterministic-reasoner',
  kind: 'deterministic',
  model: 'reclaim-reasoner-v1',
  degraded: false,
  degradedReason: null,
};

export class DeterministicReasoner implements Reasoner {
  readonly identity: ReasonerIdentity;

  constructor(degradedReason: string | null = null) {
    this.identity = degradedReason
      ? { ...IDENTITY, degraded: true, degradedReason }
      : { ...IDENTITY };
  }

  async diagnose(
    request: DiagnosisRequest,
  ): Promise<{ output: DiagnosisOutput; identity: ReasonerIdentity }> {
    const f = request.facts;

    const headline = f.consecutiveFailures >= 3
      ? `${request.taxonomyHeadline}, and it is the ${ordinal(f.consecutiveFailures)} consecutive failure on this account`
      : request.taxonomyHeadline;

    const evidence: string[] = [];
    if (f.successfulPayments > 0) {
      evidence.push(
        `${f.customerName} has ${f.successfulPayments} successful payment${f.successfulPayments === 1 ? '' : 's'} on file worth ${f.lifetimeValue}`,
      );
    } else {
      evidence.push(`${f.customerName} has never completed a payment with this merchant`);
    }
    if (f.isSubscriber && f.subscriptionAgeDays !== null) {
      evidence.push(
        `an active subscription ${Math.round(f.subscriptionAgeDays)} days old is attached to the relationship`,
      );
    }
    if (f.hasAlternateMethod) {
      evidence.push('a different instrument has worked for this customer before');
    }
    if (f.priorRecoveryAttempts > 0) {
      evidence.push(
        `${f.priorRecoverySuccesses} of ${f.priorRecoveryAttempts} previous recovery attempts on this customer succeeded`,
      );
    }

    const explanation = [
      request.taxonomyExplanation,
      `In this specific case ${joinClauses(evidence)}.`,
      `Weighing the failure class against that history, the model puts recovery at ${percent(f.recoveryProbability)}.`,
    ].join(' ');

    const keyFactors: string[] = [
      `${f.failureLabel} on ${f.method.toUpperCase()} via ${f.issuer}`,
      `${f.amountAtRisk} at risk, ${f.hoursSinceFailure.toFixed(1)}h since the event`,
      f.successfulPayments + f.failedPayments > 0
        ? `${f.successfulPayments}/${f.successfulPayments + f.failedPayments} lifetime payment success`
        : 'no payment history to draw on',
    ];
    if (f.hasAlternateMethod) keyFactors.push('working alternate instrument available');
    if (f.consecutiveFailures >= 2) {
      keyFactors.push(`${f.consecutiveFailures} consecutive failures — churn risk, not a blip`);
    }

    // Confidence reflects how much evidence the case actually carries.
    const evidenceDepth =
      Math.min(1, (f.successfulPayments + f.failedPayments) / 8) * 0.5 +
      Math.min(1, f.priorRecoveryAttempts / 3) * 0.2 +
      (f.isSubscriber ? 0.15 : 0) +
      0.15;

    return {
      output: {
        headline: truncate(headline, 160),
        explanation: truncate(explanation, 900),
        keyFactors: keyFactors.slice(0, 5).map((k) => truncate(k, 160)),
        confidence: round(clamp(evidenceDepth, 0.3, 0.9), 3),
      },
      identity: this.identity,
    };
  }

  async recommend(
    request: RecommendationRequest,
  ): Promise<{ output: RecommendationOutput; identity: ReasonerIdentity }> {
    const eligible = request.candidates
      .filter((c) => c.eligible)
      .sort((a, b) => b.expectedValueMinor - a.expectedValueMinor);
    const chosen = eligible.find((c) => c.strategy === request.economicChoice) ?? eligible[0]!;
    const runnerUp = eligible.find((c) => c.strategy !== chosen.strategy) ?? null;
    const ruledOut = request.candidates.filter((c) => !c.eligible);

    const sentences: string[] = [chosen.rationale];

    if (runnerUp) {
      const margin = chosen.expectedValueMinor - runnerUp.expectedValueMinor;
      sentences.push(
        margin > 0
          ? `That beats ${label(runnerUp.strategy)}, the next best option, by ${inr(margin)} in expected value.`
          : `It ties with ${label(runnerUp.strategy)} on expected value, so the cheaper and less intrusive option wins.`,
      );
    }

    if (ruledOut.length > 0) {
      const first = ruledOut[0]!;
      sentences.push(
        `${label(first.strategy)} was ruled out: ${lowerFirst(first.ineligibleReason ?? 'not available for this case')}`,
      );
    }

    const risks: string[] = [];
    if (chosen.strategy === 'immediate_retry' || chosen.strategy === 'delayed_retry') {
      risks.push('A failed retry consumes one of the case retry budget and adds a bank decline record.');
    }
    if (chosen.strategy === 'payment_link' || chosen.strategy === 'customer_notification') {
      risks.push('Each additional contact raises the goodwill cost and can push the case below the value floor.');
    }
    if (chosen.successProbability < 0.3) {
      risks.push(
        `Success probability is only ${percent(chosen.successProbability)}; a single attempt is justified but a second likely is not.`,
      );
    }
    if (chosen.strategy === 'escalate') {
      risks.push('Human review costs analyst time whether or not the money is recovered.');
    }

    // Confidence from the size of the gap to the runner-up: a clear winner is a
    // confident recommendation, a photo finish is not.
    const spread = runnerUp ? chosen.expectedValueMinor - runnerUp.expectedValueMinor : 0;
    const scale = Math.max(Math.abs(chosen.expectedValueMinor), 10_000);
    const confidence = runnerUp ? 0.5 + 0.45 * Math.min(1, spread / scale) : 0.6;

    return {
      output: {
        strategy: chosen.strategy,
        explanation: truncate(sentences.join(' '), 900),
        risks: risks.slice(0, 4),
        confidence: round(clamp(confidence, 0.3, 0.97), 3),
      },
      identity: this.identity,
    };
  }

  /**
   * A rule-based planner over the same tool catalog the LLM planner sees.
   *
   * It walks a fixed investigation order, skips tools that have already succeeded, and
   * stops early when a tool failure makes the remaining steps pointless. Because it emits
   * the identical `ToolPlanOutput` shape, the agent loop, the validation layer and the
   * agent test-suite are exercised in exactly the same way in both modes.
   */
  async planNextTool(
    request: ToolPlanRequest,
  ): Promise<{ output: ToolPlanOutput; identity: ReasonerIdentity }> {
    const completed = new Set(request.observations.filter((o) => o.ok).map((o) => o.tool));
    const attempted = new Set(request.observations.map((o) => o.tool));
    const available = new Set(request.toolCatalog.map((t) => t.name));

    // Order matters: context before history, history before prediction, prediction
    // before economics. Each step's output is an input to the next.
    const order = [
      'get_customer_context',
      'get_payment_history',
      'get_subscription',
      'diagnose_failure',
      'get_recovery_probability',
      'calculate_expected_recovery',
    ];

    if (request.stepsRemaining <= 0) {
      return {
        output: {
          rationale: 'Step budget exhausted; proceeding with the evidence gathered so far.',
          tool: null,
          arguments: {},
          done: true,
        },
        identity: this.identity,
      };
    }

    for (const tool of order) {
      if (!available.has(tool)) continue;
      if (completed.has(tool) || attempted.has(tool)) continue;
      return {
        output: {
          rationale: rationaleForTool(tool),
          tool,
          arguments: {},
          done: false,
        },
        identity: this.identity,
      };
    }

    return {
      output: {
        rationale: 'Customer context, failure diagnosis, probability and economics are all gathered.',
        tool: null,
        arguments: {},
        done: true,
      },
      identity: this.identity,
    };
  }

  async answer(request: CopilotRequest): Promise<{ output: CopilotOutput; identity: ReasonerIdentity }> {
    const { evidence } = request;

    const body: string[] = [evidence.headline];

    if (evidence.breakdown.length > 0) {
      const top = evidence.breakdown.slice(0, 4);
      body.push(
        `The breakdown: ${top
          .map((b) => `${b.label} at ${b.value}${b.share ? ` (${b.share})` : ''}`)
          .join(', ')}.`,
      );
    }

    if (evidence.recommendation) body.push(evidence.recommendation);

    return {
      output: {
        answer: truncate(body.join(' '), 2000),
        citations: evidence.figures.slice(0, 8).map((f) => ({ label: f.label, value: f.value })),
        followUps: followUpsFor(evidence.intent),
      },
      identity: this.identity,
    };
  }
}

function rationaleForTool(tool: string): string {
  const map: Record<string, string> = {
    get_customer_context:
      'Start with who this customer is: lifetime value, segment, and eligibility flags.',
    get_payment_history:
      'Pull the payment history to see whether this failure is an anomaly or a pattern.',
    get_subscription:
      'Check the subscription and mandate, which determine whether a retry is even permitted.',
    diagnose_failure: 'Classify the failure to establish its recoverability profile.',
    get_recovery_probability: 'Score the case with the trained recovery-probability model.',
    calculate_expected_recovery: 'Price every strategy in the bounded action space.',
  };
  return map[tool] ?? `Gather evidence via ${tool}.`;
}

function followUpsFor(intent: string): string[] {
  const map: Record<string, string[]> = {
    revenue_at_risk: [
      'Which failure reason is costing the most this week?',
      'What is our biggest single recovery opportunity right now?',
    ],
    biggest_opportunity: [
      'How much of that is above the auto-execute ceiling?',
      'What is the recovery rate on cases like these?',
    ],
    revenue_drop: [
      'Which bank or issuer regressed the most?',
      'How many cases are currently blocked by policy?',
    ],
    prioritisation: [
      'How much revenue have we recovered in the last 7 days?',
      'Which strategy is producing the best return?',
    ],
    recovery_performance: [
      'Where are we losing the most to policy blocks?',
      'What is the average time to recovery?',
    ],
  };
  return map[intent] ?? ['How much revenue is currently at risk?', 'What should we prioritise today?'];
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function inr(minor: number): string {
  return (minor / 100).toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  });
}

function label(strategy: string): string {
  return strategy.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function joinClauses(parts: string[]): string {
  if (parts.length === 0) return 'no additional history is available';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function createDeterministicReasoner(degradedReason: string | null = null): Reasoner {
  return new DeterministicReasoner(degradedReason);
}
