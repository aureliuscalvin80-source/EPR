// Purchase orders: draft → sent → partial → received, or closed (short) / cancelled.
// Receiving adds the stock and records an IN move in the same transaction.

import express from "express";
import { randomUUID } from "node:crypto";
import { tx } from "./db.js";
import { HttpError } from "./http.js";
import { str, numIn, oneOf, CHANNELS } from "./validate.js";

const CLOSED_DAYS = 180;

const lineOut = (l) => ({ id: l.id, itemKey: l.item_key, sku: l.sku, tax: l.tax, name: l.name, unit: l.unit, qty: l.qty, received: l.received, price: l.price });
const poOut = (p, lines) => ({
  id: p.id, number: p.number, supplierId: p.supplier_id, status: p.status, note: p.note, createdBy: p.created_by,
  createdAt: p.created_at, sentAt: p.sent_at, sentVia: p.sent_via, closedAt: p.closed_at, lines: lines.map(lineOut),
});

/** Open orders, plus finished ones from the last 180 days. */
export function listPos(db) {
  const pos = db.prepare(`SELECT * FROM purchase_orders WHERE status IN ('draft','sent','partial') OR COALESCE(closed_at, updated_at) >= ?
    ORDER BY created_at DESC`).all(Date.now() - CLOSED_DAYS * 864e5);
  const lines = db.prepare("SELECT * FROM po_lines WHERE po_id IN (SELECT value FROM json_each(?)) ORDER BY pos").all(JSON.stringify(pos.map((p) => p.id)));
  const by = new Map();
  for (const l of lines) (by.get(l.po_id) || by.set(l.po_id, []).get(l.po_id)).push(l);
  return pos.map((p) => poOut(p, by.get(p.id) || []));
}

