-- Lumen Concierge - business data schema (PostgreSQL)
-- LangGraph creates its memory tables (checkpoint*) at server start; npm run ingest creates the
-- lumen_policies pgvector table.

CREATE EXTENSION IF NOT EXISTS vector;

DROP TABLE IF EXISTS audit_log, returns, order_items, orders, inventory, products, chat_messages, sessions, customers CASCADE;

CREATE TABLE customers (
  customer_id  TEXT PRIMARY KEY,            -- LUM-CUST-100001
  full_name    TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT,
  city         TEXT
);

CREATE TABLE products (
  product_id   TEXT PRIMARY KEY,            -- LUM-PRD-0001
  name         TEXT NOT NULL,
  brand        TEXT NOT NULL,
  category     TEXT NOT NULL CONSTRAINT products_category_check
               CHECK (category IN ('Footwear', 'Topwear', 'Bottomwear', 'Accessories')),
  price_inr    NUMERIC(10,2) NOT NULL,
  sizes        TEXT[] NOT NULL DEFAULT '{}',
  description  TEXT NOT NULL,
  rating       NUMERIC(2,1),
  return_window_days INT NOT NULL DEFAULT 30 CHECK (return_window_days > 0)
);
CREATE SEQUENCE IF NOT EXISTS product_seq START 1;

CREATE TABLE inventory (
  product_id   TEXT REFERENCES products(product_id),
  size         TEXT NOT NULL DEFAULT 'ONE',
  location     TEXT NOT NULL,               -- Online Warehouse, Mumbai Store, Bengaluru Store
  quantity     INT  NOT NULL,
  PRIMARY KEY (product_id, size, location)
);

CREATE TABLE orders (
  order_id       TEXT PRIMARY KEY,          -- LUM-ORD-20261101-0001
  customer_id    TEXT REFERENCES customers(customer_id),
  status         TEXT NOT NULL,             -- processing, shipped, out_for_delivery, delivered, cancelled
  order_date     DATE NOT NULL,
  delivery_date  DATE,                      -- actual or expected
  courier        TEXT,
  tracking_ref   TEXT,
  delivery_city  TEXT,
  total_inr      NUMERIC(10,2) NOT NULL
);

CREATE TABLE order_items (
  order_id     TEXT REFERENCES orders(order_id),
  product_id   TEXT REFERENCES products(product_id),
  size         TEXT,
  quantity     INT NOT NULL,
  price_inr    NUMERIC(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE returns (
  return_id    TEXT PRIMARY KEY,            -- LUM-RET-000001
  order_id     TEXT REFERENCES orders(order_id),
  product_id   TEXT REFERENCES products(product_id),
  customer_id  TEXT REFERENCES customers(customer_id),
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending_approval', -- pending_approval, approved, rejected
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by  TEXT,
  reviewed_at  TIMESTAMPTZ
);
CREATE SEQUENCE IF NOT EXISTS return_seq START 1;

-- Chat sessions: links a browser session to a (demo-)authenticated customer.
CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  customer_id  TEXT REFERENCES customers(customer_id),
  title        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id           BIGSERIAL PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content      TEXT NOT NULL,
  info         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit trail: tool calls, Altrum verdicts, staff decisions (PII masked before insert).
CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id   TEXT,
  event        TEXT NOT NULL,               -- chat, tool_call, altrum_verdict, staff_decision, memory_deleted
  detail       JSONB NOT NULL DEFAULT '{}'
);
