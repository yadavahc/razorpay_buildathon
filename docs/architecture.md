# Architecture

How RECLAIM is put together, and why the pieces are arranged this way.

---

## 1. The shape of the problem

A merchant loses revenue through four distinct channels, and treating them as one problem
is the mistake that leaves money on the table:

| Channel | Has a bank error code? | Can be retried? | Needs |
|---|---|---|---|
| Payment failure | yes | sometimes | diagnosis, then a retry or a link |
| Subscription dunning | yes | only with a live mandate | mandate check, then a retry or re-authorisation |
| Checkout abandonment | no | never | re-engagement — there is no authorisation to re-present |
| Overdue receivable | no | never | a reminder, escalating with age |

RECLAIM normalises all four into a `CaseProfile` — a recoverability prior, an optimal
delay, structural feasibility flags, and a per-strategy lift — so the rest of the pipeline
handles one shape while the domain keeps four distinct behaviours.

---

## 2. The layers

Each layer knows only about the one below it. The dependency direction never inverts.

```
┌──────────────────────────────────────────────────────────────────┐
│ PRESENTATION   Next.js app router. Route handlers, React screens. │
│                Imports the domain; the domain imports nothing here.│
├──────────────────────────────────────────────────────────────────┤
│ ORCHESTRATION  DecisionService — runs one case end to end.        │
│                IngestionService — turns activity into cases.      │
│                SimulationService — replays policies.              │
├──────────────────────────────────────────────────────────────────┤
│ AGENTS         Analyst (read scopes), Strategist, Copilot.        │
│                All action flows through the ToolRegistry.         │
├──────────────────────────────────────────────────────────────────┤
│ DECISIONING    Recovery model → Expected-value engine → Policy    │
│                engine. Only the first is probabilistic.           │
├──────────────────────────────────────────────────────────────────┤
│ EXECUTION      ActionExecutor. The only component permitted to    │
│                cause a side effect that costs or recovers money.  │
├──────────────────────────────────────────────────────────────────┤
│ ADAPTERS       PaymentProvider · Reasoner · DataStore             │
│                One interface each, two implementations each.      │
└──────────────────────────────────────────────────────────────────┘
```

`packages/core` has exactly one runtime dependency (zod) and no framework coupling, so the
same code runs in the Next.js server, in Cloud Functions, in the CLI scripts, and in the
test process. Anything touching the filesystem or the Admin SDK lives behind
`@reclaim/core/node`, which the browser bundle can never reach.

---

## 3. The decision pipeline

One case, end to end, as `DecisionService.runCase` executes it:

```
 1  CONTEXT    Assemble the customer, their full history, and the opportunity graph.
               One set of queries, one object, consumed by everything downstream — which
               is what guarantees the number the model scored is the number the merchant
               sees on the case screen.

 2  PREDICT    Score recoverability with the trained model. Records a per-feature logit
               decomposition alongside the probability.

 3  DIAGNOSE   The analyst agent investigates through read-only tools, then the reasoner
               explains what it found. The agent holds no write scope, so "let me look
               into this" cannot become "I have charged the customer".

 4  DECIDE     The expected-value engine prices all six strategies. The reasoner chooses
               among the priced options and justifies the choice. It may depart from the
               EV winner when the facts justify it — and the departure is recorded.

 5  RECORD     Persist an immutable AI decision record. This happens BEFORE execution:
               if the process died mid-action, the reasoning that led to it would still
               be on record, which is the property an auditor actually cares about.

 6  GUARD      The policy engine authorises, denies, or routes to a human. A denial is
               recorded as a blocked action with reason codes, never swallowed.

 7  EXECUTE    Claim the idempotency key, then call the provider behind a circuit breaker
               with bounded backoff. A denial or hard failure consults the suggested
               alternative and re-enters at step 6, bounded to three fallbacks.

 8  MEASURE    Record the outcome against the prediction. Only captured money counts as
               recovered.
```

Each phase is separately timed and reported, which is what the demo screen animates —
those are the real phase boundaries, not a scripted sequence.

---

## 4. Why the reasoning layer cannot break anything

