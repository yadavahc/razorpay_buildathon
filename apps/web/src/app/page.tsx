import { ensureDetectionRun, getEngineBundle } from '@/lib/engine';
import {
  ArchitectureSection,
  Hero,
  ImpactSection,
  LandingFooter,
  type LandingStats,
  LoopSection,
  ProblemSection,
} from '@/components/landing/sections';
import { SoundProvider } from '@/components/landing/sound';

export const dynamic = 'force-dynamic';

/**
 * The landing page is a server component that reads the engine directly rather than
 * calling its own API over HTTP. Every figure it shows is therefore the same figure the
 * dashboard would show, computed from the same records, with no round trip and no cache
 * that could drift.
 */
async function loadStats(): Promise<LandingStats> {
  const { engine, corpusStats } = await getEngineBundle();
  await ensureDetectionRun();

  const [overview, runtime] = await Promise.all([
    engine.analytics.controlTower(engine.merchantId),
    Promise.resolve(engine.runtimeInfo()),
  ]);

  return {
    grossRevenueMinor: overview.grossRevenueMinor,
    leakedRevenueMinor: overview.leakedRevenueMinor,
    leakageRate: overview.leakageRate,
    recoveredRevenueMinor: overview.recoveredRevenueMinor,
    recoveryRate: overview.recoveryRate,
    revenueAtRiskMinor: overview.revenueAtRiskMinor,
    activeCases: overview.activeCases,
    customers: corpusStats?.customers ?? overview.customersAffected,
    payments: corpusStats?.payments ?? 0,
    modelAuc: runtime.model.rocAuc,
    modelVersion: runtime.model.version,
    modelDegraded: runtime.model.degraded,
    reasoner: runtime.reasoner.live
      ? `${runtime.reasoner.provider} · ${runtime.reasoner.model}`
      : 'RECLAIM deterministic reasoner',
    reasonerLive: runtime.reasoner.live,
    provider: runtime.paymentProvider.name,
    providerLive: runtime.paymentProvider.live,
    interventionsExecuted: overview.interventionsExecuted,
    interventionsBlocked: overview.interventionsBlocked,
    duplicatesPrevented: overview.duplicatesPrevented,
  };
}

export default async function LandingPage() {
  const stats = await loadStats();

  return (
    // The sound design is scoped to this page. The dashboard is a working tool and the
    // provider never wraps it, so `useSound` there returns the no-op implementation.
    <SoundProvider>
      <main id="main" className="relative">
        <Hero stats={stats} />
        <ProblemSection stats={stats} />
        <LoopSection />
        <ArchitectureSection stats={stats} />
        <ImpactSection stats={stats} />
        <LandingFooter />
      </main>
    </SoundProvider>
  );
}
