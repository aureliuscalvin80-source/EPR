import express from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb, tx } from "./db.js";
import { HttpError } from "./http.js";
import { applyReports } from "./reports.js";
import { parse } from "../public/js/formula.js";
import { DEFAULT_SETTINGS } from "../public/js/stock.js";
import { keyOf } from "../public/js/util.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const XLSX_DIST = path.join(ROOT, "node_modules", "xlsx", "dist");
const MAX_UPLOAD = 15 * 1024 * 1024;
const MOVE_DAYS = 31;

// ---------- input validation ----------
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);
function numIn(v, label, { min = -Infinity } = {}) {
  const n = v === "" || v == null ? 0 : Number(v);
  if (!Number.isFinite(n) || n < min) throw new HttpError(400, `${label} must be a number${min === 0 ? " of 0 or more" : ""}.`);
  return n;
}
const oneOf = (v, allowed, label) => {
  if (!allowed.includes(v)) throw new HttpError(400, `${label} must be one of ${allowed.join(", ")}.`);
  return v;
};
function itemFields(b) {
  return {
    name: str(b.name),
    unit: oneOf(b.unit ?? "PCS", ["PCS", "SET"], "Unit"),
    qty: numIn(b.qty, "Quantity"),
    price: numIn(b.price, "Price", { min: 0 }),
    minStock: numIn(b.minStock, "Min stock", { min: 0 }),
  };
}
function ruleFields(b) {
  const r = {
    name: str(b.name, 120),
    kind: oneOf(b.kind, ["alert", "column"], "Type"),
    scope: oneOf(b.scope ?? "ALL", ["ALL", "PPN", "NON"], "Applies to"),
    severity: oneOf(b.severity ?? "warn", ["warn", "crit"], "Severity"),
    expr: str(b.expr, 2000),
  };
  if (!r.name) throw new HttpError(400, "Give the formula a name.");
  try {
    parse(r.expr);
  } catch (e) {
    throw new HttpError(400, "Formula error: " + e.message);
  }
  return r;
}

// ---------- row → API shape ----------
const itemOut = (r) => ({ key: r.key, sku: r.sku, tax: r.tax, name: r.name, unit: r.unit, qty: r.qty, price: r.price, minStock: r.min_stock, updatedAt: r.updated_at });
const ruleOut = (r) => ({ id: r.id, name: r.name, kind: r.kind, scope: r.scope, severity: r.severity, expr: r.expr, enabled: !!r.enabled, createdAt: r.created_at });
const histOut = (r) => ({ id: r.id, fileId: r.file_id, file: r.file, kind: r.kind, tax: r.tax, ym: r.ym, check: r.status, msg: r.msg, lines: r.lines, skus: r.skus, qty: r.qty, rp: r.rp, otherUnits: r.other_units });

