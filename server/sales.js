// Customers and sales invoices.
// draft → issued (gets its number, stock goes down, totals and customer details are frozen) → paid via payments,
// or void (admin; stock goes back). Each ledger (PPN / Non-PPN) has its own numbering.

import express from "express";
import { randomUUID } from "node:crypto";
import { tx } from "./db.js";
import { HttpError } from "./http.js";
import { str, numIn, oneOf, termsIn } from "./validate.js";
import { invoiceTotals, lineNets } from "../public/js/invoice.js";
import { keyOf } from "../public/js/util.js";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = ["transfer", "cash", "giro", "offset", "other"];
const KEEP_DAYS = 400;

const ymdIn = (v, label) => {
  const s = str(v, 10);
  if (!YMD.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `${label} must be a date.`);
  return s;
};
// Local calendar date of the server (set the machine's time zone to WIB/WITA/WIT as appropriate).
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const addDays = (ymd, n) => new Date(Date.parse(ymd) + n * 864e5).toISOString().slice(0, 10);

export function customerFields(b) {
  const f = {
    name: str(b.name, 200),
    contact: str(b.contact, 200),
    phone: str(b.phone, 40),
    whatsapp: str(b.whatsapp, 40),
    email: str(b.email, 200),
    address: str(b.address, 1000),
    npwp: str(b.npwp, 40),
    notes: str(b.notes, 2000),
    terms: termsIn(b.terms),
    internal: b.internal ? 1 : 0,
    ledger: b.internal ? oneOf(b.ledger, ["PPN", "NON"], "Entity ledger") : "",
  };
  if (!f.name) throw new HttpError(400, "Customer name is required.");
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) throw new HttpError(400, "That email address doesn't look right.");
  for (const c of ["whatsapp", "phone"]) {
    if (f[c] && !/^\+?[\d\s().-]{6,}$/.test(f[c])) throw new HttpError(400, `${c === "phone" ? "Telephone" : "WhatsApp"} number can only contain digits, spaces, +, -, ( and ).`);
  }
  if (f.npwp && ![15, 16].includes(f.npwp.replace(/\D/g, "").length)) throw new HttpError(400, "NPWP must have 15 or 16 digits.");
  return f;
}

const customerOut = (c) => ({ id: c.id, name: c.name, contact: c.contact, phone: c.phone, whatsapp: c.whatsapp, email: c.email, address: c.address, npwp: c.npwp, notes: c.notes,
  terms: c.terms, internal: !!c.internal, ledger: c.ledger });
const lineOut = (l) => ({ id: l.id, itemKey: l.item_key, sku: l.sku, name: l.name, unit: l.unit, qty: l.qty, price: l.price, discPct: l.disc_pct });
const payOut = (p) => ({ id: p.id, date: p.pay_date, amount: p.amount, method: p.method, note: p.note, by: p.created_by });

export const listCustomers = (db) => db.prepare("SELECT * FROM customers ORDER BY name COLLATE NOCASE").all().map(customerOut);

