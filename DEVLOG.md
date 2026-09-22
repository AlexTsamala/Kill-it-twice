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
