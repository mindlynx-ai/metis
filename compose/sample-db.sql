-- Copyright 2026 Seillen Ltd
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.
--
-- Sample data for trying the SQL / Postgres nodes: a small orders table.

CREATE TABLE IF NOT EXISTS orders (
  id serial PRIMARY KEY,
  customer text NOT NULL,
  email text NOT NULL,
  amount numeric(10, 2) NOT NULL,
  status text NOT NULL DEFAULT 'paid',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed only when empty, so re-running this file never duplicates the rows.
INSERT INTO orders (customer, email, amount, status)
SELECT * FROM (VALUES
  ('Ada Lovelace', 'ada@example.com', 129.00, 'paid'),
  ('Alan Turing', 'alan@example.com', 59.50, 'paid'),
  ('Grace Hopper', 'grace@example.com', 240.00, 'refunded'),
  ('Katherine Johnson', 'kj@example.com', 88.25, 'paid'),
  ('Linus Torvalds', 'linus@example.com', 15.00, 'pending'),
  ('Margaret Hamilton', 'mh@example.com', 512.75, 'paid')
) AS seed(customer, email, amount, status)
WHERE NOT EXISTS (SELECT 1 FROM orders);

-- A customers table so the Data node can be tried with a JOIN (an order + its
-- customer). Idempotent: safe to run on a fresh volume or re-exec into a live db.
CREATE TABLE IF NOT EXISTS customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  tier text NOT NULL DEFAULT 'standard'
);

INSERT INTO customers (name, email, tier) VALUES
  ('Ada Lovelace', 'ada@example.com', 'gold'),
  ('Alan Turing', 'alan@example.com', 'standard'),
  ('Grace Hopper', 'grace@example.com', 'gold'),
  ('Katherine Johnson', 'kj@example.com', 'standard'),
  ('Linus Torvalds', 'linus@example.com', 'standard'),
  ('Margaret Hamilton', 'mh@example.com', 'gold')
ON CONFLICT (email) DO NOTHING;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id integer REFERENCES customers(id);
UPDATE orders o SET customer_id = c.id FROM customers c WHERE c.email = o.email;
