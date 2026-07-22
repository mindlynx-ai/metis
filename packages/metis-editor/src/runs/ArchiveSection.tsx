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
 * The Archive: runs Temporal's visibility has forgotten but Metis still
 * remembers (the store outlives the dev server's retention). Detail pages are
 * store-backed, so archived runs stay fully inspectable - no operator levers,
 * though: Temporal no longer has their history.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.js';
import { durationBetween, timeAgo } from './format.js';

type ArchiveRow = Awaited<ReturnType<typeof api.executionArchive>>['items'][number];

export function ArchiveSection() {
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [retentionDays, setRetentionDays] = useState<number>();

  useEffect(() => {
    api
      .executionArchive()
      .then((result) => {
        setRows(result.items);
        setRetentionDays(result.retentionDays);
      })
      .catch(() => setRows([]));
  }, []);

  if (rows.length === 0) return null;
  const now = Date.now();
  return (
    <section aria-label="Archive" className="operate-archive">
      <h2 className="op-section-title">Archive - beyond Temporal&apos;s memory</h2>
      <p className="help">
        Temporal&apos;s visibility no longer lists these runs; Metis keeps them
        {retentionDays ? ` for ${retentionDays} days` : ''}. They stay fully inspectable.
      </p>
      <div className="runs-table-wrap">
        <table className="runs-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Started</th>
              <th>Took</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.executionId}>
                <td className="runs-cell-run">
                  <Link to={`/executions/${encodeURIComponent(row.executionId)}`} state={{ from: '/operate' }}>
                    {row.workflowName ?? row.executionId}
                  </Link>
                  <span className="runs-sub mono">
                    {row.executionId}
                    {row.definitionVersion !== undefined && (
                      <span className="ver-chip">v{row.definitionVersion}·c{row.definitionChangeset ?? 0}</span>
                    )}
                  </span>
                </td>
                <td>
                  <span className={`status status-${row.status}`}>{row.status}</span>
                </td>
                <td title={row.startTime}>{timeAgo(row.startTime, now)}</td>
                <td>{durationBetween(row.startTime, row.endTime) ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
