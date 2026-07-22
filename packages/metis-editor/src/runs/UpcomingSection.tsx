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

/** Upcoming: the executions that are GOING to run (schedule fire times). */
import { timeUntil } from './format.js';

export interface UpcomingEntry {
  when: string;
  label: string;
  cron?: string;
}

export function UpcomingSection({ entries, now }: { entries: UpcomingEntry[]; now: number }) {
  if (entries.length === 0) return null;
  return (
    <section aria-label="Upcoming runs" className="operate-upcoming">
      <h2 className="op-section-title">Upcoming - scheduled to run</h2>
      <div className="upcoming-list">
        {entries.map((entry) => (
          <div className="upcoming-item" key={`${entry.label}-${entry.when}`}>
            <span className="upcoming-when" title={entry.when}>
              {timeUntil(entry.when, now)}
            </span>
            <span className="upcoming-what">
              <span>{entry.label}</span>
              {entry.cron && <span className="runs-sub mono">{entry.cron}</span>}
            </span>
            <span className="upcoming-at">{new Date(entry.when).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
