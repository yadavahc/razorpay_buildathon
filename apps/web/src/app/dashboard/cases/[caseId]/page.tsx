'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import type {
  AIDecision,
  AuditLog,
  CaseTimelineEntry,
  GraphFeatures,
  Notification,
  OpportunityGraph,
  PaymentLink,
  PolicyDecision,
  RecoveryAction,
  RecoveryCase,
  RecoveryOutcome,
  RecoveryStrategy,
  StrategyCandidate,
} from '@reclaim/core';
import {
  CASE_SOURCE_DESCRIPTIONS,
  CASE_SOURCE_LABELS,
  CASE_STATUS_LABELS,
  METHOD_LABELS,
  SEGMENT_LABELS,
  STRATEGY_LABELS,
  failureLabel,
  formatDateTime,
  formatMinor,
  formatMinorCompact,
  formatPercent,
  formatRelative,
} from '@reclaim/core/presentation';
import { useApi, useMutation } from '@/lib/use-api';
import { PageHeader } from '@/components/dashboard/metrics';
import { DecisionInspector, StrategyTable } from '@/components/dashboard/decision-inspector';
import { OpportunityGraphView } from '@/components/dashboard/opportunity-graph';
import {
  Badge,
  Button,
  ErrorState,
  Panel,
  Skeleton,
  Surface,
  cn,
} from '@/components/ui/primitives';

interface CaseDetail {
  case: RecoveryCase;
  customer: {
    id: string;
    name: string;
    email: string;
    phone: string;
    segment: keyof typeof SEGMENT_LABELS;
    timezone: string;
    contactPreference: string;
    contactOptOut: boolean;
    doNotRetry: boolean;
    chargebackCount: number;
    createdAt: string;
  };
  profile: {
    key: string;
    label: string;
    category: string;
    headline: string;
    explanation: string;
    baseRecoverability: number;
    optimalDelayHours: number;
    retryPossible: boolean;
    customerActionRequired: boolean;
  };
  features: GraphFeatures;
  prediction: {
    probability: number;
    threshold: number;
    aboveThreshold: boolean;
    modelVersion: string;
    degraded: boolean;
    degradedReason: string | null;
    drivers: Array<{ label: string; contribution: number; direction: string; value: number }>;
  };
  strategies: StrategyCandidate[];
  recommended: StrategyCandidate;
  graph: OpportunityGraph;
  mandateActive: boolean | null;
  contactsInLast24h: number;
  aiDecisions: AIDecision[];
  policyDecisions: PolicyDecision[];
  actions: RecoveryAction[];
  outcomes: RecoveryOutcome[];
  notifications: Notification[];
  paymentLinks: PaymentLink[];
  audit: AuditLog[];
}

/**
 * The case investigation screen.
 *
 * Everything a reviewer needs to second-guess the engine, on one page: the evidence, the
 * graph the model read, the priced options, the guardrail verdicts, and the measured
 * result. If the engine got a case wrong, this page is where that becomes visible.
 */
