import { useState } from 'react';

import { patchJson, postJson } from '../api.js';
import { type ControlAction, useControlAction, useDeadLetters, useRuntimeConfig, useStatus } from '../queries.js';
import type { DeadLetter } from '../types.js';

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
  const [notice, setNotice] = useState<string>();
  const [failed, setFailed] = useState(false);

  const { data: status } = useStatus();
  const { data: dlq } = useDeadLetters();
  const { data: config } = useRuntimeConfig();
  const control = useControlAction();

  const run = (label: string, action: ControlAction) => () => {
    control.mutate(action, {
      onSuccess: () => {
        setNotice(`${label} ok`);
        setFailed(false);
      },
      onError: (cause) => {
        setNotice(`${label} failed: ${cause.message}`);
        setFailed(true);
      },
    });
  };

  const busy = control.isPending;
  const paused = config?.backfillPaused ?? false;

  return (
    <>
      {notice !== undefined && (
        <p className={`notice ${failed ? 'error' : ''}`}>{notice}</p>
      )}

      <section className="panel">
        <h2>Backfill — {status?.checkpoints[0]?.status ?? '…'}</h2>
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
            cursor {(status?.checkpoints[0]?.last_processed_id ?? 0).toLocaleString('en-US')}
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
              defaultValue={config?.batchSize ?? 500}
              key={`batch-${String(config?.batchSize)}`}
              style={{ width: 100 }}
            />
          </label>
          <label className="row">
            poll interval ms
            <input
              name="outboxPollIntervalMs"
              type="number"
              min={1}
              defaultValue={config?.outboxPollIntervalMs ?? 250}
              key={`poll-${String(config?.outboxPollIntervalMs)}`}
              style={{ width: 100 }}
            />
          </label>
          <label className="row">
            max retries
            <input
              name="retryMaxAttempts"
              type="number"
              min={1}
              defaultValue={config?.retryMaxAttempts ?? 5}
              key={`retry-${String(config?.retryMaxAttempts)}`}
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
        <h2>Dead letter queue — {dlq?.count ?? 0} rows</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <button
            className="action"
            type="button"
            disabled={busy || (dlq?.count ?? 0) === 0}
            onClick={run('replay all', () => postJson('/admin/dlq/replay-all'))}
          >
            Replay all
          </button>
        </div>
        {(dlq?.rows ?? []).length === 0 ? (
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
              {(dlq?.rows ?? []).map((row) => (
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
