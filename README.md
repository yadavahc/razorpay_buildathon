# RECLAIM

**Autonomous Revenue Recovery Infrastructure**

> Find the revenue slipping away. Decide what to do. Recover it safely.

RECLAIM is a decisioning layer that sits above payment infrastructure. Razorpay and its
peers give merchants excellent rails and rich failure signals; what sits above that layer
is unsolved. Given thousands of revenue-loss events, which are actually recoverable, what
should be done about each one, what does it cost, and did it work?

This repository is a complete, running answer to that question:

```
Detect → Diagnose → Predict → Decide → Guard → Execute → Measure → Learn
```

---

## Quick start

Three commands. No credentials, no accounts, no external services.

```bash
npm install
npm run bootstrap    # generate the synthetic corpus, then train the model
npm run dev          # http://localhost:3000
```

`npm run bootstrap` takes about five seconds: it writes a deterministic 24,000-payment
corpus to `data/` and fits the recovery-probability model on it. The dashboard is populated
the moment it opens.

To see the whole system work end to end, open **Demo mode** and press *Run live recovery*.

### Verifying the build

```bash
npm run verify       # typecheck → full test suite + quality report → production build
```

---

## What it does

| Signature feature | What it actually is |
|---|---|
| **Revenue Recovery Control Tower** | Revenue at risk, model-weighted recoverable revenue, measured recovered revenue, the recovery funnel, a live opportunity map and the guardrail scoreboard — all computed from stored records at request time. |
| **Recovery probability model** | A calibrated logistic regression over 26 features, trained on the corpus with a real train/validation/test split. Reported metrics come from the artifact, not from the UI source. |
| **Expected-value engine** | Prices all six interventions in integer paise: success probability × amount, minus direct cost, minus the goodwill cost of asking the customer again. Doing nothing scores exactly zero. |
| **Policy & guardrail engine** | Seventeen deterministic checks between a recommendation and a charge. The AI proposes; this authorises. |
| **Recovery opportunity graph** | The customer neighbourhood — payments, failures, subscriptions, prior interventions and their outcomes — rendered on the case screen and feeding the model's relational features. |
| **AI decision inspector** | The complete chain for any recommendation: detected problem, weighted signals, probability, priced options, guardrail verdicts, action, measured outcome. |
| **Merchant copilot** | Natural-language questions answered from real queries. Every figure is echoed back with the tool that produced it. |
| **Strategy simulator** | Replays the portfolio under six competing policies with identical seeded draws, so differences are attributable to the decision rather than to luck. |
| **Failure lab** | Arms any of seven faults and shows the system falling back, degrading or escalating instead of breaking. |
| **Audit trail** | Append-only and hash-chained. Verified by replay on every read, not by a stored flag. |
| **Guardrail regret ledger** | Prices what the safety rules cost. Blocked exposure is counted; foregone recovery is estimated from the rate the same strategies actually realised where they were permitted — never from the model, which would be arguing for itself. Proposes bounded policy amendments that always require human approval. |
| **Systemic incident detection** | Changes the unit of decision from a payment to a population. Detects correlated failure bursts by issuer, method or reason using a binomial deviation against each dimension's own baseline, holds retries into a dead route, and releases the held cohort as one coordinated wave when it recovers. |
| **Recovery timing engine** | Answers *when*, not just *what*. Estimates recovery rate over hours-since-failure × day-of-month per failure reason, with empirical-Bayes shrinkage and a significance test on the winning cell, so it reports a timing edge on 3 of 17 failure reasons rather than on all of them. |

---

## Runs with nothing; runs better with something

Every external dependency is optional and behind an interface. Removing one downgrades
that subsystem to an offline implementation, and **the UI states which one is active on
every screen** — a demo that silently pretends to be a live integration is a
misrepresentation, so RECLAIM badges the truth in the status rail.

