# SPEC.md — Kill It Twice

**Version:** v4
**Date:** 2026-09-16
**Author:** Aleksandre Tsamalashvili
**Status:** Written before implementation. Expected to change — revisions are logged in §14.

---

## 0. How to read this document

This is the document I am building from. It records **decisions I have already made**, the
alternatives I rejected, and the questions I have deliberately left open.

Language rules I am holding myself to:

- **"Must" / "is" / "does"** = decided. The agent implements it as written and does not
  substitute its own judgment.
- **"Open"** = not decided. Listed in §13. The agent must stop and ask rather than guess.

If the implementation needs to contradict something marked as decided, that is a **spec
deviation**: stop, record it in `DEVLOG.md`, and amend this file in its own commit before
continuing.

---

## 1. What I am building

A data replication system that takes a relational source of truth and propagates it into two
derived systems, and stays correct when any part of it dies.

```
PostgreSQL (source of truth)
        │
        ├── Backfill path ──────────┐
        │   (existing rows)         │
        │                           ▼
        └── Outbox path ────► Replication Layer ──► Elasticsearch (current state)
            (live changes)          │
                                    └───────────► RabbitMQ ──► Consumer ──► Projection table
```

Both paths run **concurrently**, and both write to **both sinks**. Failures anywhere are absorbed
by checkpoints, bounded retries, and a DLQ. The whole thing is observable from a UI and provable
by one command.

**The primary deliverable is `make verify`.** Everything in this spec exists to make the five
gates in §9 pass under a script, not under a demo I narrate by hand. Where a design choice
would produce a nicer system but a weaker gate, the gate wins.

---

## 2. Constraints I am working under

| Constraint    | Value                               |
| ------------- | ----------------------------------- |
| Calendar time | 9 days (2026-09-16 → 2026-09-25)    |
| Team          | One engineer + coding agent         |
| Runtime       | Single machine, `docker compose up` |

The 15-minute budget is a real constraint, not a nicety. It caps the dataset size (§4), caps
the sink-outage duration in G3, and rules out anything requiring a warm-up period.

### D1 — Change capture: transactional outbox, not CDC

Every write to `products` also inserts a row into `replication_outbox` **in the same
transaction**. The incremental worker reads the outbox.

_Rejected:_ Debezium / Postgres logical replication. It is the more correct answer for a source
I do not own, and it is what I would reach for in production against a third-party database.
I rejected it here because standing up a connector, a slot, and the schema-change handling
around it would consume 2–3 of my 9 days and buys nothing the gates test.

_Rejected:_ `updated_at` polling alone. Loses deletes, needs an overlap window to survive clock
skew, and gives no durable record of _what_ changed — only that something did.

**Assumption this exposes:** an outbox requires me to own the writer. The brief describes data
arriving from client systems, which I would not own. I am modelling the source as a system I
control. If the source were genuinely third-party, D1 flips to logical replication and the rest
of this document is unchanged — the outbox is the only component that would be replaced.

### D2 — Delivery guarantee: at-least-once transport, effectively-once application

I do **not** claim exactly-once. What I claim:

- The pipeline delivers each change to each sink **at least once**.
- Both sinks are **idempotent**, so re-delivery converges to the same final state.
- Therefore the observable end state is **effectively-once**.

The mechanisms that make that true are D3 and D4. Any claim in the README must match this
sentence exactly.

### D3 — Elasticsearch idempotency: deterministic `_id` + external versioning

- `_id` = the Postgres primary key. Re-indexing overwrites; it never duplicates.
- Every write uses `version_type: external` with `version` = `products.version`, a monotonic
  integer incremented on every update.
- A `version_conflict_engine_exception` means Elasticsearch already holds a **newer** version.
  That is **success, not failure** — the item is counted as applied and skipped. Treating it as
  an error is the single most likely bug in this system and the verify script asserts against it.

This is what makes backfill and incremental safe to run concurrently (D6). A backfill batch
carrying version 4 cannot clobber an incremental write of version 7.

### D4 — Consumer idempotency: dedup table with the event ID as primary key

The consumer inserts `processed_events(event_id PRIMARY KEY)` and writes its projection in the
same transaction. A duplicate delivery hits the primary key, is swallowed, and is ACKed.

The projection table also gives verify something countable for G2. Without it, "records reached
the event stream" is unmeasurable.

