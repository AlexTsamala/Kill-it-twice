# DEVLOG.md

Append-only log of deviations, decisions the spec did not cover, and things that broke.
Entries are written as they happen, including the unflattering ones.

Format per `AGENTS.md` §7:

```
## YYYY-MM-DD — <short title>

**Asked for:** what the instruction was
**What happened:** what was actually produced, or what broke
**Why it was wrong:** the actual reason, not a euphemism
**Resolution:** what changed — code, spec, or both
```

---

## 2026-09-19 — `docker kill` does not trigger Docker's restart policy

_Recorded 2026-09-22, after the fact._

**Asked for:** SPEC §9/G1 — "at t+90s, `docker kill` the `worker` container. **Restart:** compose
restarts it."

**What happened:** it does not. After `docker kill` the container stayed down. Inspecting it
gave exit code 137 and `RestartCount: 0`, with the service declared `restart: on-failure` at
the time. Nothing brought the worker back, so a gate written to the spec's wording would have
waited for a restart that was never coming and failed on a timeout.

**Why it was wrong:** `docker kill` is an explicit stop request from the operator, so Docker
treats the container as intentionally stopped and the restart policy does not apply. The
policy covers the container dying on its own. The spec assumed `docker kill` simulates a crash
end to end; it simulates the crash, not the supervisor's reaction to it.

This matters beyond wording. G1's claim is that the pipeline recovers from an ungraceful
death, and the restart is part of what is being demonstrated. Leaving it implicit would have
meant the gate passed or failed on a Docker detail rather than on anything the system does.

**Resolution:** no code change — the worker resumes from its checkpoint correctly once
restarted, which is the actual assertion. `verify.sh` must perform the restart itself with
`docker compose up -d worker` rather than waiting for one. SPEC §9/G1's "compose restarts it"
is wrong as written and needs an edit in its own commit.

---

## 2026-09-20 — a deleted product came back to life in the projection

_Recorded 2026-09-22, after the fact._

**Asked for:** Phase 3 — consumer with `processed_events` dedup (D4) and a `product_projection`
upsert guarded by `WHERE excluded.version > product_projection.version` (D6).

**What happened:** the first full end-to-end run finished with source at 2,000,001 and the
projection at 2,000,002. A product that `mutate.ts` created and soft-deleted moments later was
still in the projection, as though the delete had never happened.

**Why it was wrong:** I had conflated "the queue delivers in order" with "my handlers run in
order". They are different claims. RabbitMQ delivers messages to one consumer in order, but
`prefetch: 100` means up to 100 of them are in flight at once, and `channel.consume`'s callback
returns immediately — nothing was serialising the handlers. `product.deleted` (version 2) won
the race against `product.created` (version 1) for the same row.

The consequence is worse than a reordering. The DELETE ran against a row that did not exist
yet and matched zero rows; the INSERT then created it. The version guard cannot catch this:
`excluded.version > product_projection.version` needs an existing row to compare against, and
after a delete there is nothing left to compare. The guard protects against a stale *update*
overwriting a fresh one, which is what D6 was written for. It says nothing about a delete that
arrives before the thing it deletes.

I would not have found this by reading the code. It only appeared because `scripts/mutate.ts`
drove a create and a delete close enough together to land in the same prefetch window.

**Resolution:** added `src/consumer/aggregate-serializer.ts`, which chains handlers per
`aggregateId` so events for one product run in sequence while different products stay fully
concurrent. Global serialisation would also have fixed it and was rejected — the consumer is
already the throughput bottleneck named in D6, and serialising everything would have made the
2,000,000-row run far slower for no correctness gain.

**Still open:** this is verified only by the live run. There is no automated test for it, and
an ordering bug with no regression test is one refactor away from coming back. It belongs with
the integration tests in Phase 5.

---

## 2026-09-21 — the Elasticsearch index was never created with its mapping

**Asked for:** Phase 2, "create the ES index with the strict mapping from SPEC §6".

**What happened:** `ensureProductsIndex` was written, exported, and never called. Nothing in
`src/` or `scripts/` referenced it. The first `_bulk` write auto-created `products-v1` with
Elasticsearch's default dynamic mapping, and every run since — including the 2,000,000-row
runs reported as successful — used that index. The live mapping had `dynamic` at its default
of `true`, `price` as `float` instead of `scaled_float`, `sku` as text rather than `keyword`,
and no `products-read` alias.

**Why it was wrong:** Phase 2's "done when" was "backfill completes and the ES doc count
equals the source count". That is true with either mapping, so the check could not see the
defect. I treated the passing count as evidence the index was correct when it was only
evidence that documents arrived. The bug then stayed invisible for two phases because nothing
else read the mapping.

