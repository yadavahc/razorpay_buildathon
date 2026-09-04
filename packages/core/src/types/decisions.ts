import { z } from 'zod';
import {
  actionStatusSchema,
  failureReasonSchema,
  outcomeKindSchema,
  policyVerdictSchema,
  recoveryStrategySchema,
} from './enums.js';
import { isoTimestamp, minorAmount, probability } from './entities.js';

/**
 * A named, quantified input to a decision. Signals are what the Decision Inspector
 * renders: every number the AI layer reasoned over is captured here so a reviewer can
 * reconstruct the decision without seeing hidden model internals.
 */
export const decisionSignalSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  /** Signed contribution to the recovery probability, in logit units. */
  contribution: z.number().nullable().default(null),
  direction: z.enum(['positive', 'negative', 'neutral']).default('neutral'),
});
export type DecisionSignal = z.infer<typeof decisionSignalSchema>;

export const failureDiagnosisSchema = z.object({
  failureReason: failureReasonSchema.nullable(),
  category: z.enum([
    'funding',
    'instrument',
    'authentication',
    'infrastructure',
    'risk',
    'mandate',
    'customer_intent',
  ]),
  /** Whether the underlying condition typically clears without customer action. */
  selfResolving: z.boolean(),
  recoverabilityPrior: probability,
  headline: z.string(),
  explanation: z.string(),
  recommendedWindowHours: z.number().nonnegative(),
  customerActionRequired: z.boolean(),
});
export type FailureDiagnosis = z.infer<typeof failureDiagnosisSchema>;

/** One evaluated option in the strategy comparison table. */
export const strategyCandidateSchema = z.object({
  strategy: recoveryStrategySchema,
  successProbability: probability,
  /** Gross amount expected back if the intervention lands. */
  grossRecoveryMinor: minorAmount,
  interventionCostMinor: z.number().int().nonnegative(),
  /** Modelled cost of annoying a customer (goodwill/churn), in minor units. */
  goodwillCostMinor: z.number().int().nonnegative(),
  expectedValueMinor: z.number().int(),
  delayHours: z.number().nonnegative(),
  rationale: z.string(),
  eligible: z.boolean(),
  ineligibleReason: z.string().nullable().default(null),
});
export type StrategyCandidate = z.infer<typeof strategyCandidateSchema>;

export const aiDecisionSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  caseId: z.string().min(1),
  /** Which reasoner produced the language: a hosted LLM or the deterministic engine. */
  reasoner: z.object({
    id: z.string(),
    kind: z.enum(['llm', 'deterministic']),
    model: z.string(),
    degraded: z.boolean(),
    degradedReason: z.string().nullable().default(null),
  }),
  detectedProblem: z.string(),
  signals: z.array(decisionSignalSchema),
  diagnosis: failureDiagnosisSchema,
  recoveryProbability: probability,
  modelVersion: z.string(),
  candidates: z.array(strategyCandidateSchema),
  recommendedStrategy: recoveryStrategySchema,
  expectedValueMinor: z.number().int(),
  confidence: probability,
  /** A short, reviewable justification. Never raw chain-of-thought. */
  explanation: z.string(),
  toolCalls: z.array(
    z.object({
      tool: z.string(),
      ok: z.boolean(),
      durationMs: z.number().int().nonnegative(),
      error: z.string().nullable().default(null),
    }),
  ),
  latencyMs: z.number().int().nonnegative(),
  createdAt: isoTimestamp,
});
export type AIDecision = z.infer<typeof aiDecisionSchema>;

export const policyCheckResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  result: z.enum(['pass', 'fail', 'warn', 'skip']),
  detail: z.string(),
  /** Machine-readable code used by the executor to pick a fallback path. */
  reasonCode: z.string().nullable().default(null),
});
export type PolicyCheckResult = z.infer<typeof policyCheckResultSchema>;

export const policyDecisionSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  caseId: z.string().min(1),
  aiDecisionId: z.string().nullable(),
  requestedStrategy: recoveryStrategySchema,
  amountMinor: minorAmount,
  verdict: policyVerdictSchema,
  checks: z.array(policyCheckResultSchema),
  reasonCodes: z.array(z.string()),
  /** Populated when the engine can suggest a permitted alternative to a denied action. */
  suggestedAlternative: recoveryStrategySchema.nullable(),
  policyVersion: z.string(),
  evaluatedAt: isoTimestamp,
  durationMs: z.number().int().nonnegative(),
});
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const recoveryActionSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  caseId: z.string().min(1),
  customerId: z.string().min(1),
  strategy: recoveryStrategySchema,
  amountMinor: minorAmount,
  status: actionStatusSchema,
  idempotencyKey: z.string().min(1),
  aiDecisionId: z.string().nullable(),
  policyDecisionId: z.string().nullable(),
  /** Provider-side identifier (payment id, link id, message id). */
  providerRef: z.string().nullable(),
  providerMode: z.enum(['demo', 'razorpay_test']),
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
  errorCode: z.string().nullable(),
  /** Set when this action exists because a previous action failed. */
  fallbackOfActionId: z.string().nullable(),
  scheduledFor: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  completedAt: isoTimestamp.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;

export const recoveryOutcomeSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  caseId: z.string().min(1),
  actionId: z.string().nullable(),
  outcome: outcomeKindSchema,
  recoveredAmountMinor: minorAmount,
  amountAtRiskMinor: minorAmount,
  strategy: recoveryStrategySchema,
  predictedProbability: probability,
  /** Wall-clock time from detection to resolution; drives "average recovery time". */
  timeToOutcomeMs: z.number().int().nonnegative(),
  recordedAt: isoTimestamp,
});
export type RecoveryOutcome = z.infer<typeof recoveryOutcomeSchema>;

/**
 * Audit entries are append-only and hash-chained: each record embeds the hash of its
 * predecessor for the same merchant, so tampering with history is detectable by
 * replaying the chain. This is the "immutable-style" trail the track asks for.
 */
export const auditLogSchema = z.object({
  id: z.string().min(1),
  merchantId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  at: isoTimestamp,
  actor: z.object({
    kind: z.enum(['system', 'agent', 'user', 'scheduler', 'simulator']),
    id: z.string(),
  }),
  event: z.string(),
  caseId: z.string().nullable(),
  customerId: z.string().nullable(),
  amountMinor: z.number().int().nullable(),
  trigger: z.string(),
  aiDecisionId: z.string().nullable(),
  policyDecisionId: z.string().nullable(),
  actionId: z.string().nullable(),
  actionStatus: actionStatusSchema.nullable(),
  failure: z.string().nullable(),
  fallback: z.string().nullable(),
  finalOutcome: outcomeKindSchema.nullable(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditLog = z.infer<typeof auditLogSchema>;

/** Idempotency ledger entry; guarantees at-most-once financial side effects. */
export const idempotencyRecordSchema = z.object({
  key: z.string().min(1),
  merchantId: z.string().min(1),
  scope: z.string(),
  actionId: z.string(),
  resultRef: z.string().nullable(),
  status: actionStatusSchema,
  createdAt: isoTimestamp,
});
export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;
