import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS } from "../public/js/stock.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  key        TEXT PRIMARY KEY,
  sku        TEXT NOT NULL,
  tax        TEXT NOT NULL CHECK (tax IN ('PPN','NON')),
  name       TEXT NOT NULL DEFAULT '',
  unit       TEXT NOT NULL DEFAULT 'PCS' CHECK (unit IN ('PCS','SET')),
  qty        REAL NOT NULL DEFAULT 0,
  price      REAL NOT NULL DEFAULT 0,
  min_stock  REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS moves (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  t    INTEGER NOT NULL,
  key  TEXT NOT NULL,
  sku  TEXT NOT NULL,
  tax  TEXT NOT NULL,
  type TEXT NOT NULL,
  qty  REAL NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS moves_t ON moves (t);
CREATE TABLE IF NOT EXISTS rules (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('alert','column')),
  scope      TEXT NOT NULL CHECK (scope IN ('ALL','PPN','NON')),
  severity   TEXT NOT NULL DEFAULT 'warn' CHECK (severity IN ('warn','crit')),
  expr       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sku  TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  at   INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'attach',
  tax  TEXT NOT NULL DEFAULT '',
  ym   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS history (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL,
  file        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  tax         TEXT NOT NULL DEFAULT '',
  ym          TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  msg         TEXT NOT NULL DEFAULT '',
  lines       INTEGER,
  skus        INTEGER NOT NULL DEFAULT 0,
  qty         REAL NOT NULL DEFAULT 0,
  rp          REAL NOT NULL DEFAULT 0,
  other_units TEXT NOT NULL DEFAULT '',
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_file ON history (file_id);
-- Units sold per SKU and month, from sales reports.
CREATE TABLE IF NOT EXISTS demand (
  tax  TEXT NOT NULL,
  sku  TEXT NOT NULL,
  ym   TEXT NOT NULL,
  pcs  REAL NOT NULL DEFAULT 0,
  sets REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (tax, sku, ym)
);
-- SKUs that had stock at the end of a month, from stock reports.
CREATE TABLE IF NOT EXISTS stock_seen (
  tax TEXT NOT NULL,
  sku TEXT NOT NULL,
  ym  TEXT NOT NULL,
  PRIMARY KEY (tax, sku, ym)
);
CREATE TABLE IF NOT EXISTS settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppliers (
  id         TEXT PRIMARY KEY,
  company    TEXT NOT NULL,
  contact    TEXT NOT NULL DEFAULT '',
  wechat     TEXT NOT NULL DEFAULT '',
  whatsapp   TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  preferred  TEXT NOT NULL DEFAULT '' CHECK (preferred IN ('','whatsapp','wechat','email','phone')),
  notes      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','staff','viewer')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
-- id is the SHA-256 of the session token; the token itself only lives in the user's cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id          TEXT PRIMARY KEY,
  number      TEXT NOT NULL UNIQUE,
  supplier_id TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('draft','sent','partial','received','closed','cancelled')),
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER,
  sent_via    TEXT NOT NULL DEFAULT '',
  closed_at   INTEGER,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS po_supplier ON purchase_orders (supplier_id, status);
-- sku/name/unit are copied onto the line so an order stays readable if the product is later renamed or deleted.
CREATE TABLE IF NOT EXISTS po_lines (
  id       TEXT PRIMARY KEY,
  po_id    TEXT NOT NULL,
  item_key TEXT NOT NULL,
  sku      TEXT NOT NULL,
  tax      TEXT NOT NULL,
  name     TEXT NOT NULL,
  unit     TEXT NOT NULL,
  qty      REAL NOT NULL,
  received REAL NOT NULL DEFAULT 0,
  price    REAL NOT NULL DEFAULT 0,
  pos      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS po_lines_po ON po_lines (po_id);
CREATE TABLE IF NOT EXISTS customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  contact    TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  whatsapp   TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  address    TEXT NOT NULL DEFAULT '',
  npwp       TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- A sales invoice belongs to one ledger (PPN or Non-PPN). The number is given when it is issued;
-- customer details and totals are copied in at that moment so the issued document never changes.
CREATE TABLE IF NOT EXISTS invoices (
  id           TEXT PRIMARY KEY,
  number       TEXT UNIQUE,
  tax          TEXT NOT NULL CHECK (tax IN ('PPN','NON')),
  customer_id  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft','issued','void')),
  inv_date     TEXT NOT NULL,
  due_date     TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  nsfp         TEXT NOT NULL DEFAULT '',
  cust_name    TEXT NOT NULL DEFAULT '',
  cust_address TEXT NOT NULL DEFAULT '',
  cust_npwp    TEXT NOT NULL DEFAULT '',
  subtotal     REAL NOT NULL DEFAULT 0,
  dpp_lain     REAL NOT NULL DEFAULT 0,
  ppn          REAL NOT NULL DEFAULT 0,
  total        REAL NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL DEFAULT '',
  issued_by    TEXT NOT NULL DEFAULT '',
  issued_at    INTEGER,
  voided_at    INTEGER,
  void_reason  TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invoices_customer ON invoices (customer_id);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id         TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  item_key   TEXT NOT NULL,
  sku        TEXT NOT NULL,
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL,
  qty        REAL NOT NULL,
  price      REAL NOT NULL,
  disc_pct   REAL NOT NULL DEFAULT 0,
  pos        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invoice_lines_inv ON invoice_lines (invoice_id);
CREATE TABLE IF NOT EXISTS invoice_payments (
  id         TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  pay_date   TEXT NOT NULL,
  amount     REAL NOT NULL,
  method     TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invoice_payments_inv ON invoice_payments (invoice_id);
-- Payments to suppliers against purchase orders, in the order's currency, with the rate actually paid.
CREATE TABLE IF NOT EXISTS supplier_payments (
  id         TEXT PRIMARY KEY,
  po_id      TEXT NOT NULL,
  pay_date   TEXT NOT NULL,
  amount     REAL NOT NULL,
  currency   TEXT NOT NULL,
  fx         REAL NOT NULL,
  idr        REAL NOT NULL,
  method     TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS supplier_payments_po ON supplier_payments (po_id);
-- Running costs per entity, by the date they were paid. Salaries live in salary_payments, not here.
CREATE TABLE IF NOT EXISTS expenses (
  id          TEXT PRIMARY KEY,
  ledger      TEXT NOT NULL CHECK (ledger IN ('PPN','NON')),
  exp_date    TEXT NOT NULL,
  category    TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount      REAL NOT NULL,
  method      TEXT NOT NULL DEFAULT 'transfer',
  recurring   INTEGER NOT NULL DEFAULT 0,
  source_id   TEXT,
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS expenses_date ON expenses (exp_date);
-- Stock per product as last seen in each month; the last copy taken in a month is its closing stock.
CREATE TABLE IF NOT EXISTS stock_snapshots (
  ym         TEXT NOT NULL,
  key        TEXT NOT NULL,
  sku        TEXT NOT NULL,
  tax        TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  unit       TEXT NOT NULL DEFAULT 'PCS',
  qty        REAL NOT NULL,
  cost       REAL NOT NULL DEFAULT 0,
  sell_price REAL NOT NULL DEFAULT 0,
  taken_at   INTEGER NOT NULL,
  PRIMARY KEY (ym, key)
);
CREATE TABLE IF NOT EXISTS employees (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  position    TEXT NOT NULL DEFAULT '',
  ledger      TEXT NOT NULL CHECK (ledger IN ('PPN','NON')),
  phone       TEXT NOT NULL DEFAULT '',
  bank        TEXT NOT NULL DEFAULT '',
  start_date  TEXT NOT NULL DEFAULT '',
  base_salary REAL NOT NULL DEFAULT 0,
  allowance   REAL NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
-- One salary payment per employee per month. Amounts are copied in, so a later raise doesn't change history.
CREATE TABLE IF NOT EXISTS salary_payments (
  id          TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  period      TEXT NOT NULL,
  pay_date    TEXT NOT NULL,
  ledger      TEXT NOT NULL,
  name        TEXT NOT NULL,
  base        REAL NOT NULL DEFAULT 0,
  allowance   REAL NOT NULL DEFAULT 0,
  bonus       REAL NOT NULL DEFAULT 0,
  deduction   REAL NOT NULL DEFAULT 0,
  net         REAL NOT NULL,
  method      TEXT NOT NULL DEFAULT 'transfer',
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  UNIQUE (employee_id, period)
);
`;

/** Columns added after the first release; ALTER them into databases created before. */
const MIGRATIONS = [
  ["items", "supplier_id", "TEXT"],
  ["moves", "user_name", "TEXT NOT NULL DEFAULT ''"],
  ["items", "sell_price", "REAL NOT NULL DEFAULT 0"],
  ["items", "moq", "REAL NOT NULL DEFAULT 0"],
  ["items", "lot", "REAL NOT NULL DEFAULT 0"],
  ["items", "last_fob", "REAL NOT NULL DEFAULT 0"],
  ["items", "last_cur", "TEXT NOT NULL DEFAULT ''"],
  ["customers", "terms", "INTEGER"],
  ["customers", "internal", "INTEGER NOT NULL DEFAULT 0"],
  ["customers", "ledger", "TEXT NOT NULL DEFAULT ''"],
  ["suppliers", "currency", "TEXT NOT NULL DEFAULT 'IDR'"],
  ["suppliers", "terms", "INTEGER"],
  ["suppliers", "npwp", "TEXT NOT NULL DEFAULT ''"],
  ["suppliers", "address", "TEXT NOT NULL DEFAULT ''"],
  ["invoices", "terms", "INTEGER NOT NULL DEFAULT 0"],
  ["invoices", "transfer_to", "TEXT NOT NULL DEFAULT ''"],
  ["invoices", "internal", "INTEGER NOT NULL DEFAULT 0"],
  ["purchase_orders", "ledger", "TEXT NOT NULL DEFAULT ''"],
  ["purchase_orders", "order_date", "TEXT NOT NULL DEFAULT ''"],
  ["purchase_orders", "eta", "TEXT NOT NULL DEFAULT ''"],
  ["purchase_orders", "currency", "TEXT NOT NULL DEFAULT 'IDR'"],
  ["purchase_orders", "fx", "REAL NOT NULL DEFAULT 1"],
  ["purchase_orders", "freight", "REAL NOT NULL DEFAULT 0"],
  ["purchase_orders", "duty", "REAL NOT NULL DEFAULT 0"],
  ["purchase_orders", "other_cost", "REAL NOT NULL DEFAULT 0"],
];

/** Tables whose CHECK constraint was loosened later; rebuilt once, keeping every row. */
function relaxMovesType(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'moves'").get()?.sql || "";
  if (!/CHECK \(type IN/.test(sql)) return;
  tx(db, () => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('moves')").all().map((c) => c.name).join(", ");
    db.exec("ALTER TABLE moves RENAME TO moves_old");
    db.exec(`CREATE TABLE moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, key TEXT NOT NULL, sku TEXT NOT NULL, tax TEXT NOT NULL,
      type TEXT NOT NULL, qty REAL NOT NULL, note TEXT NOT NULL DEFAULT '', user_name TEXT NOT NULL DEFAULT '')`);
    db.exec(`INSERT INTO moves (${cols}) SELECT ${cols} FROM moves_old`);
    db.exec("DROP TABLE moves_old");
    db.exec("CREATE INDEX IF NOT EXISTS moves_t ON moves (t)");
  });
}

// Starter formulas that predate purchase orders: count stock already on order, so items on an open PO stop alerting.
// Only formulas still exactly as shipped are changed.
const RULE_UPGRADES = [
  ["hist_months > 0 and qty < reorder_point", "hist_months > 0 and qty + on_order < reorder_point"],
  ["min_stock > 0 and qty < min_stock", "min_stock > 0 and qty + on_order < min_stock"],
];

const DEFAULT_RULES = [
  { name: "Below safety stock", kind: "alert", scope: "ALL", severity: "crit", expr: "hist_months > 0 and qty <= safety_stock" },
  { name: "Reorder now", kind: "alert", scope: "ALL", severity: "warn", expr: "hist_months > 0 and qty + on_order < reorder_point" },
  { name: "Below min stock", kind: "alert", scope: "ALL", severity: "warn", expr: "min_stock > 0 and qty + on_order < min_stock" },
  { name: "Suggested order", kind: "column", scope: "ALL", severity: "warn", expr: "suggested_order" },
];

export function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  for (const [table, col, type] of MIGRATIONS) {
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  for (const [from, to] of RULE_UPGRADES) db.prepare("UPDATE rules SET expr = ? WHERE expr = ?").run(to, from);
  relaxMovesType(db);
  // Purchase orders from before ledgers existed: take the ledger of their first line.
  db.exec(`UPDATE purchase_orders SET ledger = COALESCE((SELECT tax FROM po_lines WHERE po_id = purchase_orders.id ORDER BY pos LIMIT 1), 'PPN') WHERE ledger = ''`);
  db.exec(`UPDATE purchase_orders SET order_date = date(created_at / 1000, 'unixepoch', 'localtime') WHERE order_date = ''`);
  // First run: write default settings and a starter set of formulas.
  if (!db.prepare("SELECT 1 FROM settings WHERE id = 1").get()) {
    tx(db, () => {
      db.prepare("INSERT INTO settings (id, json) VALUES (1, ?)").run(JSON.stringify(DEFAULT_SETTINGS));
      const ins = db.prepare("INSERT INTO rules (id, name, kind, scope, severity, expr, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)");
      const now = Date.now();
      DEFAULT_RULES.forEach((r, i) => ins.run(randomUUID(), r.name, r.kind, r.scope, r.severity, r.expr, now + i, now + i));
    });
  }
  return db;
}

/** Run fn inside a transaction; roll back if it throws. */
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
