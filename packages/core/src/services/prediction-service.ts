import type { Logger } from '../logging/index.js';
import { noopLogger } from '../logging/index.js';
import type { RecoveryFeatureInput } from '../ml/features.js';
import {
  type ModelArtifact,
  type Prediction,
  RecoveryModel,
  createFallbackModel,
  priorEstimate,
} from '../ml/model.js';
import type { DecisionSignal } from '../types/decisions.js';

/**
 * Serves the recovery-probability model.
 *
 * The important behaviour here is what happens when the trained artifact is missing — a
 * fresh clone before `npm run train`, or a Cloud Function whose bundle did not ship it.
 * The service does not throw and it does not silently return 0.5. It falls back to a
 * documented prior estimate, marks the prediction `degraded`, and reports a distinct
 * model version, which the API surfaces and the dashboard renders as a warning banner.
 * A degraded prediction is still a usable one; a hidden degradation is not.
 */

export interface PredictionResult extends Prediction {
  degraded: boolean;
  degradedReason: string | null;
  signals: DecisionSignal[];
}

export class PredictionService {
  private model: RecoveryModel;
  private degradedReason: string | null;

  constructor(
    artifact: ModelArtifact | null,
    private readonly logger: Logger = noopLogger,
  ) {
    if (artifact) {
      this.model = RecoveryModel.fromArtifact(artifact);
      this.degradedReason = null;
    } else {
      this.model = createFallbackModel();
      this.degradedReason =
        'No trained model artifact was found. Run "npm run train" to fit the model on the seeded corpus; predictions are using the taxonomy prior until then.';
      this.logger.warn('prediction service running without a trained artifact', {});
    }
  }

  get artifact(): ModelArtifact {
    return this.model.artifact;
  }

  get isDegraded(): boolean {
    return this.degradedReason !== null;
  }

  get version(): string {
    return this.model.version;
  }

  get threshold(): number {
    return this.model.threshold;
  }

  /** Swap in a freshly trained artifact without restarting the process. */
  reload(artifact: ModelArtifact): void {
    this.model = RecoveryModel.fromArtifact(artifact);
    this.degradedReason = null;
    this.logger.info('recovery model reloaded', {
      version: artifact.version,
      rocAuc: artifact.evaluation.probabilistic.rocAuc,
    });
  }

  predict(input: RecoveryFeatureInput): PredictionResult {
    if (this.degradedReason) {
      const probability = priorEstimate(input);
      return {
        probability,
        rawProbability: probability,
        logit: Math.log(probability / (1 - probability)),
        aboveThreshold: probability >= 0.5,
        threshold: 0.5,
        modelVersion: this.model.version,
        drivers: [],
        degraded: true,
        degradedReason: this.degradedReason,
        signals: [
          {
            key: 'profile_prior',
            label: 'Failure-class recoverability prior',
            value: input.baseRecoverability,
            contribution: null,
            direction: input.baseRecoverability >= 0.5 ? 'positive' : 'negative',
          },
          {
            key: 'customer_success_ratio',
            label: 'Lifetime payment success ratio',
            value:
              Math.round(
                ((input.customerSuccessCount + 1) /
                  (input.customerSuccessCount + input.customerFailureCount + 2)) *
                  1000,
              ) / 1000,
            contribution: null,
            direction: 'neutral',
          },
        ],
      };
    }

    const prediction = this.model.predict(input);
    return {
      ...prediction,
      degraded: false,
      degradedReason: null,
      signals: this.model.toSignals(prediction),
    };
  }

  /** Batch scoring for the simulator and the batch runner. */
  predictMany(inputs: readonly RecoveryFeatureInput[]): PredictionResult[] {
    return inputs.map((input) => this.predict(input));
  }
}