export default function CaseDetailPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = use(params);
  const { data, error, loading, refresh, refreshing } = useApi<CaseDetail>(`/api/cases/${caseId}`);
  const [override, setOverride] = useState<RecoveryStrategy | ''>('');

  const decide = useMutation<
    { execute: boolean; strategy?: RecoveryStrategy },
    { caseId: string; executed: boolean }
  >(`/api/cases/${caseId}/decide`, { onSuccess: () => void refresh() });

  if (error) {
    return (
      <>
        <PageHeader title="Recovery case" description="Case investigation." />
        <ErrorState message={error.message} onRetry={() => void refresh()} />
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Recovery case" description="Loading case evidence…" />
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-[420px] rounded-xl lg:col-span-2" />
          <Skeleton className="h-[420px] rounded-xl" />
        </div>
      </>
    );
  }

  if (!data) return null;

  const c = data.case;
  const latestDecision = data.aiDecisions[0] ?? null;
  const isTerminal = ['recovered', 'stopped', 'unrecoverable'].includes(c.status);

  return (
    <>
      <div className="mb-4">
        <Link href="/dashboard/cases" className="text-2xs text-silver-500 hover:text-silver-300">
          ← All cases
        </Link>
      </div>

      <PageHeader
        title={data.customer.name}
        description={`${CASE_SOURCE_LABELS[c.sourceType]} · ${CASE_SOURCE_DESCRIPTIONS[c.sourceType]}`}
        refreshing={refreshing}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={override}
              onChange={(event) => setOverride(event.target.value as RecoveryStrategy | '')}
              aria-label="Override the recommended strategy"
              disabled={isTerminal}
              className="h-9 rounded-lg border border-white/[0.09] bg-ink-850 px-2 text-xs text-silver-300 outline-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-mint-500/60"
            >
              <option value="">Use recommendation</option>
              {data.strategies
                .filter((s) => s.eligible)
                .map((s) => (
                  <option key={s.strategy} value={s.strategy}>
                    Force: {STRATEGY_LABELS[s.strategy]}
                  </option>
                ))}
            </select>
            <Button
              size="md"
              variant="secondary"
              disabled={isTerminal}
              loading={decide.pending}
              onClick={() => void decide.run({ execute: false })}
            >
              Investigate
            </Button>
            <Button
              size="md"
              variant="primary"
              disabled={isTerminal}
              loading={decide.pending}
              onClick={() =>
                void decide.run({ execute: true, ...(override ? { strategy: override } : {}) })
              }
            >
              Run recovery
            </Button>
          </div>
        }
      />

      {decide.error && (
        <div className="mb-5">
          <ErrorState title="Could not run the pipeline" message={decide.error.message} />
        </div>
      )}

      {isTerminal && (
        <div className="mb-5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
          <p className="text-xs text-silver-400">
            This case is <strong className="text-silver-200">{CASE_STATUS_LABELS[c.status]}</strong>{' '}
            and can no longer be acted on. Terminal states have no outgoing transitions, which is
            what keeps the recovered total monotonic and auditable.
          </p>
        </div>
      )}

      {/* Headline strip */}
      <Surface className="mb-6">
        <dl className="grid gap-px overflow-hidden rounded-xl bg-white/[0.05] sm:grid-cols-2 lg:grid-cols-5">
          <Cell
            label="Amount at risk"
            value={formatMinor(c.amountAtRiskMinor, { whole: true })}
            tone="text-risk-400"
          />
          <Cell
            label="Recovery probability"
            value={
              c.recoveryProbability === null
                ? 'not scored'
                : formatPercent(c.recoveryProbability, 1)
            }
            hint={`${data.prediction.modelVersion}${data.prediction.degraded ? ' (degraded)' : ''}`}
            tone="text-info-400"
          />
          <Cell
            label="Best expected value"
            value={formatMinor(data.recommended.expectedValueMinor)}
            hint={STRATEGY_LABELS[data.recommended.strategy]}
            tone="text-mint-400"
          />
          <Cell
            label="Recovered"
            value={formatMinor(c.recoveredAmountMinor, { whole: true })}
            hint={c.recoveredAmountMinor > 0 ? 'captured' : 'nothing captured yet'}
            tone={c.recoveredAmountMinor > 0 ? 'text-mint-400' : 'text-silver-500'}
          />
          <Cell
            label="Status"
            value={CASE_STATUS_LABELS[c.status]}
            hint={`Detected ${formatRelative(c.detectedAt)}`}
            tone="text-silver-100"
          />
        </dl>
      </Surface>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <OpportunityGraphView graph={data.graph} />

          {latestDecision ? (
            <DecisionInspector
              decision={latestDecision}
              policyDecisions={data.policyDecisions}
              actions={data.actions}
              outcomes={data.outcomes}
            />
          ) : (
            <Panel
              title="AI decision inspector"
              description="No decision has been recorded for this case yet."
            >
              <div className="space-y-4">
                <p className="text-xs leading-relaxed text-silver-400 text-pretty">
                  The case has been detected and scored, but the analyst agent has not investigated
                  it. The strategies below are priced from the current model probability and would
                  be re-priced at decision time.
                </p>
                <StrategyTable
                  candidates={data.strategies}
                  chosen={data.recommended.strategy}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  loading={decide.pending}
                  disabled={isTerminal}
                  onClick={() => void decide.run({ execute: false })}
                >
                  Investigate this case
                </Button>
              </div>
            </Panel>
          )}

          <CaseTimeline entries={c.timeline} />
        </div>

        <div className="space-y-6">
          <CustomerPanel detail={data} />
          <DiagnosisPanel detail={data} />
          <ActivityPanel detail={data} />
        </div>
      </div>
    </>
  );
}

