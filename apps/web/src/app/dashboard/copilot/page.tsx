'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useApi, useMutation } from '@/lib/use-api';
import { PageHeader } from '@/components/dashboard/metrics';
import { Badge, Button, Panel, Surface, cn } from '@/components/ui/primitives';

interface CopilotAnswer {
  id: string;
  question: string;
  intent: string;
  answer: string;
  citations: Array<{ label: string; value: string }>;
  followUps: string[];
  toolsUsed: string[];
  reasoner: { id: string; kind: string; model: string; degraded: boolean; degradedReason: string | null };
  latencyMs: number;
}

interface Turn {
  question: string;
  answer: CopilotAnswer | null;
  error: string | null;
}

/**
 * THE REVENUE COPILOT
 *
 * Ask about leakage and recovery in plain language.
 *
 * The mechanism that makes the answers trustworthy is visible on screen: every response
 * lists the figures it relied on and the tools that produced them. The agent classifies
 * the question, runs the real analytics queries, computes the answer, and only then asks
 * the reasoner to word it — so there is no path by which a number reaches this page
 * without having come out of a query first.
 */
export default function CopilotPage() {
  const reduced = useReducedMotion();
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const { data: suggestions } = useApi<{ suggestions: string[] }>('/api/copilot');

  const ask = useMutation<{ question: string }, CopilotAnswer>('/api/copilot');

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'end' });
  }, [turns, reduced]);

  const submit = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length < 3 || ask.pending) return;

    setQuestion('');
    setTurns((previous) => [...previous, { question: trimmed, answer: null, error: null }]);

    const result = await ask.run({ question: trimmed });

    setTurns((previous) => {
      const next = [...previous];
      const last = next.length - 1;
      next[last] = {
        question: trimmed,
        answer: result,
        error: result ? null : (ask.error?.message ?? 'The copilot could not answer.'),
      };
      return next;
    });
  };

  return (
    <>
      <PageHeader
        title="AI revenue copilot"
        description="Ask about revenue leakage and recovery performance. Every figure in an answer is echoed back with the tool that produced it."
      />

      <div className="grid gap-6 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <Surface className="flex min-h-[560px] flex-col overflow-hidden">
            <div className="flex-1 space-y-5 overflow-y-auto p-5" aria-live="polite">
              {turns.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-4 py-16 text-center">
                  <p className="max-w-md text-sm leading-relaxed text-silver-400 text-pretty">
                    The copilot reads live application data. It cannot invent a number — the answer
                    is computed from real queries before any language is generated.
                  </p>
                  <div className="flex max-w-2xl flex-wrap justify-center gap-2">
                    {(suggestions?.suggestions ?? []).map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => void submit(suggestion)}
                        className="rounded-full border border-white/[0.09] bg-white/[0.03] px-3 py-1.5 text-xs text-silver-400 transition-colors hover:bg-white/[0.06] hover:text-silver-100"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                turns.map((turn, index) => (
                  <div key={index} className="space-y-3">
                    <div className="flex justify-end">
                      <p className="max-w-[75%] rounded-2xl rounded-br-sm border border-white/[0.09] bg-white/[0.05] px-4 py-2.5 text-xs leading-relaxed text-silver-100">
                        {turn.question}
                      </p>
                    </div>

                    {turn.answer === null && turn.error === null ? (
                      <ThinkingRow />
                    ) : turn.error ? (
                      <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-loss-500/25 bg-loss-500/[0.05] px-4 py-3">
                        <p className="text-xs text-loss-400">{turn.error}</p>
                      </div>
                    ) : (
                      <motion.div
                        initial={reduced ? false : { opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                        className="max-w-[85%] space-y-3"
                      >
                        <div className="rounded-2xl rounded-bl-sm border border-white/[0.07] bg-ink-850/80 px-4 py-3">
                          <p className="text-xs leading-relaxed text-silver-200 text-pretty">
                            {turn.answer!.answer}
                          </p>
                        </div>

                        {turn.answer!.citations.length > 0 && (
                          <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-4 py-3">
                            <p className="label-eyebrow">Figures this answer used</p>
                            <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                              {turn.answer!.citations.map((citation) => (
                                <div
                                  key={citation.label}
                                  className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] pb-1"
                                >
                                  <dt className="text-2xs text-silver-500">{citation.label}</dt>
                                  <dd className="tnum text-2xs text-silver-200">{citation.value}</dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone="neutral">
                            {turn.answer!.intent.replace(/_/g, ' ')}
                          </Badge>
                          {turn.answer!.toolsUsed.map((tool) => (
                            <Badge key={tool} tone="accent">
                              {tool}
                            </Badge>
                          ))}
                          <Badge tone={turn.answer!.reasoner.degraded ? 'warning' : 'neutral'}>
                            {turn.answer!.reasoner.kind === 'llm'
                              ? turn.answer!.reasoner.model
                              : 'deterministic reasoner'}
                          </Badge>
                          <span className="tnum text-2xs text-silver-600">
                            {turn.answer!.latencyMs}ms
                          </span>
                        </div>

                        {turn.answer!.followUps.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {turn.answer!.followUps.map((followUp) => (
                              <button
                                key={followUp}
                                type="button"
                                onClick={() => void submit(followUp)}
                                className="rounded-full border border-white/[0.08] px-3 py-1 text-2xs text-silver-500 transition-colors hover:bg-white/[0.05] hover:text-silver-200"
                              >
                                {followUp}
                              </button>
                            ))}
                          </div>
                        )}
                      </motion.div>
                    )}
                  </div>
                ))
              )}
              <div ref={endRef} />
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit(question);
              }}
              className="flex items-center gap-2 border-t border-white/[0.06] p-3"
            >
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Why did revenue drop this week?"
                aria-label="Ask the revenue copilot"
                maxLength={500}
                className="h-10 flex-1 rounded-lg border border-white/[0.09] bg-ink-850 px-3.5 text-xs text-silver-100 placeholder:text-silver-600 outline-none focus-visible:ring-2 focus-visible:ring-mint-500/60"
              />
              <Button
                type="submit"
                variant="primary"
                loading={ask.pending}
                disabled={question.trim().length < 3}
              >
                Ask
              </Button>
            </form>
          </Surface>
        </div>

        <div className="space-y-6">
          <Panel title="How this works" description="Why the numbers can be trusted.">
            <ol className="space-y-3">
              {[
                {
                  step: 'Classify',
                  body: 'The question is matched against intent patterns. This is a keyword matcher, not a model call — it decides which real queries to run.',
                },
                {
                  step: 'Query',
                  body: 'The agent runs the analytics those queries need against live records, and computes the complete answer itself.',
                },
                {
                  step: 'Word it',
                  body: 'Only then is the reasoner asked to phrase the finished figures. It is instructed to preserve every number exactly, and it never sees a question without the answer attached.',
                },
                {
                  step: 'Cite',
                  body: 'The citations shown are the computed figures, not the reasoner’s echo of them, so you can check any claim against the dashboard.',
                },
              ].map((item, index) => (
                <li key={item.step} className="flex gap-3">
                  <span className="font-mono text-2xs text-mint-500">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <p className="text-xs font-medium text-silver-200">{item.step}</p>
                    <p className="mt-0.5 text-2xs leading-relaxed text-silver-500 text-pretty">
                      {item.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Try asking" description="Questions the copilot answers well.">
            <ul className="space-y-1.5">
              {(suggestions?.suggestions ?? []).map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    onClick={() => void submit(suggestion)}
                    className={cn(
                      'w-full rounded-lg px-2.5 py-2 text-left text-xs text-silver-400 transition-colors',
                      'hover:bg-white/[0.04] hover:text-silver-100',
                    )}
                  >
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}

function ThinkingRow() {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-silver-600"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
      <span className="text-2xs text-silver-600">Running queries…</span>
    </div>
  );
}
