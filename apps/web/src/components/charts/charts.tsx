'use client';

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { formatMinorCompact, formatPercent } from '@reclaim/core/presentation';
import { ChartFrame, ChartTooltip, chartMargin } from './frame';
import { AXIS_TICK, CHART_SURFACE, CHROME, MARKS, ORDINAL_6, STATUS, categoricalFor } from './theme';

/**
 * The chart set.
 *
 * Each of these answers one question, and the chart form follows from the question
 * rather than from variety. Magnitude across nominal categories is a bar with a single
 * hue; change over time is a line; an ordered pipeline is an ordinal ramp; a
 * relationship between two measures is a scatter. There are no dual axes anywhere,
 * and no chart uses a value ramp to re-encode a length it already shows.
 */

const inr = (minor: number): string => formatMinorCompact(minor);

/* -------------------------------------------------------------------------- */
/* Recovery trend — two semantic series over time                              */
/* -------------------------------------------------------------------------- */

export interface TrendPoint {
  day: string;
  leakedMinor: number;
  recoveredMinor: number;
  caseCount: number;
  recoveredCount: number;
}

export function RecoveryTrendChart({ data }: { data: TrendPoint[] }) {
  const shortDay = (day: string): string =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  return (
    <ChartFrame
      title="Leakage and recovery over time"
      description="Money lost to failed payments each day, against money actually captured back."
      definition="Leaked is the gross value of payments that failed on that day. Recovered is the value of payments captured by a recovery action, dated to the day the outcome was recorded. Both are measured, not projected."
      legend={[
        { key: 'leaked', label: 'Leaked', color: STATUS.lost },
        { key: 'recovered', label: 'Recovered', color: STATUS.recovered },
      ]}
      height={280}
      empty={data.length === 0}
      tableRows={data}
      tableColumns={[
        { key: 'day', label: 'Day', render: (r) => shortDay(r.day) },
        { key: 'leaked', label: 'Leaked', align: 'right', render: (r) => inr(r.leakedMinor) },
        {
          key: 'recovered',
          label: 'Recovered',
          align: 'right',
          render: (r) => inr(r.recoveredMinor),
        },
        { key: 'cases', label: 'Cases', align: 'right', render: (r) => r.caseCount },
      ]}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={chartMargin}>
          <defs>
            <linearGradient id="recovered-wash" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={STATUS.recovered} stopOpacity={MARKS.areaOpacity * 2} />
              <stop offset="100%" stopColor={STATUS.recovered} stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke={CHROME.grid} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="day"
            tickFormatter={shortDay}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHROME.axis }}
            minTickGap={28}
          />
          <YAxis
            tickFormatter={(v: number) => inr(v)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={62}
          />
          <Tooltip
            cursor={{ stroke: CHROME.cursor, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0]?.payload as TrendPoint;
              return (
                <ChartTooltip
                  label={shortDay(String(label))}
                  rows={[
                    { key: 'l', label: 'Leaked', value: inr(point.leakedMinor), color: STATUS.lost },
                    {
                      key: 'r',
                      label: 'Recovered',
                      value: inr(point.recoveredMinor),
                      color: STATUS.recovered,
                    },
                  ]}
                  footer={`${point.caseCount} cases opened · ${point.recoveredCount} recovered`}
                />
              );
            }}
          />

          <Area
            type="monotone"
            dataKey="recoveredMinor"
            stroke="none"
            fill="url(#recovered-wash)"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="leakedMinor"
            stroke={STATUS.lost}
            strokeWidth={MARKS.lineWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{
              r: MARKS.dotRadius,
              stroke: CHART_SURFACE,
              strokeWidth: MARKS.dotStrokeWidth,
            }}
          />
          <Line
            type="monotone"
            dataKey="recoveredMinor"
            stroke={STATUS.recovered}
            strokeWidth={MARKS.lineWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{
              r: MARKS.dotRadius,
              stroke: CHART_SURFACE,
              strokeWidth: MARKS.dotStrokeWidth,
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Recovery funnel — ordered stages, ordinal ramp                              */
/* -------------------------------------------------------------------------- */

export interface FunnelStage {
  stage: string;
  label: string;
  count: number;
  amountMinor: number;
  conversion: number;
  description: string;
}

export function RecoveryFunnelChart({ stages }: { stages: FunnelStage[] }) {
  const max = Math.max(1, ...stages.map((s) => s.amountMinor));

  return (
    <ChartFrame
      title="Recovery funnel"
      description="How much of the leaked revenue survives each stage of the pipeline."
      definition="Each stage is a strict subset of the one above it. The drop from 'economically worth working' to 'intervention executed' is revenue blocked by the policy engine — a real leak, deliberately shown rather than hidden."
      height={stages.length * 56}
      empty={stages.length === 0}
      tableRows={stages}
      tableColumns={[
        { key: 'stage', label: 'Stage', render: (r) => r.label },
        { key: 'count', label: 'Cases', align: 'right', render: (r) => r.count.toLocaleString('en-IN') },
        { key: 'amount', label: 'Value', align: 'right', render: (r) => inr(r.amountMinor) },
        {
          key: 'conv',
          label: 'Conversion',
          align: 'right',
          render: (r) => formatPercent(r.conversion),
        },
      ]}
    >
      {/* A funnel is a sequence of labelled proportions, so it is drawn directly rather
          than forced into a bar chart: the stage name, the value and the conversion all
          need to sit on the same row, which an axis-based chart cannot do cleanly. */}
      <ol className="flex h-full flex-col justify-between gap-1">
        {stages.map((stage, index) => {
          const width = (stage.amountMinor / max) * 100;
          return (
            <li key={stage.stage} className="group relative" title={stage.description}>
              <div className="flex items-baseline justify-between gap-3 pb-1">
                <span className="truncate text-xs text-silver-300">{stage.label}</span>
                <span className="tnum shrink-0 text-2xs text-silver-500">
                  {inr(stage.amountMinor)}
                  <span className="ml-2 text-silver-600">
                    {index === 0 ? '' : formatPercent(stage.conversion, 0)}
                  </span>
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-[3px] bg-white/[0.04]">
                <div
                  className="h-full rounded-[3px] transition-[width] duration-700 ease-smooth"
                  style={{
                    width: `${Math.max(1, width)}%`,
                    backgroundColor: ORDINAL_6[Math.min(index, ORDINAL_6.length - 1)],
                  }}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Leakage breakdown — magnitude across nominal categories                     */
/* -------------------------------------------------------------------------- */

export interface LeakageBucket {
  key: string;
  label: string;
  lostAmountMinor: number;
  count: number;
  recoveredAmountMinor: number;
  recoveryRate: number;
  share: number;
  openAmountMinor: number;
}

export function LeakageBreakdownChart({
  buckets,
  title,
  description,
  definition,
  limit = 8,
}: {
  buckets: LeakageBucket[];
  title: string;
  description: string;
  definition: string;
  limit?: number;
}) {
  const data = buckets.slice(0, limit);

  return (
    <ChartFrame
      title={title}
      description={description}
      definition={definition}
      height={Math.max(180, data.length * 30 + 24)}
      empty={data.length === 0}
      tableRows={data}
      tableColumns={[
        { key: 'label', label: 'Category', render: (r) => r.label },
        { key: 'lost', label: 'Lost', align: 'right', render: (r) => inr(r.lostAmountMinor) },
        { key: 'count', label: 'Payments', align: 'right', render: (r) => r.count.toLocaleString('en-IN') },
        { key: 'share', label: 'Share', align: 'right', render: (r) => formatPercent(r.share, 0) },
        {
          key: 'rate',
          label: 'Recovered',
          align: 'right',
          render: (r) => formatPercent(r.recoveryRate, 0),
        },
      ]}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ ...chartMargin, left: 8 }} barCategoryGap={6}>
          <CartesianGrid stroke={CHROME.grid} strokeWidth={1} horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(v: number) => inr(v)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHROME.axis }}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ ...AXIS_TICK, fontFamily: 'var(--font-sans)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={132}
          />
          <Tooltip
            cursor={{ fill: CHROME.cursor }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const bucket = payload[0]?.payload as LeakageBucket;
              return (
                <ChartTooltip
                  label={bucket.label}
                  rows={[
                    { key: 'lost', label: 'Lost', value: inr(bucket.lostAmountMinor) },
                    { key: 'count', label: 'Payments', value: bucket.count.toLocaleString('en-IN') },
                    { key: 'share', label: 'Share of leakage', value: formatPercent(bucket.share, 0) },
                    {
                      key: 'rec',
                      label: 'Recovered so far',
                      value: formatPercent(bucket.recoveryRate, 0),
                    },
                    { key: 'open', label: 'Still open', value: inr(bucket.openAmountMinor) },
                  ]}
                />
              );
            }}
          />
          {/* One series, one hue. A value ramp here would re-encode bar length as
              colour and burn the only free channel on information already shown. */}
          <Bar
            dataKey="lostAmountMinor"
            fill={categoricalFor(0)}
            radius={[0, MARKS.barRadius, MARKS.barRadius, 0]}
            maxBarSize={MARKS.barMaxThickness}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Opportunity map — amount against probability                                */
/* -------------------------------------------------------------------------- */

export interface OpportunityPoint {
  caseId: string;
  customerName: string;
  amountAtRiskMinor: number;
  recoveryProbability: number;
  expectedValueMinor: number;
  priorityScore: number;
  hoursOpen: number;
}

export function OpportunityMapChart({
  points,
  onSelect,
}: {
  points: OpportunityPoint[];
  onSelect?: (caseId: string) => void;
}) {
  const data = points.map((p) => ({
    ...p,
    x: p.recoveryProbability * 100,
    y: p.amountAtRiskMinor / 100,
    z: Math.max(1, p.expectedValueMinor),
  }));

  return (
    <ChartFrame
      title="Recovery opportunity map"
      description="Every open case, placed by how much is at stake against how likely it is to come back."
      definition="Horizontal position is the model's recovery probability. Vertical position is the amount at risk in rupees. Bubble area is expected value — probability times amount, minus the cost of intervening. The top-right quadrant is where the money is."
      height={300}
      empty={data.length === 0}
      tableRows={points}
      tableColumns={[
        { key: 'customer', label: 'Customer', render: (r) => r.customerName },
        { key: 'amount', label: 'At risk', align: 'right', render: (r) => inr(r.amountAtRiskMinor) },
        {
          key: 'p',
          label: 'Recovery',
          align: 'right',
          render: (r) => formatPercent(r.recoveryProbability, 0),
        },
        { key: 'ev', label: 'Expected', align: 'right', render: (r) => inr(r.expectedValueMinor) },
        { key: 'age', label: 'Open', align: 'right', render: (r) => `${r.hoursOpen.toFixed(0)}h` },
      ]}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ ...chartMargin, left: 8, bottom: 16 }}>
          <CartesianGrid stroke={CHROME.grid} strokeWidth={1} />
          <XAxis
            type="number"
            dataKey="x"
            name="Recovery probability"
            unit="%"
            domain={[0, 100]}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHROME.axis }}
            label={{
              value: 'Recovery probability',
              position: 'insideBottom',
              offset: -12,
              fill: CHROME.labelText,
              fontSize: 10,
            }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="Amount at risk"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={62}
            tickFormatter={(v: number) => inr(v * 100)}
          />
          <ZAxis type="number" dataKey="z" range={[60, 520]} />
          <Tooltip
            cursor={{ stroke: CHROME.cursor, strokeWidth: 1 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0]?.payload as OpportunityPoint;
              return (
                <ChartTooltip
                  label={point.customerName}
                  rows={[
                    { key: 'a', label: 'At risk', value: inr(point.amountAtRiskMinor) },
                    {
                      key: 'p',
                      label: 'Recovery probability',
                      value: formatPercent(point.recoveryProbability, 0),
                    },
                    { key: 'ev', label: 'Expected value', value: inr(point.expectedValueMinor) },
                  ]}
                  footer={`Open ${point.hoursOpen.toFixed(0)}h · recoverability decays with a ~72h half-life`}
                />
              );
            }}
          />
          <Scatter
            data={data}
            fill={STATUS.info}
            fillOpacity={0.55}
            stroke={CHART_SURFACE}
            strokeWidth={MARKS.dotStrokeWidth}
            onClick={(entry: unknown) => {
              const point = entry as { caseId?: string };
              if (point.caseId) onSelect?.(point.caseId);
            }}
            style={{ cursor: onSelect ? 'pointer' : 'default' }}
            isAnimationActive={false}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Strategy performance — identity encoding across strategies                  */
/* -------------------------------------------------------------------------- */

export interface StrategyRow {
  strategy: string;
  label: string;
  attempts: number;
  succeeded: number;
  recoveredMinor: number;
  successRate: number;
  averagePredicted: number;
  calibrationGap: number;
}

export function StrategyPerformanceChart({ rows }: { rows: StrategyRow[] }) {
  return (
    <ChartFrame
      title="Recovery by strategy"
      description="What each intervention actually brought back."
      definition="Recovered value is the sum of captured payments attributed to outcomes recorded against that strategy. Attempts counts every action executed or failed, so the success rate is measured against work done rather than work planned."
      height={Math.max(180, rows.length * 34 + 24)}
      empty={rows.length === 0}
      tableRows={rows}
      tableColumns={[
        { key: 'strategy', label: 'Strategy', render: (r) => r.label },
        { key: 'attempts', label: 'Attempts', align: 'right', render: (r) => r.attempts },
        { key: 'ok', label: 'Recovered', align: 'right', render: (r) => r.succeeded },
        {
          key: 'rate',
          label: 'Success',
          align: 'right',
          render: (r) => formatPercent(r.successRate, 0),
        },
        {
          key: 'gap',
          label: 'vs predicted',
          align: 'right',
          render: (r) => `${r.calibrationGap >= 0 ? '+' : ''}${(r.calibrationGap * 100).toFixed(1)}pp`,
        },
        { key: 'value', label: 'Value', align: 'right', render: (r) => inr(r.recoveredMinor) },
      ]}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ ...chartMargin, left: 8 }} barCategoryGap={6}>
          <CartesianGrid stroke={CHROME.grid} strokeWidth={1} horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(v: number) => inr(v)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHROME.axis }}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ ...AXIS_TICK, fontFamily: 'var(--font-sans)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={132}
          />
          <Tooltip
            cursor={{ fill: CHROME.cursor }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as StrategyRow;
              return (
                <ChartTooltip
                  label={row.label}
                  rows={[
                    { key: 'v', label: 'Recovered', value: inr(row.recoveredMinor) },
                    { key: 'a', label: 'Attempts', value: row.attempts.toLocaleString('en-IN') },
                    { key: 's', label: 'Observed success', value: formatPercent(row.successRate, 0) },
                    {
                      key: 'p',
                      label: 'Mean prediction',
                      value: formatPercent(row.averagePredicted, 0),
                    },
                  ]}
                  footer={
                    Math.abs(row.calibrationGap) < 0.08
                      ? 'Prediction and outcome agree within 8 points.'
                      : `${row.calibrationGap > 0 ? 'Outperforming' : 'Underperforming'} its prediction by ${Math.abs(row.calibrationGap * 100).toFixed(0)} points.`
                  }
                />
              );
            }}
          />
          <Bar
            dataKey="recoveredMinor"
            radius={[0, MARKS.barRadius, MARKS.barRadius, 0]}
            maxBarSize={MARKS.barMaxThickness}
            isAnimationActive={false}
          >
            {/* Identity encoding: colour follows the strategy, fixed by its index in the
                bounded action space, so filtering never repaints the survivors. */}
            {rows.map((row, index) => (
              <Cell key={row.strategy} fill={categoricalFor(index)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Calibration — predicted against observed                                    */
/* -------------------------------------------------------------------------- */

export interface CalibrationBin {
  bucket: string;
  count: number;
  predictedMean: number;
  observedRate: number;
}

export function CalibrationChart({ bins }: { bins: CalibrationBin[] }) {
  const data = bins.filter((b) => b.count > 0).map((b) => ({
    ...b,
    predicted: b.predictedMean * 100,
    observed: b.observedRate * 100,
  }));

  return (
    <ChartFrame
      title="Calibration"
      description="When the model says 70%, does 70% actually come back?"
      definition="Each point is a probability band. The horizontal position is the mean probability the model assigned in that band; the vertical position is the share of those cases that actually recovered. Perfect calibration lies on the diagonal — above it the model is pessimistic, below it optimistic."
      legend={[
        { key: 'obs', label: 'Observed', color: STATUS.info },
        { key: 'ideal', label: 'Perfect calibration', color: CHROME.labelText, dash: true },
      ]}
      height={260}
      empty={data.length === 0}
      tableRows={data}
      tableColumns={[
        { key: 'bucket', label: 'Predicted band', render: (r) => r.bucket },
        { key: 'n', label: 'Cases', align: 'right', render: (r) => r.count },
        {
          key: 'p',
          label: 'Mean predicted',
          align: 'right',
          render: (r) => formatPercent(r.predictedMean, 0),
        },
        {
          key: 'o',
          label: 'Observed',
          align: 'right',
          render: (r) => formatPercent(r.observedRate, 0),
        },
      ]}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ ...chartMargin, left: 8, bottom: 16 }}>
          <CartesianGrid stroke={CHROME.grid} strokeWidth={1} />
          <XAxis
            type="number"
            dataKey="predicted"
            domain={[0, 100]}
            unit="%"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHROME.axis }}
            label={{
              value: 'Predicted',
              position: 'insideBottom',
              offset: -12,
              fill: CHROME.labelText,
              fontSize: 10,
            }}
          />
          <YAxis
            type="number"
            dataKey="observed"
            domain={[0, 100]}
            unit="%"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          {/* The reference diagonal is the only dashed line in the product, and it earns
              it: it is a threshold, not a grid. */}
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 100, y: 100 },
            ]}
            stroke={CHROME.labelText}
            strokeDasharray="4 4"
            strokeWidth={1}
          />
          <Tooltip
            cursor={{ stroke: CHROME.cursor, strokeWidth: 1 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const bin = payload[0]?.payload as CalibrationBin;
              const gap = bin.predictedMean - bin.observedRate;
              return (
                <ChartTooltip
                  label={`Predicted ${bin.bucket}`}
                  rows={[
                    { key: 'n', label: 'Cases', value: bin.count.toLocaleString('en-IN') },
                    { key: 'p', label: 'Mean predicted', value: formatPercent(bin.predictedMean, 0) },
                    { key: 'o', label: 'Actually recovered', value: formatPercent(bin.observedRate, 0) },
                  ]}
                  footer={
                    Math.abs(gap) < 0.05
                      ? 'Well calibrated in this band.'
                      : gap > 0
                        ? `Optimistic by ${(gap * 100).toFixed(0)} points.`
                        : `Pessimistic by ${(-gap * 100).toFixed(0)} points.`
                  }
                />
              );
            }}
          />
          <Scatter
            data={data}
            fill={STATUS.info}
            stroke={CHART_SURFACE}
            strokeWidth={MARKS.dotStrokeWidth}
            isAnimationActive={false}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Threshold sweep — where the operating point should sit                      */
