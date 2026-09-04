'use client';

import type { PolicyDecision } from '@reclaim/core';
import {
  STRATEGY_LABELS,
  VERDICT_LABELS,
  VERDICT_TONES,
  formatCount,
  formatDateTime,
  formatMinorCompact,
  formatPercent,
  policyReasonLabel,
} from '@reclaim/core/presentation';
import { useApi } from '@/lib/use-api';
import { MetricGrid, MetricTile, PageHeader } from '@/components/dashboard/metrics';
import { Badge, ErrorState, Panel, ProportionBar, Skeleton, cn } from '@/components/ui/primitives';

interface PolicyRule {
  id: string;
  name: string;
  value: string;
  description: string;
  reasonCode: string;
  enforcement: { pass: number; fail: number; warn: number; skip: number };
  blockedCount: number;
}

interface PolicyPayload {
  version: string;
  rules: PolicyRule[];
  totals: { evaluations: number; allow: number; deny: number; require_human: number };
  topReasons: Array<{ code: string; count: number }>;
  recentDecisions: PolicyDecision[];
}

/**
 * THE GUARDRAIL RULEBOOK
 *
 * What the policy engine enforces, and what it has actually done. The rules are described
 * from the running configuration, so changing a limit in the environment changes what
 * this page says — there is no prose here that can drift from the code.
 */
