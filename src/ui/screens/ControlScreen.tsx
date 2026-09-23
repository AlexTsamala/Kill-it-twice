import { useState } from 'react';

import { getJson, patchJson, postJson } from '../api.js';
import type { DeadLetter, RuntimeConfig, StatusReport } from '../types.js';
import { usePolling } from '../usePolling.js';

interface DlqPage {
  rows: DeadLetter[];
  count: number;
}

const PAYLOAD_FIELDS = [
  'id',
  'sku',
  'name',
  'description',
  'price',
  'status',
  'version',
  'updated_at',
] as const;

/** The stored payload keeps the field that caused the rejection (D10); correcting a row is
 *  what strips it, so replay only succeeds once someone has actually fixed it. */
function correctedPayload(row: DeadLetter): Record<string, unknown> {
  return Object.fromEntries(PAYLOAD_FIELDS.map((field) => [field, row.payload[field] ?? null]));
}

export function ControlScreen(): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [failed, setFailed] = useState(false);

  const status = usePolling<StatusReport>(() => getJson<StatusReport>('/admin/status'));
  const dlq = usePolling<DlqPage>(() => getJson<DlqPage>('/admin/dlq?limit=100'), 4000);
  const config = usePolling<RuntimeConfig>(() => getJson<RuntimeConfig>('/admin/control/config'), 5000);

  const run = (label: string, action: () => Promise<unknown>) => () => {
    setBusy(true);
    action()
      .then(() => {
        setNotice(`${label} ok`);
        setFailed(false);
        status.refresh();
        dlq.refresh();
        config.refresh();
      })
      .catch((cause: unknown) => {
        setNotice(`${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        setFailed(true);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const paused = config.value?.backfillPaused ?? false;

  return (
    <>
      {notice !== undefined && (
        <p className={`notice ${failed ? 'error' : ''}`}>{notice}</p>
      )}

      <section className="panel">
        <h2>Backfill — {status.value?.checkpoints[0]?.status ?? '…'}</h2>
        <div className="row">
          <button
            className="action"
            type="button"
            disabled={busy || paused}
            onClick={run('pause', () => postJson('/admin/control/backfill/pause'))}
          >
            Pause
          </button>
          <button
            className="action"
            type="button"
            disabled={busy || !paused}
            onClick={run('resume', () => postJson('/admin/control/backfill/resume'))}
          >
            Resume
          </button>
          <button
            className="action danger"
            type="button"
            disabled={busy}
            onClick={run('reset checkpoint', () => postJson('/admin/control/backfill/reset'))}
          >
            Reset checkpoint to 0
          </button>
          <span className="muted">
            cursor {(status.value?.checkpoints[0]?.last_processed_id ?? 0).toLocaleString('en-US')}
          </span>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Resetting is safe at any time — external versioning (D3) means a replayed document
          cannot overwrite a newer one.
        </p>
      </section>

      <section className="panel">
        <h2>Runtime configuration</h2>
        <form
          className="row"
          onSubmit={(submit) => {
            submit.preventDefault();
            const form = new FormData(submit.currentTarget);
            run('config update', () =>
              postJson('/admin/control/config', {
                batchSize: Number(form.get('batchSize')),
                outboxPollIntervalMs: Number(form.get('outboxPollIntervalMs')),
                retryMaxAttempts: Number(form.get('retryMaxAttempts')),
              }),
            )();
          }}
        >
          <label className="row">
            batch size
            <input
              name="batchSize"
              type="number"
              min={1}
              defaultValue={config.value?.batchSize ?? 500}
              key={`batch-${String(config.value?.batchSize)}`}
              style={{ width: 100 }}
            />
          </label>
          <label className="row">
            poll interval ms
            <input
              name="outboxPollIntervalMs"
              type="number"
              min={1}
              defaultValue={config.value?.outboxPollIntervalMs ?? 250}
              key={`poll-${String(config.value?.outboxPollIntervalMs)}`}
              style={{ width: 100 }}
            />
          </label>
          <label className="row">
            max retries
            <input
              name="retryMaxAttempts"
              type="number"
              min={1}
              defaultValue={config.value?.retryMaxAttempts ?? 5}
              key={`retry-${String(config.value?.retryMaxAttempts)}`}
              style={{ width: 80 }}
            />
          </label>
          <button className="action" type="submit" disabled={busy}>
            Apply
          </button>
        </form>
        <p className="muted" style={{ marginBottom: 0 }}>
          Environment variables supply every default and are still validated at startup. A value
          set here is an explicit override the workers pick up on their next batch.
        </p>
      </section>

      <section className="panel">
        <h2>Dead letter queue — {dlq.value?.count ?? 0} rows</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <button
            className="action"
            type="button"
            disabled={busy || (dlq.value?.count ?? 0) === 0}
            onClick={run('replay all', () => postJson('/admin/dlq/replay-all'))}
          >
            Replay all
          </button>
        </div>
        {(dlq.value?.rows ?? []).length === 0 ? (
          <p className="muted">Empty. Inject poison records on the Simulation screen.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>id</th>
                <th>aggregate</th>
                <th>type</th>
                <th>error</th>
                <th>attempts</th>
                <th>checkpoint</th>
                <th>state</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(dlq.value?.rows ?? []).map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>{row.aggregate_id}</td>
                  <td className="muted">{row.event_type}</td>
                  <td style={{ maxWidth: 360 }}>{row.error}</td>
                  <td>{row.attempts}</td>
                  <td className="muted">{row.checkpoint_at}</td>
                  <td className={row.replayed_at === null ? 'warn' : 'ok'}>
                    {row.replayed_at === null ? 'pending' : 'replayed'}
                  </td>
                  <td>
                    <div className="row">
                      <button
                        className="action"
                        type="button"
                        disabled={busy || row.replayed_at !== null}
                        onClick={run(`correct ${String(row.id)}`, () =>
                          patchJson(`/admin/dlq/${String(row.id)}/payload`, correctedPayload(row)),
                        )}
                      >
                        Correct
                      </button>
                      <button
                        className="action"
                        type="button"
                        disabled={busy || row.replayed_at !== null}
                        onClick={run(`replay ${String(row.id)}`, () =>
                          postJson(`/admin/dlq/${String(row.id)}/replay`),
                        )}
                      >
                        Replay
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