function Cell({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: string;
}) {
  return (
    <div className="bg-ink-900 px-5 py-4">
      <dt className="label-eyebrow">{label}</dt>
      <dd className={cn('mt-1.5 text-lg font-medium tracking-tight', tone)}>{value}</dd>
      {hint && <p className="mt-0.5 truncate text-2xs text-silver-600">{hint}</p>}
    </div>
  );
}

function CustomerPanel({ detail }: { detail: CaseDetail }) {
  const f = detail.features;
  const flags: Array<{ label: string; tone: 'warning' | 'negative' }> = [];
  if (detail.customer.contactOptOut) flags.push({ label: 'Opted out of contact', tone: 'negative' });
  if (detail.customer.doNotRetry) flags.push({ label: 'Do not retry', tone: 'negative' });
  if (detail.customer.chargebackCount > 0) {
    flags.push({ label: `${detail.customer.chargebackCount} chargebacks`, tone: 'warning' });
  }
  if (detail.mandateActive === false) flags.push({ label: 'Mandate revoked', tone: 'negative' });

  return (
    <Panel title="Customer" description="The relationship behind the number.">
      <dl className="space-y-2">
        <Line label="Segment" value={SEGMENT_LABELS[detail.customer.segment]} />
        <Line label="Lifetime value" value={formatMinorCompact(f.lifetimeValueMinor)} />
        <Line
          label="Payment history"
          value={`${f.successfulPaymentCount} paid · ${f.failedPaymentCount} failed`}
        />
        <Line label="Success ratio" value={formatPercent(f.successRatio, 0)} />
        <Line
          label="Prior recoveries"
          value={
            f.priorRecoveryAttempts === 0
              ? 'none'
              : `${f.priorRecoverySuccesses}/${f.priorRecoveryAttempts} (${formatPercent(f.priorRecoveryRate, 0)})`
          }
        />
        <Line
          label="Subscription"
          value={
            f.isSubscriber
              ? `active, ${Math.round(f.subscriptionAgeDays ?? 0)} days old`
              : 'none'
          }
        />
        <Line
          label="Alternate instrument"
          value={
            f.hasAlternateSuccessfulMethod
              ? f.alternateMethods.map((m) => METHOD_LABELS[m]).join(', ')
              : 'none on file'
          }
        />
        <Line label="Consecutive failures" value={String(f.consecutiveFailures)} />
        <Line label="Contacts in last 24h" value={String(detail.contactsInLast24h)} />
        <Line label="Timezone" value={detail.customer.timezone} />
      </dl>

      {flags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5 border-t border-white/[0.06] pt-4">
          {flags.map((flag) => (
            <Badge key={flag.label} tone={flag.tone}>
              {flag.label}
            </Badge>
          ))}
        </div>
      )}
    </Panel>
  );
}

function DiagnosisPanel({ detail }: { detail: CaseDetail }) {
  return (
    <Panel title="Failure class" description="What the taxonomy says about this kind of loss.">
      <p className="text-xs font-medium text-silver-200">{detail.profile.label}</p>
      <p className="mt-2 text-xs leading-relaxed text-silver-400 text-pretty">
        {detail.profile.headline}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-silver-500 text-pretty">
        {detail.profile.explanation}
      </p>
      <dl className="mt-4 space-y-2 border-t border-white/[0.06] pt-4">
        <Line
          label="Base recoverability"
          value={formatPercent(detail.profile.baseRecoverability, 0)}
        />
        <Line
          label="Optimal retry window"
          value={
            detail.profile.optimalDelayHours > 0
              ? `${detail.profile.optimalDelayHours}h`
              : 'immediate'
          }
        />
        <Line
          label="Retry possible"
          value={detail.profile.retryPossible ? 'yes' : 'no — instrument is dead'}
        />
        <Line
          label="Customer must act"
          value={detail.profile.customerActionRequired ? 'yes' : 'no'}
        />
        <Line label="Failure code" value={failureLabel(detail.case.failureReason)} />
      </dl>
    </Panel>
  );
}

