export interface Checkpoint {
  pipeline: string;
  last_processed_id: number;
  status: string;
}

export interface StatusReport {
  checkpoints: Checkpoint[];
  counts: {
    source: number;
    projection: number;
    processed_events: number;
    outbox_pending: number;
    elasticsearch: number | null;
  };
  backfillProgressRatio: number;
  lagSeconds: number;
  consumerQueueDepth: number;
  dlqDepth: number;
  pendingPoison: number;
  sinks: { elasticsearch: boolean; rabbitmq: boolean };
  dependencies: Record<string, boolean>;
}

export interface DeadLetter {
  id: number;
  pipeline: string;
  source_ref: number;
  aggregate_id: number;
  event_type: string | null;
  payload: Record<string, unknown>;
  error: string;
  attempts: number;
  checkpoint_at: number;
  replayed_at: string | null;
}

export interface RuntimeConfig {
  backfillPaused: boolean;
  killWorker: boolean;
  batchSize: number;
  outboxPollIntervalMs: number;
  retryMaxAttempts: number;
}

export interface ProductHit {
  id: string;
  version: number | undefined;
  source: Record<string, unknown> | null;
}

export interface ChangeEvent {
  id: number;
  aggregate_id: number;
  event_type: string;
  version: number;
  occurred_at: string;
  processed_at: string | null;
}
