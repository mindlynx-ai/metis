/*
 * Copyright 2026 Seillen Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Reviews: every run parked on a person, with the numbers that decide it.
 * The decision goes back on the run's own signal, so this page adds no
 * endpoint and no state of its own; refresh it and the truth is the runs.
 *
 * Both buttons open a confirmation carrying the values the decision turns on,
 * because approving is one click from paying an invoice and a misclick must
 * not be able to do it. It used to be a window.prompt, which was both the
 * wrong clothes and, worse, showed nothing but a title.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, type TemporalExecution } from '../api.js';
import { toast } from '../toast-store.js';
import { ensureUplift, useUplift } from '../uplift-store.js';
import { Icon } from '../ui/Icon.js';
import { timeAgo, timeUntil } from './format.js';
import { mayDecide, reviewQueue, type ReviewItem } from './review-queue.js';
import { DecisionModal } from './DecisionModal.js';

const POLL_MS = 15000;
/** The capability this page exists to serve; its pitch comes from the offer. */
const CAPABILITY = 'cap.approvals';

/** The empty state: nothing to review, or nothing that CAN be reviewed here. */
function EmptyQueue({ owned, pitch }: { owned: boolean; pitch?: string }) {
  return (
    <div className="conn-empty">
      <div className="conn-empty-mark" aria-hidden="true">
        <Icon name="stamp" size={28} />
      </div>
      <h2>{owned ? 'Nothing to review' : 'Approvals are part of Helix'}</h2>
      <p>
        {owned
          ? 'When a run reaches an approval step it parks here with everything you need to decide.'
          : (pitch ?? 'Add a human sign-off gate inside a run.')}
      </p>
      {!owned && (
        <Link className="btn btn-primary" to="/account">
          See what Helix adds
        </Link>
      )}
    </div>
  );
}

export function ReviewQueuePage() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [role, setRole] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  // The decision being confirmed, if any. Held here rather than in the row so
  // a poll refreshing the list cannot pull the dialog out from under someone
  // mid-sentence.
  const [pending, setPending] = useState<{ item: ReviewItem; decision: 'approved' | 'rejected' }>();
  const offers = useUplift((state) => state.offers);
  const capabilities = useUplift((state) => state.capabilities);
  useEffect(ensureUplift, []);

  const load = useCallback(async () => {
    try {
      // Running runs only: a parked approval is by definition still running.
      const result = await api.temporalExecutions('Running');
      setItems(reviewQueue(result.items as TemporalExecution[]));
      setError(undefined);
    } catch {
      setError('could not reach the runs');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    api
      .me()
      .then((session) => setRole(session.role))
      .catch(() => undefined);
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const decide = async (item: ReviewItem, decision: 'approved' | 'rejected', reason: string) => {
    setBusy(item.signalType);
    try {
      // The approver is NOT sent from here: the server stamps the session on
      // the signal, so the run's audit line cannot be dressed up by a client.
      await api.signalExecution(item.executionId, item.signalType, { decision, reason });
      toast.success(decision === 'approved' ? 'Approved' : 'Rejected');
      setPending(undefined);
      await load();
    } catch {
      toast.error('That decision did not go through');
    } finally {
      setBusy(undefined);
    }
  };

  const now = Date.now();
  const owned = capabilities.includes(CAPABILITY);
  const offer = offers.find((candidate) => candidate.id === CAPABILITY);

  return (
    <main className="shell-main review-page" aria-label="Reviews">
      <header className="page-hero">
        <div>
          <h1 className="page-title">Reviews</h1>
          <p className="page-hero-sub">
            Runs waiting on a person. Every decision is recorded against the run with who made
            it, when, and why, so the sign-off is part of the run's history.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => void load()}>
          <Icon name="refresh" size={14} /> Refresh
        </button>
      </header>

      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}

      {loaded && items.length === 0 && <EmptyQueue owned={owned} pitch={offer?.description} />}

      {items.length > 0 && (
        <section aria-label="Waiting for a decision">
          <div className="runs-table-wrap">
            <table className="runs-table">
              <thead>
                <tr>
                  <th>Decision</th>
                  <th>Run</th>
                  <th>Waiting</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const allowed = mayDecide(item, role);
                  return (
                    <tr key={`${item.executionId}-${item.signalType}`}>
                      <td className="runs-cell-run">
                        <span className="review-title">
                          {item.title}
                          {item.escalated && <span className="status status-waiting">escalated</span>}
                        </span>
                        <dl className="review-fields">
                          {item.fields.map((field) => (
                            <div key={field.label}>
                              <dt>{field.label}</dt>
                              <dd>{field.value}</dd>
                            </div>
                          ))}
                        </dl>
                        {item.refused && <span className="runs-sub">{item.refused}</span>}
                      </td>
                      <td>
                        <Link
                          to={`/executions/${encodeURIComponent(item.executionId)}`}
                          state={{ from: '/reviews' }}
                        >
                          {item.workflowName}
                        </Link>
                        <span className="runs-sub mono">{item.executionId}</span>
                      </td>
                      <td title={item.startTime}>
                        {timeAgo(item.startTime, now)}
                        {item.until && (
                          <span className="runs-sub">decide {timeUntil(item.until, now)}</span>
                        )}
                      </td>
                      <td className="op-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={!allowed || busy === item.signalType}
                          title={allowed ? 'Approve and continue the run' : `Needs the ${item.approverRole} role`}
                          onClick={() => setPending({ item, decision: 'approved' })}
                        >
                          Approve
                        </button>
                        {/* Plain, like every other row action on Operate. It
                            wore kv-remove, a 28px icon button, which squashed
                            the word out of its own chrome. The destructive
                            weight belongs on the dialog's confirm, not on the
                            button that only opens it. */}
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={!allowed || busy === item.signalType}
                          title={allowed ? 'Reject: the run takes its rejected branch' : `Needs the ${item.approverRole} role`}
                          onClick={() => setPending({ item, decision: 'rejected' })}
                        >
                          Reject
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {pending && (
        <DecisionModal
          item={pending.item}
          decision={pending.decision}
          busy={busy === pending.item.signalType}
          onCancel={() => setPending(undefined)}
          onConfirm={(reason) => void decide(pending.item, pending.decision, reason)}
        />
      )}
    </main>
  );
}
