#!/usr/bin/env bash
#
# verify.sh — the graded deliverable. Runs G1..G4 from SPEC §9 against a cold stack and
# prints one PASS/FAIL line per gate. Never sleeps and hopes: every wait polls a condition.
#
# Usage: ./verify.sh                (cold start, all gates — the graded run)
#        ./verify.sh --keep         (reuse the running stack, all gates)
#        ./verify.sh --keep g3 g4   (reuse the stack, run only those gates)

set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || cp .env.example .env

# Read .env as data, not as shell. Values like ES_JAVA_OPTS=-Xms2g -Xmx2g are valid for
# compose but would be executed as a command by `source`.
while IFS='=' read -r key value; do
  case "$key" in '' | '#'*) continue ;; esac
  export "$key=${value%$'\r'}"
done <.env

KEEP_STACK=false
[ "${1:-}" = "--keep" ] && { KEEP_STACK=true; shift; }
SELECTED_GATES=("$@")

wanted() {
  [ ${#SELECTED_GATES[@]} -eq 0 ] && return 0
  local gate
  for gate in "${SELECTED_GATES[@]}"; do [ "$gate" = "$1" ] && return 0; done
  return 1
}

FAILURES=0
STARTED_AT=$(date +%s)

# ---------------------------------------------------------------- output ---

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
pass() { printf '\033[32m%-34s PASS\033[0m (%s)\n' "$1" "$2"; }
fail() { printf '\033[31m%-34s FAIL\033[0m (%s)\n' "$1" "$2"; FAILURES=$((FAILURES + 1)); }

# ------------------------------------------------------------- primitives ---

sql() { docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"; }

es() { curl -sf "http://localhost:${ELASTICSEARCH_PORT}$1" 2>/dev/null; }

api() { curl -sf "http://localhost:${HTTP_PORT}$1" 2>/dev/null; }

api_post() {
  local path=$1 body=${2:-}
  [ -n "$body" ] || body='{}'
  curl -sf -X POST "http://localhost:${HTTP_PORT}${path}" \
    -H 'content-type: application/json' -d "$body" 2>/dev/null
}

api_delete() { curl -sf -X DELETE "http://localhost:${HTTP_PORT}$1" 2>/dev/null; }

es_count() {
  es "/${ELASTICSEARCH_INDEX}/_refresh" >/dev/null || true
  es "/${ELASTICSEARCH_INDEX}/_count" | jq -r '.count' 2>/dev/null || echo 0
}

source_count()     { sql "SELECT count(*) FROM products WHERE deleted_at IS NULL"; }
projection_count() { sql "SELECT count(*) FROM product_projection"; }
checkpoint_of()    { sql "SELECT last_processed_id FROM replication_checkpoint WHERE pipeline = '$1'"; }
backfill_status()  { sql "SELECT status FROM replication_checkpoint WHERE pipeline = 'backfill'"; }
dlq_depth()        { sql "SELECT count(*) FROM replication_dlq WHERE replayed_at IS NULL"; }
outbox_pending()   { sql "SELECT count(*) FROM replication_outbox WHERE processed_at IS NULL"; }

worker_cpu() {
  docker stats --no-stream --format '{{.CPUPerc}}' "$(docker compose ps -q worker)" 2>/dev/null |
    tr -d '%' || echo 0
}

# Poll a shell condition. Fails loudly on timeout rather than continuing with bad state.
poll_until() {
  local what=$1 timeout=$2 condition=$3
  local deadline=$(($(date +%s) + timeout))

  until eval "$condition"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "waiting for $what" "timed out after ${timeout}s"
      return 1
    fi
    sleep 1
  done
}

# ------------------------------------------------------------ cold start ---

cold_start() {
  say "Cold start"
  docker compose down -v --remove-orphans >/dev/null 2>&1
  docker compose up -d --build --wait >/dev/null 2>&1
  info "stack healthy"

  docker compose run --rm tools node dist/scripts/migrate.js >/dev/null 2>&1
  docker compose run --rm tools node dist/scripts/seed.js >/dev/null 2>&1
  info "seeded $(source_count) products"

  # The workers booted before the tables existed and have already decided the backfill is
  # finished over an empty table. Restarting is what gives them the seeded data.
  docker compose restart worker consumer >/dev/null 2>&1
  info "workers restarted"
}

# ------------------------------------------- G1 + G2: kill / restart runs ---

# Waits for the backfill cursor to pass a position, then SIGKILLs the worker and brings it
# back. `docker kill` does not trigger Docker's restart policy (DEVLOG 2026-09-19), so the
# restart is explicit here rather than assumed.
kill_and_restart_at() {
  local threshold=$1
  poll_until "backfill cursor >= $threshold" 420 \
    '[ "$(checkpoint_of backfill)" -ge '"$threshold"' ]' || return 1

  local before
  before=$(checkpoint_of backfill)
  local starts_before
  starts_before=$(docker compose logs worker 2>/dev/null | grep -c 'backfill started' || true)

  docker compose kill -s SIGKILL worker >/dev/null 2>&1
  docker compose up -d worker >/dev/null 2>&1

  poll_until "worker to resume" 120 \
    '[ "$(docker compose logs worker 2>/dev/null | grep -c "backfill started" || true)" -gt '"$starts_before"' ]' ||
    return 1

  local resumed
  resumed=$(docker compose logs worker 2>/dev/null | grep -o '"resumingFrom":[0-9]*' | tail -1 | cut -d: -f2)
  echo "$before $resumed"
}

run_kill_cycles() {
  say "G1/G2 — three kill/restart cycles during the backfill"
  local total=$SEED_TOTAL

  for percent in 20 45 70; do
    local threshold=$((total * percent / 100))
    local result
    result=$(kill_and_restart_at "$threshold") || return 1
    KILL_CHECKPOINTS+=("${result% *}")
    KILL_RESUMES+=("${result#* }")
    info "cycle at ${percent}%: killed at ${result% *}, resumed at ${result#* }"
  done
}

gate_g1() {
  local killed=${KILL_CHECKPOINTS[0]} resumed=${KILL_RESUMES[0]}

  poll_until "backfill to complete" 600 '[ "$(backfill_status)" = "completed" ]' || {
    fail "G1 resume after kill" "backfill never completed"
    return
  }

  local src es_docs lost
  src=$(source_count)
  es_docs=$(es_count)
  lost=$((src - es_docs))

  if [ "$resumed" -lt "$killed" ]; then
    fail "G1 resume after kill" "resumed at $resumed, behind the persisted checkpoint $killed"
  elif [ "$resumed" -ge "$src" ]; then
    fail "G1 resume after kill" "resumed at $resumed, not mid-stream"
  elif [ "$lost" -ne 0 ]; then
    fail "G1 resume after kill" "$lost records lost (source $src, es $es_docs)"
  else
    pass "G1 resume after kill" "killed at $killed / resumed at $resumed, 0 lost"
  fi
}

gate_g2() {
  poll_until "projection to converge" 900 \
    '[ "$(projection_count)" -ge "$(source_count)" ]' || true

  local src es_docs proj dupes processed
  src=$(source_count)
  es_docs=$(es_count)
  proj=$(projection_count)
  dupes=$(sql "SELECT count(*) - count(DISTINCT id) FROM product_projection")
  processed=$(sql "SELECT count(*) FROM processed_events")

  info "delivery guarantee: at-least-once transport, effectively-once application (D2)"
  info "processed_events $processed vs projection $proj — difference is suppressed redeliveries"

  if [ "$src" -ne "$es_docs" ] || [ "$src" -ne "$proj" ]; then
    fail "G2 no duplicates" "source $src / es $es_docs / projection $proj do not match"
  elif [ "$dupes" -ne 0 ]; then
    fail "G2 no duplicates" "$dupes duplicate ids in the projection"
  elif [ "$processed" -lt "$proj" ]; then
    fail "G2 no duplicates" "processed_events $processed < projection $proj"
  else
    pass "G2 no duplicates" "$src source / $es_docs es / $proj projection / 0 dupes, ${#KILL_CHECKPOINTS[@]} kill cycles"
  fi
}

# ----------------------------------------------------- G3: sink outage ---

gate_g3() {
  say "G3 — 60s Elasticsearch outage"
  local outage_seconds=60
  local checkpoint_before cpu_total=0 cpu_samples=0
  checkpoint_before=$(checkpoint_of incremental)

  local log_marker
  log_marker=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  docker compose stop elasticsearch >/dev/null 2>&1
  api_post /admin/simulate/mutations '{"count":200,"ratePerSecond":400}' >/dev/null 2>&1 || true

  local deadline=$(($(date +%s) + outage_seconds))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local sample
    sample=$(worker_cpu)
    cpu_total=$(echo "$cpu_total + $sample" | bc)
    cpu_samples=$((cpu_samples + 1))
    sleep 2
  done

  local attempts
  attempts=$(docker compose logs worker --since "$log_marker" 2>/dev/null |
    grep -c -E 'transient failure; retrying|batch failed after retries' || true)

  local checkpoint_during
  checkpoint_during=$(checkpoint_of incremental)

  docker compose start elasticsearch >/dev/null 2>&1
  local recovery_start
  recovery_start=$(date +%s)
  poll_until "pipeline to drain after recovery" 300 '[ "$(outbox_pending)" -eq 0 ]' || true
  local recovery_seconds=$(($(date +%s) - recovery_start))

  local mean_cpu
  mean_cpu=$(echo "scale=1; $cpu_total / $cpu_samples" | bc)

  local src es_docs lost
  src=$(source_count)
  es_docs=$(es_count)
  lost=$((src - es_docs))

  if [ "$checkpoint_during" -ne "$checkpoint_before" ]; then
    fail "G3 sink outage" "checkpoint moved during the outage ($checkpoint_before -> $checkpoint_during)"
  elif [ "$lost" -ne 0 ]; then
    fail "G3 sink outage" "$lost records lost (source $src, es $es_docs)"
  elif [ "$attempts" -ge 30 ]; then
    fail "G3 sink outage" "$attempts elasticsearch attempts during the outage, budget is 30"
  elif [ "$(echo "$mean_cpu >= 10" | bc)" -eq 1 ]; then
    fail "G3 sink outage" "mean worker cpu ${mean_cpu}%, budget is 10%"
  else
    pass "G3 sink outage" "${outage_seconds}s down, 0 lost, recovered in ${recovery_seconds}s, $attempts attempts, ${mean_cpu}% cpu"
  fi
}

# ----------------------------------------------- G4: partial batch failure ---

gate_g4() {
  say "G4 — 3 poison records in a 500-record batch"
  local poison=3
  local checkpoint_before dlq_before es_before
  checkpoint_before=$(checkpoint_of incremental)
  dlq_before=$(dlq_depth)
  es_before=$(es_count)

  # Stopping the worker is what makes the batch composition deterministic: the poison and
  # the outbox rows are both waiting when it starts, so the first batch is exactly BATCH_SIZE.
  docker compose stop worker >/dev/null 2>&1
  api_post /admin/simulate/poison "{\"count\":$poison}" >/dev/null
  api_post /admin/simulate/mutations '{"count":400,"ratePerSecond":2000}' >/dev/null
  docker compose start worker >/dev/null 2>&1

  poll_until "poison to reach the DLQ" 180 '[ "$(dlq_depth)" -ge '"$((dlq_before + poison))"' ]' || true
  poll_until "outbox to drain" 300 '[ "$(outbox_pending)" -eq 0 ]' || true

  local dlq_now checkpoint_after applied complete
  dlq_now=$(dlq_depth)
  checkpoint_after=$(checkpoint_of incremental)
  applied=$(docker compose logs worker 2>/dev/null |
    grep 'batch partially dead-lettered' | tail -1 | grep -o '"applied":[0-9]*' | cut -d: -f2 || true)
  complete=$(sql "SELECT count(*) FROM replication_dlq
                   WHERE replayed_at IS NULL AND payload IS NOT NULL
                     AND error <> '' AND checkpoint_at IS NOT NULL")

  local batch_size=$((${applied:-0} + poison))

  if [ "$((dlq_now - dlq_before))" -ne "$poison" ]; then
    fail "G4 partial batch failure" "expected $poison dlq rows, got $((dlq_now - dlq_before))"
  elif [ "$batch_size" -ne "$BATCH_SIZE" ]; then
    fail "G4 partial batch failure" "batch was $batch_size records, expected $BATCH_SIZE"
  elif [ "$complete" -lt "$poison" ]; then
    fail "G4 partial batch failure" "only $complete dlq rows carry payload, error and checkpoint_at"
  elif [ "$checkpoint_after" -le "$checkpoint_before" ]; then
    fail "G4 partial batch failure" "checkpoint did not advance past the batch"
  elif ! g4_replay_survives; then
    fail "G4 partial batch failure" "a corrected dlq row did not replay into elasticsearch"
  else
    pass "G4 partial batch failure" "${applied} indexed / $poison dlq'd, checkpoint $checkpoint_before -> $checkpoint_after, replay ok"
  fi
  info "es before $es_before, after $(es_count) — poison never reached the index"

  g4_clear_simulation_artifacts
}

# A replayed poison record is indexed and projected but has no source row, so it leaves
# source == es == projection false until the simulation undoes itself.
g4_clear_simulation_artifacts() {
  local removed
  removed=$(api_delete /admin/simulate/poison) || {
    fail "G4 simulation cleanup" "the cleanup endpoint did not respond"
    return
  }

  poll_until "projection to settle after cleanup" 60 \
    '[ "$(projection_count)" -eq "$(source_count)" ]' || true

  local src es_docs proj
  src=$(source_count)
  es_docs=$(es_count)
  proj=$(projection_count)

  if [ "$src" -ne "$es_docs" ] || [ "$src" -ne "$proj" ]; then
    fail "G4 simulation cleanup" "source $src / es $es_docs / projection $proj still disagree"
  else
    pass "G4 simulation cleanup" "$(jq -rc '.' <<<"$removed"), counts back to $src"
  fi
}

# Correct one DLQ payload and replay it. Returns non-zero unless the document lands.
g4_replay_survives() {
  local row id payload
  row=$(api "/admin/dlq?limit=50" | jq -c 'first(.rows[] | select(.replayed_at == null))')
  [ -n "$row" ] && [ "$row" != "null" ] || return 1

  id=$(jq -r '.id' <<<"$row")
  payload=$(jq -c '.payload | {id, sku, name, description, price, status, version, updated_at}' <<<"$row")

  curl -sf -X PATCH "http://localhost:${HTTP_PORT}/admin/dlq/${id}/payload" \
    -H 'content-type: application/json' -d "$payload" >/dev/null || return 1

  local outcome
  outcome=$(api_post "/admin/dlq/${id}/replay" | jq -r '.outcome')
  [ "$outcome" = "replayed" ] || return 1

  local doc_id
  doc_id=$(jq -r '.id' <<<"$payload")
  es "/${ELASTICSEARCH_INDEX}/_doc/${doc_id}" | jq -e '.found == true' >/dev/null
}

# ------------------------------------------------------------------ main ---

KILL_CHECKPOINTS=()
KILL_RESUMES=()

$KEEP_STACK || cold_start

say "Gates"
if wanted g1 || wanted g2; then
  run_kill_cycles && gate_g1 && gate_g2 || fail "G1/G2" "kill cycles did not complete"
fi
wanted g3 && gate_g3
wanted g4 && gate_g4

say "Summary"
printf '  elapsed %ss\n' "$(($(date +%s) - STARTED_AT))"
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32m  all gates passed\033[0m\n'
else
  printf '\033[31m  %s gate(s) failed\033[0m\n' "$FAILURES"
fi
exit "$FAILURES"