Found while testing G4: three poison records with an unmapped field were indexed cleanly
instead of being rejected, and the unmapped field was added to the mapping — dynamic mapping
doing exactly what `dynamic: strict` exists to prevent. G4 could not have passed, and the
failure would have looked like a bug in the new DLQ code rather than in Phase 2.

**Resolution:** `ElasticsearchProductSink` now implements `OnModuleInit` and calls
`ensureProductsIndex` before it can serve a write. Mapping and `dynamic` cannot be changed in
place, so the index had to be recreated from a clean volume. Verified against the live
cluster afterwards: `dynamic: strict`, `price` as `scaled_float` with `scaling_factor` 100,
`sku` as `keyword`, and the `products-read` alias present.

**Still open:** the same class of gap applies to anything else asserted only by a row count.
Phase 5's `verify.sh` should assert the mapping itself, not only the document total.

---

## 2026-09-22 — the fan-out queue blocked the pipeline that fills it

**Asked for:** Phase 5 — `verify.sh` passing G1..G4 across five consecutive clean runs.
"Flaky is failing. If it passes 4 times out of 5, it does not pass."

**What happened:** runs 1 to 4 passed in 326–371s. Run 5 failed G1/G2 and G3 and took 887s.
The backfill had not stopped; it had slowed to roughly 108 rows per second against a normal
14,000. After the second kill/restart it moved 86,000 rows in 792 seconds and never reached
the third kill threshold, so the cycle timed out and everything after it read a half-populated
index.

**Why it was wrong:** RabbitMQ's log dated the window exactly — `system_memory_high_watermark`
set at 11:57:08 and cleared at 12:10:00, against a stall from 11:57:34 to 12:10:46. A memory
alarm blocks publishing connections, so `channel.publish` returned false and the backfill sat
in `waitForDrainOrThrow` waiting for a drain event that could not arrive until the alarm
cleared.

The cause is `analytics.queue`. SPEC §7 binds it to demonstrate that the fan-out is real and
deliberately never drains it, so a 2,000,000-row backfill leaves 2,000,000 messages in it
permanently — on top of whatever `product.consumer` has not yet acked. The default watermark
is 40% of system memory. The demonstration queue was competing for memory with the pipeline
it exists to demonstrate.

It passed four times because the consumer usually kept its own queue short enough to stay
under the limit. Run 5's kill cycles shifted the timing and pushed it over. That is the worst
kind of failure to find late: a real capacity limit wearing the costume of a flaky test, and
it would have hit a reviewer with less RAM on the first run rather than the fifth.

**Resolution:** `analytics.queue` is removed, and SPEC §7 is amended in its own commit (v3).

The first fix was `x-queue-mode: lazy`, which keeps the queue's messages on disk. It works,
but it treats the symptom: the queue would still be accumulating 2,000,000 messages that
nothing will ever read. Measured peaks made the trade obvious —

| queue | peak depth | drained? |
| --- | --- | --- |
| `analytics.queue` | 2,001,000 | never |
| `product.consumer` | 925,405 | yes, continuously |

Two thirds of the broker's load existed only to illustrate that a topic exchange fans out.
`PLAN.md` already listed the second queue as the first thing to cut after UI polish, so the
cut was planned; the alarm only supplied the reason. Nothing in G1..G4 referenced it.

**What this does not fix:** `product.consumer` still peaks near 925,000 messages, because the
backfill publishes faster than the consumer acks — the bottleneck D6 predicted. The alarm
still fires at that peak. What changed is that it no longer blocks: in the five runs after
the removal the backfill went straight through an alarm window at full speed —

```
12:54:26  alarm set
12:54:34  cursor   822,500   200,000 rows in 10s
12:54:54  cursor 1,124,500
12:55:06  cursor 1,324,500
12:58:26  alarm cleared
```

— against the failing run, where a sustained alarm held the backfill at 108 rows/s for
13 minutes. Removing the queue that never drains turned a sustained block into a transient
one. Five consecutive cold runs then passed in 326–389s, with G3 costing 5–7 attempts each
time against its budget of 30.

The peak itself is untouched, so a machine with substantially less than 8 GB could still
stall. The fix is the one D6 already names — raise prefetch and batch-commit the projection,
or run several consumers on the same queue — and it is not built. That belongs in the
README's capacity notes, stated as a measured limit rather than as a solved problem.

---

## 2026-09-22 — /metrics is rendered by hand, and prom-client was dropped

**Asked for:** Phase 6a — "/metrics in Prometheus format, every metric listed in SPEC §10".
`prom-client` is on AGENTS.md's approved dependency list, so the obvious reading is to use it.

**What happened:** I installed it, then removed it again and wrote the exposition format
directly.

