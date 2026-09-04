'use client';

import type { ControlTowerMetrics, PolicyAmendmentProposal, RegretLedger } from '@reclaim/core';
import { formatCount, formatMinorCompact, formatPercent } from '@reclaim/core/presentation';
import { useApi } from '@/lib/use-api';
import { MetricGrid, MetricTile, PageHeader } from '@/components/dashboard/metrics';
import {
  Badge,
  ErrorState,
  Panel,
  ProportionBar,
  Skeleton,
  cn,
} from '@/components/ui/primitives';

interface RegretPayload {
  ledger: RegretLedger;
  overview: ControlTowerMetrics;
}

/**
 * THE GUARDRAIL REGRET LEDGER
 *
 * Recovery products report what they recovered. This page reports what the safety rules
 * cost — because a guardrail nobody can price only ever ratchets tighter.
 *
 * The page is built to be read sceptically. Facts and estimates are visually separated,
 * every estimate carries its sample size, and rows with too little evidence show a dash
 * rather than a confident-looking number. The caveat on each row is not fine print: it
 * states what would have to be true for that row to mislead you.
 */
export default function RegretPage() {
  const { data, error, loading, refresh } = useApi<RegretPayload>('/api/regret', {
    pollMs: 60_000,
  });

  const header = (
    <PageHeader
      title="Guardrail regret ledger"
      description="What the safety rules stopped, what that prevented, and what it cost."
    />
  );

  if (error) {
    return (
      <>
        {header}
        <ErrorState message={error.message} onRetry={() => void refresh()} />
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        {header}
        <MetricGrid columns={4}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </MetricGrid>
        <Skeleton className="mt-6 h-[420px] rounded-xl" />
      </>
    );
  }

  if (!data) return null;

  const { ledger } = data;
  const { totals, evidenceBase } = ledger;
  const maxExposure = Math.max(1, ...ledger.rows.map((r) => r.blockedExposureMinor));

  return (
    <>
      {header}

      <MetricGrid columns={4}>
        <MetricTile
          label="Blocked exposure"
          value={formatMinorCompact(totals.blockedExposureMinor)}
          definition="Total amount at risk on the distinct cases a guardrail stopped. A counted fact, not an estimate."
          hint={`${formatCount(totals.blockedDecisions)} decisions · ${formatCount(totals.blockedCases)} cases`}
          tone="neutral"
        />
        <MetricTile
          label="Estimated foregone"
          value={formatMinorCompact(totals.estimatedForegoneMinor)}
          definition="Blocked exposure multiplied by the recovery rate the same strategies actually realised where they were permitted. An estimate from realised outcomes, not from the model."
          hint="upper bound · unadjusted"
          tone="warning"
        />
        <MetricTile
          label="Harm prevented (priced)"
          value={formatMinorCompact(totals.pricedHarmPreventedMinor)}
          definition="Only harms with an unambiguous cash value: duplicate charges refused, and charges to customers already over the chargeback limit."
          hint={`${totals.rowsWithoutEstimate} row${totals.rowsWithoutEstimate === 1 ? '' : 's'} unpriceable`}
          tone="positive"
        />
        <MetricTile
          label="Net regret"
          value={formatMinorCompact(totals.netRegretMinor)}
          definition="Estimated foregone recovery minus priced harm prevented. Positive means the guardrails cost more than the harm they can be shown to have avoided."
          hint="not a mandate to loosen"
          tone={totals.netRegretMinor > 0 ? 'negative' : 'positive'}
          emphasis
        />
      </MetricGrid>

      <p className="mt-4 text-xs leading-relaxed text-silver-500">
        Estimates compare each blocked strategy against{' '}
        <span className="text-silver-300">{formatCount(evidenceBase.outcomes)}</span> realised
        outcomes for that same strategy. The comparison is matched on strategy but{' '}
        <span className="text-silver-300">not covariate-adjusted</span> — cases a guardrail blocks
        are not a random sample of the cases it permits. Read every figure in the foregone column
        as an upper bound.
      </p>

      <Panel
        className="mt-6"
        title="Every guardrail, priced"
        description="Facts on the left of the divider, estimates on the right."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-left text-[11px] uppercase tracking-wider text-silver-500">
                <th className="px-5 py-3 font-medium">Guardrail</th>
                <th className="px-3 py-3 text-right font-medium">Cases</th>
                <th className="px-3 py-3 text-right font-medium">Exposure</th>
                <th className="px-3 py-3 font-medium">Prevented</th>
                <th className="border-l border-white/[0.06] px-3 py-3 text-right font-medium">
                  Realised rate
                </th>
                <th className="px-3 py-3 text-right font-medium">Est. foregone</th>
                <th className="px-5 py-3 text-right font-medium">n</th>
              </tr>
            </thead>
            <tbody>
              {ledger.rows.map((row) => (
                <tr
                  key={row.reasonCode}
                  className="border-b border-white/[0.04] align-top last:border-0"
                >
                  <td className="px-5 py-3">
                    <div className="font-medium text-silver-100">{row.label}</div>
                    <div className="mt-1 max-w-[280px] text-[11px] leading-snug text-silver-500">
                      {row.caveat}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-silver-300">
                    {formatCount(row.blockedCases)}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="tabular-nums text-silver-100">
                      {formatMinorCompact(row.blockedExposureMinor)}
                    </div>
                    <ProportionBar
                      value={row.blockedExposureMinor / maxExposure}
                      tone="neutral"
                      className="mt-1.5"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <div className="tabular-nums text-silver-200">
                      {formatCount(row.harmPrevented.count)}
                    </div>
                    <div className="mt-0.5 max-w-[200px] text-[11px] leading-snug text-silver-500">
                      {row.harmPrevented.unit}
                    </div>
                    {row.harmPrevented.pricedMinor !== null && (
                      <div className="mt-1 text-[11px] text-mint-400">
                        {formatMinorCompact(row.harmPrevented.pricedMinor)} avoided
                      </div>
                    )}
                  </td>
                  <td className="border-l border-white/[0.06] px-3 py-3 text-right tabular-nums text-silver-300">
                    {row.comparableRecoveryRate === null ? (
                      <span className="text-silver-600">—</span>
                    ) : (
                      formatPercent(row.comparableRecoveryRate)
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {row.estimatedForegoneMinor === null ? (
                      <span className="text-silver-600">—</span>
                    ) : (
                      <span className="tabular-nums text-risk-400">
                        {formatMinorCompact(row.estimatedForegoneMinor)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-[11px] text-silver-600">
                    {formatCount(row.comparableSampleSize)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        className="mt-6"
        title="Proposed policy amendments"
        description="The engine proposes. A human disposes. Nothing here is ever applied automatically."
      >
        {ledger.proposals.length === 0 ? (
          <div className="px-5 py-8 text-sm text-silver-400">
            No amendment is warranted against the current evidence. Guardrails carrying regret are
            either consent-bound — where the foregone figure is simply what compliance costs — or
            already scoped narrowly enough that no bounded change would recover value.
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {ledger.proposals.map((proposal) => (
              <ProposalRow key={proposal.id} proposal={proposal} />
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function ProposalRow({ proposal }: { proposal: PolicyAmendmentProposal }) {
  const confidenceTone =
    proposal.confidence === 'high'
      ? 'positive'
      : proposal.confidence === 'medium'
        ? 'warning'
        : 'neutral';

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-silver-100">{proposal.title}</span>
            <Badge tone={confidenceTone}>
              {proposal.confidence} confidence · n={formatCount(proposal.sampleSize)}
            </Badge>
          </div>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-silver-400">
            {proposal.rationale}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2 font-mono text-[11px]">
            <span className="text-silver-500">{proposal.change.key}</span>
            <span className="rounded bg-white/[0.04] px-1.5 py-0.5 text-silver-400 line-through">
              {proposal.change.from}
            </span>
            <span className="text-silver-600">→</span>
            <span className="rounded bg-mint-500/10 px-1.5 py-0.5 text-mint-400">
              {proposal.change.to}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div
            className={cn(
              'tabular-nums text-lg font-semibold',
              proposal.estimatedRecoveryDeltaMinor > 0 ? 'text-mint-400' : 'text-silver-400',
            )}
          >
            +{formatMinorCompact(proposal.estimatedRecoveryDeltaMinor)}
          </div>
          <div className="text-[11px] text-silver-500">projected recovery</div>
          {proposal.estimatedHarmDeltaMinor === 0 && (
            <div className="mt-1 text-[11px] text-silver-500">no added customer contact</div>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-silver-500">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-risk-400" />
        Requires human approval — RECLAIM never edits its own guardrails.
      </div>
    </li>
  );
}
