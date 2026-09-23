import { useRef } from 'react';

import { getJson } from '../api.js';
import type { StatusReport } from '../types.js';
import { POLL_INTERVAL_MS, usePolling } from '../usePolling.js';

const SPARK_SAMPLES = 40;

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function formatEta(remaining: number, rowsPerSecond: number): string {
  if (remaining <= 0) {
    return 'complete';
  }
  if (rowsPerSecond <= 0) {
    return '—';
  }

  const seconds = Math.round(remaining / rowsPerSecond);
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.round(seconds / 60))}m`;
}

function Sparkline({ points }: { points: readonly number[] }): React.JSX.Element {
  const peak = Math.max(...points, 1);
  const step = 100 / Math.max(points.length - 1, 1);
  const path = points
    .map((value, index) => `${String(index * step)},${String(30 - (value / peak) * 28)}`)
    .join(' ');

  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" style={{ width: '100%', height: 40 }}>
      <polyline points={path} fill="none" stroke="#60a5fa" strokeWidth="1.2" />
    </svg>
  );
}

export function StatusScreen(): React.JSX.Element {
  const history = useRef<number[]>([]);
  const previous = useRef<{ cursor: number; at: number }>({ cursor: 0, at: 0 });

  const { value: status, error } = usePolling<StatusReport>(
    () => getJson<StatusReport>('/admin/status'),
    POLL_INTERVAL_MS,
  );

  if (error !== undefined && status === undefined) {
    return <p className="notice error">Cannot reach the admin api: {error}</p>;
  }
  if (status === undefined) {
    return <p className="muted">Loading…</p>;
  }

  const backfill = status.checkpoints.find((row) => row.pipeline === 'backfill');
  const cursor = backfill?.last_processed_id ?? 0;
  const now = Date.now();
  const elapsed = (now - previous.current.at) / 1000;
  const throughput =
    previous.current.at === 0 || elapsed <= 0
      ? 0
      : Math.max((cursor - previous.current.cursor) / elapsed, 0);

  previous.current = { cursor, at: now };
  history.current = [...history.current, throughput].slice(-SPARK_SAMPLES);

  const remaining = Math.max(status.counts.source - cursor, 0);

  return (
    <>
      {error !== undefined && <p className="notice error">Last poll failed: {error}</p>}

      <section className="panel">
        <h2>Backfill</h2>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="metric">{(status.backfillProgressRatio * 100).toFixed(2)}%</span>
          <span className="muted">
            {formatNumber(cursor)} / {formatNumber(status.counts.source)} · {backfill?.status} · eta{' '}
            {formatEta(remaining, throughput)}
          </span>
        </div>
        <div className="bar">
          <span style={{ width: `${String(status.backfillProgressRatio * 100)}%` }} />
        </div>
        <Sparkline points={history.current} />
        <small className="muted">{formatNumber(Math.round(throughput))} rows/s</small>
      </section>

      <div className="grid">
        <section className="panel">
          <h2>Incremental lag</h2>
          <div className={`metric ${status.lagSeconds > 30 ? 'warn' : ''}`}>
            {status.lagSeconds.toFixed(1)}s
            <small>{formatNumber(status.counts.outbox_pending)} outbox rows waiting</small>
          </div>
        </section>
        <section className="panel">
          <h2>Consumer queue</h2>
          <div className="metric">
            {formatNumber(status.consumerQueueDepth)}
            <small>messages not yet acked</small>
          </div>
        </section>
        <section className="panel">
          <h2>Dead letters</h2>
          <div className={`metric ${status.dlqDepth > 0 ? 'bad' : ''}`}>
            {formatNumber(status.dlqDepth)}
            <small>{formatNumber(status.pendingPoison)} poison records pending</small>
          </div>
        </section>
        <section className="panel">
          <h2>Dependencies</h2>
          <div className="lights">
            {Object.entries(status.dependencies).map(([name, up]) => (
              <span className="light" key={name}>
                <span>{name}</span>
                <span className={`dot ${up ? 'up' : 'down'}`} />
              </span>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <h2>Counts — all three must agree (G2)</h2>
        <table>
          <tbody>
            <tr>
              <th>Source (products)</th>
              <td>{formatNumber(status.counts.source)}</td>
            </tr>
            <tr>
              <th>Elasticsearch</th>
              <td className={status.counts.elasticsearch === status.counts.source ? 'ok' : 'bad'}>
                {status.counts.elasticsearch === null
                  ? 'unreachable'
                  : formatNumber(status.counts.elasticsearch)}
              </td>
            </tr>
            <tr>
              <th>Projection</th>
              <td className={status.counts.projection === status.counts.source ? 'ok' : 'bad'}>
                {formatNumber(status.counts.projection)}
              </td>
            </tr>
            <tr>
              <th>Processed events</th>
              <td className="muted">{formatNumber(status.counts.processed_events)}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}
