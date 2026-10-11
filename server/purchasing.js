// Purchase orders and supplier payments (owners only).
// draft → sent ("Ordered") → partial → received, or cancelled (nothing received) / closed (rest won't come).
// Prices are in the order's currency. Landed cost per unit = price × rate + freight, duty and other costs
// spread over the lines by value. Receiving books stock in, updates each SKU's moving-average cost, and records a PO move.

import express from "express";
import { randomUUID } from "node:crypto";
import { tx } from "./db.js";
import { HttpError } from "./http.js";
import { str, numIn, oneOf, CHANNELS, CURRENCIES } from "./validate.js";

const CLOSED_DAYS = 180;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = ["transfer", "cash", "giro", "offset", "other"];

const lineOut = (l) => ({ id: l.id, itemKey: l.item_key, sku: l.sku, tax: l.tax, name: l.name, unit: l.unit, qty: l.qty, received: l.received, price: l.price });
const poOut = (p, lines) => ({
  id: p.id, number: p.number, supplierId: p.supplier_id, status: p.status, note: p.note, createdBy: p.created_by,
  createdAt: p.created_at, sentAt: p.sent_at, sentVia: p.sent_via, closedAt: p.closed_at, lines: lines.map(lineOut),
  ledger: p.ledger, orderDate: p.order_date, eta: p.eta, currency: p.currency, fx: p.fx, freight: p.freight, duty: p.duty, otherCost: p.other_cost,
});
const spOut = (p) => ({ id: p.id, poId: p.po_id, date: p.pay_date, amount: p.amount, currency: p.currency, fx: p.fx, idr: p.idr, method: p.method, note: p.note, by: p.created_by });

/** Goods value in the order's currency, and what is payable: everything once ordered, only what arrived if cancelled or closed. */
export const poGoods = (lines) => lines.reduce((a, l) => a + l.qty * l.price, 0);
export function poPayable(p, lines) {
  if (p.status === "draft") return 0;
  if (p.status === "cancelled" || p.status === "closed") return lines.reduce((a, l) => a + l.received * l.price, 0);
  return poGoods(lines);
}
/** Landed cost per unit in rupiah. */
export function landedUnit(p, l, goods) {
  const fx = p.currency === "IDR" ? 1 : +p.fx || 0;
  const charges = (+p.freight || 0) + (+p.duty || 0) + (+(p.other_cost ?? p.otherCost) || 0);
  return (+l.price || 0) * fx + (goods > 0 ? (charges * (+l.price || 0)) / goods : 0);
}

/** Open orders, plus finished ones from the last 180 days. */
export function listPos(db) {
  const pos = db.prepare(`SELECT * FROM purchase_orders WHERE status IN ('draft','sent','partial') OR COALESCE(closed_at, updated_at) >= ?
    ORDER BY created_at DESC`).all(Date.now() - CLOSED_DAYS * 864e5);
  const lines = db.prepare("SELECT * FROM po_lines WHERE po_id IN (SELECT value FROM json_each(?)) ORDER BY pos").all(JSON.stringify(pos.map((p) => p.id)));
  const by = new Map();
  for (const l of lines) (by.get(l.po_id) || by.set(l.po_id, []).get(l.po_id)).push(l);
  return pos.map((p) => poOut(p, by.get(p.id) || []));
}
export const listSupplierPays = (db) => db.prepare("SELECT * FROM supplier_payments ORDER BY pay_date DESC, created_at DESC LIMIT 2000").all().map(spOut);

