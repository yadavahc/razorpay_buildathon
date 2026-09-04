'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import Link from 'next/link';
import { useState } from 'react';
import type { AIDecision, AuditLog, ControlTowerMetrics, ExecutionResult, RecoveryCase } from '@reclaim/core';
import {
  STRATEGY_LABELS,
  formatCount,
  formatDateTime,
  formatMinor,
  formatMinorCompact,
  formatPercent,
} from '@reclaim/core/presentation';
import { useApi, useMutation } from '@/lib/use-api';
import { PageHeader } from '@/components/dashboard/metrics';
import { Badge, Button, ErrorState, Panel, Surface, cn } from '@/components/ui/primitives';

interface RunStep {
  key: string;
  label: string;
  detail: string;
  at: string;
  ms: number;
  status: 'ok' | 'blocked' | 'failed';
}

interface RunPayload {
  caseId: string;
  steps: RunStep[];
  aiDecision: AIDecision;
  execution: ExecutionResult | null;
  case: RecoveryCase | null;
  audit: AuditLog[];
  overview: ControlTowerMetrics;
  recoveredAmountMinor: number;
  provider: { name: string; live: boolean; description: string };
  reasoner: AIDecision['reasoner'];
  totalMs: number;
}

interface BatchPayload {
  detected: number;
  queued: number;
  processed: number;
  recoveredMinor: number;
  recoveredCount: number;
  blockedCount: number;
  escalatedCount: number;
  duplicatesPrevented: number;
  failedCount: number;
  durationMs: number;
  throughputPerSecond: number;
  strategyMix: Array<{ strategy: string; count: number }>;
  before: { revenueAtRiskMinor: number; recoveredRevenueMinor: number; activeCases: number; recoveryRate: number };
  after: { revenueAtRiskMinor: number; recoveredRevenueMinor: number; activeCases: number; recoveryRate: number };
  deltaRecoveredMinor: number;
  errors: Array<{ caseId: string; error: string }>;
}

interface FaultCatalogue {
  catalogue: Array<{ kind: string; label: string; expected: string }>;
  armed: Array<{ id: string; kind: string; target: string; remaining: number; note: string }>;
}

/**
 * DEMO MODE
 *
 * Three buttons, three honest stories.
 *
 * Nothing here is scripted. "Run live recovery" ingests a genuinely new failure and puts
 * it through the real pipeline; the probability is the model's, the policy verdict is the
 * engine's, and the outcome is whatever the provider returned. Runs do sometimes end
 * without the money coming back — which is the point, because a demo that always succeeds
 * is a video, not a system.
 */
