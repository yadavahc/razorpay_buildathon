import { describe, expect, it } from 'vitest';
import {
  FAILURE_PROFILES,
  FAILURE_REASON_LIST,
  GENESIS_HASH,
  MoneyError,
  RECOVERY_STRATEGIES,
  addMoney,
  canonicalJson,
  createMemoryStore,
  createRng,
  failureReasonsForMethod,
  formatMinor,
  formatMinorCompact,
  fromMajor,
  hashObject,
  idempotencyKeyFor,
  money,
  resolveCaseProfile,
  retryIsStructurallyPossible,
  scaleMinor,
  sha256Hex,
  subtractMoney,
  sumMoney,
  verifyAuditChain,
} from '@reclaim/core';

describe('money — integer arithmetic', () => {
  it('refuses a non-integer amount', () => {
    expect(() => money(10.5)).toThrow(MoneyError);
    expect(() => money(Number.NaN)).toThrow(MoneyError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 10)).toThrow(MoneyError);
  });

  it('converts from major units by rounding half-up to the paisa', () => {
    expect(fromMajor(99.99).amountMinor).toBe(9_999);
    expect(fromMajor(0.005).amountMinor).toBe(1);
    expect(fromMajor(1234.567).amountMinor).toBe(123_457);
  });

  it('adds and subtracts without floating-point drift', () => {
    // The classic 0.1 + 0.2 problem, which integer paise makes impossible.
    const total = sumMoney([fromMajor(0.1), fromMajor(0.2)]);
    expect(total.amountMinor).toBe(30);

    expect(addMoney(money(100), money(250)).amountMinor).toBe(350);
    expect(subtractMoney(money(350), money(100)).amountMinor).toBe(250);
  });

  it('scales by a ratio and rounds to an integer', () => {
    expect(scaleMinor(1_000_000, 0.37)).toBe(370_000);
    expect(scaleMinor(333_333, 0.5)).toBe(166_667);
    expect(Number.isInteger(scaleMinor(999_999, 0.333333))).toBe(true);
  });

  it('formats in Indian numbering', () => {
    expect(formatMinor(12_345_678, { whole: true })).toContain('1,23,457');
    expect(formatMinorCompact(1_000_000)).toBe('₹10.0K');
    expect(formatMinorCompact(150_000_000)).toBe('₹15.00L');
    expect(formatMinorCompact(-50_000).startsWith('-')).toBe(true);
  });
});

describe('hashing — determinism and canonical form', () => {
  it('produces the known SHA-256 of an empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces the known SHA-256 of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes structurally equal objects identically regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(hashObject({ x: [1, 2], y: null })).toBe(hashObject({ y: null, x: [1, 2] }));
  });

  it('derives the same idempotency key for identical intent', () => {
    const a = idempotencyKeyFor({ caseId: 'case_1', strategy: 'delayed_retry', attempt: 0 });
    const b = idempotencyKeyFor({ strategy: 'delayed_retry', attempt: 0, caseId: 'case_1' });
    expect(a).toBe(b);
  });

  it('derives a different key for different intent', () => {
    const a = idempotencyKeyFor({ caseId: 'case_1', attempt: 0 });
    const b = idempotencyKeyFor({ caseId: 'case_1', attempt: 1 });
    expect(a).not.toBe(b);
  });
});

describe('audit chain — tamper detection', () => {
  it('verifies a chain the store produced', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 12; i++) {
      await store.appendAudit({
        merchantId: 'merch_test',
        actor: { kind: 'system', id: 'test' },
        event: `event.${i}`,
        trigger: 'unit-test',
        amountMinor: i * 1_000,
      });
    }

    const logs = await store.auditLogs.list();
    const result = verifyAuditChain(logs);

    expect(result.valid).toBe(true);
    expect(result.checked).toBe(12);
    expect(logs[0]!.prevHash).toBe(GENESIS_HASH);
    expect(logs.map((l) => l.seq)).toEqual([...Array(12).keys()]);
  });

  it('detects an altered record', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 5; i++) {
      await store.appendAudit({
        merchantId: 'merch_test',
        actor: { kind: 'system', id: 'test' },
        event: 'action.executed',
        trigger: 'unit-test',
        amountMinor: 100_000,
      });
    }

    const logs = await store.auditLogs.list();
    // Someone edits an amount after the fact and leaves the hash alone.
    const tampered = logs.map((log, index) =>
      index === 2 ? { ...log, amountMinor: 999_999_999 } : log,
    );

    const result = verifyAuditChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('does not match its recorded hash');
  });

  it('detects a deleted record by the broken link', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 5; i++) {
      await store.appendAudit({
        merchantId: 'merch_test',
        actor: { kind: 'system', id: 'test' },
        event: 'action.executed',
        trigger: 'unit-test',
      });
    }

    const logs = await store.auditLogs.list();
    const withHole = logs.filter((_, index) => index !== 2);

    const result = verifyAuditChain(withHole);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expected prevHash');
  });

  it('keeps separate chains per merchant', async () => {
    const store = createMemoryStore();
    await store.appendAudit({
      merchantId: 'merch_a',
      actor: { kind: 'system', id: 't' },
      event: 'a',
      trigger: 't',
    });
    await store.appendAudit({
      merchantId: 'merch_b',
      actor: { kind: 'system', id: 't' },
      event: 'b',
      trigger: 't',
    });

    const all = await store.auditLogs.list();
    // Each merchant's chain starts at sequence zero from genesis.
    expect(all.every((log) => log.seq === 0)).toBe(true);
    expect(all.every((log) => log.prevHash === GENESIS_HASH)).toBe(true);
  });
});

