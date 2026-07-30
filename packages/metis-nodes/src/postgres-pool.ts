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
 * Shared pg.Pool cache for the postgres node and the Postgres
 * DataSource: one small pool per connection (5 clients, 5 minute idle
 * timeout), keyed by connection id, torn down together on shutdown.
 */
import pg from 'pg';

const pools = new Map<string, pg.Pool>();

/**
 * How long a caller may wait for a client. pg's own default is 0, which means
 * WAIT FOR EVER, and it covers queueing as well as connecting: with five
 * clients in the pool, a sixth parallel branch waited indefinitely and reported
 * nothing at all. Ten seconds is longer than a healthy connect and shorter than
 * anybody's patience.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Server-side ceiling on one statement, which pg passes to Postgres as
 * statement_timeout. Under the engine's two-minute activity budget on purpose:
 * a query that outran that was killed by Temporal instead, which retries the
 * activity and runs the query again, so an accidental full table scan became a
 * repeating one. Here it comes back as an error naming the timeout, and the
 * connection is not left holding a query nobody is waiting for.
 */
const STATEMENT_TIMEOUT_MS = 90_000;

export async function closePostgresPools(): Promise<void> {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}

export function poolFor(key: string, material: Record<string, string>): pg.Pool {
  const existing = pools.get(key);
  if (existing) return existing;
  const options: pg.PoolConfig = material.connectionString
    ? { connectionString: material.connectionString }
    : {
        host: material.host,
        port: material.port ? Number(material.port) : undefined,
        database: material.database,
        user: material.user,
        password: material.password,
      };
  const pool = new pg.Pool({
    ...options,
    max: 5,
    idleTimeoutMillis: 5 * 60 * 1000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  pools.set(key, pool);
  return pool;
}
