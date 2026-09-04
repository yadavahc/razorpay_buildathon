'use client';

import { useMemo, useState } from 'react';
import type { GraphEdge, GraphNode, OpportunityGraph } from '@reclaim/core';
import { formatMinorCompact, formatDateTime } from '@reclaim/core/presentation';
import { Surface, cn } from '@/components/ui/primitives';
import { CHART_SURFACE, STATUS } from '@/components/charts/theme';

/**
 * THE RECOVERY OPPORTUNITY GRAPH
 *
 * A failed payment is never an isolated row, and this is the view that makes that
 * concrete: the customer at the centre, their payment history radiating out, the
 * subscriptions and invoices attached to the relationship, and the previous
 * interventions with the outcomes they produced.
 *
 * The layout is deterministic — a radial arrangement grouped by node kind — rather than
 * a force simulation. A force layout looks livelier and is worse here: the same case
 * would draw differently on every visit, so a merchant could never learn to read it, and
 * two people looking at the same case would be looking at different pictures.
 */

const KIND_RING: Record<GraphNode['kind'], number> = {
  case: 0,
  customer: 0,
  payment: 1,
  failure: 1,
  subscription: 2,
  invoice: 2,
  attempt: 2,
  intervention: 3,
  outcome: 3,
};

const KIND_LABELS: Record<GraphNode['kind'], string> = {
  customer: 'Customer',
  case: 'This case',
  payment: 'Successful payment',
  failure: 'Failed payment',
  subscription: 'Subscription',
  invoice: 'Invoice',
  attempt: 'Attempt',
  intervention: 'Past intervention',
  outcome: 'Past outcome',
};

const STATUS_COLOR: Record<GraphNode['status'], string> = {
  positive: STATUS.recovered,
  negative: STATUS.lost,
  neutral: STATUS.neutral,
  focus: STATUS.info,
};

interface Placed extends GraphNode {
  x: number;
  y: number;
  r: number;
}

const VIEW = { width: 720, height: 480 };

function layout(nodes: readonly GraphNode[]): Map<string, Placed> {
  const placed = new Map<string, Placed>();
  const centreX = VIEW.width / 2;
  const centreY = VIEW.height / 2;

  const byRing = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const ring = KIND_RING[node.kind];
    const list = byRing.get(ring);
    if (list) list.push(node);
    else byRing.set(ring, [node]);
  }

  const radii = [0, 118, 190, 218];

  for (const [ring, ringNodes] of byRing) {
    // The centre ring holds the customer and the case; place them side by side rather
    // than on top of each other.
    if (ring === 0) {
      ringNodes.forEach((node, index) => {
        const offset = ringNodes.length === 1 ? 0 : index === 0 ? -46 : 46;
        placed.set(node.id, {
          ...node,
          x: centreX + offset,
          y: centreY,
          r: node.kind === 'case' ? 26 : 22,
        });
      });
      continue;
    }

    // Outer rings fan across an arc rather than a full circle, so labels have room and
    // the reading order runs left to right.
    const radius = radii[ring] ?? 210;
    const span = ring === 1 ? Math.PI * 1.5 : Math.PI * 0.72;
    const rotate = ring === 1 ? -Math.PI * 0.75 : ring === 2 ? Math.PI * 0.64 : -Math.PI * 0.36;

    ringNodes.forEach((node, index) => {
      const t = ringNodes.length === 1 ? 0.5 : index / (ringNodes.length - 1);
      const angle = rotate + t * span;
      placed.set(node.id, {
        ...node,
        x: centreX + Math.cos(angle) * radius * 1.32,
        y: centreY + Math.sin(angle) * radius * 0.82,
        r: node.kind === 'outcome' || node.kind === 'intervention' ? 10 : 13,
      });
    });
  }

  return placed;
}

