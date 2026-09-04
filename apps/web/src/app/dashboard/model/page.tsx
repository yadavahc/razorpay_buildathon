'use client';

import type { ClassificationMetrics, EvaluationReport, ModelArtifact } from '@reclaim/core';
import { formatCount, formatMinorCompact, formatPercent } from '@reclaim/core/presentation';
import { useApi } from '@/lib/use-api';
import { MetricGrid, MetricTile, PageHeader } from '@/components/dashboard/metrics';
import { CalibrationChart, ThresholdSweepChart } from '@/components/charts/charts';
import {
  Badge,
  ErrorState,
  Panel,
  ProportionBar,
  Skeleton,
  cn,
} from '@/components/ui/primitives';

interface ModelPayload {
  degraded: boolean;
  version: string;
  algorithm: string;
  trainedAt: string;
  dataset: ModelArtifact['dataset'];
  training: ModelArtifact['training'];
  operatingThreshold: number;
  balancedThreshold: number;
  evaluation: EvaluationReport;
  balancedClassification: ClassificationMetrics;
  holdout: EvaluationReport | null;
  weights: Array<{
    feature: string;
    label: string;
    weight: number;
    magnitude: number;
    direction: 'positive' | 'negative';
  }>;
  featureCount: number;
}

/**
 * THE MODEL CARD
 *
 * Every number here is read from the artifact `npm run train` produced, so the page
 * cannot drift from the model that is actually serving predictions.
 *
 * Two operating points are reported side by side on purpose. RECLAIM runs at the
 * value-maximising threshold, which sits low because a retry costs a fraction of what a
 * missed recovery costs. The balanced threshold is shown because it is the one that
 * reveals how well the model separates the classes. Quoting only one of them tells half
 * the story, and it is usually the half that flatters the model.
 */
