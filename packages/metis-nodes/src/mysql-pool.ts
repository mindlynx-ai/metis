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
 * Shared mysql2 pool cache for the MySQL DataSource: one small pool per
 * connection, keyed by connection id, torn down together on shutdown. The
 * Postgres twin of this lives in postgres-pool.ts and behaves the same way.
 */
import mysql from 'mysql2/promise';

const pools = new Map<string, mysql.Pool>();

export async function closeMysqlPools(): Promise<void> {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}

export function mysqlPoolFor(key: string, material: Record<string, string>): mysql.Pool {
  const existing = pools.get(key);
  if (existing) return existing;
  const pool = mysql.createPool({
    uri: material.connectionString || undefined,
    host: material.connectionString ? undefined : material.host,
    port: material.port ? Number(material.port) : undefined,
    database: material.database || undefined,
    user: material.user || undefined,
    password: material.password || undefined,
    connectionLimit: 5,
    idleTimeout: 5 * 60 * 1000,
    // Keep DECIMAL and BIGINT as strings rather than silently losing precision
    // in a float: an order total that reads 129.00 must not become 129.00000001.
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    // A workflow step is one statement; leaving multi-statement off keeps a
    // templated value from being able to append a second one.
    multipleStatements: false,
  });
  pools.set(key, pool);
  return pool;
}
