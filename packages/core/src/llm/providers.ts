import type { LlmConfig } from '../config/index.js';
import { errors } from '../errors/index.js';
import { withTimeout } from '../resilience/index.js';
import { faultInjector } from '../services/fault-injector.js';
import type { CompletionRequest, CompletionResponse, LlmProvider } from './types.js';

/**
 * Extra output tokens allowed on top of the caller's request, to cover Gemini's internal
 * reasoning. Measured, not guessed: a trivial prompt spent 16 tokens thinking before
 * emitting a single word.
 */
const GEMINI_THINKING_HEADROOM = 2_000;

/**
 * Hosted model providers, spoken to over plain `fetch` against their documented HTTP
 * APIs. No vendor SDK: the surface we need is one POST, and avoiding the SDKs keeps the
 * core package dependency-free and importable from Cloud Functions, the Next.js server
 * and test processes without any bundler configuration.
 */

interface OpenAiResponseBody {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai' as const;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    faultInjector.maybeFail('ai_unavailable', 'llm', request.task);
    faultInjector.maybeFail('external_api_failure', 'llm', request.task);

    const started = Date.now();
    const response = await withTimeout(
      () =>
        fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            temperature: request.temperature ?? 0.2,
            max_tokens: request.maxTokens ?? 900,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: request.system },
              ...request.messages.map((m) => ({ role: m.role, content: m.content })),
            ],
          }),
        }),
      this.timeoutMs,
      'openai',
    );

    const body = (await response.json().catch(() => ({}))) as OpenAiResponseBody;
    if (!response.ok) {
      throw errors.providerError('openai', body.error?.message ?? `HTTP ${response.status}`, {
        status: response.status,
      });
    }

    const text = body.choices?.[0]?.message?.content ?? '';
    if (!text) throw errors.aiUnavailable('openai returned an empty completion');

    return {
      text,
      model: this.model,
      latencyMs: Date.now() - started,
      usage: body.usage
        ? {
            inputTokens: body.usage.prompt_tokens ?? 0,
            outputTokens: body.usage.completion_tokens ?? 0,
          }
        : null,
    };
  }
}

interface AnthropicResponseBody {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    faultInjector.maybeFail('ai_unavailable', 'llm', request.task);
    faultInjector.maybeFail('external_api_failure', 'llm', request.task);

    const started = Date.now();
    const response = await withTimeout(
      () =>
        fetch(`${this.baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: request.maxTokens ?? 900,
            temperature: request.temperature ?? 0.2,
            system: request.system,
            messages: request.messages
              .filter((m) => m.role !== 'system')
              .map((m) => ({ role: m.role, content: m.content })),
          }),
        }),
      this.timeoutMs,
      'anthropic',
    );

    const body = (await response.json().catch(() => ({}))) as AnthropicResponseBody;
    if (!response.ok) {
      throw errors.providerError('anthropic', body.error?.message ?? `HTTP ${response.status}`, {
        status: response.status,
      });
    }

    const text = (body.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    if (!text) throw errors.aiUnavailable('anthropic returned an empty completion');

    return {
      text,
      model: this.model,
      latencyMs: Date.now() - started,
      usage: body.usage
        ? {
            inputTokens: body.usage.input_tokens ?? 0,
            outputTokens: body.usage.output_tokens ?? 0,
          }
        : null,
    };
  }
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  error?: { message?: string };
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    faultInjector.maybeFail('ai_unavailable', 'llm', request.task);
    faultInjector.maybeFail('external_api_failure', 'llm', request.task);

    const started = Date.now();
    const response = await withTimeout(
      () =>
        fetch(`${this.baseUrl}/models/${this.model}:generateContent`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Header rather than ?key=, so the credential never lands in a URL that a
            // proxy or an access log might retain.
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: request.messages.map((m) => ({
              // Gemini names the assistant turn "model", not "assistant".
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            })),
            generationConfig: {
              temperature: request.temperature ?? 0.2,
              // Gemini bills internal reasoning against this same budget, so a limit
              // sized for the answer alone returns MAX_TOKENS with no answer at all.
              // Headroom here is not generosity, it is correctness.
              maxOutputTokens: (request.maxTokens ?? 900) + GEMINI_THINKING_HEADROOM,
              responseMimeType: 'application/json',
            },
          }),
        }),
      this.timeoutMs,
      'gemini',
    );

    const body = (await response.json().catch(() => ({}))) as GeminiResponseBody;
    if (!response.ok) {
      throw errors.providerError('gemini', body.error?.message ?? `HTTP ${response.status}`, {
        status: response.status,
      });
    }

    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';

    if (!text) {
      // Distinguish the thinking-budget exhaustion case, because it is silent otherwise:
      // a 200 with a well-formed envelope and no content at all.
      const reason =
        candidate?.finishReason === 'MAX_TOKENS'
          ? 'gemini spent its entire output budget on reasoning tokens and returned no content'
          : `gemini returned an empty completion (finishReason: ${candidate?.finishReason ?? 'none'})`;
      throw errors.aiUnavailable(reason);
    }

    return {
      text,
      model: this.model,
      latencyMs: Date.now() - started,
      usage: body.usageMetadata
        ? {
            inputTokens: body.usageMetadata.promptTokenCount ?? 0,
            // Reasoning tokens are billed and must be reported, or the cost line lies.
            outputTokens:
              (body.usageMetadata.candidatesTokenCount ?? 0) +
              (body.usageMetadata.thoughtsTokenCount ?? 0),
          }
        : null,
    };
  }
}

export function createLlmProvider(config: LlmConfig): LlmProvider | null {
  if (config.provider === 'openai' && config.apiKey) {
    return new OpenAiProvider(config.model, config.apiKey, config.baseUrl, config.timeoutMs);
  }
  if (config.provider === 'anthropic' && config.apiKey) {
    return new AnthropicProvider(config.model, config.apiKey, config.baseUrl, config.timeoutMs);
  }
  if (config.provider === 'gemini' && config.apiKey) {
    return new GeminiProvider(config.model, config.apiKey, config.baseUrl, config.timeoutMs);
  }
  return null;
}