/** Drafts, unpaid invoices of any age, and everything from the last 400 days. */
export function listInvoices(db) {
  const rows = db.prepare(`SELECT i.*, COALESCE((SELECT SUM(amount) FROM invoice_payments p WHERE p.invoice_id = i.id), 0) AS paid FROM invoices i
    WHERE i.status = 'draft' OR i.inv_date >= ? OR (i.status = 'issued' AND i.total > COALESCE((SELECT SUM(amount) FROM invoice_payments p WHERE p.invoice_id = i.id), 0))
    ORDER BY i.inv_date DESC, i.created_at DESC`).all(addDays(todayYmd(), -KEEP_DAYS));
  const ids = JSON.stringify(rows.map((r) => r.id));
  const group = (sql) => {
    const m = new Map();
    for (const r of db.prepare(sql).all(ids)) (m.get(r.invoice_id) || m.set(r.invoice_id, []).get(r.invoice_id)).push(r);
    return m;
  };
  const lines = group("SELECT * FROM invoice_lines WHERE invoice_id IN (SELECT value FROM json_each(?)) ORDER BY pos");
  const pays = group("SELECT * FROM invoice_payments WHERE invoice_id IN (SELECT value FROM json_each(?)) ORDER BY pay_date, created_at");
  return rows.map((i) => ({
    id: i.id, number: i.number || "", tax: i.tax, customerId: i.customer_id, status: i.status, date: i.inv_date, dueDate: i.due_date,
    terms: i.terms, transferTo: i.transfer_to, internal: !!i.internal, note: i.note, nsfp: i.nsfp, custName: i.cust_name, custAddress: i.cust_address, custNpwp: i.cust_npwp,
    subtotal: i.subtotal, dppLain: i.dpp_lain, ppn: i.ppn, total: i.total, paid: i.paid,
    createdBy: i.created_by, issuedBy: i.issued_by, issuedAt: i.issued_at, voidedAt: i.voided_at, voidReason: i.void_reason,
    lines: (lines.get(i.id) || []).map(lineOut), payments: (pays.get(i.id) || []).map(payOut),
  }));
}

/**
 * Units sold per item and month from issued invoices, for the safety-stock model.
 * Only complete months (before the current one) count, so a half-finished month doesn't look like low demand.
 */
export function invoiceDemand(db) {
  const cur = todayYmd().slice(0, 7);
  const dem = {};
  const months = { PPN: new Set(), NON: new Set() };
  const rows = db.prepare(`SELECT i.tax, l.item_key, l.unit, substr(i.inv_date, 1, 7) AS ym, SUM(l.qty) AS q FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
    WHERE i.status = 'issued' AND i.internal = 0 AND substr(i.inv_date, 1, 7) < ? GROUP BY i.tax, l.item_key, l.unit, ym`).all(cur);
  for (const r of rows) {
    months[r.tax].add(r.ym);
    const m = ((dem[r.item_key] ??= { m: {} }).m);
    const k = r.ym + (r.unit === "SET" ? "S" : "");
    m[k] = (m[k] || 0) + r.q;
  }
  return { dem, months: { PPN: [...months.PPN].sort(), NON: [...months.NON].sort() } };
}

