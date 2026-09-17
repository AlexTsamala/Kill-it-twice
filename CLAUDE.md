# CLAUDE.md

Read @AGENTS.md before doing anything — it governs how to work in this repo.
Read @SPEC.md for what to build.

## What this project is

A data replication pipeline: PostgreSQL → Elasticsearch + RabbitMQ, with both a backfill
mode and a continuous incremental mode running concurrently over 2M rows.

It is a take-home assignment. **The graded deliverable is `make verify`** — a script that
kills the process, stops sinks, injects bad records, and prints PASS/FAIL for five gates.
The system exists to make those gates pass honestly. When a design choice would give a
nicer system but a weaker gate, the gate wins.

## Commands

```bash
docker compose up -d       # postgres, elasticsearch, rabbitmq, api, worker, consumer
make seed                  # generate 2M products via COPY
make verify                # run all five gates — the real check
make logs                  # tail all services
npm run typecheck          # must be clean before any commit
npm test                   # unit tests
```

## Stack

TypeScript / NestJS / React + Vite. One codebase, one image, three roles via `APP_ROLE`
(`api` | `worker` | `consumer`). Postgres 16, Elasticsearch 8, RabbitMQ 3 with management UI.

## Rules that are violated most often

These are in AGENTS.md too. They are repeated here because they are the ones that get broken:

1. **Never advance a checkpoint before the work is durable.** Transient failure → retry the
   batch, checkpoint stays. Permanent per-item rejection → DLQ insert and checkpoint advance
   in one transaction.
2. **An Elasticsearch `version_conflict_engine_exception` is success, not failure.** It means
   a newer version already landed. Count it as applied and move on.
3. **A `_bulk` HTTP 200 is not success.** Inspect per-item results.
4. **Never loosen a `verify.sh` assertion to make a gate pass.** If a gate fails, the system
   is wrong. Fix the system.
5. **Run the command before saying it works.** "Should work" is not a status.

## Working agreement

- Decisions in SPEC.md §3 are closed. If one turns out to be wrong: stop, write a
  `DEVLOG.md` entry, propose the change, wait. Do not work around it silently.
- Questions in SPEC.md §13 are open. Ask; do not guess.
- A commit touching SPEC.md contains only SPEC.md. Never amend or rebase its history.
- Do not add dependencies without asking. Never add an ORM.
- Do not touch README.md until day 8.

## Priority when time is short

Gates passing honestly > cold-start reproducibility > failure-path correctness >
observability > UI function > UI polish. Cut from the bottom.
