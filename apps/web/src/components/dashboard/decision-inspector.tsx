'use client';

import type { AIDecision, PolicyDecision, RecoveryAction, RecoveryOutcome, StrategyCandidate } from '@reclaim/core';
import {
  ACTION_STATUS_LABELS,
  ACTION_STATUS_TONES,
  OUTCOME_LABELS,
  OUTCOME_TONES,
  STRATEGY_LABELS,
  VERDICT_LABELS,
  VERDICT_TONES,
  formatDateTime,
  formatMinor,
  formatMinorCompact,
  formatPercent,
  policyReasonLabel,
} from '@reclaim/core/presentation';
import { Badge, Panel, ProportionBar, cn } from '@/components/ui/primitives';

/**
 * THE DECISION INSPECTOR
 *
 * For any recommendation the engine made, this shows the full chain: what problem was
 * detected, which signals the model weighed, what each strategy was worth, which
 * guardrails ran and what they said, what was executed, and what actually happened.
 *
 * It deliberately shows concise decision explanations rather than raw model reasoning.
 * A reviewer needs the evidence and the conclusion, not a transcript.
 */

export function DecisionInspector({
  decision,
  policyDecisions,
  actions,
  outcomes,
}: {
  decision: AIDecision;
  policyDecisions: PolicyDecision[];
  actions: RecoveryAction[];
  outcomes: RecoveryOutcome[];
}) {
  const relatedPolicy = policyDecisions.filter((p) => p.aiDecisionId === decision.id);
  const policy = relatedPolicy[0] ?? policyDecisions[0] ?? null;
  const relatedActions = actions.filter((a) => a.aiDecisionId === decision.id);
  const action = relatedActions[0] ?? null;
  const outcome = outcomes.find((o) => o.actionId === action?.id) ?? outcomes[0] ?? null;

  return (
    <Panel
      title="AI decision inspector"
      description="The complete chain from detected problem to measured outcome."
      bodyClassName="p-0"
      actions={
        <Badge tone={decision.reasoner.degraded ? 'warning' : 'accent'}>
          {decision.reasoner.kind === 'llm' ? decision.reasoner.model : 'Deterministic reasoner'}
          {decision.reasoner.degraded ? ' · degraded' : ''}
        </Badge>
      }
    >
      {decision.reasoner.degraded && decision.reasoner.degradedReason && (
        <div className="border-b border-white/[0.06] bg-risk-500/[0.05] px-5 py-3">
          <p className="text-2xs leading-relaxed text-risk-400">
            This explanation came from the fallback path: {decision.reasoner.degradedReason}. The
            decision itself is unaffected — the model, the expected-value engine and the policy
            engine all ran normally.
          </p>
        </div>
      )}

      <Step index={1} label="Detected problem">
        <p className="text-xs leading-relaxed text-silver-200">{decision.detectedProblem}</p>
        <p className="mt-2 text-xs leading-relaxed text-silver-400 text-pretty">
          {decision.diagnosis.headline}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-silver-500 text-pretty">
          {decision.diagnosis.explanation}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone="neutral">{decision.diagnosis.category.replace(/_/g, ' ')}</Badge>
          <Badge tone={decision.diagnosis.selfResolving ? 'positive' : 'neutral'}>
            {decision.diagnosis.selfResolving ? 'Clears on its own' : 'Does not self-resolve'}
          </Badge>
          <Badge tone={decision.diagnosis.customerActionRequired ? 'warning' : 'positive'}>
            {decision.diagnosis.customerActionRequired
              ? 'Customer must act'
              : 'No customer action needed'}
          </Badge>
          {decision.diagnosis.recommendedWindowHours > 0 && (
            <Badge tone="neutral">
              Best retry window {decision.diagnosis.recommendedWindowHours}h
            </Badge>
          )}
        </div>
      </Step>

      <Step index={2} label="Signals the model weighed">
        <p className="mb-3 text-2xs text-silver-600">
          Contribution is in log-odds. A positive value pushed the probability up; a negative one
          pulled it down.
        </p>
        <ul className="space-y-2">
          {decision.signals.map((signal) => {
            const magnitude = Math.min(1, Math.abs(signal.contribution ?? 0) / 1.2);
            return (
              <li key={signal.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-xs text-silver-300">{signal.label}</span>
                  <span className="tnum shrink-0 text-2xs text-silver-500">
                    {typeof signal.value === 'number' ? signal.value.toFixed(3) : String(signal.value)}
                    {signal.contribution !== null && (
                      <span
                        className={cn(
                          'ml-2',
                          signal.direction === 'positive'
                            ? 'text-mint-400'
                            : signal.direction === 'negative'
                              ? 'text-loss-400'
                              : 'text-silver-600',
                        )}
                      >
                        {signal.contribution >= 0 ? '+' : ''}
                        {signal.contribution.toFixed(3)}
                      </span>
                    )}
                  </span>
                </div>
                <ProportionBar
                  value={magnitude}
                  tone={signal.direction === 'positive' ? 'positive' : signal.direction === 'negative' ? 'negative' : 'neutral'}
                  className="mt-1"
                  label={`${signal.label} contribution`}
                />
              </li>
            );
          })}
        </ul>
      </Step>

      <Step index={3} label="Recovery probability">
        <div className="flex items-baseline gap-4">
          <span className="text-3xl font-medium tracking-tight text-silver-50">
            {formatPercent(decision.recoveryProbability, 1)}
          </span>
          <span className="text-2xs text-silver-500">
            from {decision.modelVersion}
          </span>
        </div>
        <p className="mt-2 text-2xs leading-relaxed text-silver-600 text-pretty">
          This is the probability the money comes back given a well-chosen intervention. It is not
          the probability that any particular action succeeds — that is priced per strategy below.
        </p>
      </Step>

      <Step index={4} label="Strategies priced">
        <StrategyTable candidates={decision.candidates} chosen={decision.recommendedStrategy} />
      </Step>

      <Step index={5} label="Recommendation">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent" size="md">
            {STRATEGY_LABELS[decision.recommendedStrategy]}
          </Badge>
          <span className="tnum text-xs text-silver-300">
            {formatMinor(decision.expectedValueMinor)} expected value
          </span>
          <span className="text-2xs text-silver-600">
            {formatPercent(decision.confidence, 0)} confidence
          </span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-silver-400 text-pretty">
          {decision.explanation}
        </p>
      </Step>

      <Step index={6} label="Policy checks">
        {policy ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge dot tone={VERDICT_TONES[policy.verdict]} size="md">
                {VERDICT_LABELS[policy.verdict]}
              </Badge>
              <span className="text-2xs text-silver-600">
                {policy.policyVersion} · evaluated in {policy.durationMs}ms
              </span>
            </div>
            {policy.reasonCodes.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {policy.reasonCodes.map((code) => (
                  <Badge key={code} tone="warning">
                    {policyReasonLabel(code)}
                  </Badge>
                ))}
              </div>
            )}
            <ul className="space-y-1.5">
              {policy.checks.map((check) => (
                <li key={check.id} className="flex items-start gap-2.5">
                  <CheckGlyph result={check.result} />
                  <div className="min-w-0">
                    <p className="text-xs text-silver-300">{check.name}</p>
                    <p className="text-2xs leading-relaxed text-silver-600">{check.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
            {policy.suggestedAlternative && (
              <p className="mt-3 text-2xs text-silver-500">
                Suggested alternative:{' '}
                <span className="text-silver-300">
                  {STRATEGY_LABELS[policy.suggestedAlternative]}
                </span>
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-silver-500">
            No policy evaluation recorded for this decision — it was a recommendation only.
          </p>
        )}
      </Step>

      <Step index={7} label="Action executed" last={!outcome}>
        {relatedActions.length === 0 ? (
          <p className="text-xs text-silver-500">
            No action was executed for this decision. It was produced in recommend-only mode.
          </p>
        ) : (
          <ul className="space-y-2">
            {relatedActions.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/[0.06] px-3 py-2"
              >
                <Badge dot tone={ACTION_STATUS_TONES[item.status]}>
                  {ACTION_STATUS_LABELS[item.status]}
                </Badge>
                <span className="text-xs text-silver-300">{STRATEGY_LABELS[item.strategy]}</span>
                <span className="tnum text-2xs text-silver-500">
                  {formatMinorCompact(item.amountMinor)}
                </span>
                {item.providerRef && (
                  <span className="font-mono text-2xs text-silver-600">{item.providerRef}</span>
                )}
                {item.durationMs !== null && (
                  <span className="tnum text-2xs text-silver-600">{item.durationMs}ms</span>
                )}
                {item.error && (
                  <span className="w-full text-2xs leading-relaxed text-loss-400">{item.error}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Step>

      {outcome && (
        <Step index={8} label="Measured outcome" last>
          <div className="flex flex-wrap items-center gap-3">
            <Badge dot tone={OUTCOME_TONES[outcome.outcome]} size="md">
              {OUTCOME_LABELS[outcome.outcome]}
            </Badge>
            {outcome.recoveredAmountMinor > 0 && (
              <span className="tnum text-sm font-medium text-mint-400">
                {formatMinor(outcome.recoveredAmountMinor, { whole: true })} recovered
              </span>
            )}
          </div>
          <dl className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            <Row label="Predicted probability" value={formatPercent(outcome.predictedProbability, 1)} />
            <Row label="Amount at risk" value={formatMinorCompact(outcome.amountAtRiskMinor)} />
            <Row
              label="Time to outcome"
              value={`${(outcome.timeToOutcomeMs / 3_600_000).toFixed(1)}h`}
            />
            <Row label="Recorded" value={formatDateTime(outcome.recordedAt)} />
          </dl>
        </Step>
      )}
    </Panel>
  );
}

function Step({
  index,
  label,
  children,
  last,
}: {
  index: number;
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section className={cn('px-5 py-4', !last && 'border-b border-white/[0.06]')}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="font-mono text-2xs text-mint-500">
          {String(index).padStart(2, '0')}
        </span>
        <h3 className="label-eyebrow">{label}</h3>
      </div>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] pb-1">
      <dt className="text-2xs text-silver-500">{label}</dt>
      <dd className="tnum text-2xs text-silver-200">{value}</dd>
    </div>
  );
}

function CheckGlyph({ result }: { result: 'pass' | 'fail' | 'warn' | 'skip' }) {
  const config = {
    pass: { symbol: '✓', className: 'text-mint-400 border-mint-500/30 bg-mint-500/10' },
    fail: { symbol: '✕', className: 'text-loss-400 border-loss-500/30 bg-loss-500/10' },
    warn: { symbol: '!', className: 'text-risk-400 border-risk-500/30 bg-risk-500/10' },
    skip: { symbol: '–', className: 'text-silver-600 border-white/[0.08] bg-white/[0.02]' },
  }[result];

  return (
    <span
      aria-label={result}
      className={cn(
        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[9px] leading-none',
        config.className,
      )}
    >
      {config.symbol}
    </span>
  );
}

export function StrategyTable({
  candidates,
  chosen,
}: {
  candidates: StrategyCandidate[];
  chosen?: string;
}) {
  const best = Math.max(...candidates.map((c) => c.expectedValueMinor), 1);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <caption className="sr-only">
          Every strategy in the bounded action space, priced by expected value
        </caption>
        <thead>
          <tr className="border-b border-white/[0.06]">
            <th scope="col" className="py-2 pr-3 text-left font-medium text-silver-500">
              Strategy
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium text-silver-500">
              Success
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium text-silver-500">
              Gross
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium text-silver-500">
              Cost
            </th>
            <th scope="col" className="py-2 pl-2 text-right font-medium text-silver-500">
              Expected value
            </th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((candidate) => {
            const isChosen = candidate.strategy === chosen;
            return (
              <tr
                key={candidate.strategy}
                className={cn(
                  'border-b border-white/[0.04] last:border-0',
                  !candidate.eligible && 'opacity-45',
                  isChosen && 'bg-mint-500/[0.05]',
                )}
              >
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    {isChosen && <span className="h-1 w-1 rounded-full bg-mint-400" aria-hidden />}
                    <span className={cn(isChosen ? 'text-silver-100' : 'text-silver-300')}>
                      {STRATEGY_LABELS[candidate.strategy]}
                    </span>
                  </div>
                  {!candidate.eligible && candidate.ineligibleReason && (
                    <p className="mt-0.5 max-w-md text-2xs leading-relaxed text-silver-600">
                      {candidate.ineligibleReason}
                    </p>
                  )}
                  {candidate.eligible && candidate.delayHours > 0 && (
                    <p className="mt-0.5 text-2xs text-silver-600">
                      after {candidate.delayHours}h
                    </p>
                  )}
                </td>
                <td className="tnum px-2 py-2 text-right text-silver-400">
                  {candidate.eligible ? formatPercent(candidate.successProbability, 0) : '—'}
                </td>
                <td className="tnum px-2 py-2 text-right text-silver-400">
                  {candidate.eligible ? formatMinorCompact(candidate.grossRecoveryMinor) : '—'}
                </td>
                <td className="tnum px-2 py-2 text-right text-silver-500">
                  {formatMinorCompact(candidate.interventionCostMinor + candidate.goodwillCostMinor)}
                </td>
                <td className="py-2 pl-2 text-right">
                  <span
                    className={cn(
                      'tnum font-medium',
                      candidate.expectedValueMinor > 0 ? 'text-mint-400' : 'text-silver-600',
                    )}
                  >
                    {formatMinorCompact(candidate.expectedValueMinor)}
                  </span>
                  {candidate.eligible && candidate.expectedValueMinor > 0 && (
                    <ProportionBar
                      value={candidate.expectedValueMinor / best}
                      tone={isChosen ? 'positive' : 'neutral'}
                      className="ml-auto mt-1 w-20"
                      label={`${STRATEGY_LABELS[candidate.strategy]} expected value`}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