export function createSales(db, { need, write, addMove, getSettings }) {
  const customers = express.Router();
  const invoices = express.Router();
  const json = express.json({ limit: "1mb" });

  // ---------- customers ----------
  customers.post("/", need("staff"), json, write((req) => {
    const f = customerFields(req.body);
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO customers (id, name, contact, phone, whatsapp, email, address, npwp, notes, terms, internal, ledger, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, f.name, f.contact, f.phone, f.whatsapp, f.email, f.address, f.npwp, f.notes, f.terms, f.internal, f.ledger, now, now);
    return { id };
  }));
  customers.put("/:id", need("staff"), json, write((req) => {
    const f = customerFields(req.body);
    const r = db.prepare(`UPDATE customers SET name = ?, contact = ?, phone = ?, whatsapp = ?, email = ?, address = ?, npwp = ?, notes = ?, terms = ?, internal = ?, ledger = ?,
      updated_at = ? WHERE id = ?`)
      .run(f.name, f.contact, f.phone, f.whatsapp, f.email, f.address, f.npwp, f.notes, f.terms, f.internal, f.ledger, Date.now(), req.params.id);
    if (!r.changes) throw new HttpError(404, "This customer no longer exists.");
  }));
  customers.delete("/:id", need("admin"), write((req) => {
    if (db.prepare("SELECT 1 FROM invoices WHERE customer_id = ? LIMIT 1").get(req.params.id))
      throw new HttpError(409, "This customer has invoices, so it can't be deleted.");
    if (!db.prepare("DELETE FROM customers WHERE id = ?").run(req.params.id).changes) throw new HttpError(404, "This customer no longer exists.");
  }));

  // ---------- invoices ----------
  const getInv = (id) => {
    const i = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    if (!i) throw new HttpError(404, "This invoice no longer exists.");
    return i;
  };
  const customerIn = (id) => {
    const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(str(id, 100));
    if (!c) throw new HttpError(400, "Choose a customer for this invoice.");
    return c;
  };
  const linesOf = (id) => db.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY pos").all(id);
  const paidOf = (id) => db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM invoice_payments WHERE invoice_id = ?").get(id).s;
  const touch = (id) => db.prepare("UPDATE invoices SET updated_at = ? WHERE id = ?").run(Date.now(), id);

  invoices.post("/", need("staff"), json, write((req) => {
    const tax = oneOf(req.body.tax, ["PPN", "NON"], "Ledger");
    const c = customerIn(req.body.customerId);
    const id = randomUUID();
    const now = Date.now();
    const date = todayYmd();
    // Terms: the customer's own, else the default. Transfers to our own entities are due immediately.
    const terms = c.internal ? 0 : c.terms != null ? c.terms : Math.max(0, Math.round(+getSettings().invoiceTerms || 0));
    db.prepare("INSERT INTO invoices (id, tax, customer_id, status, inv_date, due_date, terms, created_by, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)")
      .run(id, tax, c.id, date, addDays(date, terms), terms, req.user.name, now, now);
    return { id };
  }));

  invoices.put("/:id", need("staff"), json, write((req) => tx(db, () => {
    const inv = getInv(req.params.id);
    const b = req.body;
    if (inv.status === "void") throw new HttpError(409, `${inv.number} is void; it can't be changed.`);
    if (inv.status === "issued") {
      // An issued invoice is a legal document: only the e-Faktur number and the due date can still change.
      const due = b.dueDate !== undefined ? ymdIn(b.dueDate, "Due date") : inv.due_date;
      db.prepare("UPDATE invoices SET nsfp = ?, due_date = ?, updated_at = ? WHERE id = ?").run(str(b.nsfp ?? inv.nsfp, 40), due, Date.now(), inv.id);
      return;
    }
    const c = customerIn(b.customerId ?? inv.customer_id);
    const date = ymdIn(b.date ?? inv.inv_date, "Invoice date");
    const terms = b.terms !== undefined ? termsIn(b.terms) ?? 0 : inv.terms;
    const due = b.terms !== undefined ? addDays(date, terms) : ymdIn(b.dueDate ?? inv.due_date, "Due date");
    if (due < date) throw new HttpError(400, "The due date can't be before the invoice date.");
    const lines = Array.isArray(b.lines) ? b.lines : [];
    db.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?").run(inv.id);
    const ins = db.prepare("INSERT INTO invoice_lines (id, invoice_id, item_key, sku, name, unit, qty, price, disc_pct, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    lines.forEach((l, i) => {
      const it = db.prepare("SELECT * FROM items WHERE key = ?").get(str(l.itemKey, 200));
      if (!it) throw new HttpError(400, "A product on this invoice no longer exists.");
      if (it.tax !== inv.tax) throw new HttpError(400, `${it.sku} is in the ${it.tax === "PPN" ? "PPN" : "Non-PPN"} ledger; this is a ${inv.tax === "PPN" ? "PPN" : "Non-PPN"} invoice.`);
      const qty = numIn(l.qty, `Quantity for ${it.sku}`, { min: 0 });
      if (!(qty > 0)) throw new HttpError(400, `Quantity for ${it.sku} must be more than 0.`);
      const disc = numIn(l.discPct, `Discount for ${it.sku}`, { min: 0 });
      if (disc > 100) throw new HttpError(400, `Discount for ${it.sku} can't be over 100%.`);
      ins.run(randomUUID(), inv.id, it.key, it.sku, it.name, it.unit, qty, numIn(l.price, `Price for ${it.sku}`, { min: 0 }), disc, i);
    });
    db.prepare("UPDATE invoices SET customer_id = ?, inv_date = ?, due_date = ?, terms = ?, note = ?, updated_at = ? WHERE id = ?")
      .run(c.id, date, due, terms, str(b.note ?? inv.note, 2000), Date.now(), inv.id);
  })));

  invoices.delete("/:id", need("staff"), write((req) => tx(db, () => {
    const inv = getInv(req.params.id);
    if (inv.status !== "draft") throw new HttpError(409, `${inv.number} is issued; void it instead.`);
    db.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?").run(inv.id);
    db.prepare("DELETE FROM invoices WHERE id = ?").run(inv.id);
  })));

  invoices.post("/:id/issue", need("staff"), write((req) => tx(db, () => {
    const inv = getInv(req.params.id);
    if (inv.status !== "draft") throw new HttpError(409, `${inv.number} is already issued.`);
    const lines = linesOf(inv.id);
    if (!lines.length) throw new HttpError(400, "Add at least one product before issuing.");
    const c = customerIn(inv.customer_id);
    // Stock check across all lines (the same product may appear on several lines).
    const need_ = new Map();
    for (const l of lines) need_.set(l.item_key, (need_.get(l.item_key) || 0) + l.qty);
    const short = [];
    for (const [key, q] of need_) {
      const it = db.prepare("SELECT * FROM items WHERE key = ?").get(key);
      if (!it) throw new HttpError(409, `A product on this invoice was deleted from the inventory.`);
      if (it.qty < q) short.push(`${it.sku} (need ${q}, have ${it.qty})`);
    }
    if (short.length) throw new HttpError(409, `Not enough stock: ${short.join(", ")}. Book the incoming goods first, or lower the quantity.`);
    // Number: <entity prefix>/<year>/<month>/<sequence>, e.g. HM/2026/10/0001. The sequence runs per entity per year.
    const year = inv.inv_date.slice(0, 4), month = inv.inv_date.slice(5, 7);
    const prefix = getSettings().ent[inv.tax].prefix;
    const seq = db.prepare(`SELECT MAX(CAST(substr(number, length(number) - 3) AS INTEGER)) AS n FROM invoices WHERE tax = ? AND number LIKE ?`).get(inv.tax, `${prefix}/${year}/%`).n || 0;
    const number = `${prefix}/${year}/${month}/${String(seq + 1).padStart(4, "0")}`;
    const st = getSettings();
    const priced = lines.map((l) => ({ qty: l.qty, price: l.price, discPct: l.disc_pct }));
    const t = invoiceTotals(priced, inv.tax, st.ppnRate, st.priceMode);
    // A sale to one of our own entities is a transfer: out of this ledger, into theirs, at the invoice's net price.
    const internal = !!c.internal;
    const transferTo = internal && c.ledger && c.ledger !== inv.tax ? c.ledger : "";
    const nets = lineNets(priced, t.subtotal);
    for (const [key, q] of need_) {
      const it = db.prepare("SELECT * FROM items WHERE key = ?").get(key);
      db.prepare("UPDATE items SET qty = qty - ?, updated_at = ? WHERE key = ?").run(q, Date.now(), key);
      addMove(it, internal ? "TRF-OUT" : "SALE", -q, `${number} · ${c.name}`, req.user);
    }
    if (transferTo) {
      lines.forEach((l, i) => {
        const tk = keyOf(transferTo, l.sku);
        const unit = l.qty ? nets[i] / l.qty : 0;
        let dst = db.prepare("SELECT * FROM items WHERE key = ?").get(tk);
        if (!dst) {
          db.prepare("INSERT INTO items (key, sku, tax, name, unit, qty, price, min_stock, sell_price, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?)")
            .run(tk, l.sku, transferTo, l.name, l.unit, Date.now());
          dst = db.prepare("SELECT * FROM items WHERE key = ?").get(tk);
        }
        const oldQ = Math.max(0, dst.qty), oldC = dst.price;
        const avg = oldC > 0 && oldQ > 0 ? (oldQ * oldC + l.qty * unit) / (oldQ + l.qty) : unit;
        db.prepare("UPDATE items SET qty = qty + ?, price = ?, updated_at = ? WHERE key = ?").run(l.qty, avg, Date.now(), tk);
        addMove(dst, "TRF-IN", l.qty, number, req.user);
      });
    }
    db.prepare(`UPDATE invoices SET status = 'issued', number = ?, cust_name = ?, cust_address = ?, cust_npwp = ?, subtotal = ?, dpp_lain = ?, ppn = ?, total = ?,
      internal = ?, transfer_to = ?, issued_by = ?, issued_at = ?, updated_at = ? WHERE id = ?`)
      .run(number, c.name, c.address, c.npwp, t.subtotal, t.dppLain, t.ppn, t.total, internal ? 1 : 0, transferTo, req.user.name, Date.now(), Date.now(), inv.id);
    return { number, total: t.total, internal, transferTo };
  })));

  invoices.post("/:id/payments", need("staff"), json, write((req) => tx(db, () => {
    const inv = getInv(req.params.id);
    if (inv.status !== "issued") throw new HttpError(409, inv.status === "draft" ? "Issue the invoice before recording payments." : `${inv.number} is void.`);
    const amount = Math.round(numIn(req.body.amount, "Amount", { min: 0 }));
    if (!(amount > 0)) throw new HttpError(400, "Enter the amount received.");
    const balance = Math.round(inv.total - paidOf(inv.id));
    if (amount > balance) throw new HttpError(400, `Only Rp ${balance.toLocaleString("id-ID")} is still owed on ${inv.number}.`);
    db.prepare("INSERT INTO invoice_payments (id, invoice_id, pay_date, amount, method, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), inv.id, ymdIn(req.body.date ?? todayYmd(), "Payment date"), amount, oneOf(req.body.method ?? "transfer", METHODS, "Method"), str(req.body.note, 500), req.user.name, Date.now());
    touch(inv.id);
    return { balance: balance - amount };
  })));
  invoices.delete("/:id/payments/:pid", need("admin"), write((req) => tx(db, () => {
    const inv = getInv(req.params.id);
    if (!db.prepare("DELETE FROM invoice_payments WHERE id = ? AND invoice_id = ?").run(req.params.pid, inv.id).changes) throw new HttpError(404, "This payment no longer exists.");
    touch(inv.id);
  })));

  invoices.post("/:id/void", need("admin"), json, write((req) => tx(db, () => {
    const inv = getInv(req.params.id);
    if (inv.status !== "issued") throw new HttpError(409, "Only an issued invoice can be voided.");
    if (paidOf(inv.id) > 0) throw new HttpError(409, "This invoice has payments. Remove them (refund) before voiding.");
    const reason = str(req.body.reason, 500);
    if (!reason) throw new HttpError(400, "Give a reason for voiding (it's kept with the invoice).");
    const ls = linesOf(inv.id);
    if (inv.transfer_to) {
      // Take the transferred stock back out of the receiving ledger first; refuse if it has already been used.
      for (const l of ls) {
        const tk = keyOf(inv.transfer_to, l.sku);
        const dst = db.prepare("SELECT * FROM items WHERE key = ?").get(tk);
        if (!dst || dst.qty < l.qty) throw new HttpError(409, `The receiving entity no longer has ${l.qty} of ${l.sku}. Move it back first.`);
        db.prepare("UPDATE items SET qty = qty - ?, updated_at = ? WHERE key = ?").run(l.qty, Date.now(), tk);
        addMove(dst, "VOID", -l.qty, `Cancel ${inv.number}`, req.user);
      }
    }
    for (const l of ls) {
      const it = db.prepare("SELECT * FROM items WHERE key = ?").get(l.item_key);
      if (!it) continue; // product deleted since; nothing to put back
      db.prepare("UPDATE items SET qty = qty + ?, updated_at = ? WHERE key = ?").run(l.qty, Date.now(), it.key);
      addMove(it, "VOID", l.qty, `Cancel ${inv.number}`, req.user);
    }
    db.prepare("UPDATE invoices SET status = 'void', voided_at = ?, void_reason = ?, updated_at = ? WHERE id = ?").run(Date.now(), reason, Date.now(), inv.id);
  })));

  return { customers, invoices };
}