export function createApp({ dataDir }) {
  const uploadDir = path.join(dataDir, "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });
  const db = openDb(path.join(dataDir, "erp.sqlite"));
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  // ---------- live updates (Server-Sent Events) ----------
  const clients = new Set();
  const changed = () => {
    for (const c of clients) c.write("event: change\ndata: {}\n\n");
  };
  app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    res.write("retry: 3000\n\n");
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  const json = express.json({ limit: "50mb" });
  const write = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      changed();
      res.json(out ?? { ok: true });
    } catch (e) {
      next(e);
    }
  };

  // ---------- state ----------
  app.get("/api/state", (req, res) => {
    const items = {};
    for (const r of db.prepare("SELECT * FROM items").all()) items[r.key] = itemOut(r);
    const dem = {};
    for (const r of db.prepare("SELECT * FROM demand").all()) {
      const d = (dem[keyOf(r.tax, r.sku)] ??= { m: {}, s: {} });
      d.m[r.ym] = r.pcs;
      if (r.sets) d.m[r.ym + "S"] = r.sets;
    }
    for (const r of db.prepare("SELECT * FROM stock_seen").all()) (dem[keyOf(r.tax, r.sku)] ??= { m: {}, s: {} }).s[r.ym] = 1;
    const files = db.prepare("SELECT * FROM files ORDER BY at DESC").all().map((f) => ({ ...f }));
    res.json({
      items,
      dem,
      rules: db.prepare("SELECT * FROM rules ORDER BY created_at").all().map(ruleOut),
      files,
      history: db.prepare("SELECT * FROM history").all().map(histOut),
      moves: db.prepare("SELECT * FROM moves WHERE t >= ? ORDER BY t DESC").all(Date.now() - MOVE_DAYS * 864e5).map((m) => ({ ...m })),
      settings: { ...DEFAULT_SETTINGS, ...JSON.parse(db.prepare("SELECT json FROM settings WHERE id = 1").get().json) },
      usage: { bytes: files.reduce((a, f) => a + f.size, 0) },
    });
  });

  // ---------- items ----------
  const getItem = (key) => {
    const r = db.prepare("SELECT * FROM items WHERE key = ?").get(key);
    if (!r) throw new HttpError(404, "This product no longer exists.");
    return r;
  };
  const addMove = (it, type, qty, note, t = Date.now()) =>
    db.prepare("INSERT INTO moves (t, key, sku, tax, type, qty, note) VALUES (?, ?, ?, ?, ?, ?, ?)").run(t, it.key, it.sku, it.tax, type, qty, note);

  app.post("/api/items", json, write((req) => {
    const sku = str(req.body.sku, 100);
    const tax = oneOf(req.body.tax, ["PPN", "NON"], "Ledger");
    if (!sku) throw new HttpError(400, "SKU is required.");
    if (sku.includes("~")) throw new HttpError(400, "SKU cannot contain ~");
    const f = itemFields(req.body);
    if (!f.name) throw new HttpError(400, "Product name is required.");
    const key = keyOf(tax, sku);
    if (db.prepare("SELECT 1 FROM items WHERE key = ?").get(key))
      throw new HttpError(409, `${sku} already exists in the ${tax === "PPN" ? "PPN" : "Non-PPN"} ledger. Edit that one instead.`);
    db.prepare("INSERT INTO items (key, sku, tax, name, unit, qty, price, min_stock, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(key, sku, tax, f.name, f.unit, f.qty, f.price, f.minStock, Date.now());
    return { key };
  }));

  app.put("/api/items/:key", json, write((req) => {
    const f = itemFields(req.body);
    if (!f.name) throw new HttpError(400, "Product name is required.");
    tx(db, () => {
      const prev = getItem(req.params.key);
      db.prepare("UPDATE items SET name = ?, unit = ?, qty = ?, price = ?, min_stock = ?, updated_at = ? WHERE key = ?")
        .run(f.name, f.unit, f.qty, f.price, f.minStock, Date.now(), prev.key);
      if (prev.qty !== f.qty) addMove(prev, "ADJ", f.qty - prev.qty, "Edited in product form");
    });
  }));

  app.delete("/api/items/:key", write((req) => {
    if (!db.prepare("DELETE FROM items WHERE key = ?").run(req.params.key).changes) throw new HttpError(404, "This product no longer exists.");
  }));

  app.post("/api/items/import", json, write((req) => {
    const rows = req.body.rows;
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, "No rows to import.");
    const now = Date.now();
    const up = db.prepare(`INSERT INTO items (key, sku, tax, name, unit, qty, price, min_stock, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET name = excluded.name, unit = excluded.unit, qty = excluded.qty, price = excluded.price,
        min_stock = excluded.min_stock, updated_at = excluded.updated_at`);
    let n = 0;
    tx(db, () => {
      for (const r of rows) {
        const sku = str(r.sku, 100);
        if (!sku || sku.includes("~")) continue;
        const tax = oneOf(r.tax, ["PPN", "NON"], "Ledger");
        const f = itemFields(r);
        up.run(keyOf(tax, sku), sku, tax, f.name, f.unit, f.qty, f.price, f.minStock, now);
        n++;
      }
    });
    return { imported: n };
  }));

  app.post("/api/items/remove-demo", write(() => {
    return tx(db, () => {
      const removed = db.prepare("DELETE FROM items WHERE sku LIKE 'DEMO-%'").run().changes;
      db.prepare("DELETE FROM moves WHERE sku LIKE 'DEMO-%'").run();
      return { removed };
    });
  }));

  // ---------- stock moves ----------
  app.post("/api/moves", json, write((req) => {
    const type = oneOf(req.body.type, ["IN", "OUT", "ADJ"], "Type");
    const q = numIn(req.body.qty, "Quantity", { min: 0 });
    // Read and write in one transaction so two people booking at once can't lose a movement.
    return tx(db, () => {
      const it = getItem(str(req.body.key, 200));
      const next = type === "IN" ? it.qty + q : type === "OUT" ? it.qty - q : q;
      if (next < 0) throw new HttpError(409, `Only ${it.qty} ${it.unit} on hand. OUT would go negative.`);
      db.prepare("UPDATE items SET qty = ?, updated_at = ? WHERE key = ?").run(next, Date.now(), it.key);
      addMove(it, type, next - it.qty, str(req.body.note));
      return { sku: it.sku, unit: it.unit, from: it.qty, to: next };
    });
  }));

  // ---------- formulas ----------
  app.post("/api/rules", json, write((req) => {
    const r = ruleFields(req.body);
    const id = randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO rules (id, name, kind, scope, severity, expr, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .run(id, r.name, r.kind, r.scope, r.severity, r.expr, now, now);
    return { id };
  }));
  app.put("/api/rules/:id", json, write((req) => {
    const r = ruleFields(req.body);
    const res = db.prepare("UPDATE rules SET name = ?, kind = ?, scope = ?, severity = ?, expr = ?, updated_at = ? WHERE id = ?")
      .run(r.name, r.kind, r.scope, r.severity, r.expr, Date.now(), req.params.id);
    if (!res.changes) throw new HttpError(404, "This formula no longer exists.");
  }));
  app.patch("/api/rules/:id", json, write((req) => {
    db.prepare("UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?").run(req.body.enabled ? 1 : 0, Date.now(), req.params.id);
  }));
  app.delete("/api/rules/:id", write((req) => {
    db.prepare("DELETE FROM rules WHERE id = ?").run(req.params.id);
  }));

  // ---------- settings ----------
  app.put("/api/settings", json, write((req) => {
    const b = req.body;
    const s = {
      ppnRate: numIn(b.ppnRate, "PPN rate", { min: 0 }),
      leadTime: numIn(b.leadTime, "Lead time", { min: 0 }),
      priceMode: oneOf(b.priceMode, ["excl", "incl"], "Price mode"),
      reviewDays: numIn(b.reviewDays, "Stock check interval", { min: 0 }),
      serviceLevel: Math.min(99.9, Math.max(50, Number(b.serviceLevel) || 95)),
      windowMonths: Math.min(60, Math.max(3, Math.round(Number(b.windowMonths) || 12))),
    };
    db.prepare("UPDATE settings SET json = ? WHERE id = 1").run(JSON.stringify(s));
    return s;
  }));

  // ---------- files ----------
  const filePath = (id) => path.join(uploadDir, id);
  const getFile = (id) => {
    const f = db.prepare("SELECT * FROM files WHERE id = ?").get(id);
    if (!f) throw new HttpError(404, "This file no longer exists.");
    return f;
  };
  app.post("/api/files", express.raw({ type: () => true, limit: MAX_UPLOAD }), write((req) => {
    const q = req.query;
    const name = str(q.name, 255);
    if (!name) throw new HttpError(400, "File name is missing.");
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, "The file is empty.");
    const kind = oneOf(q.kind ?? "attach", ["attach", "sales", "stock", "workbook"], "Use as");
    const id = randomUUID();
    fs.writeFileSync(filePath(id), req.body);
    db.prepare("INSERT INTO files (id, name, size, sku, note, at, kind, tax, ym) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, name, req.body.length, str(q.sku, 100), str(q.note), Date.now(), kind,
        kind === "sales" || kind === "stock" ? oneOf(q.tax, ["PPN", "NON"], "Ledger") : "", kind === "attach" ? "" : str(q.ym, 7));
    return { id };
  }));
  app.get("/api/files/:id/raw", (req, res, next) => {
    try {
      const f = getFile(req.params.id);
      res.download(filePath(f.id), f.name);
    } catch (e) {
      next(e);
    }
  });
  app.delete("/api/files/:id", write((req) => {
    const f = getFile(req.params.id);
    tx(db, () => {
      db.prepare("DELETE FROM history WHERE file_id = ?").run(f.id);
      db.prepare("DELETE FROM files WHERE id = ?").run(f.id);
    });
    fs.rmSync(filePath(f.id), { force: true });
  }));

  // ---------- reports ----------
  app.post("/api/reports", json, write((req) => ({ message: applyReports(db, req.body.results, !!req.body.setStock) })));

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
  // SheetJS is served locally so spreadsheets can be read without internet access.
  app.use("/vendor/xlsx", express.static(XLSX_DIST));
  app.use(express.static(PUBLIC_DIR));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "File is over 15 MB." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server. Try again." });
  });

  app.locals.close = () => {
    for (const c of clients) c.end();
    db.close();
  };
  return app;
}
