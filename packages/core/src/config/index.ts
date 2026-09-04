import { z } from 'zod';
import { errors } from '../errors/index.js';
import type { RunMode } from '../types/enums.js';

/**
 * Configuration is read once from the environment, validated, and then passed explicitly
 * to the services that need it. Nothing in the codebase reads `process.env` directly, so
 * tests can construct a config object and the app never depends on ambient state.
 *
 * Secrets are never persisted to Firestore and never sent to the browser: the public
 * surface is the `PublicRuntimeInfo` projection at the bottom of this file.
 */

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v)));

const intish = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const envSchema = z.object({
  RECLAIM_MODE: z.enum(['demo', 'razorpay_test']).optional(),
  RECLAIM_STORE: z.enum(['memory', 'firestore']).optional(),
  RECLAIM_DATA_DIR: z.string().optional(),
  RECLAIM_MERCHANT_ID: z.string().optional(),
  RECLAIM_SEED: intish(20260901),
  RECLAIM_AUTH_REQUIRED: boolish(false),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),

  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_BASE_URL: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  LLM_TIMEOUT_MS: intish(20_000),

  POLICY_MAX_RETRIES: intish(3),
  POLICY_COOLDOWN_HOURS: intish(6),
  POLICY_AUTO_EXECUTE_CEILING_MINOR: intish(5_000_000),
  POLICY_DAILY_CONTACT_CAP: intish(2),
  POLICY_MIN_EXPECTED_VALUE_MINOR: intish(2_000),
  POLICY_QUIET_HOURS_START: intish(21),
  POLICY_QUIET_HOURS_END: intish(9),
  POLICY_MAX_CHARGEBACKS: intish(2),
  // Must exceed the cost of a single escalation (18,000) or escalation could never be
  // executed — a budget smaller than the actions it governs is not a budget, it is a ban.
  POLICY_CASE_BUDGET_MINOR: intish(30_000),
});

export interface PolicyConfig {
  /** Hard ceiling on automated payment retries per case. */
  maxRetries: number;
  /** Minimum hours between two actions on the same case. */
  cooldownHours: number;
  /** Above this amount, automation stops and a human approves. */
  autoExecuteCeilingMinor: number;
  /** Outbound messages per customer per rolling 24h. */
  dailyContactCap: number;
  /** Below this expected value, intervening destroys value: stop. */
  minExpectedValueMinor: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  maxChargebacks: number;
  /** Total intervention spend allowed per case. */
  caseBudgetMinor: number;
  version: string;
}

export interface LlmConfig {
  provider: 'openai' | 'anthropic' | 'deterministic';
  model: string;
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
}

export interface FirebaseConfig {
  projectId: string | null;
  clientEmail: string | null;
  privateKey: string | null;
  emulatorHost: string | null;
  usesAdc: boolean;
}

export interface RazorpayConfig {
  keyId: string | null;
  keySecret: string | null;
  baseUrl: string;
  webhookSecret: string | null;
}

export interface ReclaimConfig {
  mode: RunMode;
  store: 'memory' | 'firestore';
  dataDir: string;
  merchantId: string;
  seed: number;
  authRequired: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  policy: PolicyConfig;
  llm: LlmConfig;
  firebase: FirebaseConfig;
  razorpay: RazorpayConfig;
}

export const POLICY_VERSION = 'policy-2026.09.1';

function resolveLlm(env: z.infer<typeof envSchema>): LlmConfig {
  if (env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      model: env.OPENAI_MODEL ?? 'gpt-4o-mini',
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      timeoutMs: env.LLM_TIMEOUT_MS,
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
      apiKey: env.ANTHROPIC_API_KEY,
      baseUrl: 'https://api.anthropic.com/v1',
      timeoutMs: env.LLM_TIMEOUT_MS,
    };
  }
  return {
    provider: 'deterministic',
    model: 'reclaim-reasoner-v1',
    apiKey: null,
    baseUrl: '',
    timeoutMs: env.LLM_TIMEOUT_MS,
  };
}

function resolveFirebase(env: z.infer<typeof envSchema>): FirebaseConfig {
  return {
    projectId: env.FIREBASE_PROJECT_ID ?? null,
    clientEmail: env.FIREBASE_CLIENT_EMAIL ?? null,
    // Private keys arrive from .env files with escaped newlines.
    privateKey: env.FIREBASE_PRIVATE_KEY ? env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : null,
    emulatorHost: env.FIRESTORE_EMULATOR_HOST ?? null,
    usesAdc: Boolean(env.GOOGLE_APPLICATION_CREDENTIALS),
  };
}