describe('failure taxonomy — internal consistency', () => {
  it('defines a profile for every failure reason', () => {
    expect(FAILURE_REASON_LIST.length).toBe(Object.keys(FAILURE_PROFILES).length);
    for (const profile of FAILURE_REASON_LIST) {
      expect(FAILURE_PROFILES[profile.reason]).toBe(profile);
    }
  });

  it('gives every profile a lift for every strategy in the bounded action space', () => {
    for (const profile of FAILURE_REASON_LIST) {
      for (const strategy of RECOVERY_STRATEGIES) {
        expect(profile.strategyLift[strategy]).toBeTypeOf('number');
        expect(profile.strategyLift[strategy]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('never assigns direct recovery lift to escalating or stopping', () => {
    // Those two do not themselves recover money; their value is priced separately.
    for (const profile of FAILURE_REASON_LIST) {
      expect(profile.strategyLift.escalate).toBe(0);
      expect(profile.strategyLift.stop_recovery).toBe(0);
    }
  });

  it('gives structurally un-retryable failures near-zero retry lift', () => {
    for (const profile of FAILURE_REASON_LIST) {
      if (profile.retryPossible) continue;
      expect(profile.strategyLift.immediate_retry).toBeLessThan(0.05);
      expect(profile.strategyLift.delayed_retry).toBeLessThan(0.05);
    }
  });

  it('keeps every recoverability prior inside a plausible range', () => {
    for (const profile of FAILURE_REASON_LIST) {
      expect(profile.baseRecoverability).toBeGreaterThan(0);
      expect(profile.baseRecoverability).toBeLessThan(1);
    }
  });

  it('reports a revoked mandate as structurally un-retryable', () => {
    expect(retryIsStructurallyPossible('mandate_revoked')).toBe(false);
    expect(retryIsStructurallyPossible('card_expired')).toBe(false);
    expect(retryIsStructurallyPossible('insufficient_funds')).toBe(true);
    // No failure reason at all means nothing blocks a retry on structural grounds.
    expect(retryIsStructurallyPossible(null)).toBe(true);
  });

  it('only offers failure reasons that can occur on the given instrument', () => {
    // A UPI payment cannot fail because a card expired.
    const upiReasons = failureReasonsForMethod('upi').map((p) => p.reason);
    expect(upiReasons).not.toContain('card_expired');
    expect(upiReasons).not.toContain('incorrect_cvv');
    expect(upiReasons).toContain('upi_collect_expired');

    const cardReasons = failureReasonsForMethod('card').map((p) => p.reason);
    expect(cardReasons).toContain('card_expired');
    expect(cardReasons).not.toContain('upi_collect_expired');
  });
});

describe('case profiles — non-payment loss channels', () => {
  it('rates late-funnel abandonment above early-funnel abandonment', () => {
    const cart = resolveCaseProfile({
      sourceType: 'checkout_abandonment',
      failureReason: null,
      abandonmentStage: 'cart',
    });
    const otp = resolveCaseProfile({
      sourceType: 'checkout_abandonment',
      failureReason: null,
      abandonmentStage: 'otp_pending',
    });

    expect(otp.baseRecoverability).toBeGreaterThan(cart.baseRecoverability);
  });

  it('decays overdue receivables with age', () => {
    const ages = [3, 20, 60, 200].map((days) =>
      resolveCaseProfile({ sourceType: 'overdue_invoice', failureReason: null, daysOverdue: days }),
    );
    for (let i = 1; i < ages.length; i++) {
      expect(ages[i]!.baseRecoverability).toBeLessThan(ages[i - 1]!.baseRecoverability);
    }
  });

  it('never permits a retry on a loss with no stored authorisation', () => {
    for (const sourceType of ['checkout_abandonment', 'overdue_invoice'] as const) {
      const profile = resolveCaseProfile({ sourceType, failureReason: null });
      expect(profile.retryPossible).toBe(false);
    }
  });

  it('falls back to a conservative profile rather than throwing on unknown input', () => {
    const profile = resolveCaseProfile({ sourceType: 'payment_failure', failureReason: null });
    expect(profile.key).toBe('unclassified');
    expect(profile.baseRecoverability).toBeGreaterThan(0);
    expect(profile.retryPossible).toBe(false);
  });
});

describe('seeded randomness — reproducibility', () => {
  it('produces an identical sequence for the same seed', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const drawsA = Array.from({ length: 50 }, () => a.next());
    const drawsB = Array.from({ length: 50 }, () => b.next());
    expect(drawsA).toEqual(drawsB);
  });

  it('produces a different sequence for a different seed', () => {
    const a = Array.from({ length: 20 }, createRng(1).next);
    const b = Array.from({ length: 20 }, createRng(2).next);
    expect(a).not.toEqual(b);
  });

  it('respects weights over a large sample', () => {
    const rng = createRng(99);
    let heavy = 0;
    const trials = 20_000;
    for (let i = 0; i < trials; i++) {
      if (rng.weighted([['heavy', 80], ['light', 20]]) === 'heavy') heavy++;
    }
    expect(heavy / trials).toBeGreaterThan(0.77);
    expect(heavy / trials).toBeLessThan(0.83);
  });

  it('shuffles deterministically for a given seed', () => {
    const items = [...Array(20).keys()];
    expect(createRng(7).shuffle([...items])).toEqual(createRng(7).shuffle([...items]));
  });
});