**Why it was wrong:** prom-client keeps its registry in the process that serves it. D8 puts
`/metrics` in the `api` role, but every counter it needs is incremented somewhere else —
`replication_events_processed_total` in the worker, the consumer's projection writes in the
consumer, `sink_write_latency_ms` in both. Three containers, three heaps, and the api can see
none of them.

So the counters have to be aggregated through Postgres regardless of which library renders
them, and once they are rows in a table, prom-client stops helping. Counters could be replayed
into it with `inc()` per scrape, but a histogram cannot: the api holds bucket counts, and
`Histogram` only accepts raw observations through `observe()`. Reconstructing one would mean
fabricating observations to land in the right buckets.

**Resolution:** workers and consumer flush counter deltas to `replication_metrics` (migration
0008), additively so a restart adds to the total rather than resetting it. The api reads that
table, computes the gauges live from Postgres and RabbitMQ, and renders the text format — about
25 lines, including cumulative histogram buckets in the shape Prometheus expects. `prom-client`
is uninstalled rather than left in `package.json` unused.

**The trade:** hand-rendering means owning the format's edge cases — label escaping in
particular. Every label value here is an identifier we generate (`backfill`, `elasticsearch`,
`transient`), so there is nothing to escape today. If a label ever carries free text, that
assumption breaks and prom-client becomes the right answer again.

---

## 2026-09-23 — an open browser tab stopped the api from starting

**Asked for:** Phase 6b — SPEC §11 screen 2's live feed, "a live feed panel streams recent
change events over SSE".

**What happened:** the next `make verify` never reached its first gate. It printed "Cold start"
and stopped. The stack was up, but `products` did not exist, and the api and worker were
restarting in a loop.

**Why it was wrong:** the SSE controller polled the database from a hand-rolled async loop
started with `void tick()`. Nothing caught a rejection from it. A browser tab left open on the
UI kept reconnecting its `EventSource` to the freshly-wiped stack, the poll queried
`runtime_settings` before migrations had created it, and the rejection reached the process as
an unhandled rejection — which Node exits on. The api died, restarted, was reconnected to, and
died again. `docker compose up --wait` never saw it healthy, so `cold_start` aborted before
running migrations.

This is the same mistake as the 2026-09-20 entry: a promise started with `void` and no
`.catch`. I fixed that one in the consumer's serialiser and then wrote the identical bug into
a new file three days later.

The severity is what makes it worth recording. A read-only endpoint nobody had deliberately
opened took down the whole api, and it only surfaced because a browser tab happened to be
pointing at it across a cold start. Without that tab it would have shipped, and the first
reviewer to leave the UI open while re-running `make verify` would have hit it.

**Resolution:** the feed is now an rxjs `interval` pipeline with `catchError`, so a failed poll
logs, yields nothing, and the stream continues. `main.ts` also installs an
`unhandledRejection` handler that logs through pino before exiting — the crash stays, because
unknown state should not be continued from, but it is now a structured log line rather than a
bare stack trace.

**Still open:** nothing enforces this. `no-floating-promises` does not catch `void promise`,
which is exactly what the rule tells you to write. A lint rule banning `void` on a promise
without a `.catch` would have caught both instances.

---

## 2026-09-23 — the documented first command does not work on a clean clone

**Asked for:** Phase 8 — clone the repository to a fresh directory and run exactly what a
reviewer would run: `docker compose up -d`, `make seed`, `make verify`.

**What happened:** the first command failed immediately.

```
$ docker compose up -d
warning: The "POSTGRES_USER" variable is not set. Defaulting to a blank string.
...
no port specified: :<empty>
```

**Why it was wrong:** `.env` is gitignored, which is right — but Docker Compose reads `.env`
for variable interpolation, and every `${POSTGRES_USER}`, `${HTTP_PORT}` and friend in
`docker-compose.yml` resolved to an empty string. `make up` works, because the Makefile has a
`.env: cp .env.example .env` target, and `verify.sh` works, because it does the same check
itself. Only the bare compose command is broken — and it is the one `CLAUDE.md` tells a
reviewer to type.

Eight days of local work could never have caught this. `.env` has existed in the working
directory since Phase 1, so every command worked here every time. It took cloning into an
empty directory to see it, which is exactly what this phase is for.

**Resolution:** no code change. Adding `${POSTGRES_USER:-app}` style defaults to the compose
file was rejected: AGENTS.md §4 forbids hardcoded credentials and ports, and it would create a
second set of defaults alongside `.env.example` that can drift apart silently. The README now
states the requirement and why. `CLAUDE.md`'s Commands block still says `docker compose up -d`
and needs its one line changed to `make up` — that file is the human's, so it is flagged
rather than edited.

**Verified after:** clean clone, `make up`, `make seed`, `make verify` — all five gates passed
in 393s, then again in 371s with no cleanup between runs.
