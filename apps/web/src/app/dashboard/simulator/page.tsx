'use client';

import { useState } from 'react';
import type { PolicySimulationResult, SimulationReport } from '@reclaim/core';
import { STRATEGY_LABELS, formatCount, formatMinorCompact, formatPercent } from '@reclaim/core/presentation';
import { useMutation } from '@/lib/use-api';
import { MetricGrid, MetricTile, PageHeader } from '@/components/dashboard/metrics';
import { PolicyComparisonChart } from '@/components/charts/charts';
import { Badge, Button, ErrorState, Panel, Surface, cn } from '@/components/ui/primitives';

interface SimulationPayload {
  report: SimulationReport;
  floorSweep: Array<{
    floorMinor: number;
    interventions: number;
    netValueMinor: number;
    recoveredMinor: number;
  }>;
}

/**
 * THE STRATEGY SIMULATOR
 *
 * Runs the case portfolio under six different recovery policies and reports what each
 * would have produced.
 *
 * The page is explicit about what this is: outcomes are sampled from the model's
 * probabilities, not observed. That makes it a counterfactual, and it inherits whatever
 * error the model has. What makes it useful rather than decorative is that every policy
 * faces the identical case set with identical seeded draws — so the difference between
 * two policies is attributable to the decision rather than to luck.
 */
