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
-- The MySQL twin of sample-db.sql: the same orders and customers, so the one
-- acceptance suite can run identical cases against either engine and the
-- "engine-agnostic data node" claim is actually tested rather than asserted.

CREATE TABLE IF NOT EXISTS customers (
  id int AUTO_INCREMENT PRIMARY KEY,
  name varchar(128) NOT NULL,
  email varchar(190) NOT NULL UNIQUE,
  tier varchar(32) NOT NULL DEFAULT 'standard'
);

INSERT INTO customers (name, email, tier) VALUES
  ('Ada Lovelace', 'ada@example.com', 'gold'),
  ('Alan Turing', 'alan@example.com', 'standard'),
  ('Grace Hopper', 'grace@example.com', 'gold'),
  ('Katherine Johnson', 'kj@example.com', 'standard'),
  ('Linus Torvalds', 'linus@example.com', 'standard'),
  ('Margaret Hamilton', 'mh@example.com', 'gold')
ON DUPLICATE KEY UPDATE tier = VALUES(tier);

CREATE TABLE IF NOT EXISTS orders (
  id int AUTO_INCREMENT PRIMARY KEY,
  customer varchar(128) NOT NULL,
  email varchar(190) NOT NULL,
  amount decimal(10, 2) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'paid',
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  customer_id int,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- Seed only when empty, so re-running this file never duplicates the rows.
INSERT INTO orders (customer, email, amount, status)
SELECT * FROM (
  SELECT 'Ada Lovelace' AS c, 'ada@example.com' AS e, 129.00 AS a, 'paid' AS s
  UNION ALL SELECT 'Alan Turing', 'alan@example.com', 59.50, 'paid'
  UNION ALL SELECT 'Grace Hopper', 'grace@example.com', 240.00, 'refunded'
  UNION ALL SELECT 'Katherine Johnson', 'kj@example.com', 88.25, 'paid'
  UNION ALL SELECT 'Linus Torvalds', 'linus@example.com', 15.00, 'pending'
  UNION ALL SELECT 'Margaret Hamilton', 'mh@example.com', 512.75, 'paid'
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM orders);

UPDATE orders o JOIN customers c ON c.email = o.email SET o.customer_id = c.id;