export function OpportunityGraphView({
  graph,
  className,
}: {
  graph: OpportunityGraph;
  className?: string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const placed = useMemo(() => layout(graph.nodes), [graph.nodes]);

  const visibleEdges = useMemo(
    () => graph.edges.filter((edge) => placed.has(edge.from) && placed.has(edge.to)),
    [graph.edges, placed],
  );

  const active = hovered ? placed.get(hovered) : null;
  const connected = useMemo(() => {
    if (!hovered) return null;
    const set = new Set<string>([hovered]);
    for (const edge of visibleEdges) {
      if (edge.from === hovered) set.add(edge.to);
      if (edge.to === hovered) set.add(edge.from);
    }
    return set;
  }, [hovered, visibleEdges]);

  const kindsPresent = useMemo(
    () => [...new Set(graph.nodes.map((n) => n.kind))],
    [graph.nodes],
  );

  return (
    <Surface className={cn('overflow-hidden', className)}>
      <header className="border-b border-white/[0.06] px-5 py-4">
        <h2 className="text-sm font-medium text-silver-100">Recovery opportunity graph</h2>
        <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-silver-400 text-pretty">
          {graph.narrative}
        </p>
      </header>

      {/* Legend: identity is never carried by colour alone. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/[0.06] px-5 py-2.5">
        {kindsPresent.map((kind) => {
          const sample = graph.nodes.find((n) => n.kind === kind)!;
          return (
            <span key={kind} className="flex items-center gap-1.5 text-2xs text-silver-400">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: STATUS_COLOR[sample.status] }}
              />
              {KIND_LABELS[kind]}
            </span>
          );
        })}
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
          className="h-[420px] w-full"
          role="img"
          aria-label={`Relationship graph for this recovery case. ${graph.narrative}`}
        >
          <g>
            {visibleEdges.map((edge) => {
              const from = placed.get(edge.from)!;
              const to = placed.get(edge.to)!;
              const dimmed = connected !== null && !(connected.has(edge.from) && connected.has(edge.to));
              return (
                <EdgeLine
                  key={edge.id}
                  edge={edge}
                  from={from}
                  to={to}
                  dimmed={dimmed}
                />
              );
            })}
          </g>

          <g>
            {[...placed.values()].map((node) => {
              const dimmed = connected !== null && !connected.has(node.id);
              const isFocus = node.status === 'focus';
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x} ${node.y})`}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(node.id)}
                  onBlur={() => setHovered(null)}
                  tabIndex={0}
                  role="button"
                  aria-label={`${KIND_LABELS[node.kind]}: ${node.label}. ${node.sublabel}`}
                  className="cursor-pointer outline-none transition-opacity duration-200"
                  style={{ opacity: dimmed ? 0.22 : 1 }}
                >
                  {isFocus && (
                    <circle
                      r={node.r + 8}
                      fill="none"
                      stroke={STATUS_COLOR[node.status]}
                      strokeWidth={1}
                      opacity={0.35}
                    />
                  )}
                  {/* A 2px ring in the surface colour keeps overlapping nodes legible. */}
                  <circle
                    r={node.r}
                    fill={STATUS_COLOR[node.status]}
                    fillOpacity={isFocus ? 0.9 : 0.7}
                    stroke={CHART_SURFACE}
                    strokeWidth={2}
                  />
                  {node.amountMinor !== null && node.r >= 13 && (
                    <text
                      y={node.r + 13}
                      textAnchor="middle"
                      className="pointer-events-none fill-silver-400 font-mono"
                      style={{ fontSize: 9 }}
                    >
                      {formatMinorCompact(node.amountMinor)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Detail panel rather than a floating tooltip: it holds position, so a keyboard
            user can read it, and it never covers the node it describes. */}
        <div className="pointer-events-none absolute bottom-3 left-3 right-3">
          <div
            className={cn(
              'rounded-lg border border-white/[0.09] bg-ink-800/95 px-3 py-2 shadow-glass backdrop-blur-xl transition-opacity duration-200',
              active ? 'opacity-100' : 'opacity-0',
            )}
          >
            {active && (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-xs font-medium text-silver-100">{active.label}</p>
                  <span className="text-2xs text-silver-500">{KIND_LABELS[active.kind]}</span>
                </div>
                <p className="mt-0.5 text-2xs text-silver-500">{active.sublabel}</p>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                  {active.amountMinor !== null && (
                    <span className="tnum text-2xs text-silver-400">
                      {formatMinorCompact(active.amountMinor)}
                    </span>
                  )}
                  {active.at && (
                    <span className="text-2xs text-silver-600">{formatDateTime(active.at)}</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* The table twin: every node reachable without hovering anything. */}
      <details className="border-t border-white/[0.06]">
        <summary className="cursor-pointer px-5 py-2.5 text-2xs text-silver-500 hover:text-silver-300">
          View as a table ({graph.nodes.length} nodes, {visibleEdges.length} relationships)
        </summary>
        <div className="max-h-64 overflow-auto border-t border-white/[0.04]">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-ink-900">
              <tr>
                <th scope="col" className="px-5 py-2 text-left font-medium text-silver-500">
                  Node
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-silver-500">
                  Kind
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium text-silver-500">
                  Detail
                </th>
                <th scope="col" className="px-5 py-2 text-right font-medium text-silver-500">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {graph.nodes.map((node) => (
                <tr key={node.id} className="border-b border-white/[0.04] last:border-0">
                  <td className="px-5 py-2 text-silver-200">{node.label}</td>
                  <td className="px-3 py-2 text-silver-500">{KIND_LABELS[node.kind]}</td>
                  <td className="px-3 py-2 text-silver-500">{node.sublabel}</td>
                  <td className="tnum px-5 py-2 text-right text-silver-300">
                    {node.amountMinor === null ? '—' : formatMinorCompact(node.amountMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Surface>
  );
}

function EdgeLine({
  edge,
  from,
  to,
  dimmed,
}: {
  edge: GraphEdge;
  from: Placed;
  to: Placed;
  dimmed: boolean;
}) {
  // A gentle quadratic curve reads better than a straight line where many edges share an
  // endpoint: it separates them at the hub instead of stacking them.
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const curve = 0.12;
  const controlX = midX - dy * curve;
  const controlY = midY + dx * curve;

  const emphasised = edge.kind === 'raised_case' || edge.kind === 'previously_recovered';

  return (
    <path
      d={`M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`}
      fill="none"
      stroke={
        edge.kind === 'previously_recovered'
          ? STATUS.recovered
          : edge.kind === 'failed_with'
            ? STATUS.lost
            : 'rgba(255,255,255,0.16)'
      }
      strokeWidth={emphasised ? 1.5 : 1}
      strokeOpacity={dimmed ? 0.08 : 0.25 + edge.strength * 0.45}
      className="transition-opacity duration-200"
    />
  );
}
