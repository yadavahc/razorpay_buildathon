import type { z } from 'zod';
import { errorMessage } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import { noopLogger } from '../logging/index.js';
import { CircuitBreaker, withRetry } from '../resilience/index.js';
import { RECOVERY_STRATEGIES } from '../types/enums.js';
import { DeterministicReasoner } from './deterministic-reasoner.js';
import {
  type CopilotOutput,
  type CopilotRequest,
  type DiagnosisOutput,
  type DiagnosisRequest,
  type Reasoner,
  type RecommendationOutput,
  type RecommendationRequest,
  SCHEMA_DESCRIPTIONS,
  type ToolPlanOutput,
  type ToolPlanRequest,
  copilotOutputSchema,
  diagnosisOutputSchema,
  recommendationOutputSchema,
  toolPlanOutputSchema,
} from './reasoner.js';
import { LlmValidationError, type LlmProvider, type ReasonerIdentity, extractJson } from './types.js';

/**
 * The hosted-model reasoner.
 *
 * Everything that comes back from the model is treated as untrusted input:
 *
 *   - the response is parsed as JSON and validated against a zod schema;
 *   - a strategy name is checked against the bounded action space, and a hallucinated
 *     one is discarded in favour of the expected-value winner;
 *   - a malformed response is retried once with the parse error fed back;
 *   - any remaining failure, timeout, or open circuit falls through to the deterministic
 *     reasoner, and the resulting decision is stamped `degraded` so the UI can say so.
 *
 * The model is therefore never load-bearing for correctness. It improves the prose and
 * can flag a consideration the rules did not encode; it cannot break the pipeline and it
 * cannot move money.
 */

const BASE_SYSTEM = `You are the reasoning layer of RECLAIM, an autonomous revenue-recovery engine for an Indian payments merchant.

Hard rules, in order of priority:
1. Use ONLY the figures supplied to you. Never invent, estimate, extrapolate or round a number that was not given. If a figure is absent, say it is not available.
2. You do not authorise, execute or approve anything. A deterministic policy engine decides what is permitted; your output is a recommendation that engine will screen.
3. Reply with a single JSON object matching the schema. No prose outside the JSON, no markdown fences, no commentary.
4. Write for a payments operations lead: concrete, specific, no filler, no hedging adjectives. Reference the actual amounts, probabilities and counts you were given.
5. Do not include step-by-step internal reasoning. State the conclusion and the evidence for it.`;

export interface LlmReasonerOptions {
  provider: LlmProvider;
  logger?: Logger;
  breaker?: CircuitBreaker;
  /** Fallback used whenever the hosted path cannot produce a valid response. */
  fallback?: Reasoner;
}

export class LlmReasoner implements Reasoner {
  readonly identity: ReasonerIdentity;

  private readonly provider: LlmProvider;
  private readonly logger: Logger;
  private readonly breaker: CircuitBreaker;
  private readonly fallback: Reasoner;

  constructor(options: LlmReasonerOptions) {
    this.provider = options.provider;
    this.logger = options.logger ?? noopLogger;
    this.breaker =
      options.breaker ??
      new CircuitBreaker({
        name: `llm:${options.provider.name}`,
        failureThreshold: 3,
        resetTimeoutMs: 30_000,
        successThreshold: 1,
        logger: options.logger,
      });
    this.fallback = options.fallback ?? new DeterministicReasoner();
    this.identity = {
      id: `${options.provider.name}:${options.provider.model}`,
      kind: 'llm',
      model: options.provider.model,
      degraded: false,
      degradedReason: null,
    };
  }