export default function DemoPage() {
  const reduced = useReducedMotion();
  const [visibleSteps, setVisibleSteps] = useState(0);

  const { data: faults, refresh: refreshFaults } = useApi<FaultCatalogue>('/api/demo/faults');

  const run = useMutation<{ generateFailure: boolean }, RunPayload>('/api/demo/run', {
    onSuccess: (payload) => {
      // Reveal the steps in sequence so the pipeline reads as a process rather than a
      // wall of text. The data is already complete; only the disclosure is animated.
      setVisibleSteps(0);
      if (reduced) {
        setVisibleSteps(payload.steps.length);
        return;
      }
      payload.steps.forEach((_, index) => {
        setTimeout(() => setVisibleSteps(index + 1), index * 420);
      });
    },
  });

  const batch = useMutation<{ limit: number; detectFirst: boolean }, BatchPayload>(
    '/api/demo/batch',
  );

  const armFault = useMutation<{ kind: string; target: string; count: number }, unknown>(
    '/api/demo/faults',
    { onSuccess: () => void refreshFaults() },
  );

  return (
    <>
      <PageHeader
        title="Demo mode"
        description="Run the whole story end to end, break it deliberately, or process the entire queue and measure what came back."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <ActionCard
          title="Run live recovery"
          body="Generate a brand-new payment failure on a real customer, then watch it move through detection, investigation, scoring, strategy pricing, guardrails, execution and outcome measurement."
          cta="Run live recovery"
          pending={run.pending}
          onRun={() => void run.run({ generateFailure: true })}
          emphasis
        />
        <ActionCard
          title="Run batch"
          body="Work the whole open queue sequentially and report exactly how much money came back, how many actions the guardrails blocked, and how many duplicates were suppressed."
          cta="Process the queue"
          pending={batch.pending}
          onRun={() => void batch.run({ limit: 150, detectFirst: true })}
        />
        <ActionCard
          title="Inject a failure"
          body="Arm a fault — a provider timeout, a duplicate request, an AI outage — and then run a recovery to watch the system fall back, degrade, or escalate rather than break."
          cta="Arm a payment timeout"
          pending={armFault.pending}
          onRun={() =>
            void armFault.run({ kind: 'payment_timeout', target: 'payments', count: 3 })
          }
        />
      </div>

      {faults && faults.armed.length > 0 && (
        <div className="mt-5 rounded-xl border border-risk-500/25 bg-risk-500/[0.06] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium text-risk-400">
              {faults.armed.length} fault{faults.armed.length === 1 ? '' : 's'} armed
            </p>
            {faults.armed.map((fault) => (
              <Badge key={fault.id} tone="warning">
                {fault.kind.replace(/_/g, ' ')} → {fault.target} ({fault.remaining} left)
              </Badge>
            ))}
            <Link href="/dashboard/lab" className="ml-auto text-2xs text-silver-400 hover:text-silver-200">
              Failure lab →
            </Link>
          </div>
        </div>
      )}

      {run.error && (
        <div className="mt-6">
          <ErrorState title="The run could not start" message={run.error.message} />
        </div>
      )}

      {run.data && (
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Panel
              title="Pipeline trace"
              description={`Case ${run.data.caseId} · completed in ${run.data.totalMs}ms`}
              bodyClassName="p-0"
              actions={
                <Link href={`/dashboard/cases/${run.data.caseId}`}>
                  <Button size="sm" variant="ghost">
                    Open case
                  </Button>
                </Link>
              }
            >
              <ol className="divide-y divide-white/[0.05]">
                <AnimatePresence initial={false}>
                  {run.data.steps.slice(0, visibleSteps).map((step, index) => (
                    <motion.li
                      key={step.key}
                      initial={reduced ? false : { opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                      className="flex gap-4 px-5 py-3.5"
                    >
                      <StepGlyph index={index + 1} status={step.status} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-xs font-medium text-silver-100">{step.label}</p>
                          <span className="tnum shrink-0 text-2xs text-silver-600">{step.ms}ms</span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-silver-400 text-pretty">
                          {step.detail}
                        </p>
                      </div>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ol>

              {visibleSteps >= run.data.steps.length && (
                <div className="border-t border-white/[0.06] px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="label-eyebrow">Result</p>
                      <p
                        className={cn(
                          'mt-1 text-lg font-medium tracking-tight',
                          run.data.recoveredAmountMinor > 0 ? 'text-mint-400' : 'text-silver-300',
                        )}
                      >
                        {run.data.recoveredAmountMinor > 0
                          ? `${formatMinor(run.data.recoveredAmountMinor, { whole: true })} recovered`
                          : `${STRATEGY_LABELS[run.data.execution?.finalStrategy ?? 'stop_recovery']} — no money captured yet`}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="label-eyebrow">Portfolio recovered</p>
                      <p className="mt-1 text-lg font-medium tracking-tight text-mint-400">
                        {formatMinorCompact(run.data.overview.recoveredRevenueMinor)}
                      </p>
                    </div>
                  </div>
                  {run.data.execution && run.data.execution.notes.length > 0 && (
                    <ul className="mt-3 space-y-1 border-t border-white/[0.05] pt-3">
                      {run.data.execution.notes.map((note, index) => (
                        <li key={index} className="text-2xs leading-relaxed text-silver-500">
                          {note}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </Panel>
          </div>

          <div className="space-y-6">
            <Panel title="Provenance" description="What actually ran, for this specific decision.">
              <dl className="space-y-2">
                <Row
                  label="Payment provider"
                  value={run.data.provider.name}
                  hint={run.data.provider.live ? 'live test-mode API' : 'offline simulator'}
                />
                <Row
                  label="Reasoner"
                  value={
                    run.data.reasoner.kind === 'llm'
                      ? run.data.reasoner.model
                      : 'Deterministic reasoner'
                  }
                  hint={run.data.reasoner.degraded ? 'degraded fallback' : 'primary path'}
                />
                <Row label="Model" value={run.data.aiDecision.modelVersion} />
                <Row
                  label="Recovery probability"
                  value={formatPercent(run.data.aiDecision.recoveryProbability, 1)}
                />
                <Row
                  label="Expected value"
                  value={formatMinor(run.data.aiDecision.expectedValueMinor)}
                />
                <Row
                  label="Confidence"
                  value={formatPercent(run.data.aiDecision.confidence, 0)}
                />
                <Row label="Tool calls" value={String(run.data.aiDecision.toolCalls.length)} />
              </dl>
            </Panel>

            <Panel
              title="Audit trail"
              description={`${run.data.audit.length} hash-chained entries for this case.`}
              bodyClassName="p-0"
            >
              <ol className="divide-y divide-white/[0.05]">
                {run.data.audit.map((entry) => (
                  <li key={entry.id} className="px-5 py-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-mono text-2xs text-silver-300">{entry.event}</span>
                      <span className="tnum text-2xs text-silver-600">#{entry.seq}</span>
                    </div>
                    <p className="mt-0.5 truncate text-2xs text-silver-600">
                      {formatDateTime(entry.at)} · {entry.actor.id}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[9px] text-silver-700">
                      {entry.hash.slice(0, 32)}…
                    </p>
                  </li>
                ))}
              </ol>
            </Panel>
          </div>
        </div>
      )}

      {batch.error && (
        <div className="mt-6">
          <ErrorState title="The batch could not run" message={batch.error.message} />
        </div>
      )}

      {batch.data && (
        <Panel
          className="mt-6"
          title="Batch result"
          description={`${formatCount(batch.data.processed)} cases processed in ${(batch.data.durationMs / 1000).toFixed(1)}s (${batch.data.throughputPerSecond}/s).`}
        >
          <div className="grid gap-px overflow-hidden rounded-xl bg-white/[0.05] sm:grid-cols-2 lg:grid-cols-4">
            <BatchCell
              label="Recovered this run"
              value={formatMinorCompact(batch.data.recoveredMinor)}
              hint={`${formatCount(batch.data.recoveredCount)} cases`}
              tone="text-mint-400"
            />
            <BatchCell
              label="Blocked by policy"
              value={formatCount(batch.data.blockedCount)}
              hint="guardrails refused"
              tone="text-risk-400"
            />
            <BatchCell
              label="Duplicates prevented"
              value={formatCount(batch.data.duplicatesPrevented)}
              hint="idempotency ledger"
              tone="text-mint-400"
            />
            <BatchCell
              label="Escalated"
              value={formatCount(batch.data.escalatedCount)}
              hint="sent to a human"
              tone="text-silver-200"
            />
          </div>

          <div className="mt-5 grid gap-6 md:grid-cols-2">
            <div>
              <p className="label-eyebrow">Portfolio before and after</p>
              <dl className="mt-3 space-y-2">
                <Delta
                  label="Revenue at risk"
                  before={batch.data.before.revenueAtRiskMinor}
                  after={batch.data.after.revenueAtRiskMinor}
                  lowerIsBetter
                />
                <Delta
                  label="Revenue recovered"
                  before={batch.data.before.recoveredRevenueMinor}
                  after={batch.data.after.recoveredRevenueMinor}
                />
                <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] pb-1.5">
                  <dt className="text-2xs text-silver-500">Open cases</dt>
                  <dd className="tnum text-2xs text-silver-200">
                    {formatCount(batch.data.before.activeCases)} →{' '}
                    {formatCount(batch.data.after.activeCases)}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-2xs text-silver-500">Recovery rate</dt>
                  <dd className="tnum text-2xs text-silver-200">
                    {formatPercent(batch.data.before.recoveryRate)} →{' '}
                    {formatPercent(batch.data.after.recoveryRate)}
                  </dd>
                </div>
              </dl>
            </div>

            <div>
              <p className="label-eyebrow">What the engine chose</p>
              <ul className="mt-3 space-y-2">
                {batch.data.strategyMix.map((entry) => {
                  const max = batch.data!.strategyMix[0]?.count ?? 1;
                  return (
                    <li key={entry.strategy}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-2xs text-silver-300">
                          {STRATEGY_LABELS[entry.strategy as keyof typeof STRATEGY_LABELS] ??
                            entry.strategy}
                        </span>
                        <span className="tnum text-2xs text-silver-500">{entry.count}</span>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                        <div
                          className="h-full rounded-full bg-info-500"
                          style={{ width: `${(entry.count / max) * 100}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          {batch.data.errors.length > 0 && (
            <div className="mt-5 border-t border-white/[0.06] pt-4">
              <p className="label-eyebrow">Cases that errored</p>
              <ul className="mt-2 space-y-1">
                {batch.data.errors.map((entry) => (
                  <li key={entry.caseId} className="text-2xs text-loss-400">
                    {entry.caseId}: {entry.error}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-2xs text-silver-600">
                One failing case never aborts a batch — it is recorded and the run continues.
              </p>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}

function ActionCard({
  title,
  body,
  cta,
  pending,
  onRun,
  emphasis,
}: {
  title: string;
  body: string;
  cta: string;
  pending: boolean;
  onRun: () => void;
  emphasis?: boolean;
}) {
  return (
    <Surface
      className={cn(
        'flex flex-col p-6',
        emphasis && 'border-mint-500/20 bg-gradient-to-b from-mint-500/[0.06] to-ink-900/90',
      )}
    >
      <h2 className="text-sm font-medium text-silver-100">{title}</h2>
      <p className="mt-2 flex-1 text-xs leading-relaxed text-silver-500 text-pretty">{body}</p>
      <Button
        className="mt-5 w-full"
        variant={emphasis ? 'primary' : 'secondary'}
        loading={pending}
        onClick={onRun}
      >
        {cta}
      </Button>
    </Surface>
  );
}

function StepGlyph({ index, status }: { index: number; status: 'ok' | 'blocked' | 'failed' }) {
  const config = {
    ok: { symbol: String(index).padStart(2, '0'), className: 'border-mint-500/30 bg-mint-500/10 text-mint-400' },
    blocked: { symbol: '!', className: 'border-risk-500/30 bg-risk-500/10 text-risk-400' },
    failed: { symbol: '✕', className: 'border-loss-500/30 bg-loss-500/10 text-loss-400' },
  }[status];

  return (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border font-mono text-[10px]',
        config.className,
      )}
    >
      {config.symbol}
    </span>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-2xs text-silver-500">{label}</dt>
      <dd className="min-w-0 text-right">
        <span className="tnum block truncate text-2xs text-silver-200">{value}</span>
        {hint && <span className="block text-[10px] text-silver-600">{hint}</span>}
      </dd>
    </div>
  );
}

function BatchCell({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: string;
}) {
  return (
    <div className="bg-ink-900 px-5 py-4">
      <p className="label-eyebrow">{label}</p>
      <p className={cn('mt-1.5 text-xl font-medium tracking-tight', tone)}>{value}</p>
      <p className="mt-0.5 text-2xs text-silver-600">{hint}</p>
    </div>
  );
}

function Delta({
  label,
  before,
  after,
  lowerIsBetter,
}: {
  label: string;
  before: number;
  after: number;
  lowerIsBetter?: boolean;
}) {
  const change = after - before;
  const improved = lowerIsBetter ? change < 0 : change > 0;

  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] pb-1.5">
      <dt className="text-2xs text-silver-500">{label}</dt>
      <dd className="tnum text-2xs text-silver-200">
        {formatMinorCompact(before)} → {formatMinorCompact(after)}
        {change !== 0 && (
          <span className={cn('ml-2', improved ? 'text-mint-400' : 'text-loss-400')}>
            {change > 0 ? '+' : ''}
            {formatMinorCompact(change)}
          </span>
        )}
      </dd>
    </div>
  );
}
