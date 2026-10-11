// Month-end records and the data behind the monthly PDF reports.
//
// Closing stock: after every burst of changes the current month's stock is copied into stock_snapshots, so the last copy
// taken in a month is that month's closing stock. Everything else (sales, payments, receipts, expenses) is dated, so a
// month is read straight from the records.

import express from "express";
import { tx } from "./db.js";
import { HttpError } from "./http.js";
import { str } from "./validate.js";
import { landedUnit, poGoods, poPayable } from "./purchasing.js";

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const ymNow = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const lastDay = (ym) => { const [y, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; };
/** Local-time millisecond bounds of a month, for timestamped records (stock moves). */
const msBounds = (ym) => { const [y, m] = ym.split("-").map(Number); return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()]; };

export function snapshotStock(db, ym = ymNow()) {
  tx(db, () => {
    db.prepare("DELETE FROM stock_snapshots WHERE ym = ?").run(ym);
    db.prepare(`INSERT INTO stock_snapshots (ym, key, sku, tax, name, unit, qty, cost, sell_price, taken_at)
      SELECT ?, key, sku, tax, name, unit, qty, price, sell_price, ? FROM items`).run(ym, Date.now());
  });
}

/** Everything a monthly report needs for one month. Money, costs and margins only for owners. */
export function monthData(db, ym, owner) {
  const from = `${ym}-01`, to = lastDay(ym);
  const [t0, t1] = msBounds(ym);
  const out = { month: ym, from, to, owner, generatedAt: Date.now() };
  const costOf = new Map(db.prepare("SELECT key, price FROM items").all().map((r) => [r.key, r.price]));

  // ---- sales ----
  const invs = db.prepare(`SELECT * FROM invoices WHERE status IN ('issued','void') AND inv_date BETWEEN ? AND ? ORDER BY inv_date, number`).all(from, to);
  const lines = db.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY pos");
  out.invoices = invs.map((i) => {
    const ls = lines.all(i.id);
    const o = { number: i.number, date: i.inv_date, due: i.due_date, tax: i.tax, customer: i.cust_name, status: i.status, internal: !!i.internal,
      subtotal: i.subtotal, ppn: i.ppn, total: i.total, qty: ls.reduce((a, l) => a + l.qty, 0) };
    if (owner) o.cogs = ls.reduce((a, l) => a + l.qty * (costOf.get(l.item_key) || 0), 0);
    return o;
  });
  const sold = new Map();
  for (const i of invs.filter((x) => x.status === "issued" && !x.internal)) {
    for (const l of lines.all(i.id)) {
      const k = l.item_key, s = sold.get(k) || { sku: l.sku, name: l.name, tax: i.tax, unit: l.unit, qty: 0, gross: 0 };
      s.qty += l.qty;
      s.gross += Math.round(l.qty * l.price * (1 - (l.disc_pct || 0) / 100));
      sold.set(k, s);
    }
  }
  out.topProducts = [...sold.values()].sort((a, b) => b.gross - a.gross).slice(0, 25);

  // ---- stock ----
  out.moves = db.prepare("SELECT t, sku, tax, type, qty, note, user_name FROM moves WHERE t >= ? AND t < ? ORDER BY t").all(t0, t1)
    .map((m) => ({ t: m.t, sku: m.sku, tax: m.tax, type: m.type, qty: m.qty, note: m.note, by: m.user_name }));
  const snap = db.prepare("SELECT * FROM stock_snapshots WHERE ym = ? ORDER BY tax, sku").all(ym);
  if (snap.length) {
    out.stock = { source: "snapshot", takenAt: Math.max(...snap.map((s) => s.taken_at)), items: snap };
  } else {
    out.stock = { source: ym === ymNow() ? "current" : "none", takenAt: Date.now(),
      items: ym === ymNow() ? db.prepare("SELECT key, sku, tax, name, unit, qty, price AS cost, sell_price FROM items ORDER BY tax, sku").all() : [] };
  }
  out.stock.items = out.stock.items.map((s) => ({ sku: s.sku, tax: s.tax, name: s.name, unit: s.unit, qty: s.qty, sellPrice: s.sell_price, ...(owner ? { cost: s.cost } : {}) }));
  out.firstSnapshot = db.prepare("SELECT MIN(ym) AS ym FROM stock_snapshots").get().ym || null;
  if (!owner) return out;

  // ---- receivables: payments received in the month, and what was owed at month end ----
  out.arPayments = db.prepare(`SELECT p.pay_date AS date, p.amount, p.method, p.note, i.number, i.cust_name AS customer, i.tax FROM invoice_payments p
    JOIN invoices i ON i.id = p.invoice_id WHERE p.pay_date BETWEEN ? AND ? ORDER BY p.pay_date`).all(from, to);
  out.arOpen = db.prepare(`SELECT i.number, i.inv_date AS date, i.due_date AS due, i.cust_name AS customer, i.tax, i.total,
      COALESCE((SELECT SUM(amount) FROM invoice_payments p WHERE p.invoice_id = i.id AND p.pay_date <= ?), 0) AS paid
    FROM invoices i WHERE i.status = 'issued' AND i.internal = 0 AND i.inv_date <= ? ORDER BY i.due_date`).all(to, to)
    .map((r) => ({ ...r, out: Math.round(r.total - r.paid) })).filter((r) => r.out > 0);

  // ---- purchasing & payables ----
  const pos = db.prepare("SELECT * FROM purchase_orders").all();
  const poLines = db.prepare("SELECT * FROM po_lines WHERE po_id = ? ORDER BY pos");
  const supName = new Map(db.prepare("SELECT id, company FROM suppliers").all().map((s) => [s.id, s.company]));
  const byNumber = new Map(pos.map((p) => [p.number, p]));
  out.poOrdered = pos.filter((p) => p.status !== "draft" && p.order_date >= from && p.order_date <= to).sort((a, b) => a.order_date.localeCompare(b.order_date)).map((p) => {
    const ls = poLines.all(p.id), g = poGoods(ls), fx = p.currency === "IDR" ? 1 : +p.fx || 0;
    return { number: p.number, date: p.order_date, supplier: supName.get(p.supplier_id) || "", tax: p.ledger, status: p.status, currency: p.currency, fx, goods: g,
      landed: g * fx + (+p.freight || 0) + (+p.duty || 0) + (+p.other_cost || 0) };
  });
  // Goods received in the month, valued at the landed cost they were booked at.
  out.poReceived = out.moves.filter((m) => m.type === "PO").map((m) => {
    const p = byNumber.get(m.note);
    const ls = p ? poLines.all(p.id) : [];
    const l = ls.find((x) => x.sku === m.sku && x.tax === m.tax);
    const unit = p && l ? landedUnit(p, l, poGoods(ls)) : 0;
    return { date: m.t, number: m.note, supplier: p ? supName.get(p.supplier_id) || "" : "", sku: m.sku, tax: m.tax, qty: m.qty, unit, value: Math.round(unit * m.qty) };
  });
  out.apPayments = db.prepare(`SELECT s.pay_date AS date, s.amount, s.currency, s.fx, s.idr, s.method, s.note, p.number, p.ledger AS tax, p.supplier_id FROM supplier_payments s
    JOIN purchase_orders p ON p.id = s.po_id WHERE s.pay_date BETWEEN ? AND ? ORDER BY s.pay_date`).all(from, to)
    .map(({ supplier_id, ...r }) => ({ ...r, supplier: supName.get(supplier_id) || "" }));
  const paidBy = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM supplier_payments WHERE po_id = ? AND pay_date <= ?");
  out.apOpen = pos.filter((p) => p.status !== "draft" && p.order_date && p.order_date <= to).map((p) => {
    const ls = poLines.all(p.id), payable = poPayable(p, ls), paid = paidBy.get(p.id, to).s, fx = p.currency === "IDR" ? 1 : +p.fx || 0;
    return { number: p.number, date: p.order_date, supplier: supName.get(p.supplier_id) || "", tax: p.ledger, currency: p.currency, payable, paid, out: payable - paid, idr: Math.round((payable - paid) * fx) };
  }).filter((r) => r.out > 0.005);

  // ---- expenses & payroll ----
  out.expenses = db.prepare("SELECT exp_date AS date, ledger AS tax, category, description, amount, method FROM expenses WHERE exp_date BETWEEN ? AND ? ORDER BY exp_date, created_at").all(from, to);
  out.salaries = db.prepare("SELECT name, ledger AS tax, pay_date AS date, base, allowance, bonus, deduction, net, method FROM salary_payments WHERE period = ? ORDER BY name COLLATE NOCASE").all(ym);
  return out;
}

