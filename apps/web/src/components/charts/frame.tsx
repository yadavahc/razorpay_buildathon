'use client';

import { type ReactNode, useId, useState } from 'react';
import { Surface, cn } from '@/components/ui/primitives';
import { CHART_SURFACE, MARKS } from './theme';

/**
 * The chart frame.
 *
 * Every chart in the product is wrapped in this, which gives each one three things it
 * would otherwise be easy to omit:
 *
 *   - a LEGEND whenever there are two or more series, so identity is never carried by
 *     colour alone;
 *   - a TABLE VIEW twin, so no value is reachable only by hovering — the accessible
 *     equivalent of the chart, one toggle away;
 *   - a stated DEFINITION of what is being measured, because a chart of "recovery" that
 *     does not say which recovery is being counted is not evidence of anything.
 */

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  /** Optional secondary encoding, used where CVD separation needs reinforcement. */
  dash?: boolean;
}

export interface TableColumn<T> {
  key: string;
  label: string;
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
}

export function ChartFrame<T>({
  title,
  description,
  definition,
  legend,
  children,
  tableRows,
  tableColumns,
  actions,
  height = 260,
  className,
  empty,
}: {
  title: string;
  description?: string;
  /** What exactly is plotted. Always shown to screen readers, on hover for sighted users. */
  definition: string;
  legend?: LegendItem[];
  children: ReactNode;
  tableRows?: readonly T[];
  tableColumns?: Array<TableColumn<T>>;
  actions?: ReactNode;
  height?: number;
  className?: string;
  empty?: boolean;
}) {
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const hasTable = Boolean(tableRows && tableColumns && tableRows.length > 0);

  return (
    <Surface className={cn('flex flex-col overflow-hidden', className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-silver-100" title={definition}>
            {title}
          </h2>
          {description && (
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-silver-500 text-pretty">
              {description}
            </p>
          )}
          <p className="sr-only">{definition}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {hasTable && (
            <button
              type="button"
              onClick={() => setShowTable((v) => !v)}
              aria-expanded={showTable}
              aria-controls={tableId}
              className="rounded-md border border-white/[0.09] px-2 py-1 text-2xs text-silver-400 transition-colors hover:bg-white/[0.05] hover:text-silver-100"
            >
              {showTable ? 'Chart' : 'Table'}
            </button>
          )}
        </div>
      </header>

      {/* A legend is always present for two or more series. */}
      {legend && legend.length >= 2 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/[0.06] px-5 py-2.5">
          {legend.map((item) => (
            <span key={item.key} className="flex items-center gap-1.5 text-2xs text-silver-400">
              <span
                aria-hidden
                className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
                style={{
                  backgroundColor: item.dash ? 'transparent' : item.color,
                  border: item.dash ? `1.5px dashed ${item.color}` : undefined,
                }}
              />
              {item.label}
            </span>
          ))}
        </div>
      )}

      <div className="flex-1 p-4">
        {empty ? (
          <div
            className="flex items-center justify-center px-4 text-center text-xs text-silver-600"
            style={{ height }}
          >
            No data in this window yet.
          </div>
        ) : showTable && hasTable ? (
          <div id={tableId} className="max-h-[420px] overflow-auto">
            <table className="w-full border-collapse text-xs">
              <caption className="sr-only">{definition}</caption>
              <thead className="sticky top-0 bg-ink-900">
                <tr>
                  {tableColumns!.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className={cn(
                        'border-b border-white/[0.08] px-3 py-2 font-medium text-silver-500',
                        column.align === 'right' ? 'text-right' : 'text-left',
                      )}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows!.map((row, index) => (
                  <tr key={index} className="border-b border-white/[0.04] last:border-0">
                    {tableColumns!.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          'px-3 py-2 text-silver-300',
                          column.align === 'right' ? 'tnum text-right' : 'text-left',
                        )}
                      >
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ height }}>{children}</div>
        )}
      </div>
    </Surface>
  );
}

/**
 * The shared tooltip. Values wear text tokens; a small colour chip beside them carries
 * identity, so the text itself is never coloured by the series.
 */
export function ChartTooltip({
  label,
  rows,
  footer,
}: {
  label: ReactNode;
  rows: Array<{ key: string; label: string; value: ReactNode; color?: string }>;
  footer?: ReactNode;
}) {
  return (
    <div className="pointer-events-none min-w-[9rem] rounded-lg border border-white/[0.1] bg-ink-800/95 px-3 py-2 shadow-glass-lg backdrop-blur-xl">
      <p className="text-2xs font-medium text-silver-300">{label}</p>
      <dl className="mt-1.5 space-y-1">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4">
            <dt className="flex items-center gap-1.5 text-2xs text-silver-500">
              {row.color && (
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-[1px]"
                  style={{ backgroundColor: row.color }}
                />
              )}
              {row.label}
            </dt>
            <dd className="tnum text-2xs font-medium text-silver-100">{row.value}</dd>
          </div>
        ))}
      </dl>
      {footer && <p className="mt-1.5 text-2xs text-silver-600">{footer}</p>}
    </div>
  );
}

/** Shared props for Recharts surfaces so every chart gets the same recessive chrome. */
export const chartMargin = { top: 8, right: 12, bottom: 4, left: 4 } as const;

/** The 2px surface-coloured gap that separates touching marks. */
export const SURFACE_GAP_STROKE = {
  stroke: CHART_SURFACE,
  strokeWidth: MARKS.surfaceGap,
} as const;