export function createPurchasing(db, { need, write, addMove, getSettings }) {
  const r = express.Router();
  const json = express.json({ limit: "2mb" });
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const addDays = (ymd, n) => new Date(Date.parse(ymd) + n * 864e5).toISOString().slice(0, 10);
  const dateIn = (v, label, optional = false) => {
    const s = str(v, 10);
    if (!s && optional) return "";
    if (!YMD.test(s)) throw new HttpError(400, `${label} must be a date.`);
    return s;
  };

  const getPo = (id) => {
    const p = db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(id);
    if (!p) throw new HttpError(404, "This purchase order no longer exists.");
    return p;
  };
  const linesOf = (id) => db.prepare("SELECT * FROM po_lines WHERE po_id = ? ORDER BY pos").all(id);
  const mustBe = (p, statuses, action) => {
    if (!statuses.includes(p.status)) throw new HttpError(409, `${p.number} is ${p.status === "sent" ? "ordered" : p.status}; it can't be ${action}.`);
  };
  const supplierIn = (id) => {
    const s = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(str(id, 100));
    if (!s) throw new HttpError(400, "Choose a supplier for this order.");
    return s;
  };
  const itemIn = (key, ledger) => {
    const it = db.prepare("SELECT * FROM items WHERE key = ?").get(str(key, 200));
    if (!it) throw new HttpError(404, "A product on this order no longer exists.");
    if (ledger && it.tax !== ledger) throw new HttpError(400, `${it.sku} is not a ${ledger === "PPN" ? "PPN" : "Non-PPN"} product. Add it to that entity under Inventory first.`);
    return it;
  };
  // Default price for a new line: the last price paid in this currency, or the cost for rupiah orders.
  const defaultPrice = (it, cur) => (it.last_cur === cur && it.last_fob > 0 ? it.last_fob : cur === "IDR" ? it.price : 0);
  function nextNumber(date) {
    const y = (date || today()).slice(0, 4);
    const n = db.prepare(`SELECT MAX(CAST(substr(number, length(number) - 3) AS INTEGER)) AS n FROM purchase_orders WHERE number LIKE ? OR number LIKE ?`).get(`PO/${y}/%`, `PO-${y}-%`).n || 0;
    return `PO/${y}/${String(n + 1).padStart(4, "0")}`;
  }
  function newDraft(sup, ledger, user, note = "") {
    const id = randomUUID();
    const now = Date.now();
    const date = today();
    const number = nextNumber(date);
    const cur = sup.currency || "IDR";
    db.prepare(`INSERT INTO purchase_orders (id, number, supplier_id, status, note, created_by, created_at, updated_at, ledger, order_date, eta, currency, fx)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, number, sup.id, note, user.name, now, now, ledger, date, addDays(date, +getSettings().leadTime || 60), cur, cur === "IDR" ? 1 : 0);
    return { id, number };
  }
  const insLine = db.prepare("INSERT INTO po_lines (id, po_id, item_key, sku, tax, name, unit, qty, received, price, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const touch = (id) => db.prepare("UPDATE purchase_orders SET updated_at = ? WHERE id = ?").run(Date.now(), id);

  // New empty draft for a supplier and receiving entity.
  r.post("/", need("admin"), json, write((req) => tx(db, () => newDraft(supplierIn(req.body.supplierId), oneOf(req.body.ledger ?? "PPN", ["PPN", "NON"], "Entity"), req.user))));

  // Add a product to the supplier's open draft for that entity (creating one if there is none). Same product twice adds up.
  r.post("/add-line", need("admin"), json, write((req) => tx(db, () => {
    const it = itemIn(req.body.itemKey);
    const qty = numIn(req.body.qty, "Order quantity", { min: 0 });
    if (!(qty > 0)) throw new HttpError(400, "Order quantity must be more than 0.");
    const sup = supplierIn(req.body.supplierId || it.supplier_id);
    let po = db.prepare("SELECT * FROM purchase_orders WHERE supplier_id = ? AND ledger = ? AND status = 'draft' ORDER BY created_at LIMIT 1").get(sup.id, it.tax);
    const created = !po;
    if (!po) po = getPo(newDraft(sup, it.tax, req.user).id);
    const ex = db.prepare("SELECT id FROM po_lines WHERE po_id = ? AND item_key = ?").get(po.id, it.key);
    if (ex) db.prepare("UPDATE po_lines SET qty = qty + ? WHERE id = ?").run(qty, ex.id);
    else {
      const pos = db.prepare("SELECT COALESCE(MAX(pos), -1) + 1 AS p FROM po_lines WHERE po_id = ?").get(po.id).p;
      insLine.run(randomUUID(), po.id, it.key, it.sku, it.tax, it.name, it.unit, qty, 0, defaultPrice(it, po.currency), pos);
    }
    touch(po.id);
    return { id: po.id, number: po.number, created, merged: !!ex };
  })));

  // A new draft from a list of alerts (one entity, one supplier).
  r.post("/from-alerts", need("admin"), json, write((req) => tx(db, () => {
    const ledger = oneOf(req.body.ledger, ["PPN", "NON"], "Entity");
    const sup = supplierIn(req.body.supplierId);
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!lines.length) throw new HttpError(400, "There is nothing to order.");
    const { id, number } = newDraft(sup, ledger, req.user);
    lines.forEach((l, i) => {
      const it = itemIn(l.itemKey, ledger);
      const qty = numIn(l.qty, `Quantity for ${it.sku}`, { min: 0 });
      if (qty > 0) insLine.run(randomUUID(), id, it.key, it.sku, it.tax, it.name, it.unit, qty, 0, defaultPrice(it, sup.currency || "IDR"), i);
    });
    return { id, number };
  })));

  // Drafts: everything can change. Ordered: arrival date, rate, extra costs, note and prices (they are often settled late).
  r.put("/:id", need("admin"), json, write((req) => tx(db, () => {
    const p = getPo(req.params.id);
    const b = req.body;
    mustBe(p, ["draft", "sent", "partial"], "edited");
    const cur = p.status === "draft" ? oneOf(b.currency ?? p.currency, CURRENCIES, "Currency") : p.currency;
    const fx = cur === "IDR" ? 1 : numIn(b.fx ?? p.fx, "Exchange rate", { min: 0 });
    const head = {
      eta: dateIn(b.eta ?? p.eta, "Expected arrival", true), fx,
      freight: numIn(b.freight ?? p.freight, "Freight", { min: 0 }), duty: numIn(b.duty ?? p.duty, "Import duty", { min: 0 }),
      other: numIn(b.otherCost ?? p.other_cost, "Other costs", { min: 0 }), note: str(b.note ?? p.note, 2000),
    };
    if (p.status === "draft") {
      const sup = supplierIn(b.supplierId ?? p.supplier_id);
      const ledger = oneOf(b.ledger ?? p.ledger, ["PPN", "NON"], "Entity");
      const orderDate = dateIn(b.orderDate ?? p.order_date, "Order date");
      db.prepare("DELETE FROM po_lines WHERE po_id = ?").run(p.id);
      const seen = new Set();
      (Array.isArray(b.lines) ? b.lines : []).forEach((l, i) => {
        const it = itemIn(l.itemKey, ledger);
        if (seen.has(it.key)) throw new HttpError(400, `${it.sku} is on this order twice. Combine the quantities into one line.`);
        seen.add(it.key);
        const qty = numIn(l.qty, `Quantity for ${it.sku}`, { min: 0 });
        if (!(qty > 0)) throw new HttpError(400, `Quantity for ${it.sku} must be more than 0.`);
        insLine.run(randomUUID(), p.id, it.key, it.sku, it.tax, it.name, it.unit, qty, 0, numIn(l.price, `Price for ${it.sku}`, { min: 0 }), i);
      });
      db.prepare(`UPDATE purchase_orders SET supplier_id = ?, ledger = ?, order_date = ?, currency = ?, eta = ?, fx = ?, freight = ?, duty = ?, other_cost = ?, note = ?, updated_at = ? WHERE id = ?`)
        .run(sup.id, ledger, orderDate, cur, head.eta, head.fx, head.freight, head.duty, head.other, head.note, Date.now(), p.id);
    } else {
      if (Array.isArray(b.lines)) {
        const upd = db.prepare("UPDATE po_lines SET price = ? WHERE id = ? AND po_id = ?");
        for (const l of b.lines) if (l.id != null && l.price != null) upd.run(numIn(l.price, "Price", { min: 0 }), String(l.id), p.id);
      }
      db.prepare(`UPDATE purchase_orders SET eta = ?, fx = ?, freight = ?, duty = ?, other_cost = ?, note = ?, updated_at = ? WHERE id = ?`)
        .run(head.eta, head.fx, head.freight, head.duty, head.other, head.note, Date.now(), p.id);
    }
  })));

  r.delete("/:id", need("admin"), write((req) => tx(db, () => {
    const p = getPo(req.params.id);
    mustBe(p, ["draft"], "deleted (cancel it instead)");
    db.prepare("DELETE FROM po_lines WHERE po_id = ?").run(p.id);
    db.prepare("DELETE FROM purchase_orders WHERE id = ?").run(p.id);
  })));

  // Mark as ordered (optionally via the channel the supplier was messaged on).
  r.post("/:id/send", need("admin"), json, write((req) => tx(db, () => {
    const p = getPo(req.params.id);
    mustBe(p, ["draft"], "ordered");
    if (!linesOf(p.id).length) throw new HttpError(400, "Add at least one product before ordering.");
    if (p.currency !== "IDR" && !(p.fx > 0)) throw new HttpError(400, "Set the exchange rate before ordering. You can update it when the goods arrive.");
    const via = oneOf(req.body.via ?? "other", [...CHANNELS, "other"], "Sent via");
    db.prepare("UPDATE purchase_orders SET status = 'sent', sent_at = ?, sent_via = ?, updated_at = ? WHERE id = ?").run(Date.now(), via, Date.now(), p.id);
  })));

  // Book goods received: stock in, moving-average landed cost, PO move.
  r.post("/:id/receive", need("admin"), json, write((req) => tx(db, () => {
    const p = getPo(req.params.id);
    mustBe(p, ["sent", "partial"], "received");
    if (p.currency !== "IDR" && !(p.fx > 0)) throw new HttpError(400, "Set the exchange rate actually paid, so the landed cost is right.");
    const all = linesOf(p.id);
    const goods = poGoods(all);
    const lines = new Map(all.map((l) => [l.id, l]));
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
      const unit = landedUnit(p, l, goods);
      const oldQ = Math.max(0, it.qty), oldC = it.price;
      const avg = oldC > 0 && oldQ > 0 ? (oldQ * oldC + q * unit) / (oldQ + q) : unit;
      db.prepare("UPDATE items SET qty = qty + ?, price = ?, last_fob = ?, last_cur = ?, updated_at = ? WHERE key = ?").run(q, avg, l.price, p.currency, Date.now(), it.key);
      addMove(it, "PO", q, p.number, req.user);
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
  r.post("/:id/close", need("admin"), write((req) => tx(db, () => {
    const p = getPo(req.params.id);
    mustBe(p, ["sent", "partial"], "closed");
    const status = p.status === "sent" ? "cancelled" : "closed";
    db.prepare("UPDATE purchase_orders SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), Date.now(), p.id);
    return { status };
  })));

  // ---------- supplier payments ----------
  r.post("/:id/payments", need("admin"), json, write((req) => tx(db, () => {
    const p = getPo(req.params.id);
    if (p.status === "draft") throw new HttpError(409, "Mark the order as ordered before paying for it.");
    const amount = numIn(req.body.amount, "Amount", { min: 0 });
    if (!(amount > 0)) throw new HttpError(400, "Enter the amount paid.");
    const fx = p.currency === "IDR" ? 1 : numIn(req.body.fx, "Rate paid", { min: 0 });
    if (!(fx > 0)) throw new HttpError(400, "Enter the rate you paid at.");
    const paid = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM supplier_payments WHERE po_id = ?").get(p.id).s;
    const out = poPayable(p, linesOf(p.id)) - paid;
    if (amount > out + 0.005) throw new HttpError(400, `That is more than the ${p.currency} ${out.toLocaleString("id-ID", { maximumFractionDigits: 2 })} still owed on ${p.number}.`);
    const date = dateIn(req.body.date ?? today(), "Payment date");
    db.prepare("INSERT INTO supplier_payments (id, po_id, pay_date, amount, currency, fx, idr, method, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), p.id, date, amount, p.currency, fx, Math.round(amount * fx), oneOf(req.body.method ?? "transfer", METHODS, "Method"), str(req.body.note, 500), req.user.name, Date.now());
    touch(p.id);
  })));
  r.delete("/:id/payments/:pid", need("admin"), write((req) => {
    if (!db.prepare("DELETE FROM supplier_payments WHERE id = ? AND po_id = ?").run(req.params.pid, req.params.id).changes) throw new HttpError(404, "This payment no longer exists.");
  }));

  return r;
}

/** Suppliers with purchase orders can't be deleted, so old orders keep their supplier. */
export const supplierHasPos = (db, id) => !!db.prepare("SELECT 1 FROM purchase_orders WHERE supplier_id = ? LIMIT 1").get(id);