export default function PolicyPage() {
  const { data, error, loading, refreshing, refresh, lastUpdated } = useApi<PolicyPayload>(
    '/api/policy',
    { pollMs: 30_000 },
  );

  if (error) {
    return (
      <>
        <PageHeader title="Policy & guardrails" description="What the engine is allowed to do." />
        <ErrorState message={error.message} onRetry={() => void refresh()} />
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Policy & guardrails" description="What the engine is allowed to do." />
        <MetricGrid columns={4}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </MetricGrid>
      </>
    );
  }

  if (!data) return null;

  const { totals } = data;
  const allowRate = totals.evaluations === 0 ? 0 : totals.allow / totals.evaluations;

  return (
    <>
      <PageHeader
        title="Policy & guardrails"
        description="The deterministic layer between a recommendation and a charge. The AI proposes; this authorises."
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        actions={<Badge tone="neutral">{data.version}</Badge>}
      />

      <MetricGrid columns={4}>
        <MetricTile
          label="Evaluations"
          value={formatCount(totals.evaluations)}
          definition="Every proposed action is evaluated, including the ones that were allowed and the ones that were merely 'stop recovery'. Nothing reaches a provider unevaluated."
          hint={`${formatPercent(allowRate)} allowed`}
          tone="neutral"
        />
        <MetricTile
          label="Allowed"
          value={formatCount(totals.allow)}
          definition="Actions that cleared every guardrail and were permitted to execute."
          tone="positive"
        />
        <MetricTile
          label="Denied"
          value={formatCount(totals.deny)}
          definition="Actions refused outright. Each denial carries machine-readable reason codes that the executor uses to pick a fallback."
          tone="negative"
        />
        <MetricTile
          label="Sent to a human"
          value={formatCount(totals.require_human)}
          definition="Actions above the automated ceiling, or high-value cases the model was not confident about. Automation prepared them; a person decides."
          tone="warning"
        />
      </MetricGrid>

      <Panel
        className="mt-6"
        title="The rulebook"
        description="Every guardrail in force, with the value it is currently set to and how often it has fired."
        bodyClassName="p-0"
      >
        <ul className="divide-y divide-white/[0.05]">
          {data.rules.map((rule) => {
            const evaluated =
              rule.enforcement.pass + rule.enforcement.fail + rule.enforcement.warn;
            const failRate = evaluated === 0 ? 0 : (rule.enforcement.fail + rule.enforcement.warn) / evaluated;
            return (
              <li key={rule.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-xs font-medium text-silver-100">{rule.name}</h3>
                      <Badge tone="neutral">{rule.value}</Badge>
                    </div>
                    <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-silver-500 text-pretty">
                      {rule.description}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tnum text-xs text-silver-300">
                      {formatCount(rule.blockedCount)}
                      <span className="ml-1.5 text-2xs text-silver-600">blocked</span>
                    </p>
                    <p className="tnum text-2xs text-silver-600">
                      {formatCount(rule.enforcement.pass)} passed
                    </p>
                  </div>
                </div>
                {evaluated > 0 && (
                  <ProportionBar
                    value={failRate}
                    tone={failRate > 0 ? 'warning' : 'positive'}
                    className="mt-2.5"
                    label={`${rule.name} block rate`}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </Panel>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Panel
          title="Why actions were blocked"
          description="Reason codes across every denial and escalation."
        >
          {data.topReasons.length === 0 ? (
            <p className="text-xs text-silver-500">
              Nothing has been blocked yet. Run a batch to exercise the guardrails.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {data.topReasons.map((reason) => {
                const max = data.topReasons[0]?.count ?? 1;
                return (
                  <li key={reason.code}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-xs text-silver-300">
                        {policyReasonLabel(reason.code)}
                      </span>
                      <span className="tnum shrink-0 text-2xs text-silver-500">
                        {formatCount(reason.count)}
                      </span>
                    </div>
                    <ProportionBar
                      value={reason.count / max}
                      tone="warning"
                      className="mt-1"
                      label={`${policyReasonLabel(reason.code)} count`}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          className="lg:col-span-2"
          title="Recent evaluations"
          description="The last thirty guardrail decisions, newest first."
          bodyClassName="p-0"
        >
          {data.recentDecisions.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-silver-500">
              No policy decisions recorded yet.
            </p>
          ) : (
            <div className="max-h-[520px] overflow-auto">
              <table className="w-full border-collapse text-xs">
                <caption className="sr-only">Recent policy decisions</caption>
                <thead className="sticky top-0 bg-ink-900">
                  <tr className="border-b border-white/[0.06]">
                    <th scope="col" className="px-5 py-2.5 text-left font-medium text-silver-500">
                      Verdict
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium text-silver-500">
                      Strategy
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium text-silver-500">
                      Amount
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-left font-medium text-silver-500">
                      Reasons
                    </th>
                    <th scope="col" className="px-5 py-2.5 text-right font-medium text-silver-500">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentDecisions.map((decision) => (
                    <tr key={decision.id} className="border-b border-white/[0.04] last:border-0">
                      <td className="px-5 py-2.5">
                        <Badge dot tone={VERDICT_TONES[decision.verdict]}>
                          {VERDICT_LABELS[decision.verdict]}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-silver-300">
                        {STRATEGY_LABELS[decision.requestedStrategy]}
                      </td>
                      <td className="tnum px-3 py-2.5 text-right text-silver-400">
                        {formatMinorCompact(decision.amountMinor)}
                      </td>
                      <td className="px-3 py-2.5">
                        {decision.reasonCodes.length === 0 ? (
                          <span className="text-silver-600">—</span>
                        ) : (
                          <span className="text-2xs text-risk-400">
                            {decision.reasonCodes.map(policyReasonLabel).join(', ')}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-right text-2xs text-silver-600">
                        {formatDateTime(decision.evaluatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel
        className="mt-6"
        title="Why this layer is deterministic"
        description="A design note, not a disclaimer."
      >
        <div className={cn('grid gap-6 md:grid-cols-2')}>
          <div>
            <p className="text-xs leading-relaxed text-silver-400 text-pretty">
              Every check in this engine is a pure function of its inputs. Given the same case, the
              same customer and the same clock, it returns the same verdict — no network calls, no
              sampling, no model. That is what makes a denial reviewable months later, and what lets
              the test suite assert on guardrail behaviour rather than hope for it.
            </p>
          </div>
          <div>
            <p className="text-xs leading-relaxed text-silver-400 text-pretty">
              Three properties are load-bearing. Every check runs even after one has already failed,
              so the audit record contains all of them rather than the first. A check can only ever
              restrict — there is no path where one upgrades a denial into an approval. And missing
              evidence resolves to the restrictive branch, never the permissive one.
            </p>
          </div>
        </div>
      </Panel>
    </>
  );
}
