import type { LlmConfig } from '../config/index.js';
import { errors } from '../errors/index.js';
import { withTimeout } from '../resilience/index.js';
import { faultInjector } from '../services/fault-injector.js';
import type { CompletionRequest, CompletionResponse, LlmProvider } from './types.js';

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

export function createLlmProvider(config: LlmConfig): LlmProvider | null {
  if (config.provider === 'openai' && config.apiKey) {
    return new OpenAiProvider(config.model, config.apiKey, config.baseUrl, config.timeoutMs);
  }
  if (config.provider === 'anthropic' && config.apiKey) {
    return new AnthropicProvider(config.model, config.apiKey, config.baseUrl, config.timeoutMs);
  }
  return null;
}