/* -------------------------------------------------------------------------- */

export interface SweepPoint {
  threshold: number;
  precision: number;
  recall: number;
  f1: number;
  netValueMinor: number;
}

export function ThresholdSweepChart({
  points,
  operatingThreshold,
  balancedThreshold,
}: {
  points: SweepPoint[];
  operatingThreshold: number;
  balancedThreshold: number;
}) {
  return (
    <ChartFrame
      title="Net value against threshold"
      description="What the portfolio earns at each possible cut-off."
      definition="Net value is recovered rupees minus intervention cost across the held-out test split, recomputed at each threshold. RECLAIM operates at the peak of this curve rather than at the peak of F1, because a retry costs a fraction of what a missed recovery costs."
      legend={[
        { key: 'value', label: 'Net recovered value', color: STATUS.recovered },
        { key: 'f1', label: 'F1 (right-hand scale is deliberately absent)', color: CHROME.labelText, dash: true },
      ]}
      height={240}
      empty={points.length === 0}
      tableRows={points}
      tableColumns={[
        { key: 't', label: 'Threshold', render: (r) => r.threshold.toFixed(2) },
        { key: 'p', label: 'Precision', align: 'right', render: (r) => r.precision.toFixed(3) },
        { key: 'r', label: 'Recall', align: 'right', render: (r) => r.recall.toFixed(3) },
        { key: 'f', label: 'F1', align: 'right', render: (r) => r.f1.toFixed(3) },
        { key: 'v', label: 'Net value', align: 'right', render: (r) => inr(r.netValueMinor) },
      ]}
    >
      {/* One measure, one axis. F1 is reported in the table rather than plotted on a
          second scale — two y-scales would invent a relationship that is not in the data. */}
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={chartMargin}>
          <CartesianGrid stroke={CHROME.grid} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="threshold"
            tickFormatter={(v: number) => v.toFixed(2)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHROME.axis }}
          />
          <YAxis
            tickFormatter={(v: number) => inr(v)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={62}
          />
          <ReferenceLine
            x={operatingThreshold}
            stroke={STATUS.recovered}
            strokeWidth={1}
            label={{ value: 'operating', fill: CHROME.labelText, fontSize: 9, position: 'top' }}
          />
          <ReferenceLine
            x={balancedThreshold}
            stroke={CHROME.labelText}
            strokeDasharray="4 4"
            strokeWidth={1}
            label={{ value: 'best F1', fill: CHROME.labelText, fontSize: 9, position: 'top' }}
          />
          <Tooltip
            cursor={{ stroke: CHROME.cursor, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0]?.payload as SweepPoint;
              return (
                <ChartTooltip
                  label={`Threshold ${Number(label).toFixed(2)}`}
                  rows={[
                    { key: 'v', label: 'Net value', value: inr(point.netValueMinor) },
                    { key: 'p', label: 'Precision', value: point.precision.toFixed(3) },
                    { key: 'r', label: 'Recall', value: point.recall.toFixed(3) },
                    { key: 'f', label: 'F1', value: point.f1.toFixed(3) },
                  ]}
                />
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="netValueMinor"
            stroke={STATUS.recovered}
            strokeWidth={MARKS.lineWidth}
            strokeLinecap="round"
            dot={false}
            activeDot={{
              r: MARKS.dotRadius,
              stroke: CHART_SURFACE,
              strokeWidth: MARKS.dotStrokeWidth,
            }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* -------------------------------------------------------------------------- */
/* Policy comparison — the simulator                                           */
/* -------------------------------------------------------------------------- */

export interface PolicyResultRow {
  policy: string;
  label: string;
  netValueMinor: number;
  recoveredMinor: number;
  interventionCostMinor: number;
  interventions: number;
  abstentions: number;
  recoveryRate: number;
  returnOnSpend: number;
}

export function PolicyComparisonChart({ results }: { results: PolicyResultRow[] }) {
  return (
    <ChartFrame
      title="Policy comparison"
      description="What each recovery policy would have produced on the same case portfolio."
      definition="Every policy faces the identical case set with identical seeded random draws, so any difference between them comes from the decision rather than from luck. Net value is recovered rupees minus what the interventions cost."
      height={Math.max(200, results.length * 38 + 24)}
      empty={results.length === 0}
      tableRows={results}
      tableColumns={[
        { key: 'p', label: 'Policy', render: (r) => r.label },
        { key: 'n', label: 'Actions', align: 'right', render: (r) => r.interventions },
        { key: 'skip', label: 'Left alone', align: 'right', render: (r) => r.abstentions },
        { key: 'rec', label: 'Recovered', align: 'right', render: (r) => inr(r.recoveredMinor) },
        { key: 'cost', label: 'Cost', align: 'right', render: (r) => inr(r.interventionCostMinor) },
        { key: 'net', label: 'Net value', align: 'right', render: (r) => inr(r.netValueMinor) },
        { key: 'roi', label: 'Return', align: 'right', render: (r) => `${r.returnOnSpend.toFixed(1)}x` },
      ]}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={results} layout="vertical" margin={{ ...chartMargin, left: 8 }} barCategoryGap={8}>
          <CartesianGrid stroke={CHROME.grid} strokeWidth={1} horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(v: number) => inr(v)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHROME.axis }}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ ...AXIS_TICK, fontFamily: 'var(--font-sans)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={150}
          />
          <Tooltip
            cursor={{ fill: CHROME.cursor }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as PolicyResultRow;
              return (
                <ChartTooltip
                  label={row.label}
                  rows={[
                    { key: 'net', label: 'Net value', value: inr(row.netValueMinor) },
                    { key: 'rec', label: 'Recovered', value: inr(row.recoveredMinor) },
                    { key: 'cost', label: 'Intervention cost', value: inr(row.interventionCostMinor) },
                    { key: 'n', label: 'Actions taken', value: row.interventions.toLocaleString('en-IN') },
                    { key: 'skip', label: 'Cases left alone', value: row.abstentions.toLocaleString('en-IN') },
                  ]}
                  footer={`${row.returnOnSpend.toFixed(1)}x return on intervention spend`}
                />
              );
            }}
          />
          <Bar
            dataKey="netValueMinor"
            radius={[0, MARKS.barRadius, MARKS.barRadius, 0]}
            maxBarSize={MARKS.barMaxThickness}
            isAnimationActive={false}
          >
            {/* The winner is highlighted; the rest recede. Emphasis, not eight hues. */}
            {results.map((row, index) => (
              <Cell
                key={row.policy}
                fill={index === 0 ? STATUS.recovered : STATUS.neutral}
                fillOpacity={index === 0 ? 1 : 0.55}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
