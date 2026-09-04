# Firestore schema

Seventeen collections, flat rather than nested. Every document carries `merchantId` so
every query can be scoped by it, and every timestamp is an ISO-8601 UTC string — which
sorts lexicographically, range-queries correctly, and survives a JSON round trip without
the timezone bugs a native `Timestamp` invites when it crosses a serialization boundary.

Document ids are the `id` field, duplicated inside the document so `getMany` can use an
`in` query on `id` rather than N point reads.

---

## Collections

### `merchants`

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `name`, `legalName`, `mcc` | string | |
| `currency` | `'INR'` | |
| `createdAt` | ISO string | |
| `policyOverrides` | map<string, number> | Per-merchant guardrail overrides, merged over platform defaults |

### `users`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Matches the Firebase Auth uid |
| `merchantId` | string | Also stamped on the auth custom claim; rules read the claim |
| `email`, `displayName` | string | |
| `role` | `owner` \| `analyst` \| `viewer` | |

### `customers`

Denormalised counters are maintained by the ingestion service so feature reads are O(1)
rather than requiring a full payment scan per prediction.

| Field | Type | Notes |
|---|---|---|
| `id`, `merchantId` | string | |
| `name`, `email`, `phone` | string | |
| `segment` | enterprise \| growth \| smb \| consumer \| trial | Drives amount distribution and reliability |
| `lifetimeValueMinor` | int | Paise |
| `successfulPaymentCount`, `failedPaymentCount` | int | |
| `priorRecoveryAttempts`, `priorRecoverySuccesses` | int | |
| `lastSuccessfulPaymentAt`, `lastFailedPaymentAt` | ISO \| null | |
| `preferredMethod` | payment method | |
| `contactPreference` | email \| sms \| whatsapp \| in_app | |
| **`contactOptOut`** | bool | **Hard policy gate.** No expected value overrides it |
| **`doNotRetry`** | bool | **Hard policy gate.** Set after disputes or explicit request |
| `chargebackCount` | int | Above tolerance, money movement is blocked |
| `timezone` | IANA string | Quiet hours are evaluated here, not in merchant time |

### `payments`

| Field | Type | Notes |
|---|---|---|
| `id`, `merchantId`, `customerId` | string | |
| `amountMinor` | int | **Always integer paise** |
| `method` | card \| upi \| netbanking \| wallet \| emi \| nach | |
| `issuer`, `network` | string \| null | Bank, UPI handle or wallet — leakage attribution |
| `status` | created \| authorized \| captured \| failed \| refunded | |
| `source` | checkout \| subscription \| invoice \| **recovery** | `recovery` marks a payment RECLAIM itself created |
| `failureReason` | failure reason \| null | One of 17 taxonomy codes |
| `errorCode` | string \| null | Razorpay-style code |
| `createdAt`, `capturedAt` | ISO \| null | |
| `subscriptionId`, `invoiceId`, `recoveryCaseId` | string \| null | |
| `idempotencyKey`, `providerRef` | string | |

### `payment_attempts`

One row per authorisation attempt, including RECLAIM's own. `initiatedByRecovery`
distinguishes them, which is what keeps recovery attempts out of the organic failure rate.

### `subscriptions`

| Field | Type | Notes |
|---|---|---|
| `planId`, `planName`, `planAmountMinor`, `interval` | | |
| `status` | active \| past_due \| paused \| cancelled \| completed | |
| `completedCycles`, `failedCycles` | int | |
| **`mandateActive`** | bool | **Hard policy gate.** Debiting without one is unauthorised, not merely ineffective |

### `invoices`, `checkout_sessions`

The two loss channels that never produce a bank error code. `checkout_sessions.stage`
(`cart` → `contact` → `method_selected` → `otp_pending`) determines the recoverability
prior — late-funnel abandonment recovers roughly three times better than early.

---

## The recovery pipeline

### `recovery_cases`