export function createMonthly(db, { need }) {
  const r = express.Router();
  r.get("/month", need("viewer"), (req, res) => {
    const ym = str(req.query.month, 7);
    if (!YM.test(ym)) throw new HttpError(400, "Month must look like 2026-10.");
    if (ym > ymNow()) throw new HttpError(400, "That month hasn't started yet.");
    res.json(monthData(db, ym, req.user.role === "admin"));
  });
  // Which months have records, for the archive list.
  r.get("/months", need("viewer"), (req, res) => {
    const snaps = new Map(db.prepare("SELECT ym, MAX(taken_at) AS at FROM stock_snapshots GROUP BY ym").all().map((s) => [s.ym, s.at]));
    const months = new Set([...snaps.keys(), ymNow()]);
    for (const q of ["SELECT DISTINCT substr(inv_date, 1, 7) AS ym FROM invoices WHERE status != 'draft'", "SELECT DISTINCT substr(exp_date, 1, 7) AS ym FROM expenses",
      "SELECT DISTINCT period AS ym FROM salary_payments", "SELECT DISTINCT substr(order_date, 1, 7) AS ym FROM purchase_orders WHERE order_date != ''"]) {
      for (const x of db.prepare(q).all()) if (x.ym && YM.test(x.ym)) months.add(x.ym);
    }
    res.json([...months].filter((m) => m <= ymNow()).sort().reverse().slice(0, 36).map((ym) => ({ ym, snapshotAt: snaps.get(ym) || null })));
  });
  return r;
}
