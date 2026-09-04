'use client';

import { useState } from 'react';
import type { AIDecision, AuditLog, CircuitSnapshot, ControlTowerMetrics, ExecutionResult, RecoveryCase } from '@reclaim/core';
import { STRATEGY_LABELS, formatDateTime, formatMinor } from '@reclaim/core/presentation';
import { useApi, useMutation } from '@/lib/use-api';
import { PageHeader } from '@/components/dashboard/metrics';
import { Badge, Button, ErrorState, Panel, Surface, cn } from '@/components/ui/primitives';

interface FaultsPayload {
  catalogue: Array<{ kind: string; label: string; expected: string }>;
  armed: Array<{ id: string; kind: string; target: string; remaining: number; armedAt: string; note: string }>;
  events: Array<{ at: string; kind: string; target: string; operation: string; remaining: number }>;
  circuits: CircuitSnapshot[];
}

interface RunPayload {
  caseId: string;
  steps: Array<{ key: string; label: string; detail: string; ms: number; status: 'ok' | 'blocked' | 'failed' }>;
  aiDecision: AIDecision;
  execution: ExecutionResult | null;
  case: RecoveryCase | null;
  audit: AuditLog[];
  overview: ControlTowerMetrics;
  recoveredAmountMinor: number;
}

const TARGETS = [
  { value: '*', label: 'Everything' },
  { value: 'payments', label: 'Payment provider' },
  { value: 'llm', label: 'Reasoning layer' },
  { value: 'notifications', label: 'Messaging' },
] as const;

/**
 * THE FAILURE LAB
 *
 * A recovery engine that has only ever been observed on the happy path is a demo, not an
 * engine. This page arms a specific fault and lets you watch the system meet it.
 *
 * Faults are bounded — they fire a fixed number of times then disarm themselves — so an
 * armed fault cannot leak into the next demonstration, and every firing is recorded.
 */