### D5 — Checkpoint advances only after durable completion, DLQ included

The rule, stated precisely because §9/G4 depends on it:

- **Transient failure** (connection refused, 429, 5xx, broker down) → retry the whole batch with
  backoff. The checkpoint does **not** move.
- **Permanent per-item rejection** (mapping conflict, validation failure, malformed payload) →
  the failed items are written to `replication_dlq` and the checkpoint **does** move.
- The DLQ insert and the checkpoint advance happen in **one Postgres transaction**. If that
  transaction fails, both roll back and the batch is retried.

A whole-batch rollback because of 3 bad records out of 500 is a bug, not a safety measure.

### D6 — Backfill and incremental run concurrently, and both write to both sinks

Both workers start at the same time. There is no "backfill completes, then switch over" phase
and no watermark handoff.

_Rejected:_ backfill-then-replay-from-boundary. It is simpler to reason about, but the brief
requires both modes running simultaneously, and it makes the long backfill a window during which
live changes are only durable, not applied. D3's external versioning makes the concurrent design
safe, so the sequenced version buys nothing.

**Both workers write to both sinks.** Backfill publishes its rows to RabbitMQ with event type
`product.snapshot`; incremental publishes `product.created` / `updated` / `deleted`. The
distinct type keeps the semantics honest — a snapshot is current state, not something that just
happened — while keeping the counts uniform: source, Elasticsearch, and the consumer projection
must all reach 2,000,000, so G2 needs no footnote about why two sinks disagree.

_Revised from v1_, where backfill wrote to Elasticsearch only. That version left the projection
holding only the few thousand live changes, so G2's sink counts did not match and the gate
needed a paragraph of explanation to read as a pass. A gate that needs explaining is a weak gate.

Consequences, both accepted:

- The consumer projection needs a version guard, since a backfill snapshot (version 4) and a
  live update (version 7) for the same row can now arrive out of order:
  `ON CONFLICT (id) DO UPDATE ... WHERE excluded.version > product_projection.version`.
  This closed what was open question §13.1 in v1.
- The consumer becomes the throughput bottleneck: 2M messages through one consumer with manual
  ACKs is the slowest link in the chain. That is useful rather than unfortunate — it gives the
  README's capacity notes a measured bottleneck and a concrete answer for doubling it (raise
  prefetch and batch-commit the projection, or run N consumers on the same queue).
- If this pushes `make verify` past the 15-minute budget in §2, `BACKFILL_PUBLISH_EVENTS` gates
  the behaviour and the trade is recorded in the README rather than dropped silently.

### D7 — Batch size 500

Chosen to match the gate: G4 is specified in terms of a 500-record batch with 3 rejections.
Making the production batch size equal the gate's batch size means the gate exercises the real
code path rather than a special case.

### D8 — Stack: NestJS + React, single codebase, three runtime roles

TypeScript/Node throughout. NestJS for the backend because it matches Optio's stack and gives me
DI, config, and lifecycle hooks without assembly. React + Vite for the UI.

_Rejected:_ Angular. It is Optio's frontend stack and would be the better signal, but I am
faster in React by enough to matter against a 9-day clock. Recorded here as a conscious trade,
not an oversight.

One codebase, one Docker image, three roles selected by `APP_ROLE`:

| Role       | Responsibility                                 |
| ---------- | ---------------------------------------------- |
| `api`      | Admin/control HTTP API, metrics, serves the UI |
| `worker`   | Backfill worker + incremental worker           |
| `consumer` | RabbitMQ consumer + projection writer          |

This matters for G1: `docker kill` targets the `worker` container specifically, and the API
survives to report what happened.

### D9 — verify kills by checkpoint position, not by wall clock

`verify.sh` polls `replication_checkpoint` and fires `docker kill` once the backfill cursor
crosses a threshold — 20%, 45% and 70% of the dataset. It never kills on a timer.

_Rejected:_ throttling the backfill so a fixed `t+90s` lands mid-stream. A throttle is a knob
that exists only to make the test work, and it would have to be retuned per machine. Position
triggering costs a poll loop in the script and nothing in the system.

The original "at t+90s" was stale by the first measurement: the backfill finishes in roughly
145s here, and finished in 28s before D6 put RabbitMQ in the path. Any wall-clock number
would have expired within a phase.