function ActivityPanel({ detail }: { detail: CaseDetail }) {
  const hasActivity =
    detail.actions.length > 0 || detail.notifications.length > 0 || detail.paymentLinks.length > 0;

  return (
    <Panel
      title="Activity"
      description="Actions taken, messages rendered, links issued."
      bodyClassName="p-0"
    >
      {!hasActivity ? (
        <p className="px-5 py-6 text-center text-xs text-silver-500">
          Nothing has been executed on this case yet.
        </p>
      ) : (
        <div className="divide-y divide-white/[0.05]">
          {detail.paymentLinks.map((link) => (
            <div key={link.id} className="px-5 py-3">
              <p className="text-xs text-silver-200">Payment link issued</p>
              <p className="mt-0.5 font-mono text-2xs text-silver-500">{link.shortUrl}</p>
              <p className="mt-0.5 text-2xs text-silver-600">
                {formatMinorCompact(link.amountMinor)} · expires {formatDateTime(link.expiresAt)}
              </p>
            </div>
          ))}
          {detail.notifications.map((notification) => (
            <details key={notification.id} className="px-5 py-3">
              <summary className="cursor-pointer text-xs text-silver-200">
                {notification.subject}
                <span className="ml-2 text-2xs text-silver-600">
                  {notification.channel} · {notification.status}
                </span>
              </summary>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-ink-950/60 p-3 text-2xs leading-relaxed text-silver-400">
                {notification.body}
              </pre>
            </details>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-2xs text-silver-500">{label}</dt>
      <dd className="tnum min-w-0 truncate text-right text-2xs text-silver-200">{value}</dd>
    </div>
  );
}

const TIMELINE_TONE: Record<CaseTimelineEntry['kind'], string> = {
  detected: 'bg-risk-500',
  investigated: 'bg-info-500',
  predicted: 'bg-info-500',
  decided: 'bg-info-500',
  policy_evaluated: 'bg-silver-600',
  action_executed: 'bg-mint-500',
  action_blocked: 'bg-risk-500',
  action_failed: 'bg-loss-500',
  fallback_taken: 'bg-risk-500',
  outcome_recorded: 'bg-mint-500',
  escalated: 'bg-risk-500',
  closed: 'bg-silver-600',
  note: 'bg-silver-700',
};

function CaseTimeline({ entries }: { entries: CaseTimelineEntry[] }) {
  return (
    <Panel
      title="Customer recovery timeline"
      description="Every step this case has been through, in the order it happened."
      bodyClassName="p-0"
    >
      <ol className="relative px-5 py-4">
        {/* The rail sits behind the markers rather than between them, so the line is
            continuous and the markers sit on it. */}
        <span
          aria-hidden
          className="absolute bottom-6 left-[26px] top-6 w-px bg-white/[0.07]"
        />
        {entries.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className="relative flex gap-4 py-2.5">
            <span
              aria-hidden
              className={cn(
                'relative z-10 mt-1 h-2 w-2 shrink-0 rounded-full ring-4 ring-ink-900',
                TIMELINE_TONE[entry.kind],
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-xs leading-relaxed text-silver-200 text-pretty">
                  {entry.summary}
                </p>
                <time className="shrink-0 text-2xs text-silver-600" dateTime={entry.at}>
                  {formatDateTime(entry.at)}
                </time>
              </div>
              <p className="mt-0.5 text-2xs text-silver-600">
                {entry.kind.replace(/_/g, ' ')}
                {entry.amountMinor !== null && entry.amountMinor > 0
                  ? ` · ${formatMinorCompact(entry.amountMinor)}`
                  : ''}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