export default function SimulatorPage() {
  const [limit, setLimit] = useState(400);
  const [seed, setSeed] = useState(424242);

  const simulate = useMutation<{ limit: number; seed: number }, SimulationPayload>('/api/simulate');
  const report = simulate.data?.report ?? null;
  const sweep = simulate.data?.floorSweep ?? [];

  return (
    <>
      <PageHeader
        title="Strategy simulator"
        description="What would the same portfolio have produced under a different recovery policy?"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-2xs text-silver-500">
              Cases
              <input
                type="number"
                min={10}
                max={2000}
                step={50}
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
                className="tnum h-8 w-20 rounded-lg border border-white/[0.09] bg-ink-850 px-2 text-xs text-silver-200 outline-none focus-visible:ring-2 focus-visible:ring-mint-500/60"
              />
            </label>
            <label className="flex items-center gap-1.5 text-2xs text-silver-500">
              Seed
              <input
                type="number"
                value={seed}
                onChange={(event) => setSeed(Number(event.target.value))}
                className="tnum h-8 w-24 rounded-lg border border-white/[0.09] bg-ink-850 px-2 text-xs text-silver-200 outline-none focus-visible:ring-2 focus-visible:ring-mint-500/60"
              />
            </label>
            <Button
              variant="primary"
              loading={simulate.pending}
              onClick={() => void simulate.run({ limit, seed })}
            >
              Run simulation
            </Button>
          </div>
        }
      />

      <Surface className="mb-6 px-5 py-4">
        <p className="text-xs leading-relaxed text-silver-400 text-pretty">
          <strong className="text-silver-200">What this is.</strong> Each policy is applied to the
          same set of open cases. For every case, the strategy that policy would choose is priced by
          the expected-value engine, and the outcome is drawn against that probability using a
          generator seeded on the case id — never on the policy. Two policies that choose the same
          action for a case therefore get the same result for it, and every difference in the table
          below comes from a difference in decision.
        </p>
        <p className="mt-2.5 text-xs leading-relaxed text-silver-500 text-pretty">
          <strong className="text-silver-300">What this is not.</strong> These outcomes are sampled,
          not observed. The simulation is only as good as the model&apos;s probabilities, and it
          should be read as a comparison between policies rather than a forecast of any one of them.
        </p>
      </Surface>

      {simulate.error && <ErrorState message={simulate.error.message} />}

      {!report && !simulate.pending && !simulate.error && (
        <Surface>
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <h2 className="text-sm font-medium text-silver-200">No simulation run yet</h2>
            <p className="max-w-md text-xs leading-relaxed text-silver-500 text-pretty">
              Run the simulator to compare RECLAIM&apos;s expected-value policy against retrying
              everything, messaging everyone, a hand-written rule, a model-threshold-only policy,
              and doing nothing at all.
            </p>
            <Button variant="primary" onClick={() => void simulate.run({ limit, seed })}>
              Run simulation
            </Button>
          </div>
        </Surface>
      )}

      {report && (
        <>
          <MetricGrid columns={4}>
            <MetricTile
              label="Cases evaluated"
              value={formatCount(report.casesEvaluated)}
              definition="Open cases included in the comparison. Each policy sees exactly this set."
              hint={`${formatMinorCompact(report.amountAtRiskMinor)} at risk`}
              tone="neutral"
            />
            <MetricTile
              label="Best policy"
              value={report.results[0]?.label ?? '—'}
              definition="The policy with the highest net value: recovered rupees minus intervention cost."
              hint={`${formatMinorCompact(report.winner.netValueMinor)} net`}
              tone="positive"
              emphasis
            />
            <MetricTile
              label="Uplift over doing nothing"
              value={formatMinorCompact(report.winner.upliftOverControlMinor)}
              definition="How much more the winning policy earns than the do-nothing control. A policy that cannot beat the control is destroying value."
              tone="positive"
            />
            <MetricTile
              label="Run time"
              value={`${(report.durationMs / 1000).toFixed(1)}s`}
              definition="Wall-clock time to price and simulate every policy across the whole case set."
              hint={`seed ${report.seed} — reproducible`}
              tone="neutral"
            />
          </MetricGrid>

          <div className="mt-6">
            <PolicyComparisonChart
              results={report.results.map((r) => ({
                policy: r.policy,
                label: r.label,
                netValueMinor: r.netValueMinor,
                recoveredMinor: r.recoveredMinor,
                interventionCostMinor: r.interventionCostMinor,
                interventions: r.interventions,
                abstentions: r.abstentions,
                recoveryRate: r.recoveryRate,
                returnOnSpend: r.returnOnSpend,
              }))}
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Panel
              title="Policy detail"
              description="What each policy does, and what it costs to do it."
              bodyClassName="p-0"
            >
              <ul className="divide-y divide-white/[0.05]">
                {report.results.map((result, index) => (
                  <PolicyRow key={result.policy} result={result} rank={index} />
                ))}
              </ul>
            </Panel>

            <Panel
              title="Where to set the value floor"
              description="Net value as the minimum expected value required to act is raised."
            >
              <p className="mb-4 text-xs leading-relaxed text-silver-500 text-pretty">
                Raising the floor means working fewer cases but wasting less on the ones that were
                never going to recover. The peak of this curve is where a merchant should set{' '}
                <code className="text-mint-400">POLICY_MIN_EXPECTED_VALUE_MINOR</code>.
              </p>
              <table className="w-full border-collapse text-xs">
                <caption className="sr-only">Net value at each expected-value floor</caption>
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th scope="col" className="py-2 pr-3 text-left font-medium text-silver-500">
                      Floor
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium text-silver-500">
                      Cases worked
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium text-silver-500">
                      Recovered
                    </th>
                    <th scope="col" className="py-2 pl-3 text-right font-medium text-silver-500">
                      Net value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sweep.map((row) => {
                    const best = Math.max(...sweep.map((r) => r.netValueMinor));
                    const isBest = row.netValueMinor === best;
                    return (
                      <tr
                        key={row.floorMinor}
                        className={cn(
                          'border-b border-white/[0.04] last:border-0',
                          isBest && 'bg-mint-500/[0.05]',
                        )}
                      >
                        <td className="tnum py-2 pr-3 text-silver-300">
                          {formatMinorCompact(row.floorMinor)}
                          {isBest && (
                            <Badge tone="positive" className="ml-2">
                              best
                            </Badge>
                          )}
                        </td>
                        <td className="tnum px-3 py-2 text-right text-silver-400">
                          {formatCount(row.interventions)}
                        </td>
                        <td className="tnum px-3 py-2 text-right text-silver-400">
                          {formatMinorCompact(row.recoveredMinor)}
                        </td>
                        <td
                          className={cn(
                            'tnum py-2 pl-3 text-right font-medium',
                            isBest ? 'text-mint-400' : 'text-silver-300',
                          )}
                        >
                          {formatMinorCompact(row.netValueMinor)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

function PolicyRow({ result, rank }: { result: PolicySimulationResult; rank: number }) {
  return (
    <li className={cn('px-5 py-4', rank === 0 && 'bg-mint-500/[0.04]')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-silver-100">{result.label}</h3>
            {rank === 0 && <Badge tone="positive">best net value</Badge>}
          </div>
          <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-silver-500 text-pretty">
            {result.description}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={cn(
              'tnum text-sm font-medium',
              result.netValueMinor > 0 ? 'text-mint-400' : 'text-silver-500',
            )}
          >
            {formatMinorCompact(result.netValueMinor)}
          </p>
          <p className="text-2xs text-silver-600">net value</p>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-1 sm:grid-cols-4">
        <Stat label="Actions" value={formatCount(result.interventions)} />
        <Stat label="Left alone" value={formatCount(result.abstentions)} />
        <Stat label="Recovered" value={formatMinorCompact(result.recoveredMinor)} />
        <Stat label="Return on spend" value={`${result.returnOnSpend.toFixed(1)}x`} />
      </dl>

      {result.strategyMix.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {result.strategyMix.slice(0, 4).map((entry) => (
            <Badge key={entry.strategy} tone="neutral">
              {STRATEGY_LABELS[entry.strategy]} · {formatPercent(entry.share, 0)}
            </Badge>
          ))}
        </div>
      )}
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs text-silver-600">{label}</dt>
      <dd className="tnum text-xs text-silver-300">{value}</dd>
    </div>
  );
}