| Subsystem | Without credentials | With credentials |
|---|---|---|
| **Payments** | Deterministic offline simulator, seeded by idempotency key | Razorpay test-mode API (`RECLAIM_MODE=razorpay_test`) |
| **Persistence** | In-process store loaded from the seeded corpus | Cloud Firestore via the Admin SDK (`RECLAIM_STORE=firestore`) |
| **Reasoning** | Built-in deterministic reasoner | OpenAI or Anthropic (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) |
| **Model** | Taxonomy prior, flagged degraded on every prediction | Trained artifact from `npm run train` |

### What is real in Razorpay test mode

Stated plainly, because the difference matters:

- **Payment links are fully real.** `createPaymentLink` creates an actual Razorpay
  test-mode link and returns the real `short_url`. This is the single most important
  recovery action in the product and it is genuinely exercised end to end.
- **Payment reads and health checks are fully real.**
- **The authorisation leg of a retry is simulated, and labelled.** RECLAIM creates a
  genuine Order (visible in the Razorpay dashboard), but it cannot complete the
  authorisation: re-charging a stored instrument requires a customer-authorised token or
  an active e-mandate, which a demo environment cannot provision and must never fake
  against a live-looking API. The result carries `simulated: true` and a `simulationNote`
  that the audit trail and the UI both display.

RECLAIM refuses to start against a non-`rzp_test_` key.

---

## The architecture

```
                        ┌──────────────────────────────┐
   Landing page ───────▶│      Merchant dashboard       │
                        └───────────────┬──────────────┘
                                        │  Next.js route handlers
                        ┌───────────────▼──────────────┐
                        │        RecoveryEngine         │  ← one wired object
                        └───────────────┬──────────────┘
        ┌───────────────┬───────────────┼───────────────┬────────────────┐
        ▼               ▼               ▼               ▼                ▼
   Ingestion      Recovery model   Analyst agent   Strategy agent    Copilot
   (detection)    (probability)    (read scopes)   (recommends)      (Q&A)
        │               │               │               │                │
        └───────────────┴───────────────┴───────┬───────┴────────────────┘
                                                ▼
                                  ┌─────────────────────────┐
                                  │  Expected-value engine   │  pure integer arithmetic
                                  └────────────┬────────────┘
                                               ▼
                                  ┌─────────────────────────┐
                                  │   POLICY ENGINE          │  deterministic, total
                                  │   allow / deny / human   │
                                  └────────────┬────────────┘
                                               ▼
                                  ┌─────────────────────────┐
                                  │   ACTION EXECUTOR        │  idempotency → retry →
                                  │                          │  circuit breaker → fallback
                                  └────────────┬────────────┘
                                               ▼
                        ┌──────────────────────┴───────────────────────┐
                        ▼                                               ▼
              Payment provider                                Outcome measurement
        (Razorpay test / offline sim)                                   │
                                                                        ▼
                                                        Hash-chained audit trail
                                                          (Firestore / in-memory)
```

Full detail in [`docs/architecture.md`](docs/architecture.md).

### The load-bearing design decisions

**The model never touches money.** Language models are good at reading a messy situation
and explaining a judgement. They are not good at arithmetic you cannot check, and they
should never stand between a customer and a charge. The reasoning layer chooses among
options that have *already been priced* and explains the choice; a deterministic engine
decides what is permitted. A model that names a strategy outside the bounded action space
is overridden and the override is recorded.

**Money is integers.** Every amount, everywhere, is an integer number of paise. Floating
point money is a class of bug this codebase cannot express.

**The idempotency key is claimed before the provider call, never after.** That ordering is
the whole guarantee, and there is a test that fails if it is reversed.

**Doing nothing scores exactly zero.** Which gives every other option a hurdle to clear.
An engine that cannot choose to stop will always find a reason to spend money.

**Only captured money counts as recovered.** A payment link that has been issued but not
paid is recorded as *awaiting customer*. Calling it revenue would make every number on the
dashboard a lie.