The `Reasoner` interface exposes four tasks: diagnose, recommend, plan the next tool call,
and answer a copilot question. Note what is *not* there — no task returns an amount, a
probability, a retry count, a policy verdict, or a strategy the engine has not already
priced.

Everything a hosted model returns is treated as untrusted input:

- parsed as JSON and validated against a zod schema;
- a strategy name checked against the bounded action space, with a hallucinated or
  ineligible one discarded in favour of the expected-value winner;
- a malformed response retried once with the parse error fed back;
- any remaining failure, timeout or open circuit falling through to the deterministic
  reasoner, with the result stamped `degraded` so the UI can say so.

`LlmReasoner.structured()` is the single entry point for every model call, and it never
lets an exception escape. Nothing downstream handles an LLM error, because nothing
downstream can receive one.

**The deterministic reasoner is not a stub.** Every sentence it produces is composed from
quantities the pipeline actually measured — the taxonomy's account of the failure class,
the model's probability, the expected values, the graph features from the customer's real
history. What a hosted model adds is fluency and the ability to notice an unusual
combination of facts. What it does not add is a single new number.

---

## 5. Why the executor is ordered the way it is

```
POLICY  →  IDEMPOTENCY  →  EXECUTE  →  RECORD  →  FALL BACK
```

**Policy first**, so a forbidden action never reaches the point of consuming a key.

**Idempotency before the side effect, never after.** This is the entire double-charge
guarantee. If the claim fails, the action is recorded as a suppressed duplicate and no
provider call is made at all. A test fails if this ordering is reversed.

**Record whatever happened.** A failed action is as fully recorded as a successful one:
action row, outcome row, case timeline entry, audit entry.

**Fall back rather than give up.** A denial consults the policy engine's suggested
alternative; a hard provider failure consults a separate failure-fallback chain
(retry → delayed retry → link → notification → escalate). Bounded to three hops, with
already-attempted strategies excluded so the chain cannot cycle. This is where a
meaningful share of recovered revenue actually comes from: the retry that could not run
becoming the link that could.

---

## 6. The opportunity graph

A failed payment is never an isolated row. A ₹9,999 decline from a customer with eight
prior successful payments and a two-year subscription is a fundamentally different object
from the same decline on a first-time trial account, and treating them alike is exactly
how recovery engines waste money on the second and give up on the first.

`deriveGraphFeatures` assembles the neighbourhood —

```
Customer → Payments → Failures → Subscriptions → Prior attempts
         → Prior recoveries → Interventions → Outcomes
```

— and produces the relational features that carry most of the model's lift: lifetime
success ratio, prior recovery rate, whether a working alternate instrument exists,
subscription tenure, consecutive failure count.

It is deliberately pure: it takes an assembled context and a reference time, so training
(which replays history) and serving (which uses "now") go through exactly the same code.
That is the mechanism preventing train/serve skew, and it caught a real one during
development (§9).

The UI renders the same neighbourhood with a **deterministic radial layout** rather than a
force simulation. A force layout looks livelier and is worse: the same case would draw
differently on every visit, so a merchant could never learn to read it, and two people
looking at the same case would be looking at different pictures.

---

## 7. The economics

```
P(strategy)  = P(recoverable) × lift(strategy | failure class) × delay decay × attempt fatigue
EV(strategy) = P(strategy) × amount at risk − direct cost − goodwill cost
```

All integer paise, no floating point, fully reproducible, asserted to the rupee in tests.

- **Lift** comes from the failure taxonomy. An expired card has a delayed-retry lift of
  0.03 and a payment-link lift of 1.0; an insufficient-funds decline is the reverse.
- **Delay decay** discounts money that arrives later, with a floor — waiting three days
  makes recovery worse, not impossible.
- **Attempt fatigue** reduces the odds of each successive attempt: the easy failures have
  already been cleared by the earlier ones.
- **Goodwill cost** escalates with each message and is charged only to customer-facing
  strategies. A silent retry returns zero however many messages preceded it.
- **`stop_recovery` scores exactly zero**, which gives every other option a hurdle.

