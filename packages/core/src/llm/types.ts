import type { z } from 'zod';

/**
 * The reasoning layer's contract.
 *
 * RECLAIM never lets a language model touch money. What it *is* good at — reading a
 * messy situation, weighing competing considerations, and explaining a judgement in a
 * sentence a human can check — is exactly what this interface exposes, and nothing more.
 *
 * Two implementations satisfy it:
 *
 *   - `LlmReasoner` calls a hosted model (OpenAI or Anthropic) and validates every
 *     response against a schema before it is allowed anywhere near the pipeline.
 *   - `DeterministicReasoner` runs offline, deriving its language from the same measured
 *     quantities the model would have been shown.
 *
 * The active implementation is surfaced in the API and badged in the UI. A deployment
 * with no API key is not silently degraded — it says so on every decision it produces.
 */

export type ReasonerKind = 'llm' | 'deterministic';

export interface ReasonerIdentity {
  id: string;
  kind: ReasonerKind;
  model: string;
  /** True when this response came from a fallback path rather than the intended one. */
  degraded: boolean;
  degradedReason: string | null;
}

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  /** Short identifier for the task; used for logging, metrics and prompt selection. */
  task: string;
  system: string;
  messages: CompletionMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResponse {
  text: string;
  model: string;
  latencyMs: number;
  /** Token usage where the provider reports it. */
  usage: { inputTokens: number; outputTokens: number } | null;
}

/**
 * A raw provider. Deliberately minimal: one method, plain strings in and out. Structured
 * output, schema validation and retries are handled one layer up so that logic is shared
 * across providers instead of reimplemented per SDK.
 */
export interface LlmProvider {
  readonly name: 'openai' | 'anthropic' | 'gemini';
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

export interface StructuredRequest<T> {
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Rendered into the prompt so the model knows the exact shape expected. */
  schemaDescription: string;
  temperature?: number;
  maxTokens?: number;
}

export class LlmValidationError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'LlmValidationError';
  }
}

/** Extract a JSON object from a model response that may be wrapped in prose or fences. */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  if (candidate.startsWith('{') || candidate.startsWith('[')) return candidate;

  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1);
  }
  return candidate;
}