---

## The data

`npm run seed` generates a deterministic corpus. Same seed, same bytes, on any machine.

| | |
|---|---|
| Customers | 5,000 |
| Payments | 24,000 (~17.9% failure rate) |
| Subscriptions | ~1,500 |
| Invoices | ~1,500 |
| Abandoned checkouts | ~1,100 |
| Historical recovery episodes | ~3,300 (the training labels) |
| Held-out evaluation episodes | ~720 (disjoint payments, never trained on) |
| Live failures awaiting detection | ~265 |

Written to `data/` as JSON plus CSV exports for inspection.

Three properties make the corpus worth measuring against:

1. **Relationships are real.** Segment drives transaction size, which drives plan choice,
   which drives failure modes. A customer with a long successful history genuinely
   recovers better — because the latent process that produces the label reads the same
   history the model reads.
2. **The label comes from a process the model cannot see perfectly.** Outcomes are drawn
   against a latent probability that includes customer responsiveness and per-event
   shocks the feature set does not expose. That noise is why the reported AUC lands where
   a real model lands rather than at 0.99.
3. **History is causally ordered.** Features for a historical episode are computed from
   the customer's state *at that moment*. Training on information that did not exist yet
   is the easiest way to produce impressive, worthless metrics, and the generator is
   structured so it cannot happen.

```bash
npm run seed -- --customers 2000 --payments 6000 --seed 7   # smaller, different world
```

---

## The model

```bash
npm run train      # fit and write data/model.json
npm run evaluate   # held-out report, with the oracle ceiling and the no-learning floor
```

A calibrated L2 logistic regression over 26 features. The choice is deliberate: a
gradient-boosted ensemble would score a point or two higher, but this model is
**auditable** — every prediction decomposes into per-feature logit contributions a
merchant can read in the Decision Inspector, and the artifact is a few kilobytes of JSON.
For a system whose output authorises spending money, explainability beats the last point
of AUC.

### Reported honestly

Discrimination is reported against two reference points, because a headline AUC quoted
without them is close to meaningless:

| Scorer | ROC AUC | What it represents |
|---|---|---|
| Taxonomy prior only | ~0.69 | no learning at all — the floor |
| **Trained model** | **~0.75** | what actually ships |
| Oracle (latent truth) | ~0.83 | unreachable ceiling — the generative noise sets it |

The model captures roughly **76% of the discrimination theoretically available above
chance**. The remaining gap is customer responsiveness and per-event shocks, hidden from
the feature set by design.

### Two operating points

RECLAIM runs at the **value-optimal** threshold, chosen by maximising net recovered rupees
on the validation split. It sits low (~0.05) because a retry costs around ₹2.50 while a
missed recovery costs the whole balance — so acting is usually right, and the binding
constraint on action is the policy engine rather than the classifier.

The **balanced** threshold (~0.35, F1-maximising) is reported alongside it because that is
the point at which the confusion matrix is informative. Quoting only one of them tells
half the story, and it is usually the half that flatters the model.

---

## The guardrails

Seventeen deterministic checks. Three properties are load-bearing:

1. **Every check runs**, even after one has already failed — the audit record needs all of
   them, not just the first.
2. **A check can only ever restrict.** There is no code path where one upgrades a denial
   into an approval.
3. **Missing evidence resolves to the restrictive branch**, never the permissive one.

| Guardrail | Default |
|---|---|
| Maximum automated retries | 3 per case |
| Cooldown between actions | 6 hours |
| Automated transaction ceiling | ₹50,000 — above this a human approves |
| Daily contact cap | 2 messages per customer per rolling 24h |
| Expected-value floor | ₹20 — below this, stopping is correct |
| Quiet hours | 21:00–09:00 **in the customer's own timezone** |
| Per-case intervention budget | ₹300 |
| Chargeback tolerance | 2 prior disputes |
| Contact consent | hard gate — no expected value overrides it |
| Mandate validity | hard gate — debiting without one is unauthorised, not merely ineffective |
| Structural feasibility | hard gate — an expired card cannot be retried at any price |
| Duplicate prevention | idempotency ledger, claimed before the side effect |
| Human escalation | material amount + low confidence → a person decides |

