import { MerchantCopilot } from './agents/copilot.js';
import { RecoveryAnalystAgent } from './agents/recovery-analyst.js';
import { DeterministicReasoner } from './llm/deterministic-reasoner.js';
import { StrategyAgent } from './agents/strategy-agent.js';
import { createToolRegistry } from './agents/tools/definitions.js';
import type { ToolRegistry } from './agents/tools/registry.js';
import { type PublicRuntimeInfo, type ReclaimConfig, toPublicRuntimeInfo } from './config/index.js';
import { createReasoner } from './llm/index.js';
import type { Reasoner } from './llm/reasoner.js';
import { createLogger, type Logger, memorySink, consoleSink } from './logging/index.js';
import type { ModelArtifact } from './ml/model.js';
import { createNotificationProvider, createPaymentProvider } from './providers/index.js';
import type { NotificationProvider, PaymentProvider } from './providers/payment-provider.js';
import { CircuitRegistry } from './resilience/index.js';
import { ActionExecutor } from './services/action-executor.js';
import { IncidentService } from './services/incident-service.js';
import { AnalyticsService } from './services/analytics-service.js';
import { CaseService } from './services/case-service.js';
import { ContextService } from './services/context-service.js';
import { DecisionService } from './services/decision-service.js';
import { faultInjector, type FaultInjector } from './services/fault-injector.js';
import { IngestionService } from './services/ingestion-service.js';
import { PredictionService } from './services/prediction-service.js';
import { SimulationService } from './services/simulation-service.js';
import type { DataStore } from './store/types.js';

/**
 * THE ENGINE
 *
 * One object that wires every component together with explicit dependencies. There is no
 * service locator, no global registry, no module-level singleton reaching for a database
 * — everything a service needs is handed to it at construction.
 *
 * The practical payoff is testability: a full engine over an in-memory store with a stub
 * provider is three lines, so the end-to-end tests exercise the real pipeline rather than
 * a mock of it.
 */
export interface RecoveryEngineOptions {
  config: ReclaimConfig;
  store: DataStore;
  modelArtifact: ModelArtifact | null;
  /** Override for tests; defaults to the provider chosen by `config.mode`. */
  paymentProvider?: PaymentProvider;
  notificationProvider?: NotificationProvider;
  /** Override for tests; defaults to the reasoner chosen by `config.llm`. */
  reasoner?: Reasoner;
  logger?: Logger;
  /** Injected in tests so retry backoff does not consume real wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
}

export class RecoveryEngine {
  readonly config: ReclaimConfig;
  readonly store: DataStore;
  readonly logger: Logger;
  readonly logSink: ReturnType<typeof memorySink>;

  readonly paymentProvider: PaymentProvider;
  readonly notificationProvider: NotificationProvider;
  readonly reasoner: Reasoner;
  readonly circuits: CircuitRegistry;
  readonly faults: FaultInjector;

  readonly context: ContextService;
  readonly prediction: PredictionService;
  readonly cases: CaseService;
  readonly analytics: AnalyticsService;
  readonly ingestion: IngestionService;
  readonly incidents: IncidentService;
  readonly executor: ActionExecutor;
  readonly decisions: DecisionService;
  readonly simulation: SimulationService;

  readonly tools: ToolRegistry;
  readonly analyst: RecoveryAnalystAgent;
  /** Same agent, deterministic reasoner. Used for batch work. */
  readonly bulkAnalyst: RecoveryAnalystAgent;
  /** Same agent, deterministic reasoner. Used for batch work. */
  readonly bulkStrategist: StrategyAgent;
  readonly strategist: StrategyAgent;
  readonly copilot: MerchantCopilot;