function hasFirestoreCredentials(fb: FirebaseConfig): boolean {
  if (fb.emulatorHost && fb.projectId) return true;
  if (fb.usesAdc && fb.projectId) return true;
  return Boolean(fb.projectId && fb.clientEmail && fb.privateKey);
}

export function loadConfig(source: Record<string, string | undefined> = readProcessEnv()): ReclaimConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw errors.config(`invalid environment configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  const env = parsed.data;
  const firebase = resolveFirebase(env);
  const razorpayConfigured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

  const mode: RunMode = env.RECLAIM_MODE ?? (razorpayConfigured ? 'razorpay_test' : 'demo');
  if (mode === 'razorpay_test' && !razorpayConfigured) {
    throw errors.config(
      'RECLAIM_MODE=razorpay_test requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to be set',
    );
  }

  const store = env.RECLAIM_STORE ?? (hasFirestoreCredentials(firebase) ? 'firestore' : 'memory');
  if (store === 'firestore' && !hasFirestoreCredentials(firebase)) {
    throw errors.config(
      'RECLAIM_STORE=firestore requires FIREBASE_PROJECT_ID plus either service-account credentials, ADC, or FIRESTORE_EMULATOR_HOST',
    );
  }

  return {
    mode,
    store,
    dataDir: env.RECLAIM_DATA_DIR ?? 'data',
    merchantId: env.RECLAIM_MERCHANT_ID ?? 'merch_reclaim_demo',
    seed: env.RECLAIM_SEED,
    authRequired: env.RECLAIM_AUTH_REQUIRED,
    logLevel: env.LOG_LEVEL ?? 'info',
    policy: {
      maxRetries: env.POLICY_MAX_RETRIES,
      cooldownHours: env.POLICY_COOLDOWN_HOURS,
      autoExecuteCeilingMinor: env.POLICY_AUTO_EXECUTE_CEILING_MINOR,
      dailyContactCap: env.POLICY_DAILY_CONTACT_CAP,
      minExpectedValueMinor: env.POLICY_MIN_EXPECTED_VALUE_MINOR,
      quietHoursStart: env.POLICY_QUIET_HOURS_START,
      quietHoursEnd: env.POLICY_QUIET_HOURS_END,
      maxChargebacks: env.POLICY_MAX_CHARGEBACKS,
      caseBudgetMinor: env.POLICY_CASE_BUDGET_MINOR,
      version: POLICY_VERSION,
    },
    llm: resolveLlm(env),
    firebase,
    razorpay: {
      keyId: env.RAZORPAY_KEY_ID ?? null,
      keySecret: env.RAZORPAY_KEY_SECRET ?? null,
      baseUrl: env.RAZORPAY_BASE_URL ?? 'https://api.razorpay.com/v1',
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? null,
    },
  };
}

function readProcessEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}

/** Test/default config with no external dependencies of any kind. */
export function defaultConfig(overrides: Partial<ReclaimConfig> = {}): ReclaimConfig {
  const base = loadConfig({});
  return {
    ...base,
    ...overrides,
    policy: { ...base.policy, ...(overrides.policy ?? {}) },
    llm: { ...base.llm, ...(overrides.llm ?? {}) },
  };
}

/**
 * The only configuration shape allowed to reach the browser. Deliberately contains
 * capability flags, never credentials.
 */
export interface PublicRuntimeInfo {
  mode: RunMode;
  store: 'memory' | 'firestore';
  merchantId: string;
  reasoner: { provider: LlmConfig['provider']; model: string; live: boolean };
  paymentProvider: { name: string; live: boolean };
  policyVersion: string;
  policy: Omit<PolicyConfig, 'version'>;
}

export function toPublicRuntimeInfo(config: ReclaimConfig): PublicRuntimeInfo {
  const { version, ...policy } = config.policy;
  return {
    mode: config.mode,
    store: config.store,
    merchantId: config.merchantId,
    reasoner: {
      provider: config.llm.provider,
      model: config.llm.model,
      live: config.llm.provider !== 'deterministic',
    },
    paymentProvider: {
      name: config.mode === 'razorpay_test' ? 'Razorpay (test mode)' : 'RECLAIM demo provider',
      live: config.mode === 'razorpay_test',
    },
    policyVersion: version,
    policy,
  };
}