  /**
   * Single entry point for every structured call: prompt, parse, validate, repair once,
   * and degrade rather than throw. Nothing in the pipeline handles an LLM exception,
   * because this method never lets one escape.
   */
  private async structured<T>(input: {
    task: string;
    prompt: string;
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    schemaDescription: string;
    temperature?: number;
    fallback: () => Promise<{ output: T; identity: ReasonerIdentity }>;
  }): Promise<{ output: T; identity: ReasonerIdentity }> {
    const system = `${BASE_SYSTEM}\n\nRespond with JSON matching exactly this shape:\n${input.schemaDescription}`;

    try {
      const result = await this.breaker.execute(async () => {
        const { value } = await withRetry(
          async (attempt) => {
            const messages =
              attempt === 1
                ? [{ role: 'user' as const, content: input.prompt }]
                : [
                    { role: 'user' as const, content: input.prompt },
                    {
                      role: 'user' as const,
                      content:
                        'Your previous reply did not parse against the schema. Reply again with a single valid JSON object and nothing else.',
                    },
                  ];

            const completion = await this.provider.complete({
              task: input.task,
              system,
              messages,
              temperature: input.temperature ?? 0.2,
            });

            let parsed: unknown;
            try {
              parsed = JSON.parse(extractJson(completion.text));
            } catch {
              throw new LlmValidationError(
                `${input.task}: response was not valid JSON`,
                completion.text,
              );
            }

            const validated = input.schema.safeParse(parsed);
            if (!validated.success) {
              throw new LlmValidationError(
                `${input.task}: ${validated.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
                completion.text,
              );
            }
            return validated.data;
          },
          {
            label: `llm:${input.task}`,
            logger: this.logger,
            policy: {
              maxAttempts: 2,
              baseDelayMs: 150,
              isRetryable: (error) => error.retryable || error.code === 'INTERNAL',
            },
          },
        );
        return value;
      });

      return { output: result, identity: { ...this.identity, degraded: false, degradedReason: null } };
    } catch (error) {
      const reason = errorMessage(error);
      this.logger.warn('reasoner degraded to deterministic engine', { task: input.task, reason });
      const degraded = await input.fallback();
      return {
        output: degraded.output,
        identity: {
          ...degraded.identity,
          degraded: true,
          degradedReason: `${this.provider.name} unavailable: ${reason}`,
        },
      };
    }
  }

  async diagnose(
    request: DiagnosisRequest,
  ): Promise<{ output: DiagnosisOutput; identity: ReasonerIdentity }> {
    return this.structured({
      task: 'diagnose_failure',
      schema: diagnosisOutputSchema,
      schemaDescription: SCHEMA_DESCRIPTIONS.diagnosis,
      prompt: buildDiagnosisPrompt(request),
      fallback: () => this.fallback.diagnose(request),
    });
  }

  async recommend(
    request: RecommendationRequest,
  ): Promise<{ output: RecommendationOutput; identity: ReasonerIdentity }> {
    const result = await this.structured({
      task: 'recommend_strategy',
      schema: recommendationOutputSchema,
      schemaDescription: SCHEMA_DESCRIPTIONS.recommendation,
      prompt: buildRecommendationPrompt(request),
      fallback: () => this.fallback.recommend(request),
    });

    // Guard the action space. A model that names a strategy outside the bounded set, or
    // one the strategy engine ruled structurally ineligible, is overridden and the
    // override is recorded rather than hidden.
    const eligible = new Set(request.candidates.filter((c) => c.eligible).map((c) => c.strategy));
    const proposed = result.output.strategy as (typeof RECOVERY_STRATEGIES)[number];
    if (!RECOVERY_STRATEGIES.includes(proposed) || !eligible.has(proposed)) {
      this.logger.warn('reasoner proposed an unusable strategy; overriding', {
        proposed: result.output.strategy,
        replacedWith: request.economicChoice,
      });
      return {
        output: {
          ...result.output,
          strategy: request.economicChoice,
          explanation: `${result.output.explanation} (The reasoner proposed "${result.output.strategy}", which is not an available action for this case, so the expected-value winner was used instead.)`,
          confidence: Math.min(result.output.confidence, 0.5),
        },
        identity: { ...result.identity, degraded: true, degradedReason: 'invalid strategy proposed' },
      };
    }

    return result;
  }

  async planNextTool(
    request: ToolPlanRequest,
  ): Promise<{ output: ToolPlanOutput; identity: ReasonerIdentity }> {
    const result = await this.structured({
      task: 'plan_next_tool',
      schema: toolPlanOutputSchema,
      schemaDescription: SCHEMA_DESCRIPTIONS.toolPlan,
      temperature: 0,
      prompt: buildPlannerPrompt(request),
      fallback: () => this.fallback.planNextTool(request),
    });

    // A tool name outside the catalog ends the loop cleanly instead of erroring; the
    // agent then proceeds with whatever evidence it has already gathered.
    const catalog = new Set(request.toolCatalog.map((t) => t.name));
    if (result.output.tool !== null && !catalog.has(result.output.tool)) {
      this.logger.warn('reasoner selected an unknown tool', { tool: result.output.tool });
      return {
        output: {
          rationale: `Requested unavailable tool "${result.output.tool}"; continuing with the evidence already gathered.`,
          tool: null,
          arguments: {},
          done: true,
        },
        identity: { ...result.identity, degraded: true, degradedReason: 'unknown tool selected' },
      };
    }
    return result;
  }

  async answer(request: CopilotRequest): Promise<{ output: CopilotOutput; identity: ReasonerIdentity }> {
    return this.structured({
      task: 'copilot_answer',
      schema: copilotOutputSchema,
      schemaDescription: SCHEMA_DESCRIPTIONS.copilot,
      temperature: 0.1,
      prompt: buildCopilotPrompt(request),
      fallback: () => this.fallback.answer(request),
    });
  }
}

function buildDiagnosisPrompt(request: DiagnosisRequest): string {
  const f = request.facts;
  return `Diagnose this revenue-loss event for the merchant's operations team.

MEASURED FACTS (the only numbers you may use):
- Amount at risk: ${f.amountAtRisk}
- Loss channel: ${f.sourceType}
- Failure class: ${f.failureLabel} (category: ${f.failureCategory})
- Instrument: ${f.method} via ${f.issuer}
- Time since the event: ${f.hoursSinceFailure.toFixed(1)} hours
- Customer: ${f.customerName}, segment ${f.customerSegment}
- Payment history: ${f.successfulPayments} successful, ${f.failedPayments} failed, lifetime value ${f.lifetimeValue}
- Consecutive failures right now: ${f.consecutiveFailures}
- Subscriber: ${f.isSubscriber ? `yes, ${f.subscriptionAgeDays ?? 0} days old` : 'no'}
- Alternate working instrument on file: ${f.hasAlternateMethod ? 'yes' : 'no'}
- Prior recovery attempts on this customer: ${f.priorRecoveryAttempts} (${f.priorRecoverySuccesses} recovered)
- Model recovery probability: ${(f.recoveryProbability * 100).toFixed(1)}%

REFERENCE — how this failure class generally behaves:
${request.taxonomyHeadline}
${request.taxonomyExplanation}

REFERENCE — what the customer relationship graph shows:
${request.graphNarrative}

Explain what went wrong and what it means for recoverability. Be specific to this customer, not generic about the failure class.`;
}

function buildRecommendationPrompt(request: RecommendationRequest): string {
  return `Choose the recovery action for this case.

DIAGNOSIS:
${request.diagnosis.headline}
${request.diagnosis.explanation}

CONTEXT:
- Amount at risk: ${request.facts.amountAtRisk}
- Recovery probability: ${(request.facts.recoveryProbability * 100).toFixed(1)}%
- Customer: ${request.facts.customerName} (${request.facts.customerSegment}), ${request.facts.successfulPayments} successful payments

STRATEGY OPTIONS, ALREADY PRICED BY THE EXPECTED-VALUE ENGINE:
${request.formattedCandidates}

The expected-value winner among available options is: ${request.economicChoice}

Pick the strategy with the strongest case. You may only pick a strategy marked AVAILABLE.
Choosing something other than the expected-value winner requires a concrete reason grounded in the facts above; absent such a reason, pick the winner.
Explain why it beats the alternatives, referring to the actual expected values shown.`;
}

function buildPlannerPrompt(request: ToolPlanRequest): string {
  const catalog = request.toolCatalog
    .map((t) => `- ${t.name}: ${t.description}\n  parameters: ${t.parameters}`)
    .join('\n');
  const observations =
    request.observations.length === 0
      ? '(none yet — this is the first step)'
      : request.observations
          .map((o) => `- ${o.tool}: ${o.ok ? 'OK' : 'FAILED'} — ${o.summary}`)
          .join('\n');

  return `Goal: ${request.goal}

AVAILABLE TOOLS:
${catalog}

OBSERVATIONS SO FAR:
${observations}

Steps remaining in the budget: ${request.stepsRemaining}

Choose the single most useful next tool call, or set done=true if you have enough to proceed.
Never call a tool that already succeeded. If a tool failed and its information is not essential, move on rather than retrying it.`;
}

function buildCopilotPrompt(request: CopilotRequest): string {
  return `The merchant asked: "${request.question}"

The following figures were computed from live application data by these tools: ${request.toolsUsed.join(', ') || 'none'}.
These are the ONLY numbers you may state. Do not compute new ones, do not round them differently, do not add any figure that is not listed.

${request.dataContext}

A correct answer has already been assembled for you:
"${request.evidence.headline}"

Rewrite that into a direct, well-structured answer to the merchant's actual question. Preserve every figure exactly as given. Add interpretation and a recommended next step where the data supports one.`;
}