**Human escalation is modelled as a residual, not a multiplier.** A multiplier says a
human is 35% better at everything, which produces the absurd conclusion that a routine
insufficient-funds decline — where the textbook answer is "wait three days and retry", and
a human would do exactly that — is worth twelve minutes of analyst time. The residual says
what is true: where automation is already going to succeed a human adds almost nothing;
where automation is stuck, a human can negotiate, correct bad data or reach the customer
directly. That correction is §9.

---

## 8. Safety properties, and where each is enforced

| Property | Mechanism | Enforced in |
|---|---|---|
| No double charge | Idempotency key claimed before the provider call | `ActionExecutor`, `DataStore.claimIdempotency` |
| Bounded retries | Attempt counter checked per case | `evaluatePolicy` → `max_retries` |
| No provider hang | `withTimeout` + circuit breaker | `resilience/` |
| Graceful degradation | Reasoner fallback; model fallback prior | `LlmReasoner`, `PredictionService` |
| No unvalidated model output | zod schema + action-space check | `LlmReasoner.structured` |
| No unsafe agent action | Scope check before the handler runs | `ToolRegistry.invoke` |
| Human review | Ceiling + confidence triggers | `evaluatePolicy` → `require_human` |
| Tamper-evident history | Per-merchant hash chain, verified by replay | `appendAudit`, `verifyAuditChain` |
| Monotonic recovered total | Terminal states have no outgoing transitions | `CaseService.TRANSITIONS` |

---

## 9. Defects the tests caught

Thirteen real bugs surfaced during development. They are listed because a codebase that
claims to be tested should be able to say what the tests actually found.

The last four came from *running* the finished system rather than from writing new code,
which is its own argument: four of these were invisible to a passing test suite and a clean
typecheck.

**A first-attempt retry captured money and failed to record it.**
The state machine omitted `investigating → recovered`, on the assumption that a case
always passes through `in_progress` first. It does not: a retry that succeeds on the first
action captures immediately. The provider took the money, the transition threw, and nothing
was booked. Caught by an end-to-end test asserting the recovered total.
→ *Fix: `recovered` is reachable from every non-terminal state.*

**Train/serve skew in `hoursSinceFailure`.**
At training time the feature was derived from the chosen strategy's delay; at serving time
it means elapsed time since detection. The model learned a positive coefficient on a
quantity that is negative in the generative process — it was reading strategy selection
through a feature that would mean something else in production. Invisible in offline
metrics, fatal in the live system.
→ *Fix: detection delay drawn independently of strategy. Reported AUC fell 0.756 → 0.729,
which is the honest number.*

**Human escalation preferred on routine cases.**
The multiplicative lift model made escalation the expected-value winner on a ₹3,500
insufficient-funds decline the automation was already handling at 99%.
→ *Fix: residual model (§7). Locked in by a regression test.*

**The per-case budget was smaller than one escalation.**
Budget ₹150, escalation cost ₹180. Escalation could never execute — a budget smaller than
the actions it governs is not a budget, it is a ban.
→ *Fix: budget raised to ₹300.*

**A stopped case was reported as a failed action.**
`closeUnrecovered` wrote the outcome row but returned nothing, so `ExecutionResult.outcome`
stayed null and the demo screen fell back to labelling a guardrail stop as "action failed".
The record was right; the report was wrong.
→ *Fix: the closing outcome is returned and propagated. Locked in by a regression test.*

**A duplicate was reported as a policy block.**
When the idempotency ledger caught a replay, the policy engine denied it and the executor
recorded `blocked` rather than `skipped_duplicate`. Both prevent the double-charge, but the
metrics misattributed it — "duplicates prevented" undercounted and "blocked by policy"
overcounted, and those two numbers mean very different things to a merchant.
→ *Fix: a denial whose sole cause is the ledger is recorded as a duplicate.*

Two more surfaced only when the adapter was pointed at a real Firestore project, which is
why `npm run check:firestore` exists — the in-memory store satisfies the same interface and
could not have revealed either.

**Every filtered read demanded a composite index.**
`buildQuery` appended an implicit `orderBy('id')` for stable iteration. Firestore indexes
single fields automatically, but an equality filter combined with an ordering on a
different field requires a composite — so the adapter failed on its very first query
against a fresh project with `FAILED_PRECONDITION`.
*Fix: order only when the caller asks for it. Cursor pagination now anchors on the document
snapshot, which resolves against whatever ordering is in effect — including the implicit
`__name__` order — so it works with or without an explicit sort.*