All tunable through environment variables; the Policy page renders them from the running
configuration, so changing one changes what the page says.

---

## Testing

```bash
npm test              # 159 tests across 7 suites
npm run test:report   # run the suite and publish results to the System Quality page
```

| Category | Tests | What it catches |
|---|---|---|
| Unit | 81 | Policy engine against every guardrail; expected value asserted to the rupee; integer money; audit hash chain; taxonomy consistency |
| Integration | 21 | Repository semantics; atomic idempotency under concurrency; case lifecycle; detection across all four loss channels |
| Agent | 27 | Tool authorisation by scope; validation against hostile arguments; idempotent calls; tool-failure handling |
| End-to-end | 11 | The complete pipeline with nothing stubbed but the outside world; batch; money booked exactly once |
| Failure injection | 19 | Every fault the lab can arm, asserted to produce a recovery rather than a crash |

The suite runs against a **real engine over a real in-memory store** — real policy engine,
real executor, real agents, real audit chain. A suite that mocks the executor proves the
mock works.

Six real defects were found and fixed by these tests during development, including a
state-machine gap where a first-attempt retry captured the money and then failed to record
it. They are documented in [`docs/architecture.md`](docs/architecture.md#defects-the-tests-caught).

The System Quality page reads a file that a real test run writes. Until the suite has been
run it says so, rather than showing a green badge nobody earned.

---

## Firebase

RECLAIM runs entirely without Firebase. To use it:

```bash
# 1. Credentials. A service-account JSON file is easiest — the private key contains
#    newlines, and a file avoids escaping them through shell and dotenv parsing.
#    Project settings → Service accounts → Generate new private key
FIREBASE_PROJECT_ID=your-project
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json     # gitignored

# 2. Verify the connection before committing to anything. Writes ~30 documents to a
#    throwaway namespace, exercises the transactional idempotency claim and the
#    hash-chained audit append, then deletes them.
npm run check:firestore

# 3. Rules and indexes
firebase deploy --only firestore:rules,firestore:indexes

# 4. Upload the corpus (~35,000 documents — above the Spark free daily write tier)
npm run seed:firestore

# 5. Switch the app over
RECLAIM_STORE=firestore

# 6. Cloud Functions (optional)
npm run functions:build && firebase deploy --only functions
```

`npm run check:firestore` is worth running first. It found two real bugs in the Firestore
adapter that the in-memory tests could not: an implicit `orderBy('id')` that forced a
composite index on every filtered read, and a chain-head document stored inside
`audit_logs` where it polluted every merchant-scoped read of the trail.

The web config in `.env.local` points at **`reclaim-razorpay`**. Those `NEXT_PUBLIC_*`
values cover the client SDK (auth and analytics) only — server-side Firestore needs an
Admin SDK service account for the same project, which is a separate download.

> **Before deploying rules**, note that `firestore.rules` denies all client writes and
> scopes reads by a `merchantId` custom claim. If the project already serves another app,
> deploying will lock that app out — check the existing collections first.

Or run everything locally against the emulator:

```bash
firebase emulators:start          # sets FIRESTORE_EMULATOR_HOST
npm run seed:firestore
```

**Security rules**: the browser reads, the server writes. Every financial mutation goes
through the action executor behind the policy engine and the idempotency ledger; letting a
client write a recovery action directly would route around all of it. Client writes are
denied on every collection that records money or decisions, reads are scoped by merchant
claim, and the idempotency ledger is invisible to clients entirely. See
[`firestore.rules`](firestore.rules) and
[`docs/firestore-schema.md`](docs/firestore-schema.md).

**Cloud Functions** provide event-driven detection (`onPaymentFailure`), a scheduled sweep
(`runRecoverySweep`), a signature-verified Razorpay webhook, and a daily audit-chain
integrity check. They construct the same `RecoveryEngine` the web app does — a Cloud
Function is a different trigger for the same engine, not a second implementation.

---

## Repository layout

```
packages/core/          The domain. Zero framework coupling, one runtime dependency (zod).
  domain/               Failure taxonomy, case profiles, intervention economics
  ml/                   Features, logistic regression, metrics, training pipeline
  strategy/             Expected value, strategy engine
  policy/               The deterministic guardrail engine
  graph/                Recovery opportunity graph
  agents/               Tool registry, analyst, strategist, copilot
  providers/            Payment provider abstraction (demo + Razorpay)
  llm/                  Reasoner abstraction (hosted + deterministic)
  store/                Persistence abstraction (memory + Firestore)
  services/             Ingestion, context, prediction, execution, analytics, simulation
  seed/                 Synthetic corpus generator
  node/                 Filesystem and Admin SDK — never imported by the browser

apps/web/               Next.js 15 application
  app/api/              Route handlers
  app/dashboard/        Eleven screens
  components/charts/    Validated palette, mark specs, table twins
  components/dashboard/ Opportunity graph, decision inspector, shell

functions/              Firebase Cloud Functions
scripts/                seed, train, evaluate, reset, seed:firestore,
                        check:firestore, test:report
tests/                  unit / integration / agent / e2e / failure
docs/                   Architecture, Firestore schema, API reference
```

### Scripts

| Command | What it does |
|---|---|
| `npm run bootstrap` | `seed` then `train` — everything a fresh clone needs |
| `npm run seed` | Generate the synthetic corpus |
| `npm run train` | Fit the model, write `data/model.json` |
| `npm run evaluate` | Held-out report with oracle and baseline references |
| `npm run dev` | Development server |
| `npm test` | Full suite |
| `npm run test:report` | Suite + publish results to the quality page |
| `npm run verify` | Typecheck, test, build |
| `npm run reset` | Return the demo to a clean state |
| `npm run seed:firestore` | Upload the corpus to Firestore |
| `npm run check:firestore` | Verify the Firestore adapter against a real project |

---

## Deployment

```bash
npm run build
npm start
```

Any Node host works. The one constraint that applies everywhere: `data/` must exist at
**build** time or the deployed app reports its model as degraded. Either commit the
artifact or put `npm run bootstrap` in the build command.

### Firebase Hosting

RECLAIM has dynamic route handlers and a server-side engine, so it cannot be a static
export. Firebase's web-frameworks integration builds the Next.js app and puts the server
on Cloud Functions:

```bash
firebase experiments:enable webframeworks   # once per machine
firebase use reclaim-razorpay
npm run bootstrap                           # corpus + model must exist before the build
firebase deploy --only hosting:app
```

`firebase.json` targets the `app` hosting target, mapped to the site
`reclaim-razorpay-2c628` in `.firebaserc`, with the backend in `asia-south1`.

`NEXT_PUBLIC_*` values are inlined at build time, so they must be present in the
environment when `firebase deploy` runs the build — `.env.local` at the repository root
is read by `next.config.mjs`, which is enough for a local deploy.

### Vercel

Set the root directory to `apps/web`, add the variables from `.env.example`, and use
`npm run bootstrap && npm run build` as the build command.

---

## A note on synthetic data

Everything in this repository runs on generated data. No real customer records, no real
payment credentials, and **no messages are dispatched to anyone** — the messaging provider
renders and stores message bodies so they can be inspected in the UI, and dispatches
nothing. Sending real email or SMS to synthetic addresses would be both useless and
irresponsible.

Where an operation is simulated rather than performed, the result says so, the audit trail
records it, and the interface displays it.
