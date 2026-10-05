CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  paypal_order_id TEXT NOT NULL,
  customer_json TEXT NOT NULL,
  shipping_json TEXT NOT NULL,
  order_notes TEXT,
  items_json TEXT NOT NULL,
  total_quantity INTEGER NOT NULL,
  merchandise_total REAL NOT NULL,
  shipping_total REAL NOT NULL,
  total REAL NOT NULL,
  paypal_capture_json TEXT,
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at
ON orders(created_at);

CREATE INDEX IF NOT EXISTS idx_orders_paypal_order_id
ON orders(paypal_order_id);