The unit of work. One revenue-loss event from detection to a measured outcome.

| Field | Type | Notes |
|---|---|---|
| `sourceType` | payment_failure \| subscription_dunning \| checkout_abandonment \| overdue_invoice | |
| **`sourceId`** | string | The originating payment/session/invoice. **Unique per merchant** — the de-duplication key |
| `amountAtRiskMinor` | int | |
| `status` | detected \| investigating \| awaiting_action \| in_progress \| recovered \| escalated \| stopped \| unrecoverable | Terminal states have no outgoing transitions |
| `recoveryProbability` | float \| null | Null until scored |
| `expectedValueMinor` | int \| null | Best available option, after costs |
| `priorityScore` | float \| null | amount × probability, decayed by age |
| `attemptCount`, `notificationCount` | int | Read directly by the policy engine |
| `cooldownUntil` | ISO \| null | |
| `recoveredAmountMinor` | int | Only ever captured money |
| `timeline` | array | Embedded, append-only; the UI timeline |

The timeline is embedded rather than a subcollection: it is always read with the case,
never queried independently, and is bounded by the retry and contact caps.

### `recovery_actions`

Every attempt, including the ones that never reached a provider.

| Field | Type | Notes |
|---|---|---|
| `strategy` | one of six | |
| `status` | pending \| blocked \| executing \| succeeded \| failed \| fell_back \| **skipped_duplicate** | |
| **`idempotencyKey`** | string | Claimed *before* the provider call |
| `aiDecisionId`, `policyDecisionId` | string \| null | The reasoning and the authorisation behind it |
| `providerRef`, `providerMode` | string | `demo` or `razorpay_test` — recorded per action |
| `attempts`, `error`, `errorCode` | | |

### `recovery_outcomes`

Where predicted probability meets reality. The rows the calibration chart is computed from.

| Field | Type | Notes |
|---|---|---|
| `outcome` | recovered \| action_failed \| no_response \| awaiting_customer \| escalated_to_human \| stopped | |
| `recoveredAmountMinor` | int | **Non-zero only when money was captured** |
| `predictedProbability` | float | Stored so the model can be checked rather than trusted |
| `timeToOutcomeMs` | int | |

### `ai_decisions`

The Decision Inspector's source. Reasoner identity (including `degraded` and why), detected
problem, weighted signals with logit contributions, diagnosis, probability, all six priced
candidates, recommendation, confidence, explanation, and the tool-call trace.

Written **before** execution begins, so the reasoning survives a crash mid-action.

### `policy_decisions`

Every guardrail evaluation, with all thirteen check results — not just the failing ones.

| Field | Type | Notes |
|---|---|---|
| `verdict` | allow \| deny \| require_human | |
| `checks` | array | `{ id, name, description, result, detail, reasonCode }` |
| `reasonCodes` | string[] | Machine-readable; the executor branches on these |
| `suggestedAlternative` | strategy \| null | Drives the fallback chain |
| `policyVersion` | string | |

### `audit_logs`

Append-only and hash-chained.

| Field | Type | Notes |
|---|---|---|
| `seq` | int | Monotonic **per merchant**, assigned inside a transaction |
| `prevHash` | string | Previous entry's hash; genesis is 64 zeros |
| `hash` | string | SHA-256 of the canonical JSON of every other field |
| `actor` | `{ kind, id }` | system \| agent \| user \| scheduler \| simulator |
| `event`, `trigger` | string | |
| `amountMinor`, `caseId`, `customerId` | | |
| `aiDecisionId`, `policyDecisionId`, `actionId` | string \| null | |
| `actionStatus`, `failure`, `fallback`, `finalOutcome` | | |

### `audit_chain_heads`

One pointer per merchant, `{ seq, hash }`, keyed by merchant id. The append transaction
reads exactly this one row rather than scanning the log, so appending is O(1) regardless
of chain length.

