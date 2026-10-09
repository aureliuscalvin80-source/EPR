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
`;

/** Columns added after the first release; ALTER them into databases created before. */
const MIGRATIONS = [["items", "supplier_id", "TEXT"]];

const DEFAULT_RULES = [
  { name: "Below safety stock", kind: "alert", scope: "ALL", severity: "crit", expr: "hist_months > 0 and qty <= safety_stock" },
  { name: "Reorder now", kind: "alert", scope: "ALL", severity: "warn", expr: "hist_months > 0 and qty < reorder_point" },
  { name: "Below min stock", kind: "alert", scope: "ALL", severity: "warn", expr: "min_stock > 0 and qty < min_stock" },
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
