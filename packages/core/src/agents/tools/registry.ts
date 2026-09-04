import { z } from 'zod';
import { ReclaimError, errorMessage, toReclaimError } from '../../errors/index.js';
import type { Logger } from '../../logging/index.js';
import type { DataStore } from '../../store/types.js';

/**
 * THE AGENT TOOL LAYER
 *
 * An agent in this system cannot do anything except call a tool from this registry, and
 * every call passes through the same five gates before it reaches any business logic:
 *
 *   1. EXISTENCE   — the tool name must be registered. A hallucinated name is an error,
 *                    not an exception thrown from deep inside a service.
 *   2. AUTHORISATION — the caller's scopes must cover the tool's required scope. The
 *                    analyst agent literally cannot call `retry_payment`; it holds only
 *                    read scopes, so an attempt fails at the gate.
 *   3. VALIDATION  — arguments are parsed with a zod schema. Model-supplied arguments are
 *                    treated as hostile input and never reach a service unvalidated.
 *   4. IDEMPOTENCY — mutating tools declare a key derivation; the registry claims the key
 *                    before the handler runs and returns the prior result on a replay.
 *   5. AUDIT       — every invocation, successful or not, is written to the audit trail.
 *
 * The result is that "can the agent do something unsafe?" has a structural answer rather
 * than a prompt-engineering answer.
 */

export type ToolScope =
  | 'read:customer'
  | 'read:payments'
  | 'read:subscription'
  | 'read:analytics'
  | 'compute:prediction'
  | 'compute:strategy'
  | 'write:payment'
  | 'write:notification'
  | 'write:case';

export const READ_ONLY_SCOPES: ToolScope[] = [
  'read:customer',
  'read:payments',
  'read:subscription',
  'read:analytics',
  'compute:prediction',
  'compute:strategy',
];

export const ALL_SCOPES: ToolScope[] = [
  ...READ_ONLY_SCOPES,
  'write:payment',
  'write:notification',
  'write:case',
];

export interface ToolCallContext {
  merchantId: string;
  /** Who is invoking: which agent, or a human operator. */
  actor: { kind: 'agent' | 'user' | 'system'; id: string };
  scopes: ToolScope[];
  store: DataStore;
  logger: Logger;
  nowIso: string;
  /** Correlation id linking every tool call in one agent run. */
  runId: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  /** Shown to the planner; keep it short and unambiguous. */
  parameterSummary: string;
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  outputSchema: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
  scope: ToolScope;
  /** True when the tool has side effects. Mutating tools require an idempotency key. */
  mutating: boolean;
  /** Derive a stable key from the validated input; identical intent yields one key. */
  idempotencyKey?: (input: TInput, context: ToolCallContext) => string;
  /** One-line summary of the result, shown in the agent trace and fed to the planner. */
  summarize: (output: TOutput) => string;
  handler: (input: TInput, context: ToolCallContext) => Promise<TOutput>;
}