It gets its own collection rather than sitting in `audit_logs` under a reserved id. Keeping
it alongside the entries meant it matched every merchant-scoped read of the trail, so chain
verification received a document with no `hash` and the audit screen listed a row that was
not an audit event. No client access.

Verification replays the chain and recomputes every hash. Altering a historical record
invalidates every entry after it.

### `notifications`, `payment_links`

Rendered message bodies (stored in full, dispatched to nobody) and issued links.

### `idempotency_keys`

Document id **is** the key. Claimed in a transaction: read and write inside the same
transaction, so two concurrent executors racing on one key cannot both observe "unused".

**No client read access at all** — the keys derive from case and amount data, and exposing
the ledger would let a client probe which actions have been taken.

---

## Security rules

The governing principle: **the browser reads, the server writes.**

Every financial mutation goes through the action executor, running server-side behind the
policy engine and the idempotency ledger. Letting a client write a recovery action, an
outcome, or an audit entry directly would route around all of it.

- Client writes are denied on **every** collection.
- Reads are scoped by `request.auth.token.merchantId` — the custom claim, not a `users`
  lookup, which would allow cross-merchant reads in the window before claims propagate.
- `audit_logs`: readable so the chain can be verified in the browser; `create`, `update`
  and `delete` denied outright, since a client write would break the chain even if
  otherwise benign.
- `idempotency_keys`: no access.
- Default deny on everything unmatched.

The Admin SDK bypasses rules entirely and is the only writer. See
[`firestore.rules`](../firestore.rules).

---

## Indexes

Composite indexes in [`firestore.indexes.json`](../firestore.indexes.json). The query
surface is deliberately narrow — exactly what these indexes serve — so no query that works
against the in-memory store becomes a full-collection scan in production.

| Collection | Fields |
|---|---|
Firestore indexes every single field automatically, so a query with **one** equality
filter and no ordering needs nothing declared. Almost every read RECLAIM issues is exactly
that shape, which is why only two composite indexes are actually required:

| Collection | Fields | Why |
|---|---|---|
| `recovery_cases` | `merchantId` + `sourceId` | the case de-duplication lookup |
| `recovery_cases` | `merchantId` + `status` | the detection guard on startup |

The rest of `firestore.indexes.json` supports the ordered, server-paged reads described
under *Scale notes* below. They are declared ahead of that change because deploying an
index is slow and discovering the need in production is worse.

An earlier version of the store appended an implicit `orderBy('id')` to every query for
stable iteration. That forced a composite index on *every single filtered read* and made
the adapter fail on its first query against a fresh project. Ordering is now applied only
when a caller asks for it, and cursor pagination anchors on the document snapshot so it
works with or without an explicit sort.

---

## Scale notes

At the corpus's size — 24,000 payments, 5,000 customers — the whole dataset is a few tens
of megabytes and the in-memory store holds it comfortably. In Firestore mode nothing is
loaded into memory; the store reads through and the same engine code runs unchanged.

Two things would need attention at genuinely large scale, and both are structural rather
than incidental:

- **`ContextService.loadCustomerContext`** reads a customer's full payment history per
  case. For a customer with thousands of payments this should page, or read from a
  rolling aggregate maintained on write.
- **`AnalyticsService`** computes portfolio metrics by full scan, over a snapshot that is
  shared across a request and cached for 20 seconds against Firestore (and not at all
  against the in-memory store, where the scan is free). That brings one `/api/metrics`
  request from 48 collection scans down to 8, and to zero within the window.

  It is a mitigation, not a solution. Above a few hundred thousand cases this wants
  incremental aggregates updated by a Cloud Function trigger, with the scan kept as the
  reconciliation path. Without the cache the mode is not merely slow: a single dashboard
  load costs roughly 42,000 billed reads and exhausts a Spark project's daily allowance,
  which is how the problem was found.

Both are noted rather than hidden: the current shape is correct for the data volume it
targets, and the boundaries are drawn so the change would be local.
