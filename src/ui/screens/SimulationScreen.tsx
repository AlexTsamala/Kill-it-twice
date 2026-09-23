import { useState } from 'react';

import { deleteJson, postJson } from '../api.js';
import { type ControlAction, useControlAction, useStatus } from '../queries.js';

export function SimulationScreen(): React.JSX.Element {
  const [notice, setNotice] = useState<string>();
  const [failed, setFailed] = useState(false);

  const { data: status } = useStatus();
  const control = useControlAction();

  const run = (label: string, action: ControlAction) => () => {
    control.mutate(action, {
      onSuccess: (result) => {
        setNotice(`${label}: ${JSON.stringify(result)}`);
        setFailed(false);
      },
      onError: (cause) => {
        setNotice(`${label} failed: ${cause.message}`);
        setFailed(true);
      },
    });
  };

  const busy = control.isPending;
  const sinks = status?.sinks;

  return (
    <>
      {notice !== undefined && <p className={`notice ${failed ? 'error' : ''}`}>{notice}</p>}

      <section className="panel">
        <h2>Sinks</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Switching a sink off makes every write to it fail transiently, so the workers take the
          real backoff path and the checkpoint holds. It is the same code G3 exercises by stopping
          the container.
        </p>
        <div className="row">
          {(['elasticsearch', 'rabbitmq'] as const).map((sink) => {
            const enabled = sinks?.[sink] ?? true;
            return (
              <button
                key={sink}
                className={`action ${enabled ? '' : 'danger'}`}
                type="button"
                disabled={busy}
                onClick={run(`${sink} ${enabled ? 'off' : 'on'}`, () =>
                  postJson('/admin/simulate/sink', { sink, enabled: !enabled }),
                )}
              >
                {sink}: {enabled ? 'on' : 'OFF'}
              </button>
            );
          })}
        </div>
      </section>

      <div className="grid">
        <section className="panel">
          <h2>Poison records</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Injected into the next batch, taking slots from it so the batch is still exactly
            BATCH_SIZE. Elasticsearch rejects them per item; the rest of the batch lands.
          </p>
          <form
            className="row"
            onSubmit={(submit) => {
              submit.preventDefault();
              const count = Number(new FormData(submit.currentTarget).get('count'));
              run('inject poison', () => postJson('/admin/simulate/poison', { count }))();
            }}
          >
            <input name="count" type="number" min={1} max={500} defaultValue={3} style={{ width: 90 }} />
            <button className="action" type="submit" disabled={busy}>
              Inject
            </button>
            <button
              className="action"
              type="button"
              disabled={busy}
              onClick={run('clear poison artifacts', () => deleteJson('/admin/simulate/poison'))}
            >
              Clear artifacts
            </button>
            <span className="muted">{status?.pendingPoison ?? 0} pending</span>
          </form>
        </section>

        <section className="panel">
          <h2>Source mutations</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Drives the real repository, so each one writes its outbox row in the same transaction
            a production write would (D1).
          </p>
          <form
            className="row"
            onSubmit={(submit) => {
              submit.preventDefault();
              const form = new FormData(submit.currentTarget);
              run('generate mutations', () =>
                postJson('/admin/simulate/mutations', {
                  count: Number(form.get('count')),
                  ratePerSecond: Number(form.get('ratePerSecond')),
                }),
              )();
            }}
          >
            <label className="row">
              count
              <input name="count" type="number" min={1} max={100000} defaultValue={200} style={{ width: 100 }} />
            </label>
            <label className="row">
              per second
              <input
                name="ratePerSecond"
                type="number"
                min={1}
                max={10000}
                defaultValue={500}
                style={{ width: 100 }}
              />
            </label>
            <button className="action" type="submit" disabled={busy}>
              Generate
            </button>
          </form>
        </section>
      </div>

      <section className="panel">
        <h2>Kill the worker</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Exits the worker process with 137 and no shutdown hooks — the ungraceful death G1
          produces with <code>docker kill</code>. Compose restarts it, and it resumes from the
          last persisted checkpoint.
        </p>
        <button
          className="action danger"
          type="button"
          disabled={busy}
          onClick={run('kill worker', () => postJson('/admin/simulate/kill-worker'))}
        >
          Kill worker now
        </button>
      </section>
    </>
  );
}
