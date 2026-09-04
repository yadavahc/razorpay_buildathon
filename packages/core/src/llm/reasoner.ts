import { z } from 'zod';
import type { StrategyCandidate } from '../types/decisions.js';
import type { RecoveryStrategy } from '../types/enums.js';
import type { ReasonerIdentity } from './types.js';

/**
 * The four reasoning tasks RECLAIM delegates to a language model.
 *
 * Note what is *not* here: no task returns an amount, a probability, a retry count, a
 * policy verdict or a strategy the engine has not already priced. The model chooses
 * between options that have already been costed and explains the choice. Every number it
 * is allowed to mention is a number that was handed to it.
 */

export const diagnosisOutputSchema = z.object({
  headline: z.string().min(10).max(160),
  explanation: z.string().min(40).max(900),
  keyFactors: z.array(z.string().min(3).max(160)).min(1).max(5),
  /** The model's own confidence in the reading, not the recovery probability. */
  confidence: z.number().min(0).max(1),
});
export type DiagnosisOutput = z.infer<typeof diagnosisOutputSchema>;

export const recommendationOutputSchema = z.object({
  /** Must be one of the strategies supplied in the request; validated after parsing. */
  strategy: z.string(),
  explanation: z.string().min(40).max(900),
  risks: z.array(z.string().min(3).max(200)).max(4).default([]),
  confidence: z.number().min(0).max(1),
});
export type RecommendationOutput = z.infer<typeof recommendationOutputSchema>;

export const toolPlanOutputSchema = z.object({
  /** A one-line justification for the next step. Not a transcript of internal reasoning. */
  rationale: z.string().min(3).max(240),
  tool: z.string().nullable(),
  arguments: z.record(z.string(), z.unknown()).default({}),
  done: z.boolean().default(false),
});
export type ToolPlanOutput = z.infer<typeof toolPlanOutputSchema>;

export const copilotOutputSchema = z.object({
  answer: z.string().min(10).max(2000),
  /** Figures the answer relies on, echoed back so the merchant can verify each one. */
  citations: z
    .array(z.object({ label: z.string().max(120), value: z.string().max(120) }))
    .max(8)
    .default([]),
  followUps: z.array(z.string().max(140)).max(3).default([]),
});
export type CopilotOutput = z.infer<typeof copilotOutputSchema>;

export interface DiagnosisRequest {
  /** Deterministic facts. The reasoner may interpret these; it may not invent others. */
  facts: {
    amountAtRisk: string;
    failureLabel: string;
    failureCategory: string;
    sourceType: string;
    method: string;
    issuer: string;
    customerName: string;
    customerSegment: string;
    successfulPayments: number;
    failedPayments: number;
    lifetimeValue: string;
    isSubscriber: boolean;
    subscriptionAgeDays: number | null;
    priorRecoveryAttempts: number;
    priorRecoverySuccesses: number;
    hoursSinceFailure: number;
    hasAlternateMethod: boolean;
    consecutiveFailures: number;
    recoveryProbability: number;
  };
  /** The taxonomy's own explanation, offered as grounding rather than as an answer. */
  taxonomyHeadline: string;
  taxonomyExplanation: string;
  graphNarrative: string;
}

export interface RecommendationRequest {
  facts: DiagnosisRequest['facts'];
  diagnosis: DiagnosisOutput;
  candidates: StrategyCandidate[];
  /** The expected-value winner. The reasoner must justify or challenge this, not replace it. */
  economicChoice: RecoveryStrategy;
  formattedCandidates: string;
}

export interface ToolPlanRequest {
  goal: string;
  toolCatalog: Array<{ name: string; description: string; parameters: string }>;
  observations: Array<{ tool: string; ok: boolean; summary: string }>;
  stepsRemaining: number;
}

/**
 * The copilot's evidence packet.
 *
 * The agent runs real queries first and computes every figure itself; the reasoner only
 * turns that packet into prose. This is the mechanism that makes "answers come from
 * application data, not hallucination" structural rather than aspirational — there is no
 * path by which a number reaches the user that did not come out of a tool call.
 */
export interface CopilotEvidence {
  /** Intent classified deterministically by the agent from the question text. */
  intent: string;
  /** A complete, already-correct answer sentence assembled from the figures below. */
  headline: string;
  figures: Array<{ label: string; value: string; hint?: string }>;
  breakdown: Array<{ label: string; value: string; share?: string }>;
  recommendation: string | null;
}

export interface CopilotRequest {
  question: string;
  /** Serialised evidence packet, rendered for a language model. */
  dataContext: string;
  evidence: CopilotEvidence;
  toolsUsed: string[];
}

/**
 * The task-oriented reasoning interface consumed by the agents. Implementations must be
 * total: every method returns a usable result even when the underlying provider is down.
 */
export interface Reasoner {
  readonly identity: ReasonerIdentity;
  diagnose(request: DiagnosisRequest): Promise<{ output: DiagnosisOutput; identity: ReasonerIdentity }>;
  recommend(
    request: RecommendationRequest,
  ): Promise<{ output: RecommendationOutput; identity: ReasonerIdentity }>;
  planNextTool(request: ToolPlanRequest): Promise<{ output: ToolPlanOutput; identity: ReasonerIdentity }>;
  answer(request: CopilotRequest): Promise<{ output: CopilotOutput; identity: ReasonerIdentity }>;
}

/** Human-readable schema hints appended to prompts so the model returns parseable JSON. */
export const SCHEMA_DESCRIPTIONS = {
  diagnosis: `{
  "headline": string (10-160 chars, one sentence naming the cause),
  "explanation": string (40-900 chars, 2-4 sentences a merchant can act on),
  "keyFactors": string[] (1-5 short evidence statements, each citing a supplied figure),
  "confidence": number (0-1, your confidence in this reading)
}`,
  recommendation: `{
  "strategy": string (EXACTLY one of the strategy ids listed in the candidate table),
  "explanation": string (40-900 chars, why this option beats the others),
  "risks": string[] (0-4 short statements of what could go wrong),
  "confidence": number (0-1)
}`,
  toolPlan: `{
  "rationale": string (max 240 chars, one line on why this step),
  "tool": string | null (a tool name from the catalog, or null when finished),
  "arguments": object (arguments for that tool, matching its parameter list),
  "done": boolean (true when you have enough information)
}`,
  copilot: `{
  "answer": string (10-2000 chars, direct answer using ONLY the supplied figures),
  "citations": [{"label": string, "value": string}] (each figure you relied on),
  "followUps": string[] (0-3 suggested next questions)
}`,
} as const;
