# API reference

All endpoints live under `/api` and share one envelope, so the client never has to guess
which shape it received.

```jsonc
// success
{ "ok": true,  "data": { /* ... */ }, "meta": { "durationMs": 12, "at": "2026-09-01T…" } }

// failure
{ "ok": false, "error": { "code": "POLICY_DENIED", "message": "…", "retryable": false },
  "meta": { "durationMs": 3, "at": "2026-09-01T…" } }
```

`error.code` is a member of the `ErrorCode` union in `packages/core/src/errors`. HTTP
status follows from it (`404` for `NOT_FOUND`, `422` for `POLICY_DENIED`, `504` for
`PROVIDER_TIMEOUT`, and so on), and `retryable` tells a client whether repeating the
request could plausibly help.

---

## Reads

### `GET /api/runtime`

Capability and provenance for the whole app. The status rail is rendered from this, so a
viewer always knows what is actually running.

```jsonc
{
  "runtime": {
    "mode": "demo",                    // or "razorpay_test"
    "store": "memory",                 // or "firestore"
    "reasoner": { "provider": "deterministic", "model": "reclaim-reasoner-v1", "live": false },
    "paymentProvider": { "name": "RECLAIM demo provider", "live": false },
    "policyVersion": "policy-2026.09.1",
    "policy": { "maxRetries": 3, "cooldownHours": 6, /* … */ },
    "model": { "version": "recovery-probability-v1", "degraded": false, "rocAuc": 0.752, "threshold": 0.05 }
  },
  "corpus": { "customers": 5000, "payments": 24000, /* … */ },
  "boot": { "ms": 301, "at": "…" },
  "detection": { "casesOpenedOnBoot": 400 },
  "warnings": []                        // e.g. "No trained model artifact was found…"
}
```

Contains no credentials, by construction — it is the `PublicRuntimeInfo` projection.

### `GET /api/metrics`

The Control Tower payload in one round trip: `overview`, `funnel`, `trend` (30 days),
`opportunities` (top 12), `strategies`, `health`. Every value computed from stored records
at request time.

### `GET /api/leakage`

`breakdown` across failure reason, method, issuer, segment, source type, amount band and
hour of day; plus `comparison` (trailing 7 days vs the 7 before) and `overview`.

### `GET /api/cases`

Paginated, filtered case list.

| Query | Values |
|---|---|
| `status` | `open` \| `resolved` \| `recovered` \| `escalated` \| a specific status \| omitted for all |
| `sourceType` | one of the four loss channels |
| `q` | free text over customer name, email, case id, failure reason |
| `sort` | `priority` (default) \| `amount` \| `probability` \| `newest` |
| `page`, `pageSize` | default 1, 25 (max 100) |

Offset-based rather than cursor-based, deliberately: the sort keys are derived and change
as cases age, and a cursor over a moving sort key silently skips or repeats rows.

### `GET /api/cases/[caseId]`

Everything the investigation screen needs, assembled server-side: the case, customer,
failure profile, graph features, prediction with its drivers, all six priced strategies,
the opportunity graph, and every AI decision, policy decision, action, outcome,
notification, payment link and audit entry for the case.

### `GET /api/model`

The model card, read from the artifact `npm run train` wrote: dataset shape, training
parameters, both operating points, the full evaluation report with calibration bins and
threshold sweep, the held-out report, and the learned weights ranked by magnitude.

### `GET /api/policy`

The rulebook rendered from the *running* configuration — changing `POLICY_MAX_RETRIES`
changes what this returns — plus live enforcement counts per rule, verdict totals, top
denial reason codes, and the thirty most recent decisions.

### `GET /api/audit`

Paginated audit entries plus a **live chain verification** recomputed on every request
from the stored records. Filter by `caseId` or `event`. Verification always runs over the
complete chain, never the filtered page — a partial chain would fail to link and report a
false alarm.

### `GET /api/health`

Store, payment provider, reasoner, model, circuit-breaker snapshots, armed faults, and the
last forty structured log records.

### `GET /api/quality`

The test report, read from `apps/web/public/quality-report.json`. Returns
`{ available: false, message }` when the suite has not been run — which is the honest
answer, rather than a pass rate nobody verified.

### `GET /api/copilot`

Suggested questions for an empty copilot screen.

---

## Writes

### `POST /api/cases/[caseId]/decide`

Run the decision pipeline for one case.

```jsonc
{
  "execute": true,              // false → recommend and record, take no action
  "strategy": "payment_link",   // optional: force a strategy
  "actor": "user"               // "user" | "agent"
}
```

A forced strategy overrides the *recommendation*, never the *guardrails* — a human can
tell RECLAIM what to try, not what is permitted. The policy engine still runs and can
refuse, and the refusal is recorded.

Returns the AI decision, the full execution result (every step with its policy verdict),
the updated case, and per-phase timings.

### `POST /api/copilot`

```jsonc
{ "question": "Why did revenue drop this week?" }
```

Returns `answer`, `citations` (the computed figures, not the reasoner's echo of them),
`followUps`, `toolsUsed`, `intent`, and the reasoner identity. The agent classifies the
question, runs the real analytics queries, computes the answer, and only then asks the
reasoner to word it — so no number reaches the response without having come out of a query.

### `POST /api/simulate`

```jsonc
{ "limit": 400, "seed": 424242 }
```

Runs the portfolio under all six policies with identical seeded draws, plus a value-floor
sweep. Reproducible for a given seed.

---

## Demo mode

### `POST /api/demo/run`

```jsonc
{ "generateFailure": true, "failureReason": "insufficient_funds", "caseId": "…" }
```

Generates a genuinely new failure on a real customer (the failure class is constrained to
ones possible on that instrument), then runs the full pipeline. Returns a step-by-step
trace the demo screen animates.

Nothing is scripted: the probability is the model's, the policy verdict is the engine's,
and the outcome is whatever the provider returned. Runs sometimes end without the money
coming back.

### `POST /api/demo/batch`

```jsonc
{ "limit": 150, "detectFirst": true }
```

Processes the open queue **sequentially** — the policy engine reads per-customer contact
counts and per-case cooldowns that earlier iterations mutate, and running concurrently
would let two cases for one customer each see "no contact yet today".

Returns before/after portfolio state, recovered value, blocked count, duplicates
prevented, escalations, throughput, and the strategy mix for that run specifically.

### `GET` / `POST` / `DELETE` `/api/demo/faults`

Read the fault catalogue with armed faults, circuit states and the firing log; arm a fault
(`{ kind, target, count }`); or disarm one by `?id=` or all of them.

Faults are bounded — they fire a fixed number of times then disarm themselves — so an
armed fault cannot leak into the next demonstration. Arming is recorded in the audit trail.

---

## Notes for consumers

**Everything is `force-dynamic`.** These read live state; caching them would defeat the
purpose.

**No authentication is enforced by default.** `RECLAIM_AUTH_REQUIRED` exists and Firebase
Auth is wired for the client, but the demo runs open so it can be opened and used without
an account. In a real deployment these handlers would sit behind the auth middleware and
derive `merchantId` from the verified token rather than from configuration.

**Long-running endpoints.** `/api/demo/batch` declares `maxDuration = 300`. On a serverless
host with a shorter ceiling, lower `limit` or move the batch to the scheduled Cloud
Function, which is what it exists for.