export function createPurchasing(db, { need, write, addMove }) {
  const r = express.Router();
  const json = express.json({ limit: "1mb" });

  const getPo = (id) => {
    const p = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(id);
    if (!p) throw new HttpError(404, "This purchase order no longer exists.");
    return p;
  };
  const mustBe = (p, statuses, action) => {
    if (!statuses.includes(p.status)) throw new HttpError(409, `${p.number} is ${p.status}; it can't be ${action}.`);
  };
  const supplierIn = (id) => {
    const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(str(id, 100));
    if (!s) throw new HttpError(400, "Choose a supplier for this order.");
    return s;
  };
  function nextNumber() {
    const y = new Date().getFullYear();
    const last = db.prepare("SELECT number FROM purchase_orders WHERE number LIKE ? ORDER BY number DESC LIMIT 1").get(`PO-${y}-%`);
    const n = last ? Number(last.number.split("-")[2]) + 1 : 1;
    return `PO-${y}-${String(n).padStart(4, "0")}`;
  }
  function newDraft(supplierId, user, note = "") {
    const id = randomUUID();
    const now = Date.now();
    const number = nextNumber();
    db.prepare("INSERT INTO purchase_orders (id, number, supplier_id, status, note, created_by, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)")
      .run(id, number, supplierId, note, user.name, now, now);
    return { id, number };
  }
  const itemIn = (key) => {
    const it = db.prepare("SELECT * FROM items WHERE key = ?").get(str(key, 200));
    if (!it) throw new HttpError(404, "This product no longer exists.");
    return it;
  };
  const touch = (id) => db.prepare("UPDATE purchase_orders SET updated_at = ? WHERE id = ?").run(Date.now(), id);

  // New empty draft.
  r.post("/", need("staff"), json, write((req) => tx(db, () => newDraft(supplierIn(req.body.supplierId).id, req.user, str(req.body.note, 2000)))));

  // Add a product to the supplier's open draft (creating one if there is none). Same product twice adds up.
  r.post("/add-line", need("staff"), json, write((req) => tx(db, () => {
    const it = itemIn(req.body.itemKey);
    const qty = numIn(req.body.qty, "Order quantity", { min: 0 });
    if (!(qty > 0)) throw new HttpError(400, "Order quantity must be more than 0.");
    const sup = supplierIn(req.body.supplierId || it.supplier_id);
    let po = db.prepare("SELECT id, number FROM purchase_orders WHERE supplier_id = ? AND status = 'draft' ORDER BY created_at LIMIT 1").get(sup.id);
    const created = !po;
    if (!po) po = newDraft(sup.id, req.user);
    const ex = db.prepare("SELECT id FROM po_lines WHERE po_id = ? AND item_key = ?").get(po.id, it.key);
    if (ex) db.prepare("UPDATE po_lines SET qty = qty + ? WHERE id = ?").run(qty, ex.id);
    else {
      const pos = db.prepare("SELECT COALESCE(MAX(pos), -1) + 1 AS p FROM po_lines WHERE po_id = ?").get(po.id).p;
      db.prepare("INSERT INTO po_lines (id, po_id, item_key, sku, tax, name, unit, qty, received, price, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)")
        .run(randomUUID(), po.id, it.key, it.sku, it.tax, it.name, it.unit, qty, it.price, pos);
    }
    touch(po.id);
    return { id: po.id, number: po.number, created, merged: !!ex };
  })));

  // Edit a draft: note and the full list of lines.
  r.put("/:id", need("staff"), json, write((req) => tx(db, () => {
    const p = getPo(req.params.id);
    mustBe(p, ["draft"], "edited");
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    db.prepare("DELETE FROM po_lines WHERE po_id = ?").run(p.id);
    const ins = db.prepare("INSERT INTO po_lines (id, po_id, item_key, sku, tax, name, unit, qty, received, price, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)");
    const seen = new Set();
    lines.forEach((l, i) => {
      const it = itemIn(l.itemKey);
      if (seen.has(it.key)) throw new HttpError(400, `${it.sku} is on this order twice. Combine the quantities into one line.`);
      seen.add(it.key);
      const qty = numIn(l.qty, `Quantity for ${it.sku}`, { min: 0 });
      if (!(qty > 0)) throw new HttpError(400, `Quantity for ${it.sku} must be more than 0.`);
      ins.run(randomUUID(), p.id, it.key, it.sku, it.tax, it.name, it.unit, qty, numIn(l.price, `Price for ${it.sku}`, { min: 0 }), i);
    });
    db.prepare("UPDATE purchase_orders SET note = ?, updated_at = ? WHERE id = ?").run(str(req.body.note ?? p.note, 2000), Date.now(), p.id);
  })));

  r.delete("/:id", need("staff"), write((req) => tx(db, () => {
    const p = getPo(req.params.id);
    mustBe(p, ["draft"], "deleted (cancel it instead)");
    db.prepare("DELETE FROM po_lines WHERE po_id = ?").run(p.id);
    db.prepare("DELETE FROM purchase_orders WHERE id = ?").run(p.id);
  })));

  r.post("/:id/send", need("staff"), json, write((req) => tx(db, () => {
    const p = getPo(req.params.id);
    mustBe(p, ["draft"], "sent");
    if (!db.prepare("SELECT COUNT(*) AS n FROM po_lines WHERE po_id = ?").get(p.id).n) throw new HttpError(400, "Add at least one product before sending.");
    const via = oneOf(req.body.via ?? "other", [...CHANNELS, "other"], "Sent via");
    db.prepare("UPDATE purchase_orders SET status = 'sent', sent_at = ?, sent_via = ?, updated_at = ? WHERE id = ?").run(Date.now(), via, Date.now(), p.id);
  })));

  // Book goods received against the order's lines.
  r.post("/:id/receive", need("staff"), json, write((req) => tx(db, () => {
    const p = getPo(req.params.id);
    mustBe(p, ["sent", "partial"], "received");
    const lines = new Map(db.prepare("SELECT * FROM po_lines WHERE po_id = ?").all(p.id).map((l) => [l.id, l]));
    let booked = 0;
    for (const x of Array.isArray(req.body.lines) ? req.body.lines : []) {
      const l = lines.get(String(x.id));
      if (!l) throw new HttpError(400, "A line on this receipt is not on the order.");
      const q = numIn(x.qty, `Received quantity for ${l.sku}`, { min: 0 });
      if (!q) continue;
      const remaining = l.qty - l.received;
      if (q > remaining + 1e-9) throw new HttpError(400, `${l.sku}: only ${remaining} ${l.unit} still to come on ${p.number}. Book any extra as a stock move.`);
      const it = db.prepare("SELECT * FROM items WHERE key = ?").get(l.item_key);
      if (!it) throw new HttpError(409, `${l.sku} has been deleted from the inventory. Re-create it before receiving.`);
      db.prepare("UPDATE items SET qty = qty + ?, updated_at = ? WHERE key = ?").run(q, Date.now(), it.key);
      addMove(it, "IN", q, `Received ${p.number}`, req.user);
      db.prepare("UPDATE po_lines SET received = received + ? WHERE id = ?").run(q, l.id);
      l.received += q;
      booked++;
    }
    if (!booked) throw new HttpError(400, "Enter the quantity received for at least one product.");
    const done = [...lines.values()].every((l) => l.received >= l.qty - 1e-9);
    db.prepare("UPDATE purchase_orders SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(done ? "received" : "partial", done ? Date.now() : null, Date.now(), p.id);
    return { status: done ? "received" : "partial", booked };
  })));

  // Nothing (more) is coming: cancel an order with no receipts, or close a partly received one.
  r.post("/:id/close", need("staff"), write((req) => tx(db, () => {
    const p = getPo(req.params.id);
    mustBe(p, ["sent", "partial"], "closed");
    const status = p.status === "sent" ? "cancelled" : "closed";
    db.prepare("UPDATE purchase_orders SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), Date.now(), p.id);
    return { status };
  })));

  return r;
}

/** Suppliers with purchase orders can't be deleted, so old orders keep their supplier. */
export const supplierHasPos = (db, id) => !!db.prepare("SELECT 1 FROM purchase_orders WHERE supplier_id = ? LIMIT 1").get(id);
