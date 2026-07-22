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
  const pool = new pg.Pool({ ...options, max: 5, idleTimeoutMillis: 5 * 60 * 1000 });
  pools.set(key, pool);
  return pool;
}