**The audit chain head polluted the audit trail.**
The per-merchant `{ seq, hash }` pointer was stored inside `audit_logs` under a reserved
id. It carries `merchantId`, so it matched every merchant-scoped read of the trail: chain
verification received a document with no `hash` and crashed, and the audit screen would
have listed a row that was not an audit event.
*Fix: its own `audit_chain_heads` collection, with no client access.*

**One dashboard load exhausted a day's Firestore read quota.**
`AnalyticsService` read its whole working set on every method call, and `/api/metrics`
makes six such calls — 48 collection scans per request. Over the in-memory store that is
a few array filters and costs nothing measurable. Against Firestore it is roughly 42,000
billed document reads for a single page view, which is most of a Spark project's daily
allowance; the app rendered correctly and then the next request failed with
`RESOURCE_EXHAUSTED`.

This is the one defect that could only be found by running against a real project. It is
not a quota inconvenience — a mode that supports one page view per day is not a working
mode.
*Fix: a portfolio snapshot shared across the request and cached for a short TTL. Caching
the in-flight promise, not just the result, is what collapses the six concurrent calls
into one scan. 48 reads become 8 on the first call and 0 within the window. The TTL is
zero for the in-memory store, where the scan is free and a cache could only serve
something stale. The batch and demo endpoints invalidate explicitly so a run shows up
immediately.*

The genuine fix at scale is still incremental aggregates maintained on write, with the
scan kept as the reconciliation path — this makes the read-through implementation viable
until then rather than replacing that plan.

Two further definitional errors were caught by assertions rather than by crashes: the
funnel's stages were computed independently and could invert, and its top stage counted
only failed payments while the stage below counted all four loss channels. Both are fixed;
funnel nesting is now asserted.

---

**A blocked contact strategy proposed itself as its own fallback.**
`suggestAlternative` returned the strategy it had just been handed when quiet hours denied
it. The executor reads a self-suggestion as "nothing left to try", so every customer-facing
recommendation dead-ended overnight with `fallbacks 0` — abandoning positive expected value
at precisely the hours when nobody was watching. Found by running a live recovery at 04:55
IST, not by a test.
→ *Fix: quiet hours routes to a silent retry, which the check exempts by design. A sweep
test now asserts no strategy is ever proposed as its own replacement, across every reason
code and both denial verdicts — which immediately caught three more instances.*

**The fallback chain reported a strategy it never re-evaluated.**
The executor adopted the next strategy and only then checked whether it had already been
attempted, so on a repeat it exited via the top-of-loop guard with `finalStrategy` pointing
at the stale attempt. Worse, that exit path skipped `closeUnrecovered`, leaving cases
parked in `investigating` forever.
→ *Fix: the already-attempted test moved into `nextStrategy`, so a repeat returns null and
routes into the proper closing branch.*

**The bulk path paid language-model latency per case.**
Every case in a batch ran its investigation *and* its strategy recommendation through the
LLM. A 200-case sweep took nineteen minutes and started failing on `fetch failed` as the
circuit breaker opened. Nobody reads 200 generated explanations, and the decision is not the
model's to make: the score comes from the classifier and the authorisation from the policy
engine.
→ *Fix: batch work runs on the deterministic reasoner. 19 minutes → 10.6 seconds, same
decisions. Single-case investigation still uses the LLM, where a human will read it.*

**A timing analysis that found an effect everywhere.**
Described in §9a. The first cut of the timing engine reported a timing edge on seventeen of
seventeen failure reasons and a pay cycle on eight, including bank downtime. Both were the
same error — treating the maximum of many comparisons as though it were a single one.
→ *Fix: a two-proportion z-test on the winning cell and a chi-square test on the day axis.
Three of seventeen, and two, respectively.*

---

## 9a. Three additions, and the statistics that make them honest

Each of these was added after the core loop worked, and each exists because the loop had a
blind spot that the loop itself could not see.

### The guardrail regret ledger

A recovery system reports what it recovered. Almost none can say what its safety rules
cost, so guardrails get set once and only ever ratchet tighter.

