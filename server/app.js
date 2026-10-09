import express from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb, tx } from "./db.js";
import { HttpError } from "./http.js";
import { applyReports } from "./reports.js";
import { createAuth, makeSetupCode } from "./auth.js";
import { createPurchasing, listPos, supplierHasPos } from "./purchasing.js";
import { str, numIn, oneOf, itemFields, ruleFields, supplierFields } from "./validate.js";
import { DEFAULT_SETTINGS } from "../public/js/stock.js";
import { keyOf } from "../public/js/util.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const XLSX_DIST = path.join(ROOT, "node_modules", "xlsx", "dist");
const MAX_UPLOAD = 15 * 1024 * 1024;
const MOVE_DAYS = 31;

// ---------- row → API shape ----------
const itemOut = (r) => ({ key: r.key, sku: r.sku, tax: r.tax, name: r.name, unit: r.unit, qty: r.qty, price: r.price, minStock: r.min_stock, supplierId: r.supplier_id || "", updatedAt: r.updated_at });
const supplierOut = (r) => ({ id: r.id, company: r.company, contact: r.contact, wechat: r.wechat, whatsapp: r.whatsapp, email: r.email, phone: r.phone, preferred: r.preferred, notes: r.notes });
const ruleOut = (r) => ({ id: r.id, name: r.name, kind: r.kind, scope: r.scope, severity: r.severity, expr: r.expr, enabled: !!r.enabled, createdAt: r.created_at });
const histOut = (r) => ({ id: r.id, fileId: r.file_id, file: r.file, kind: r.kind, tax: r.tax, ym: r.ym, check: r.status, msg: r.msg, lines: r.lines, skus: r.skus, qty: r.qty, rp: r.rp, otherUnits: r.other_units });