Measured across five consecutive runs, the first kill landed between 402,500 and 421,000 —
mid-stream every time, never at zero and never after completion.

_Closes the first open question in v2's §13._

### D10 — DLQ replay sends the stored payload, never a fresh read

`POST /admin/dlq/:id/replay` re-sends `replication_dlq.payload` exactly as captured at failure
time. Correcting a row is an explicit `PATCH` of that payload, not a re-read of the source.

_Rejected:_ re-reading current state from `products`. It is more useful operationally, since
the replay would pick up whatever fixed the row, but it makes a DLQ row mean something
different depending on when it is replayed — the opposite of "replayable in isolation" (§5).

It is also impossible for the failures G4 injects: a poison record was never in `products`,
so there is no source row to re-read. A replay path that works for only some DLQ rows is
worse than one rule that always holds.

The stored payload keeps the field that caused the rejection. Storing a cleaned copy would
make every replay succeed by accident and reduce G4's correct-then-replay assertion to
theatre.

_Closes the second open question in v2's §13._

### D11 — G2 runs three kill/restart cycles

Three, at 20%, 45% and 70% of the backfill.

Every cycle exercises the same mechanism — resume from the persisted checkpoint — so extra
cycles buy confidence rather than coverage. What three buys over one is three independent
resume positions, including one after the pipeline has already recovered twice, which is
where a checkpoint bug that only appears on re-resume would surface.

Measured: fifteen kills across five consecutive runs, zero records lost, and source,
Elasticsearch and the projection converging on 2,000,000 every time.

Three remains a judgement rather than a proof. It is defensible because the failure it targets
is deterministic once triggered, not probabilistic.

_Closes the third open question in v2's §13._

### D12 — 2,000,000 rows stay, and backfill keeps publishing events

`make verify` runs all four gates from a cold start in 326–389s across five consecutive runs,
against the 15-minute budget in §2 — roughly nine minutes spare.

`BACKFILL_PUBLISH_EVENTS` stays `true`. The escape hatch D6 described is not needed, and the
trade does not have to be documented as a cut.

The consumer is the pacing item exactly as D6 predicted: the backfill publishes faster than
the consumer acks, and `product.consumer` peaks near 925,000 messages before draining. That
peak is the system's real capacity limit and is recorded in the README rather than hidden.

_Closes the fourth open question in v2's §13._

---

## 4. Data volume — and why

**2,000,000 products.** Measured at 526 MB in Postgres — 423 MB of heap plus 103 MB of
indexes, about 276 bytes per row all-in.

_Corrected in v4._ The estimate written before implementation was 400–600 bytes per row and
~1.2 GB, roughly double the truth. The generated rows are narrower than guessed, and nothing
below depended on the size being 1.2 GB — the reasoning is about row count, not bytes.

Reasoning, since the brief grades it:

- **Above the in-memory threshold.** 2M rows cannot be held in a Node heap, so keyset pagination
  and streaming are load-bearing rather than decorative. At 10k, an accidental
  `SELECT * FROM products` would pass every gate and hide the bug.
- **A mid-run kill is meaningful.** The backfill runs about 145s, so a kill triggered on
  checkpoint position (D9) lands genuinely mid-stream with a cursor that is neither 0 nor
  complete — measured between 402,500 and 421,000 across five runs. At 10k the backfill would
  finish before the kill signal was delivered.
- **Fits the 15-minute verify budget.** Measured: all four gates from cold in 326–389s,
  including the 60s sink outage (D12). D6 made the consumer the pacing item exactly as
  expected, and it still leaves roughly nine minutes spare.
- **Seeding is not the bottleneck.** `make seed` uses `COPY FROM STDIN` and generates 2M rows in
  well under a minute, so re-running verify is cheap.

I deliberately did not go to 20M. It would prove nothing additional about the gates and would
push verify past the point where a reviewer runs it twice.

---

## 5. Data model

```sql
CREATE TABLE products (
    id          BIGSERIAL PRIMARY KEY,
    sku         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT,
    price       NUMERIC(12,2) NOT NULL,
    status      TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,   -- D3: incremented on every update
    deleted_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`id` is `BIGSERIAL`, not UUID: keyset pagination needs a stable, cheaply-ordered cursor, and
`WHERE id > $1 ORDER BY id LIMIT 500` on a bigint index is the fastest honest way to walk 2M rows.

```sql
CREATE TABLE replication_outbox (
    id             BIGSERIAL PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    aggregate_id   BIGINT NOT NULL,
    event_type     TEXT NOT NULL,          -- product.created | product.updated | product.deleted
    version        INTEGER NOT NULL,
    payload        JSONB NOT NULL,         -- full row snapshot at change time
    occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at   TIMESTAMPTZ
);