export default function FailureLabPage() {
  const [target, setTarget] = useState<string>('*');
  const [count, setCount] = useState(3);

  const { data, refresh } = useApi<FaultsPayload>('/api/demo/faults', { pollMs: 5_000 });

  const arm = useMutation<{ kind: string; target: string; count: number }, unknown>(
    '/api/demo/faults',
    { onSuccess: () => void refresh() },
  );
  const disarm = useMutation<undefined, unknown>('/api/demo/faults', {
    method: 'DELETE',
    onSuccess: () => void refresh(),
  });
  const run = useMutation<{ generateFailure: boolean }, RunPayload>('/api/demo/run', {
    onSuccess: () => void refresh(),
  });

  return (
    <>
      <PageHeader
        title="Failure lab"
        description="Arm a fault, then run a recovery and watch the system fall back, degrade, or escalate rather than break."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              loading={run.pending}
              onClick={() => void run.run({ generateFailure: true })}
            >
              Run a recovery
            </Button>
            <Button
              variant="ghost"
              disabled={!data || data.armed.length === 0}
              loading={disarm.pending}
              onClick={() => void disarm.run(undefined)}
            >
              Disarm all
            </Button>
          </div>
        }
      />

      <Surface className="mb-6 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-2xs text-silver-500">
            Target
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              className="h-8 rounded-lg border border-white/[0.09] bg-ink-850 px-2 text-xs text-silver-200 outline-none focus-visible:ring-2 focus-visible:ring-mint-500/60"
            >
              {TARGETS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-2xs text-silver-500">
            Fires
            <input
              type="number"
              min={1}
              max={20}
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
              className="tnum h-8 w-16 rounded-lg border border-white/[0.09] bg-ink-850 px-2 text-xs text-silver-200 outline-none focus-visible:ring-2 focus-visible:ring-mint-500/60"
            />
          </label>
          <p className="text-2xs text-silver-600">
            A fault fires the given number of times, then disarms itself.
          </p>
        </div>
      </Surface>

      {arm.error && <ErrorState message={arm.error.message} />}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(data?.catalogue ?? []).map((fault) => {
          const armed = data?.armed.filter((a) => a.kind === fault.kind) ?? [];
          return (
            <Surface key={fault.kind} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-xs font-medium text-silver-100">{fault.label}</h2>
                {armed.length > 0 && (
                  <Badge dot tone="warning">
                    {armed.reduce((sum, a) => sum + a.remaining, 0)} left
                  </Badge>
                )}
              </div>
              <p className="mt-2 flex-1 text-xs leading-relaxed text-silver-500 text-pretty">
                {fault.expected}
              </p>
              <Button
                className="mt-4 w-full"
                size="sm"
                variant={armed.length > 0 ? 'danger' : 'secondary'}
                loading={arm.pending}
                onClick={() => void arm.run({ kind: fault.kind, target, count })}
              >
                {armed.length > 0 ? 'Arm again' : 'Arm this fault'}
              </Button>
            </Surface>
          );
        })}
      </div>

      {run.data && (
        <Panel
          className="mt-6"
          title="What happened when you ran it"
          description={`Case ${run.data.caseId}`}
          bodyClassName="p-0"
        >
          <ol className="divide-y divide-white/[0.05]">
            {run.data.steps.map((step, index) => (
              <li key={step.key} className="flex gap-4 px-5 py-3">
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border font-mono text-[10px]',
                    step.status === 'ok'
                      ? 'border-mint-500/30 bg-mint-500/10 text-mint-400'
                      : step.status === 'blocked'
                        ? 'border-risk-500/30 bg-risk-500/10 text-risk-400'
                        : 'border-loss-500/30 bg-loss-500/10 text-loss-400',
                  )}
                >
                  {step.status === 'ok' ? String(index + 1).padStart(2, '0') : step.status === 'blocked' ? '!' : '✕'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-xs font-medium text-silver-100">{step.label}</p>
                    <span className="tnum shrink-0 text-2xs text-silver-600">{step.ms}ms</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-silver-400 text-pretty">
                    {step.detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {run.data.execution && (
            <div className="border-t border-white/[0.06] px-5 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={run.data.recoveredAmountMinor > 0 ? 'positive' : 'neutral'} size="md">
                  {STRATEGY_LABELS[run.data.execution.finalStrategy]}
                </Badge>
                {run.data.execution.fallbacksUsed > 0 && (
                  <Badge tone="warning">
                    {run.data.execution.fallbacksUsed} fallback
                    {run.data.execution.fallbacksUsed === 1 ? '' : 's'} taken
                  </Badge>
                )}
                {run.data.execution.duplicatePrevented && (
                  <Badge tone="accent">duplicate suppressed</Badge>
                )}
                {run.data.execution.blockedByPolicy && <Badge tone="warning">policy blocked</Badge>}
                {run.data.recoveredAmountMinor > 0 && (
                  <span className="tnum text-xs text-mint-400">
                    {formatMinor(run.data.recoveredAmountMinor, { whole: true })} recovered
                  </span>
                )}
              </div>
              <ul className="mt-3 space-y-1">
                {run.data.execution.notes.map((note, index) => (
                  <li key={index} className="text-2xs leading-relaxed text-silver-500">
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel
          title="Circuit breakers"
          description="Open circuits fail fast instead of queueing. A dependency that is down should produce a fallback, not a hang."
          bodyClassName="p-0"
        >
          {!data || data.circuits.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-silver-500">
              No circuits have been exercised yet. Arm a gateway failure and run a recovery.
            </p>
          ) : (
            <ul className="divide-y divide-white/[0.05]">
              {data.circuits.map((circuit) => (
                <li key={circuit.name} className="px-5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-2xs text-silver-300">{circuit.name}</span>
                    <Badge
                      dot
                      tone={
                        circuit.state === 'closed'
                          ? 'positive'
                          : circuit.state === 'half_open'
                            ? 'warning'
                            : 'negative'
                      }
                    >
                      {circuit.state.replace('_', ' ')}
                    </Badge>
                  </div>
                  <p className="mt-1 text-2xs text-silver-600">
                    {circuit.totalCalls} calls · {circuit.totalFailures} failures ·{' '}
                    {circuit.totalTrips} trips · {circuit.totalShortCircuited} short-circuited
                    {circuit.retryAfterMs > 0 && ` · retry in ${(circuit.retryAfterMs / 1000).toFixed(1)}s`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Fault log"
          description="Every time an armed fault actually fired."
          bodyClassName="p-0"
        >
          {!data || data.events.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-silver-500">
              No faults have fired yet.
            </p>
          ) : (
            <ol className="max-h-80 divide-y divide-white/[0.05] overflow-auto">
              {[...data.events].reverse().map((event, index) => (
                <li key={index} className="px-5 py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-2xs text-loss-400">{event.kind.replace(/_/g, ' ')}</span>
                    <span className="text-2xs text-silver-600">{formatDateTime(event.at)}</span>
                  </div>
                  <p className="mt-0.5 font-mono text-2xs text-silver-500">
                    {event.target}.{event.operation} · {event.remaining} remaining
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </>
  );
}
