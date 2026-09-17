# AGENTS.md

Instructions for any coding agent working in this repository.

---

## 1. Read this first

`SPEC.md` is the source of truth for **what** to build. This file governs **how** to work.

If the two conflict, `SPEC.md` wins on substance and this file wins on process.

**Decisions in `SPEC.md` §3 are closed.** Do not substitute your own judgment on them, do not
"improve" them, and do not silently pick a different approach because it seems cleaner. If
implementing a closed decision turns out to be wrong or impossible:

1. Stop.
2. Append an entry to `DEVLOG.md` (format in §7).
3. Say what broke and what you propose instead.
4. Wait. Do not continue past the conflict.

Items in `SPEC.md` §13 are explicitly **open**. Ask before choosing; do not guess and proceed.

---

## 2. Where things live

```
.
├── SPEC.md                 # what to build — the contract
├── AGENTS.md               # this file
├── DEVLOG.md               # running log of deviations and decisions
├── README.md               # written last; do not touch until day 8
├── Makefile                # seed, verify, up, down, logs
├── docker-compose.yml
├── verify.sh               # the gate runner — the main deliverable
├── migrations/             # numbered SQL, forward-only, never edited once committed
├── src/
│   ├── main.ts             # single entrypoint, branches on APP_ROLE
│   ├── common/             # config, logging, metrics, retry — no business logic
│   ├── source/             # products CRUD + outbox writer (same transaction, always)
│   ├── replication/
│   │   ├── backfill/       # keyset walk → ES
│   │   ├── incremental/    # outbox poll → ES + RabbitMQ
│   │   ├── sinks/          # elasticsearch.sink.ts, rabbitmq.sink.ts
│   │   └── dlq/            # DLQ write + replay
│   ├── consumer/           # RabbitMQ consumer + projection
│   ├── admin/              # control API, status, simulation endpoints
│   └── ui/                 # React + Vite
└── scripts/                # seed generator, gate helpers
```

One image, three roles via `APP_ROLE=api|worker|consumer`. Do not split into separate
applications or a monorepo with multiple package.json files.

---

## 3. Do not touch

- **`migrations/` already committed.** Forward-only. Add `0007_*.sql`; never edit `0003_*.sql`.
- **`SPEC.md`** — you may propose changes in `DEVLOG.md`; only the human edits the spec.
- **`.env.example`** — add new variables here *and* document them, never rename existing ones.
- **`verify.sh` gate assertions** — you may fix the script's mechanics (timing, polling, docker
  invocation). You may **not** loosen a threshold, widen a tolerance, or change an assertion so a
  failing gate passes. If a gate fails, the system is wrong, not the gate.
- **Git history for `SPEC.md`** — never amend, squash, or rebase commits that touch it. The
  chronology is a graded deliverable.

---

## 4. Conventions

**Language:** TypeScript, strict mode. No `any` — use `unknown` and narrow. No non-null `!`.

**Errors:** every error crossing a sink boundary is classified `transient | permanent` by an
explicit function, never by string-matching at the call site. `src/common/errors.ts` owns that
classification. Adding a new error case means editing that one file.

**Config:** environment variables only, validated at startup with a schema. The process must
refuse to boot on invalid config rather than failing at first use. No hardcoded hosts, ports,
credentials, batch sizes, or intervals — anywhere, including tests.

**Logging:** structured JSON via the shared logger. Never `console.log`. Every log line inside a
processing path carries `eventId`, `aggregateId`, `pipeline`, `attempt`. Never log full payloads
at info level.

**Database:** parameterised queries only. Anything that writes business data and an outbox row
does both in one transaction — no exceptions, no "I'll add the transaction later".

**Async:** no floating promises. No `setInterval` for work loops; use a cancellable loop that
honours shutdown. Every worker registers a SIGTERM handler that finishes the in-flight batch,
persists the checkpoint, and exits cleanly — `docker kill` tests the ungraceful path, SIGTERM
tests the graceful one, and both must be correct.

**Dependencies:** do not add a package without asking. `pg`, `@elastic/elasticsearch`, `amqplib`,
`@nestjs/*`, `prom-client`, `zod`, `react`, `vite` are approved. Anything else needs a reason.
Never add an ORM — the queries here are hand-written on purpose.

**Naming:** metrics `snake_case` with unit suffix (`_total`, `_seconds`, `_ms`). Files
`kebab-case.ts`. Classes `PascalCase`.

---

## 5. Commits

One logical change per commit. Conventional-ish prefixes: `feat:`, `fix:`, `docs:`, `test:`,
`chore:`, `spec:`.

Rules:

- A commit touching `SPEC.md` contains **only** `SPEC.md`.
- Never commit code that implements a spec change in the same commit as the spec change.
- Never commit a failing `make verify` without a `DEVLOG.md` entry saying why.
- No `--amend` or force-push on anything already pushed.

---

## 6. How to check your own work

**Before claiming anything is done, run it.** "Should work" is not a status. Not having run the
command is not the same as the command having passed.

Checks, in order:

```bash
npm run typecheck        # must be clean, zero errors
npm run lint
npm test                 # unit tests
docker compose up -d && make seed
make verify              # the real check
```

Specific rules:

- **Never report a gate as passing without running `make verify` and pasting its actual output.**
- `make verify` must be runnable **twice in a row** from a cold start without manual cleanup.
  If the second run fails, the teardown is broken — fix it, do not document it as a caveat.
- Any change to retry, checkpoint, DLQ, or sink code requires a full `make verify` run, not just
  unit tests. Those four areas are where the gates live.
- Flaky is failing. If a gate passes 4 times out of 5, it does not pass. Find the race.

**Write the failing test first** for anything in the failure-handling path. A retry test that has
never been observed failing proves nothing.

---

## 7. DEVLOG.md

Append-only. Every entry:

```
## 2026-09-19 — <short title>

**Asked for:** what the instruction was
**What happened:** what was actually produced, or what broke
**Why it was wrong:** the actual reason, not a euphemism
**Resolution:** what changed — code, spec, or both
```

Log it when: a spec decision turns out to be wrong; you produce something that does not match the
instruction; a gate fails for a non-obvious reason; you make a choice the spec did not cover.

This file is read by humans who will ask about specific entries. Write it honestly, including the
entries that are unflattering. An empty or uniformly successful DEVLOG is a worse signal than one
full of corrections.

---

## 8. Things that will be rejected

- Advancing a checkpoint before the corresponding work is durable.
- Treating an Elasticsearch `version_conflict_engine_exception` as an error. It is success —
  a newer version already landed. See `SPEC.md` §3/D3.
- Treating a `_bulk` HTTP 200 as success without inspecting per-item results.
- Rolling back a whole batch because some items failed permanently.
- A retry loop without jitter, without a cap, or without a maximum attempt count.
- A DLQ row that references the source by ID instead of storing the full payload.
- A random `eventId` per publish attempt — it must be derived from the outbox row ID.
- `sleep`-based synchronisation in tests or in `verify.sh`. Poll for the condition.
- Catching an error and continuing without logging, DLQ-ing, or rethrowing it.
- Simulation endpoints that exist only in test builds. They ship.
- Editing `verify.sh` thresholds to make a gate pass.

---

## 9. Priority when time is short

1. The five gates passing honestly.
2. `docker compose up` and `make seed` working from cold on another machine.
3. Correctness of the failure paths.
4. Observability.
5. UI functionality.
6. UI polish. Always cut this first.

Three gates that genuinely pass beat five that half-work. If something must be dropped, drop
feature surface and never gate quality — then say so in `DEVLOG.md` so it reaches the README.
