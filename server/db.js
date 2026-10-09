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
  type TEXT NOT NULL CHECK (type IN ('IN','OUT','ADJ')),
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
`;

/** Columns added after the first release; ALTER them into databases created before. */
const MIGRATIONS = [
  ["items", "supplier_id", "TEXT"],
  ["moves", "user_name", "TEXT NOT NULL DEFAULT ''"],
];

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