The ledger separates a fact from an estimate and labels every field accordingly. Blocked
exposure is counted from persisted policy decisions and de-duplicated per case. Foregone
recovery is estimated from the rate the *same strategies actually realised* on the cases
they were permitted to run — deliberately not the model's own prediction, which would be
the function that recommended the action arguing for itself. Rows below twenty comparable
outcomes report no figure at all rather than a noisy one, and consent guardrails
(opt-out, do-not-retry, duplicate prevention) are never proposed for relaxation however
expensive they are shown to be.

It found that quiet hours was the single most expensive guardrail in the system — which is
the same defect described in §9 as the quiet-hours fallback dead end, arriving from the
opposite direction.

### Systemic incident detection

Every decision above this point is made about one payment in isolation. That is right for a
wrong CVV and exactly wrong for an issuer outage, where hundreds of unrelated customers
fail for a reason that has nothing to do with them and case-by-case logic responds by
retrying into a dead endpoint.

Detection is a binomial deviation against each dimension's *own* trailing baseline, not a
threshold on a count: a busy issuer fails more often than a quiet one at all times, so a
count-based rule fires constantly on the large banks and never on the small ones. The
baseline excludes the detection window, because a large enough incident would otherwise
raise its own yardstick and hide itself.

Suppression is published as an immutable snapshot the policy engine is *handed*, so
authorisation stays pure and synchronous. The failure mode is deliberately permissive: a
detector that has not run recently suppresses nothing, because a monitoring outage must
not become a revenue outage.

Only retries are held. A payment link still works while an issuer's authorisation endpoint
does not.

### The recovery timing engine

The system decided what to do and never decided when. Timing was a constant, which assumes
every failure decays the same way — but an expired card is permanent, an outage is
temporary, and insufficient funds is a statement about a balance on one particular day.

The engine estimates recovery rate over hours-since-failure × day-of-month per failure
reason. That grid is where this feature could most easily have lied, and it needed three
defences, two of which were added only after the first implementation produced obvious
nonsense:

1. **A sample floor per cell.** Below twenty observations a cell carries no rate.
2. **Empirical-Bayes shrinkage** toward the reason's own mean, so a thin cell showing 100%
   is pulled most of the way back rather than believed.
3. **A significance test on the winning cell.** The first version required only that the
   best cell beat the baseline by three points — and duly reported a timing edge on
   *seventeen of seventeen* failure reasons, including ones where waiting provably cannot
   help. The maximum of ~36 correlated comparisons is not distributed like a single draw.
   Requiring a two-proportion z of 3.3 cut that to three of seventeen.

The same error appeared on the day-of-month axis. A raw max-minus-min spread reported eight
"cyclical" failures including bank downtime and network errors, which cannot have a pay
cycle. A chi-square test against the reason's own baseline at p<0.01 cut that to exactly
the two liquidity-bound reasons with enough data to detect.

**On the synthetic corpus specifically.** The generator models Indian salary-cycle
liquidity, because real subscription dunning data shows it, and it applies that effect only
to funds-related declines. The timing engine is never told this. It recovered the effect on
`insufficient_funds` (chi-square 38.2, n=2031) and `daily_limit_exceeded` (29.4, n=1802),
produced zero false positives across fourteen technical failure reasons, and correctly
failed to detect `wallet_insufficient_balance` because it has only 141 observations. That
is a validation result for the detector, and it is not a discovery about real payments —
the UI says so on the page.

---

## 10. What is deliberately not here

**No microservices.** A well-structured modular monolith with clear service boundaries is
the right shape at this size. Splitting the policy engine from the executor across a
network boundary would add failure modes without adding isolation.

**No ORM.** The `DataStore` interface is narrow by design — exactly what Firestore can
serve efficiently with composite indexes, so no query that works in memory can quietly
become a full-collection scan in production.

**No gradient-boosted model.** Explainability beats the last point of AUC when the output
authorises spending money (§ README).

**No force-directed graph layout.** Determinism beats liveliness when the reader needs to
learn to read the picture (§6).

**No real message dispatch.** The system operates on synthetic customer records. Sending
real email or SMS to synthetic addresses would be both useless and irresponsible; messages
are rendered in full and stored so the content is inspectable.
