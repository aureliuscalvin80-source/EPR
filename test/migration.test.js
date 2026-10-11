import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../server/db.js";

test("databases from before suppliers get the supplier_id column and keep their data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-mig-"));
  const file = path.join(dir, "erp.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE items (key TEXT PRIMARY KEY, sku TEXT NOT NULL, tax TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'PCS',
    qty REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, min_stock REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    INSERT INTO items VALUES ('PPN~A', 'A', 'PPN', 'Alpha', 'PCS', 5, 100, 0, 1);`);
  old.close();
  const db = openDb(file);
  const row = db.prepare("SELECT * FROM items WHERE key = 'PPN~A'").get();
  assert.equal(row.qty, 5);
  assert.equal(row.supplier_id, null);
  db.close();
  openDb(file).close(); // running the migration twice is harmless
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the old moves table (IN/OUT/ADJ only) is rebuilt so sales and transfers can be recorded, keeping its rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-mig-"));
  const file = path.join(dir, "erp.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE moves (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, key TEXT NOT NULL, sku TEXT NOT NULL, tax TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('IN','OUT','ADJ')), qty REAL NOT NULL, note TEXT NOT NULL DEFAULT '');
    INSERT INTO moves (t, key, sku, tax, type, qty, note) VALUES (1, 'PPN~A', 'A', 'PPN', 'IN', 3, 'old');`);
  old.close();
  const db = openDb(file);
  db.prepare("INSERT INTO moves (t, key, sku, tax, type, qty, note) VALUES (2, 'PPN~A', 'A', 'PPN', 'SALE', -1, 'new')").run();
  assert.deepEqual(db.prepare("SELECT type, user_name FROM moves ORDER BY t").all().map((r) => [r.type, r.user_name]), [["IN", ""], ["SALE", ""]]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