CREATE INDEX idx_outbox_unprocessed ON replication_outbox (id) WHERE processed_at IS NULL;

CREATE TABLE replication_checkpoint (
    pipeline          TEXT PRIMARY KEY,     -- 'backfill' | 'incremental'
    last_processed_id BIGINT NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'idle',
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE replication_dlq (
    id              BIGSERIAL PRIMARY KEY,
    pipeline        TEXT NOT NULL,
    source_ref      BIGINT NOT NULL,        -- outbox id or product id
    aggregate_id    BIGINT NOT NULL,
    event_type      TEXT,
    payload         JSONB NOT NULL,         -- complete, replayable without the source row
    error           TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    checkpoint_at   BIGINT NOT NULL,        -- where the pipeline was; needed to reconstruct context
    first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_failed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    replayed_at     TIMESTAMPTZ
);

CREATE TABLE processed_events (           -- consumer-side, D4
    event_id     TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product_projection (         -- consumer-side sink, countable by G2
    id      BIGINT PRIMARY KEY,
    version INTEGER NOT NULL,             -- D6: guards against out-of-order snapshot vs update
    name    TEXT NOT NULL,
    price   NUMERIC(12,2) NOT NULL,
    status  TEXT NOT NULL
);
```

The DLQ payload is a **complete snapshot**, not a foreign key. A DLQ row must be replayable even
if the source row has since changed or been deleted — otherwise "replay" silently replays
something else.

Deletes are soft (`deleted_at`) so the backfill can see current state, plus a
`product.deleted` outbox event so the change reaches both sinks.

---

## 6. Elasticsearch design

Index `products-v1` behind alias `products-read`. Explicit mapping, no dynamic mapping:

```json
{
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "id": { "type": "long" },
      "sku": { "type": "keyword" },
      "name": { "type": "text" },
      "description": { "type": "text" },
      "price": { "type": "scaled_float", "scaling_factor": 100 },
      "status": { "type": "keyword" },
      "version": { "type": "integer" },
      "updated_at": { "type": "date" }
    }
  }
}
```

`dynamic: strict` is chosen **because** it gives G4 a real failure mode: an injected record with
an unmapped field or a non-numeric price is rejected per-item by the bulk API while its 497
neighbours succeed. A permissive mapping would make the poison-record gate untestable without
faking the failure.

All writes go through `_bulk`. A 200 response is not success — per-item results are inspected and
classified into applied / version-conflict-skipped / transient / permanent, per D5.

---

## 7. RabbitMQ design

Topic exchange `product.events` (durable) → queue `product.consumer` (durable, persistent
messages) → consumer with manual ACK and prefetch 100.

_Removed in v3:_ a second `analytics.queue`, bound but undrained, to demonstrate the fan-out is
real. It was undrained, so with D6 it accumulated every backfill snapshot — 2,000,000 messages
held permanently — and eventually triggered RabbitMQ's resource alarm, which blocks publishers
and stalled the backfill that was filling it. One consumer satisfies the requirement. Fan-out
remains a property of the topic exchange; demonstrating it is one extra binding, and an
undrained queue is a liability rather than a feature.

Publisher confirms are **mandatory**. An un-confirmed publish is a failed publish; the outbox row
is not marked processed until the broker confirms.

Event shape:

```json
{
  "eventId": "outbox-843210",
  "eventType": "product.updated",
  "aggregateId": 123,
  "version": 7,
  "occurredAt": "2026-09-16T08:00:00Z",
  "data": {
    "id": 123,
    "sku": "...",
    "name": "...",
    "price": 25.5,
    "status": "active"
  }
}
```

`eventId` is derived from the outbox row ID, so it is stable across retries — which is what makes
D4's dedup table work. A random UUID per publish attempt would defeat it.

Backfill events carry `eventType: "product.snapshot"` and `eventId: "backfill-<productId>"`
(D6). The prefix keeps backfill and incremental event IDs in separate namespaces, so a snapshot
and a later update of the same row are two distinct events and neither dedups the other away.

---

## 8. Retry policy

`sleep = random(0, min(30_000, 1000 * 2^attempt))` ms, max 5 attempts.

Full jitter, not fixed exponential: after a shared sink outage, fixed backoff synchronises every
retrying component into a thundering herd at the moment the sink returns.

Retryable: connection errors, resets, 429, 503, ES 5xx, broker disconnects.
Not retryable: mapping conflicts, validation failures, 400s, malformed payloads → DLQ per D5.

The bounded-backoff design is also what satisfies G3's no-busy-loop criterion: a 60-second outage
produces roughly 8 attempts, not 40,000.

---

## 9. The gates

Five scenarios. Each is executed by `make verify`, not described. Each prints one line.

### G1 — Crash recovery

**Setup:** start backfill over 2M rows; `docker kill` the `worker` container once the backfill
checkpoint crosses a position threshold (D9).
**Restart:** `verify.sh` restarts it with `docker compose up -d worker`. Docker's restart
policy does not cover `docker kill` — an explicit kill is treated as an intentional stop, so
the container stays down with `RestartCount: 0`. The restart is the script's job, not the
daemon's.
**Assertions:**

- resume cursor ≥ last persisted checkpoint and < total (proves it neither restarted nor finished)
- final ES doc count == source count
- records lost == 0

**PASS line:** `G1 resume after kill ... PASS (killed at 412,331 / resumed at 412,000, 0 lost)`

### G2 — No duplicates

**Setup:** run the full pipeline through **three** kill/restart cycles at random points.
**Assertions:**

- `SELECT count(*) FROM products WHERE deleted_at IS NULL` == ES doc count
  == `count(*) FROM product_projection` — all three equal, per D6
- zero duplicate `id` in the projection
- `count(*) FROM processed_events` ≥ projection count, and the difference equals the number of
  duplicate deliveries that were correctly suppressed rather than applied
- declared guarantee printed alongside: at-least-once delivery, effectively-once application

**PASS line:** `G2 no duplicates ... PASS (2,000,000 source / 2,000,000 es / 2,000,000 projection / 0 dupes)`

### G3 — Sink outage

**Setup:** mid-run, `docker compose stop elasticsearch` for 60s, then start it.
**Assertions:**

- zero records lost after recovery (final counts match)
- **no busy-loop:** worker CPU sampled from `docker stats` every 2s during the outage, mean
  < 10%; total ES attempts during the outage < 30
- system recovers without manual intervention; recovery time measured and printed

**PASS line:** `G3 sink outage ... PASS (60s down, 0 lost, recovered in 4.2s, 8 attempts, 3% cpu)`

### G4 — Partial batch failure

**Setup:** inject 3 poison records (non-numeric price, violating `dynamic: strict`) into a
500-record batch via the simulation API.
**Assertions:**

- 497 present in Elasticsearch
- exactly 3 rows in `replication_dlq`, each with payload, error, and `checkpoint_at` populated
- the checkpoint advanced past the batch (no whole-batch rollback)
- replaying a DLQ row after the payload is corrected results in the document being indexed

### G5 — Observability

**Setup:** scrape `/metrics` and `GET /admin/status` and answer the five questions
programmatically, without reading code.
**Assertions:** all five resolve to a non-stale value —
where is the backfill · current throughput · incremental lag · DLQ depth · health.
Additionally: lag metric measurably rises during the G3 outage and returns afterwards, proving
the metric is live rather than hardcoded.

If a gate cannot be made to pass in the time available, it prints **FAIL** and the README explains
why.

---

## 10. Observability

`/metrics` in Prometheus format:

```
replication_events_processed_total{pipeline,sink}
replication_events_failed_total{pipeline,sink,reason}
replication_events_retried_total{pipeline,sink}
replication_dlq_depth
replication_lag_seconds
replication_last_processed_id{pipeline}
backfill_progress_ratio
pipeline_throughput_per_second{pipeline}
consumer_queue_depth
sink_write_latency_ms{sink}          -- histogram
```

`replication_lag_seconds` = `now() - occurred_at` of the **oldest unprocessed outbox row**, or 0
when the outbox is drained. Defining it from the oldest unprocessed row rather than the newest
processed one is what makes it spike correctly when the pipeline stalls.

`consumer_queue_depth` exists because D6 makes the consumer the likely bottleneck; without it,
a backlog there would be invisible from the UI.

Structured JSON logs; every processing attempt carries `eventId`, `aggregateId`, `pipeline`,
`attempt`, `outcome`, `error`.

`GET /health` (liveness) and `GET /ready` (checks Postgres, ES, RabbitMQ). A dependency outage
shows as not-ready rather than silently healthy.

---

## 11. UI

React + Vite. Functional, not polished. Four screens, matching the four required functions:

**1. Pipeline status** — backfill progress bar with cursor position and ETA, throughput sparkline,
incremental lag in seconds, consumer queue depth, DLQ depth, per-dependency health lights. Polls
`/admin/status` every 2s.

**2. Data browser** — paginated list of replicated records read **from Elasticsearch**, free-text
search, detail view showing the ES document and its version. A live feed panel streams recent
change events over SSE so a change made in screen 4 is visibly reflected within seconds.

**3. Control** — start/pause/resume backfill, reset checkpoint, DLQ table with per-row error and
payload, replay single or replay all, and editable runtime config (batch size, poll interval,
max retries).

**4. Simulation** — the failure controls, which are also the mechanisms `verify` drives:
toggle Elasticsearch sink off/on, toggle RabbitMQ sink off/on, inject N poison records into the
next batch, generate N random source mutations at a given rate, kill the worker.

Screen 4 existing as a first-class API rather than as test-only code is deliberate: the same
endpoints back both the manual demo and the automated gates, so the gates exercise shipped code.

---

## 12. Out of scope — and why

| Left out | Why |
| --- | --- |
| Horizontal scaling, multi-worker coordination | Single worker is honest and provable. Concurrency would need advisory locks or partitioned cursors; documented as the first thing I'd add. |
| Multiple parallel consumers | Named in D6 as the throughput fix, measured but not built. |
| Angular UI | D8. Speed over stack-match, consciously. |
| Auth / multi-tenancy | Zero signal for the gates. |
| S3, ClickHouse, NiFi | Present in Optio's stack, absent from the problem. |
| Schema evolution / reindex-with-zero-downtime | The alias exists to make it possible; I am not implementing it. |
| Exactly-once | D2. Would require distributed coordination I can neither build nor prove in 9 days. |

---

## 13. Open questions

None.

Every question raised here in v1 and v2 is now closed, each after the measurement that
answered it: kill timing (D9), DLQ replay (D10), G2's kill cycles (D11), and the dataset
against the time budget (D12). v1's question on consumer out-of-order handling was closed by
the D6 revision in v2.

A question is removed from this section only by becoming a decision in §3 with the evidence
attached. Nothing was dropped for running out of time.

---

## 14. Revision log

| Version | Date | Change |
| --- | --- | --- |
| v1 | 2026-09-16 | Initial spec, written before any implementation code. |
| v2 | 2026-09-16 | D6 revised: backfill now publishes to RabbitMQ as `product.snapshot` instead of writing to Elasticsearch only. v1's asymmetry left G2's sink counts mismatched and needing prose to explain. Knock-on changes: projection version guard (closes old §13.1), `consumer_queue_depth` metric, consumer named as expected bottleneck, new open question on the verify time budget. |
| v3 | 2026-09-22 | Removed `analytics.queue`. It was undrained, so with D6 it accumulated every backfill snapshot and would eventually trigger RabbitMQ's resource alarm and block publishers. One consumer satisfies the requirement. §13 closed and emptied, each question recorded as a decision with the measurement behind it: position-triggered kills (D9), stored-payload DLQ replay (D10), three kill cycles for G2 (D11), and 2,000,000 rows confirmed inside the time budget (D12). G1's setup corrected — "at t+90s" contradicted D9, and "compose restarts it" was false, since `docker kill` does not trigger Docker's restart policy. Malformed tables in §12 and §14 fixed; neither rendered on GitHub. |
| v4 | 2026-09-22 | §4's size corrected: measured 526 MB and ~276 bytes per row, against the pre-implementation estimate of ~1.2 GB and 400–600 bytes — roughly double the truth. The reasoning in §4 rests on row count rather than bytes, so it stands unchanged. Its two stale bullets also updated: the kill is position-triggered per D9, not at t+90s, and the time budget is now measured rather than predicted per D12. |

Every later revision gets a row here plus a one-line reason. Revisions are committed separately
from the code they describe.