export function createApp({ dataDir, setupCode = makeSetupCode(), secureCookies = false }) {
  const uploadDir = path.join(dataDir, "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });
  const db = openDb(path.join(dataDir, "erp.sqlite"));
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
    next();
  });

  // ---------- live updates (Server-Sent Events) ----------
  const clients = new Set(); // { res, userId, sid }
  const changed = () => {
    for (const c of clients) c.res.write("event: change\ndata: {}\n\n");
  };
  // A signed-out or switched-off user stops receiving live data at once.
  const onUserRevoked = (userId, exceptSid) => {
    for (const c of clients) if (c.userId === userId && c.sid !== exceptSid) { c.res.end(); clients.delete(c); }
  };

  // ---------- sign-in ----------
  const auth = createAuth(db, { setupCode, secureCookies, onUserRevoked });
  const { need } = auth;
  // Writes must carry this header. Browsers won't add it to a request from another site without
  // asking this server first (CORS), which it never allows, so other pages can't act as a signed-in user.
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.get("X-Requested-With") === "erp") return next();
    res.status(403).json({ error: "Request blocked. Reload the page and try again." });
  });
  app.use("/api/auth", auth.pub);
  app.use("/api", auth.authenticate);
  app.use("/api", auth.priv);

  app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    res.write("retry: 3000\n\n");
    const c = { res, userId: req.user.id, sid: req.sessionId };
    clients.add(c);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(c);
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
      suppliers: db.prepare("SELECT * FROM suppliers ORDER BY company COLLATE NOCASE").all().map(supplierOut),
      pos: listPos(db),
      files,
      history: db.prepare("SELECT * FROM history").all().map(histOut),
      moves: db.prepare("SELECT * FROM moves WHERE t >= ? ORDER BY t DESC").all(Date.now() - MOVE_DAYS * 864e5)
        .map((m) => ({ id: m.id, t: m.t, key: m.key, sku: m.sku, tax: m.tax, type: m.type, qty: m.qty, note: m.note, by: m.user_name })),
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
  const supplierIdIn = (v) => {
    const id = str(v, 100);
    if (id && !db.prepare("SELECT 1 FROM suppliers WHERE id = ?").get(id)) throw new HttpError(400, "That supplier no longer exists.");
    return id || null;
  };
  const addMove = (it, type, qty, note, user) =>
    db.prepare("INSERT INTO moves (t, key, sku, tax, type, qty, note, user_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), it.key, it.sku, it.tax, type, qty, note, user?.name || "");

  app.post("/api/items", need("staff"), json, write((req) => {
    const sku = str(req.body.sku, 100);
    const tax = oneOf(req.body.tax, ["PPN", "NON"], "Ledger");
    if (!sku) throw new HttpError(400, "SKU is required.");
    if (sku.includes("~")) throw new HttpError(400, "SKU cannot contain ~");
    const f = itemFields(req.body);
    if (!f.name) throw new HttpError(400, "Product name is required.");
    const key = keyOf(tax, sku);
    if (db.prepare("SELECT 1 FROM items WHERE key = ?").get(key))
      throw new HttpError(409, `${sku} already exists in the ${tax === "PPN" ? "PPN" : "Non-PPN"} ledger. Edit that one instead.`);
    db.prepare("INSERT INTO items (key, sku, tax, name, unit, qty, price, min_stock, supplier_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(key, sku, tax, f.name, f.unit, f.qty, f.price, f.minStock, supplierIdIn(req.body.supplierId), Date.now());
    return { key };
  }));

  app.put("/api/items/:key", need("staff"), json, write((req) => {
    const f = itemFields(req.body);
    if (!f.name) throw new HttpError(400, "Product name is required.");
    const supplierId = supplierIdIn(req.body.supplierId);
    tx(db, () => {
      const prev = getItem(req.params.key);
      db.prepare("UPDATE items SET name = ?, unit = ?, qty = ?, price = ?, min_stock = ?, supplier_id = ?, updated_at = ? WHERE key = ?")
        .run(f.name, f.unit, f.qty, f.price, f.minStock, supplierId, Date.now(), prev.key);
      if (prev.qty !== f.qty) addMove(prev, "ADJ", f.qty - prev.qty, "Edited in product form", req.user);
    });
  }));

  app.delete("/api/items/:key", need("admin"), write((req) => {
    if (!db.prepare("DELETE FROM items WHERE key = ?").run(req.params.key).changes) throw new HttpError(404, "This product no longer exists.");
  }));

  app.post("/api/items/import", need("staff"), json, write((req) => {
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

  app.post("/api/items/remove-demo", need("admin"), write(() => {
    return tx(db, () => {
      const removed = db.prepare("DELETE FROM items WHERE sku LIKE 'DEMO-%'").run().changes;
      db.prepare("DELETE FROM moves WHERE sku LIKE 'DEMO-%'").run();
      const demoSuppliers = "SELECT id FROM suppliers WHERE company LIKE '[Demo]%'";
      db.prepare(`DELETE FROM po_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE supplier_id IN (${demoSuppliers}))`).run();
      db.prepare(`DELETE FROM purchase_orders WHERE supplier_id IN (${demoSuppliers})`).run();
      db.prepare(`UPDATE items SET supplier_id = NULL WHERE supplier_id IN (${demoSuppliers})`).run();
      db.prepare(`DELETE FROM suppliers WHERE id IN (${demoSuppliers})`).run();
      return { removed };
    });
  }));

  // ---------- stock moves ----------
  app.post("/api/moves", need("staff"), json, write((req) => {
    const type = oneOf(req.body.type, ["IN", "OUT", "ADJ"], "Type");
    const q = numIn(req.body.qty, "Quantity", { min: 0 });
    // Read and write in one transaction so two people booking at once can't lose a movement.
    return tx(db, () => {
      const it = getItem(str(req.body.key, 200));
      const next = type === "IN" ? it.qty + q : type === "OUT" ? it.qty - q : q;
      if (next < 0) throw new HttpError(409, `Only ${it.qty} ${it.unit} on hand. OUT would go negative.`);
      db.prepare("UPDATE items SET qty = ?, updated_at = ? WHERE key = ?").run(next, Date.now(), it.key);
      addMove(it, type, next - it.qty, str(req.body.note), req.user);
      return { sku: it.sku, unit: it.unit, from: it.qty, to: next };
    });
  }));

  // Assign (or clear) the supplier of one product without touching anything else.
  app.put("/api/items/:key/supplier", need("staff"), json, write((req) => {
    const supplierId = supplierIdIn(req.body.supplierId);
    if (!db.prepare("UPDATE items SET supplier_id = ?, updated_at = ? WHERE key = ?").run(supplierId, Date.now(), req.params.key).changes)
      throw new HttpError(404, "This product no longer exists.");
  }));

  // ---------- suppliers ----------
  app.post("/api/suppliers", need("staff"), json, write((req) => {
    const f = supplierFields(req.body);
    const id = randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO suppliers (id, company, contact, wechat, whatsapp, email, phone, preferred, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, f.company, f.contact, f.wechat, f.whatsapp, f.email, f.phone, f.preferred, f.notes, now, now);
    return { id };
  }));
  app.put("/api/suppliers/:id", need("staff"), json, write((req) => {
    const f = supplierFields(req.body);
    const res = db.prepare("UPDATE suppliers SET company = ?, contact = ?, wechat = ?, whatsapp = ?, email = ?, phone = ?, preferred = ?, notes = ?, updated_at = ? WHERE id = ?")
      .run(f.company, f.contact, f.wechat, f.whatsapp, f.email, f.phone, f.preferred, f.notes, Date.now(), req.params.id);
    if (!res.changes) throw new HttpError(404, "This supplier no longer exists.");
  }));
  app.delete("/api/suppliers/:id", need("admin"), write((req) => {
    return tx(db, () => {
      if (supplierHasPos(db, req.params.id)) throw new HttpError(409, "This supplier has purchase orders, so it can't be deleted. Its orders would lose their supplier.");
      const unassigned = db.prepare("UPDATE items SET supplier_id = NULL WHERE supplier_id = ?").run(req.params.id).changes;
      if (!db.prepare("DELETE FROM suppliers WHERE id = ?").run(req.params.id).changes) throw new HttpError(404, "This supplier no longer exists.");
      return { unassigned };
    });
  }));

  // ---------- formulas ----------
  app.post("/api/rules", need("admin"), json, write((req) => {
    const r = ruleFields(req.body);
    const id = randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO rules (id, name, kind, scope, severity, expr, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .run(id, r.name, r.kind, r.scope, r.severity, r.expr, now, now);
    return { id };
  }));
  app.put("/api/rules/:id", need("admin"), json, write((req) => {
    const r = ruleFields(req.body);
    const res = db.prepare("UPDATE rules SET name = ?, kind = ?, scope = ?, severity = ?, expr = ?, updated_at = ? WHERE id = ?")
      .run(r.name, r.kind, r.scope, r.severity, r.expr, Date.now(), req.params.id);
    if (!res.changes) throw new HttpError(404, "This formula no longer exists.");
  }));
  app.patch("/api/rules/:id", need("admin"), json, write((req) => {
    db.prepare("UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?").run(req.body.enabled ? 1 : 0, Date.now(), req.params.id);
  }));
  app.delete("/api/rules/:id", need("admin"), write((req) => {
    db.prepare("DELETE FROM rules WHERE id = ?").run(req.params.id);
  }));

  // ---------- settings ----------
  app.put("/api/settings", need("admin"), json, write((req) => {
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
  app.post("/api/files", need("staff"), express.raw({ type: () => true, limit: MAX_UPLOAD }), write((req) => {
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
  app.delete("/api/files/:id", need("admin"), write((req) => {
    const f = getFile(req.params.id);
    tx(db, () => {
      db.prepare("DELETE FROM history WHERE file_id = ?").run(f.id);
      db.prepare("DELETE FROM files WHERE id = ?").run(f.id);
    });
    fs.rmSync(filePath(f.id), { force: true });
  }));

  // ---------- purchase orders ----------
  app.use("/api/pos", createPurchasing(db, { need, write, addMove }));

  // ---------- reports ----------
  app.post("/api/reports", need("staff"), json, write((req) => ({ message: applyReports(db, req.body.results, !!req.body.setStock) })));

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

  app.locals.setupCode = setupCode;
  app.locals.needsSetup = () => auth.userCount() === 0;
  app.locals.close = () => {
    for (const c of clients) c.res.end();
    db.close();
  };
  return app;
}