export interface ToolInvocation {
  tool: string;
  ok: boolean;
  durationMs: number;
  summary: string;
  error: string | null;
  errorCode: string | null;
  /** Set when a mutating call was suppressed because the key had already been used. */
  deduplicated: boolean;
  output: unknown;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<never, never>>();

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): this {
    if (this.tools.has(definition.name)) {
      throw new Error(`tool "${definition.name}" is already registered`);
    }
    if (definition.mutating && !definition.idempotencyKey) {
      throw new Error(`mutating tool "${definition.name}" must declare an idempotencyKey function`);
    }
    this.tools.set(definition.name, definition as unknown as ToolDefinition<never, never>);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition<never, never> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** The catalog handed to a planner, filtered to the scopes the caller actually holds. */
  catalog(scopes: readonly ToolScope[]): Array<{ name: string; description: string; parameters: string }> {
    const held = new Set(scopes);
    return [...this.tools.values()]
      .filter((tool) => held.has(tool.scope))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameterSummary,
      }));
  }

  /**
   * Invoke a tool. Never throws: every failure — unknown tool, missing scope, invalid
   * arguments, handler error — comes back as a structured `ToolInvocation` with `ok:false`,
   * so an agent loop can observe the failure and adapt rather than crashing.
   */
  async invoke(
    name: string,
    rawInput: unknown,
    context: ToolCallContext,
  ): Promise<ToolInvocation> {
    const started = Date.now();
    const logger = context.logger.child({ tool: name, runId: context.runId });

    const fail = (error: unknown, deduplicated = false): ToolInvocation => {
      const err = toReclaimError(error);
      return {
        tool: name,
        ok: false,
        durationMs: Date.now() - started,
        summary: err.message,
        error: err.message,
        errorCode: err.code,
        deduplicated,
        output: null,
      };
    };

    const tool = this.tools.get(name) as ToolDefinition<unknown, unknown> | undefined;
    if (!tool) {
      const invocation = fail(
        new ReclaimError({
          code: 'NOT_FOUND',
          message: `unknown tool "${name}"; available tools are ${this.names().join(', ')}`,
        }),
      );
      await this.audit(context, invocation, null);
      return invocation;
    }

    if (!context.scopes.includes(tool.scope)) {
      const invocation = fail(
        new ReclaimError({
          code: 'FORBIDDEN',
          message: `tool "${name}" requires scope "${tool.scope}", which this agent does not hold`,
          details: { required: tool.scope, held: context.scopes },
        }),
      );
      await this.audit(context, invocation, null);
      return invocation;
    }

    const parsed = tool.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('; ');
      const invocation = fail(
        new ReclaimError({
          code: 'VALIDATION_FAILED',
          message: `invalid arguments for "${name}" — ${detail}`,
          details: { issues: detail },
        }),
      );
      await this.audit(context, invocation, null);
      return invocation;
    }

    let idempotencyKey: string | null = null;
    if (tool.mutating && tool.idempotencyKey) {
      idempotencyKey = tool.idempotencyKey(parsed.data, context);
      const claim = await context.store.claimIdempotency({
        key: idempotencyKey,
        merchantId: context.merchantId,
        scope: `tool:${name}`,
        actionId: context.runId,
      });
      if (!claim.claimed) {
        logger.info('tool call suppressed as duplicate', { idempotencyKey });
        const invocation: ToolInvocation = {
          tool: name,
          ok: true,
          durationMs: Date.now() - started,
          summary: `Duplicate suppressed: an identical ${name} call was already executed.`,
          error: null,
          errorCode: null,
          deduplicated: true,
          output: { deduplicated: true, resultRef: claim.record.resultRef },
        };
        await this.audit(context, invocation, idempotencyKey);
        return invocation;
      }
    }

    try {
      const output = await tool.handler(parsed.data, context);

      // The handler's own output is validated too. A service that drifts from its
      // declared contract is a bug we want surfaced here, not three layers downstream.
      const validatedOutput = tool.outputSchema.safeParse(output);
      if (!validatedOutput.success) {
        throw new ReclaimError({
          code: 'INTERNAL',
          message: `tool "${name}" returned a result that does not match its output schema: ${validatedOutput.error.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join('; ')}`,
        });
      }

      if (idempotencyKey) {
        await context.store.settleIdempotency(idempotencyKey, 'succeeded', null);
      }

      const invocation: ToolInvocation = {
        tool: name,
        ok: true,
        durationMs: Date.now() - started,
        summary: tool.summarize(validatedOutput.data),
        error: null,
        errorCode: null,
        deduplicated: false,
        output: validatedOutput.data,
      };
      await this.audit(context, invocation, idempotencyKey);
      return invocation;
    } catch (error) {
      if (idempotencyKey) {
        await context.store.settleIdempotency(idempotencyKey, 'failed', null);
      }
      logger.warn('tool call failed', { error: errorMessage(error) });
      const invocation = fail(error);
      await this.audit(context, invocation, idempotencyKey);
      return invocation;
    }
  }

  private async audit(
    context: ToolCallContext,
    invocation: ToolInvocation,
    idempotencyKey: string | null,
  ): Promise<void> {
    try {
      await context.store.appendAudit({
        merchantId: context.merchantId,
        actor: { kind: context.actor.kind === 'agent' ? 'agent' : 'user', id: context.actor.id },
        event: `tool.${invocation.tool}`,
        trigger: `agent_run:${context.runId}`,
        failure: invocation.error,
        metadata: {
          ok: invocation.ok,
          durationMs: invocation.durationMs,
          deduplicated: invocation.deduplicated,
          errorCode: invocation.errorCode,
          idempotencyKey,
          summary: invocation.summary.slice(0, 300),
        },
      });
    } catch (error) {
      // Audit failure must never take down a tool call; log and continue.
      context.logger.error('failed to write tool audit entry', error, { tool: invocation.tool });
    }
  }
}

/** Shared argument shapes reused across tool definitions. */
export const caseIdInput = z.object({ caseId: z.string().min(1) });
export const customerIdInput = z.object({ customerId: z.string().min(1) });