export default function ModelPage() {
  const { data, error, loading, refresh, lastUpdated } = useApi<ModelPayload>('/api/model');

  if (error) {
    return (
      <>
        <PageHeader title="Recovery probability model" description="How the model performs." />
        <ErrorState message={error.message} onRetry={() => void refresh()} />
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Recovery probability model" description="How the model performs." />
        <MetricGrid columns={4}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </MetricGrid>
      </>
    );
  }

  if (!data) return null;

  if (data.degraded) {
    return (
      <>
        <PageHeader
          title="Recovery probability model"
          description="No trained model artifact is loaded."
        />
        <Panel title="Model not trained">
          <p className="text-sm leading-relaxed text-silver-300 text-pretty">
            RECLAIM is currently scoring cases with the failure-taxonomy prior blended with each
            customer&apos;s own success ratio. That is a defensible fallback and the pipeline runs
            end to end on it, but it is measurably weaker than the trained model and every
            prediction it produces is flagged as degraded.
          </p>
          <pre className="mt-4 rounded-lg bg-ink-950/60 p-4 font-mono text-xs text-mint-400">
            npm run seed{'\n'}npm run train
          </pre>
          <p className="mt-3 text-xs text-silver-500">
            Training takes a few hundred milliseconds and writes <code>data/model.json</code>.
            Restart the dev server afterwards to load it.
          </p>
        </Panel>
      </>
    );
  }

  const { evaluation, balancedClassification: balanced, holdout } = data;
  const cls = evaluation.classification;
  const prob = evaluation.probabilistic;

  return (
    <>
      <PageHeader
        title="Recovery probability model"
        description={`${data.version} · ${data.algorithm.replace(/_/g, ' ')} over ${data.featureCount} features, trained ${new Date(data.trainedAt).toLocaleString('en-IN')}`}
        lastUpdated={lastUpdated}
      />

      <MetricGrid columns={4}>
        <MetricTile
          label="ROC AUC"
          value={prob.rocAuc.toFixed(3)}
          definition="Probability the model ranks a randomly chosen recoverable case above a randomly chosen unrecoverable one. Measured on the held-out test split, which the model never saw during fitting."
          hint={`base rate ${formatPercent(prob.baseRate)}`}
          tone="accent"
        />
        <MetricTile
          label="Brier score"
          value={prob.brierScore.toFixed(4)}
          definition="Mean squared error of the predicted probabilities. Lower is better; it penalises confident wrong answers far more than uncertain ones."
          hint={`log loss ${prob.logLoss.toFixed(4)}`}
          tone="neutral"
        />
        <MetricTile
          label="Calibration error"
          value={prob.calibrationError.toFixed(4)}
          definition="Expected calibration error: the average gap between what the model promises and what actually happens, weighted by how many cases sit in each probability band."
          hint="lower means the probabilities can be trusted as probabilities"
          tone={prob.calibrationError < 0.06 ? 'positive' : 'warning'}
        />
        <MetricTile
          label="Net value at threshold"
          value={formatMinorCompact(evaluation.cost.netValueMinor)}
          definition="Recovered rupees minus intervention cost on the test split, at the operating threshold. This is the number the threshold was chosen to maximise."
          hint={`vs ${formatMinorCompact(evaluation.cost.netValueInterveneAllMinor)} acting on everything`}
          tone="positive"
          emphasis
        />
      </MetricGrid>

      <Panel
        className="mt-6"
        title="Two operating points"
        description="Where RECLAIM runs, and where a conventional classifier would run."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <OperatingPoint
            title="Value-optimal"
            subtitle="Where RECLAIM operates"
            threshold={data.operatingThreshold}
            metrics={cls}
            emphasis
            note="Chosen by maximising net recovered rupees on the validation split. It sits low because a retry costs around ₹2.50 while a missed recovery costs the whole balance — so acting is usually right, and the binding constraint on action is the policy engine rather than the classifier."
          />
          <OperatingPoint
            title="Balanced"
            subtitle="Where F1 is maximised"
            threshold={data.balancedThreshold}
            metrics={balanced}
            note="Reported for interpretability. This is the threshold a conventional classifier would pick, and it shows how well the model actually separates the two classes — but operating here would leave recoverable money on the table."
          />
        </div>
      </Panel>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <CalibrationChart bins={evaluation.calibrationBins} />
        <ThresholdSweepChart
          points={evaluation.thresholdSweep}
          operatingThreshold={data.operatingThreshold}
          balancedThreshold={data.balancedThreshold}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel
          title="Cost of being wrong"
          description="The asymmetry that drives the operating threshold."
        >
          <dl className="space-y-3">
            <CostRow
              label="False-positive cost"
              value={formatMinorCompact(evaluation.cost.falsePositiveCostMinor)}
              definition="Intervention spend on cases that were never going to recover."
              tone="warning"
            />
            <CostRow
              label="False-negative cost"
              value={formatMinorCompact(evaluation.cost.falseNegativeCostMinor)}
              definition="Revenue left on the table by declining to act on a case that would have recovered."
              tone="negative"
            />
            <CostRow
              label="Average recovered amount"
              value={formatMinorCompact(evaluation.cost.averageRecoveredAmountMinor)}
              definition="Mean value of a case that actually recovered."
              tone="positive"
            />
            <CostRow
              label="Average intervention cost"
              value={formatMinorCompact(evaluation.cost.averageInterventionCostMinor)}
              definition="Mean cost of acting on a case, including the goodwill charge."
              tone="neutral"
            />
          </dl>
          <p className="mt-4 border-t border-white/[0.06] pt-4 text-xs leading-relaxed text-silver-500 text-pretty">
            A missed recovery costs roughly{' '}
            {evaluation.cost.averageInterventionCostMinor === 0
              ? '—'
              : Math.round(
                  evaluation.cost.averageRecoveredAmountMinor /
                    evaluation.cost.averageInterventionCostMinor,
                )}
            × what a wasted intervention costs. That ratio, not the shape of the ROC curve, is what
            sets the operating point.
          </p>
        </Panel>

        <Panel
          title="Confusion matrix"
          description={`At the balanced threshold (${data.balancedThreshold.toFixed(2)}), where the matrix is informative.`}
        >
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-white/[0.06] text-center text-xs">
            <div className="bg-ink-900 px-3 py-2.5" />
            <div className="bg-ink-900 px-3 py-2.5 text-2xs text-silver-500">
              predicted recover
            </div>
            <div className="bg-ink-900 px-3 py-2.5 text-2xs text-silver-500">predicted lost</div>

            <div className="bg-ink-900 px-3 py-3 text-left text-2xs text-silver-500">
              actually recovered
            </div>
            <div className="bg-mint-500/10 px-3 py-3">
              <span className="tnum text-lg font-medium text-mint-400">
                {balanced.confusion.truePositive}
              </span>
              <span className="block text-2xs text-silver-600">correctly worked</span>
            </div>
            <div className="bg-loss-500/10 px-3 py-3">
              <span className="tnum text-lg font-medium text-loss-400">
                {balanced.confusion.falseNegative}
              </span>
              <span className="block text-2xs text-silver-600">missed revenue</span>
            </div>

            <div className="bg-ink-900 px-3 py-3 text-left text-2xs text-silver-500">
              actually lost
            </div>
            <div className="bg-risk-500/10 px-3 py-3">
              <span className="tnum text-lg font-medium text-risk-400">
                {balanced.confusion.falsePositive}
              </span>
              <span className="block text-2xs text-silver-600">wasted spend</span>
            </div>
            <div className="bg-ink-900 px-3 py-3">
              <span className="tnum text-lg font-medium text-silver-300">
                {balanced.confusion.trueNegative}
              </span>
              <span className="block text-2xs text-silver-600">correctly stopped</span>
            </div>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-silver-500 text-pretty">
            Support: {formatCount(balanced.support.positive)} recoverable,{' '}
            {formatCount(balanced.support.negative)} not, {formatCount(balanced.support.total)} total.
          </p>
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel
          title="What the model learned"
          description="Standardised weights, largest influence first. Positive raises the recovery odds."
          bodyClassName="p-5"
        >
          <ul className="space-y-2.5">
            {data.weights.slice(0, 12).map((weight) => {
              const maxMagnitude = data.weights[0]?.magnitude ?? 1;
              return (
                <li key={weight.feature}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-xs text-silver-300">{weight.label}</span>
                    <span
                      className={cn(
                        'tnum shrink-0 text-2xs',
                        weight.direction === 'positive' ? 'text-mint-400' : 'text-loss-400',
                      )}
                    >
                      {weight.weight >= 0 ? '+' : ''}
                      {weight.weight.toFixed(3)}
                    </span>
                  </div>
                  <ProportionBar
                    value={weight.magnitude / maxMagnitude}
                    tone={weight.direction === 'positive' ? 'positive' : 'negative'}
                    className="mt-1"
                    label={`${weight.label} weight`}
                  />
                </li>
              );
            })}
          </ul>
        </Panel>

        <div className="space-y-6">
          <Panel title="Training" description="How this artifact was produced.">
            <dl className="space-y-2">
              <Row label="Algorithm" value={data.algorithm.replace(/_/g, ' ')} />
              <Row label="Features" value={String(data.featureCount)} />
              <Row label="Training rows" value={formatCount(data.dataset.trainRows)} />
              <Row label="Validation rows" value={formatCount(data.dataset.validationRows)} />
              <Row label="Test rows" value={formatCount(data.dataset.testRows)} />
              <Row label="Positive rate" value={formatPercent(data.dataset.positiveRate)} />
              <Row label="Epochs run" value={String(data.training.epochsRun)} />
              <Row label="Converged" value={data.training.converged ? 'yes' : 'no'} />
              <Row label="Final loss" value={data.training.finalLoss.toFixed(5)} />
              <Row label="L2 penalty" value={String(data.training.l2)} />
              <Row label="Seed" value={String(data.dataset.seed)} />
            </dl>
            <p className="mt-4 border-t border-white/[0.06] pt-4 text-2xs leading-relaxed text-silver-500 text-pretty">
              Categorical encoders are fitted on the training split only, the probability
              calibrator and the operating threshold on validation, and the test split is read
              exactly once. Nothing from validation or test can reach a feature value.
            </p>
          </Panel>

          {holdout && (
            <Panel
              title="Held-out evaluation set"
              description="An independent set of episodes drawn from payments disjoint from the training data."
            >
              <dl className="space-y-2">
                <Row label="ROC AUC" value={holdout.probabilistic.rocAuc.toFixed(3)} />
                <Row label="PR AUC" value={holdout.probabilistic.prAuc.toFixed(3)} />
                <Row label="Brier score" value={holdout.probabilistic.brierScore.toFixed(4)} />
                <Row
                  label="Calibration error"
                  value={holdout.probabilistic.calibrationError.toFixed(4)}
                />
                <Row label="Precision" value={holdout.classification.precision.toFixed(3)} />
                <Row label="Recall" value={holdout.classification.recall.toFixed(3)} />
                <Row label="F1" value={holdout.classification.f1.toFixed(3)} />
              </dl>
              <p className="mt-4 border-t border-white/[0.06] pt-4 text-2xs leading-relaxed text-silver-500 text-pretty">
                Agreement between this and the test split is the check that matters: a model that
                scores well on test and poorly here has memorised the split rather than the signal.
                Run <code className="text-mint-400">npm run evaluate</code> for the full report,
                including the oracle ceiling and the no-learning baseline.
              </p>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

function OperatingPoint({
  title,
  subtitle,
  threshold,
  metrics,
  note,
  emphasis,
}: {
  title: string;
  subtitle: string;
  threshold: number;
  metrics: ClassificationMetrics;
  note: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-4',
        emphasis ? 'border-mint-500/25 bg-mint-500/[0.04]' : 'border-white/[0.07] bg-white/[0.015]',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-silver-100">{title}</p>
          <p className="text-2xs text-silver-500">{subtitle}</p>
        </div>
        <Badge tone={emphasis ? 'positive' : 'neutral'}>threshold {threshold.toFixed(2)}</Badge>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
        <Row label="Precision" value={metrics.precision.toFixed(3)} />
        <Row label="Recall" value={metrics.recall.toFixed(3)} />
        <Row label="F1" value={metrics.f1.toFixed(3)} />
        <Row label="Specificity" value={metrics.specificity.toFixed(3)} />
        <Row label="Accuracy" value={metrics.accuracy.toFixed(3)} />
        <Row label="MCC" value={metrics.matthewsCorrelation.toFixed(3)} />
      </dl>

      <p className="mt-4 text-2xs leading-relaxed text-silver-500 text-pretty">{note}</p>
    </div>
  );
}

function CostRow({
  label,
  value,
  definition,
  tone,
}: {
  label: string;
  value: string;
  definition: string;
  tone: 'positive' | 'negative' | 'warning' | 'neutral';
}) {
  const toneClass = {
    positive: 'text-mint-400',
    negative: 'text-loss-400',
    warning: 'text-risk-400',
    neutral: 'text-silver-300',
  }[tone];

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-xs text-silver-300">{label}</dt>
        <dd className={cn('tnum text-xs font-medium', toneClass)}>{value}</dd>
      </div>
      <p className="mt-0.5 text-2xs leading-relaxed text-silver-600">{definition}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-2xs text-silver-500">{label}</dt>
      <dd className="tnum text-2xs text-silver-200">{value}</dd>
    </div>
  );
}
