import { useEffect, useState } from 'react';

import { useProductSearch } from '../queries.js';
import type { ChangeEvent, ProductHit } from '../types.js';

const PAGE_SIZE = 20;

/** Elasticsearch _source is untyped, so render only values that are genuinely scalar. */
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
const FEED_LIMIT = 30;

function LiveFeed(): React.JSX.Element {
  const [events, setEvents] = useState<ChangeEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource('/admin/events/stream');

    source.onopen = () => {
      setConnected(true);
    };
    source.onerror = () => {
      setConnected(false);
    };
    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as ChangeEvent;
      setEvents((current) => [event, ...current].slice(0, FEED_LIMIT));
    };

    return () => {
      source.close();
    };
  }, []);

  return (
    <section className="panel">
      <h2>
        Live changes <span className={connected ? 'ok' : 'muted'}>{connected ? '●' : '○'}</span>
      </h2>
      {events.length === 0 ? (
        <p className="muted">
          Nothing yet. Generate mutations on the Simulation screen and they appear here.
        </p>
      ) : (
        <div className="feed">
          {events.map((event) => (
            <div key={event.id} className="row">
              <span className="muted">{new Date(event.occurred_at).toLocaleTimeString()}</span>
              <span>{event.event_type}</span>
              <span className="muted">
                #{event.aggregate_id} v{event.version}
              </span>
              <span className={event.processed_at === null ? 'warn' : 'ok'}>
                {event.processed_at === null ? 'pending' : 'replicated'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function BrowserScreen(): React.JSX.Element {
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ProductHit>();

  const { data: result, error } = useProductSearch(query, page, PAGE_SIZE);

  const total = result?.total ?? 0;
  const reachable = result?.reachable ?? 0;
  const lastPage = Math.max(Math.ceil(reachable / PAGE_SIZE) - 1, 0);

  return (
    <>
      <section className="panel">
        <h2>Search — read from Elasticsearch, not Postgres</h2>
        <form
          className="row"
          onSubmit={(submit) => {
            submit.preventDefault();
            setPage(0);
            setQuery(term);
          }}
        >
          <input
            value={term}
            placeholder="name, sku or description…"
            onChange={(change) => {
              setTerm(change.target.value);
            }}
            style={{ flex: 1, minWidth: 220 }}
          />
          <button className="action" type="submit">
            Search
          </button>
          <span className="muted">
            {total.toLocaleString('en-US')} matches
            {total > reachable && ` · first ${reachable.toLocaleString('en-US')} browsable`}
          </span>
        </form>
      </section>

      {error !== null && <p className="notice error">{error.message}</p>}

      <section className="panel">
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>sku</th>
              <th>name</th>
              <th>price</th>
              <th>status</th>
              <th>version</th>
            </tr>
          </thead>
          <tbody>
            {(result?.hits ?? []).map((hit) => (
              <tr
                key={hit.id}
                onClick={() => {
                  setSelected(hit);
                }}
                style={{ cursor: 'pointer' }}
              >
                <td>{hit.id}</td>
                <td>{text(hit.source?.sku)}</td>
                <td>{text(hit.source?.name)}</td>
                <td>{text(hit.source?.price)}</td>
                <td>{text(hit.source?.status)}</td>
                <td className="muted">{hit.version ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="action"
            type="button"
            disabled={page === 0}
            onClick={() => {
              setPage((current) => current - 1);
            }}
          >
            Previous
          </button>
          <span className="muted">
            page {page + 1} of {lastPage + 1}
          </span>
          <button
            className="action"
            type="button"
            disabled={page >= lastPage}
            onClick={() => {
              setPage((current) => current + 1);
            }}
          >
            Next
          </button>
        </div>
      </section>

      <div className="grid">
        <section className="panel">
          <h2>Document{selected === undefined ? '' : ` — _version ${String(selected.version)}`}</h2>
          {selected === undefined ? (
            <p className="muted">Select a row to see the Elasticsearch document.</p>
          ) : (
            <pre>{JSON.stringify(selected.source, null, 2)}</pre>
          )}
        </section>
        <LiveFeed />
      </div>
    </>
  );
}