  constructor(options: RecoveryEngineOptions) {
    this.config = options.config;
    this.store = options.store;

    // Every log record is kept in a bounded ring buffer as well as written out, so the
    // ops panel can show what the engine actually did during a demo run.
    this.logSink = memorySink();
    this.logger =
      options.logger ??
      createLogger(
        { service: 'reclaim', mode: options.config.mode },
        { level: options.config.logLevel, sinks: [consoleSink, this.logSink] },
      );

    this.circuits = new CircuitRegistry();
    this.faults = faultInjector;

    this.paymentProvider = options.paymentProvider ?? createPaymentProvider(options.config);
    this.notificationProvider =
      options.notificationProvider ?? createNotificationProvider(options.config);
    this.reasoner = options.reasoner ?? createReasoner(options.config, this.logger);

    this.context = new ContextService(this.store);
    this.prediction = new PredictionService(options.modelArtifact, this.logger);
    this.cases = new CaseService(this.store);
    this.analytics = new AnalyticsService(this.store);
    this.ingestion = new IngestionService(this.store, this.logger);

    this.incidents = new IncidentService(this.store);
    this.executor = new ActionExecutor({
      store: this.store,
      paymentProvider: this.paymentProvider,
      notificationProvider: this.notificationProvider,
      policyConfig: this.config.policy,
      mode: this.config.mode,
      logger: this.logger,
      circuits: this.circuits,
      incidents: this.incidents,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });

    this.tools = createToolRegistry({
      context: this.context,
      prediction: this.prediction,
      analytics: this.analytics,
      executor: this.executor,
    });

    this.analyst = new RecoveryAnalystAgent({
      registry: this.tools,
      reasoner: this.reasoner,
      store: this.store,
      logger: this.logger,
    });
    this.strategist = new StrategyAgent({ reasoner: this.reasoner, logger: this.logger });

    // BULK PATH. A language model earns its latency when a human is going to read the
    // answer: one case, investigated, explained. Across a 300-case sweep nobody reads 300
    // explanations, and the decision is not the LLM's to make anyway -- the score comes
    // from the model and the authorisation from the policy engine. Paying ~13s of network
    // latency per case for prose no one opens turns a 12-second batch into a 65-minute one.
    //
    // So bulk work runs on the deterministic reasoner, which produces grounded prose from
    // the same measured quantities with no network call. Identical decisions, same
    // guardrails, three orders of magnitude faster.
    this.bulkAnalyst = new RecoveryAnalystAgent({
      registry: this.tools,
      reasoner: new DeterministicReasoner(),
      store: this.store,
      logger: this.logger,
    });
    this.bulkStrategist = new StrategyAgent({
      reasoner: new DeterministicReasoner(),
      logger: this.logger,
    });
    this.copilot = new MerchantCopilot({
      analytics: this.analytics,
      reasoner: this.reasoner,
      logger: this.logger,
    });

    this.decisions = new DecisionService({
      store: this.store,
      context: this.context,
      prediction: this.prediction,
      analyst: this.analyst,
      bulkAnalyst: this.bulkAnalyst,
      bulkStrategist: this.bulkStrategist,
      strategist: this.strategist,
      executor: this.executor,
      logger: this.logger,
    });

    this.simulation = new SimulationService(this.store, this.context, this.prediction);
  }

  get merchantId(): string {
    return this.config.merchantId;
  }

  /** The capability summary sent to the browser. Contains no credentials, by construction. */
  runtimeInfo(): PublicRuntimeInfo & {
    model: {
      version: string;
      degraded: boolean;
      trainedAt: string | null;
      rocAuc: number;
      threshold: number;
    };
    reasonerId: string;
    storeKind: 'memory' | 'firestore';
  } {
    const artifact = this.prediction.artifact;
    return {
      ...toPublicRuntimeInfo(this.config),
      model: {
        version: this.prediction.version,
        degraded: this.prediction.isDegraded,
        trainedAt: this.prediction.isDegraded ? null : artifact.trainedAt,
        rocAuc: artifact.evaluation.probabilistic.rocAuc,
        threshold: this.prediction.threshold,
      },
      reasonerId: this.reasoner.identity.id,
      storeKind: this.store.kind,
    };
  }

  /** Provider and circuit health, for the ops panel and the failure lab. */
  async health(): Promise<{
    store: { kind: string; healthy: boolean; counts: Record<string, number> };
    payments: { name: string; live: boolean; healthy: boolean; detail: string };
    reasoner: { id: string; kind: string; model: string };
    model: { version: string; degraded: boolean };
    circuits: ReturnType<CircuitRegistry['snapshots']>;
    faults: ReturnType<FaultInjector['armed']>;
  }> {
    const [counts, paymentHealth] = await Promise.all([
      this.store.stats().catch(() => ({}) as Record<string, number>),
      this.paymentProvider.health().catch((error: unknown) => ({
        healthy: false,
        latencyMs: 0,
        detail: error instanceof Error ? error.message : 'unknown error',
      })),
    ]);

    return {
      store: { kind: this.store.kind, healthy: Object.keys(counts).length > 0, counts },
      payments: {
        name: this.paymentProvider.identity.name,
        live: this.paymentProvider.identity.live,
        healthy: paymentHealth.healthy,
        detail: paymentHealth.detail,
      },
      reasoner: {
        id: this.reasoner.identity.id,
        kind: this.reasoner.identity.kind,
        model: this.reasoner.identity.model,
      },
      model: { version: this.prediction.version, degraded: this.prediction.isDegraded },
      circuits: this.circuits.snapshots(),
      faults: this.faults.armed(),
    };
  }
}

export function createRecoveryEngine(options: RecoveryEngineOptions): RecoveryEngine {
  return new RecoveryEngine(options);
}
