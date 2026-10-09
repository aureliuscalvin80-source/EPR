import { test } from "node:test";
import assert from "node:assert/strict";
import { normInv, ymAdd, demandStats, baseVars, evaluate, onOrderByItem, DEFAULT_SETTINGS } from "../public/js/stock.js";

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("normInv matches standard Z values", () => {
  near(normInv(0.95), 1.6449);
  near(normInv(0.99), 2.3263);
  near(normInv(0.5), 0);
});

test("ymAdd crosses year boundaries", () => {
  assert.equal(ymAdd("2025-01", -1), "2024-12");
  assert.equal(ymAdd("2024-12", 1), "2025-01");
  assert.equal(ymAdd("2025-03", -15), "2023-12");
});

const it = { key: "PPN~A", sku: "A", tax: "PPN", unit: "PCS", qty: 5, price: 1000, minStock: 0 };
const salesHist = (months) => months.map((ym) => ({ kind: "sales", tax: "PPN", ym, check: "ok" }));

test("demand stats: mean and sample standard deviation over the window", () => {
  const months = ["2025-01", "2025-02", "2025-03", "2025-04"];
  const dem = { "PPN~A": { m: { "2025-01": 10, "2025-02": 20, "2025-03": 30, "2025-04": 40 }, s: {} } };
  const { stats, win } = demandStats({ [it.key]: it }, dem, salesHist(months), DEFAULT_SETTINGS);
  assert.deepEqual(win.PPN, ["2025-04", "2025-03", "2025-02", "2025-01"]);
  const d = stats.get(it.key);
  assert.equal(d.n, 4);
  assert.equal(d.mean, 25);
  near(d.sd, 12.9099);
});

test("demand stats: months out of stock at start and end are left out", () => {
  const months = ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05"];
  const hist = [...salesHist(months), ...months.map((ym) => ({ kind: "stock", tax: "PPN", ym, check: "ok" }))];
  // In stock at the end of Jan, Feb, Apr, May; out of stock at the end of Mar.
  // Apr: stock at end, so counted. Mar sold 0 and was empty at end but had stock at start (Feb) → counted.
  const dem = { "PPN~A": { m: { "2025-01": 10, "2025-02": 10, "2025-03": 0, "2025-04": 10, "2025-05": 10 }, s: { "2025-01": 1, "2025-02": 1, "2025-04": 1, "2025-05": 1 } } };
  let d = demandStats({ [it.key]: it }, dem, hist, DEFAULT_SETTINGS).stats.get(it.key);
  assert.equal(d.so, 0);
  // Now empty at the end of Feb as well: March was blocked (empty at start and end, sold 0) → excluded.
  delete dem["PPN~A"].s["2025-02"];
  d = demandStats({ [it.key]: it }, dem, hist, DEFAULT_SETTINGS).stats.get(it.key);
  assert.equal(d.so, 1);
  assert.equal(d.n, 4);
  assert.equal(d.mean, 10);
});

test("safety stock, reorder point and suggested order", () => {
  const s = { ...DEFAULT_SETTINGS, leadTime: 30, reviewDays: 30, serviceLevel: 95 };
  const v = baseVars(it, new Map(), { n: 12, mean: 30.4, sd: 10, so: 0, mixed: 0 }, s);
  // Z(95%) × 10 × √(60/30.4) = 1.6449 × 10 × 1.4049 = 23.11 → 24
  assert.equal(v.safety_stock, 24);
  // 1/day × 60 days + 24
  assert.equal(v.reorder_point, 84);
  assert.equal(v.order_up_to, 114);
  assert.equal(v.suggested_order, 109);
  near(v.days_cover, 5);
});

test("PPN prices: stored excluding vs including tax", () => {
  const excl = baseVars(it, new Map(), null, { ...DEFAULT_SETTINGS, ppnRate: 11, priceMode: "excl" });
  assert.equal(excl.price_incl, 1110);
  assert.equal(excl.value, 5000);
  const incl = baseVars(it, new Map(), null, { ...DEFAULT_SETTINGS, ppnRate: 11, priceMode: "incl" });
  near(incl.price_excl, 900.9);
  const non = baseVars({ ...it, tax: "NON" }, new Map(), null, DEFAULT_SETTINGS);
  assert.equal(non.price_incl, 1000);
});

test("evaluate: columns feed later alerts; scope and pause are respected", () => {
  const items = { [it.key]: it, "NON~B": { key: "NON~B", sku: "B", tax: "NON", unit: "PCS", qty: 0, price: 0, minStock: 2 } };
  const rules = [
    { id: "c1", name: "Double qty", kind: "column", scope: "ALL", expr: "qty * 2" },
    { id: "a1", name: "Low", kind: "alert", scope: "ALL", severity: "crit", expr: "col_double_qty < 4" },
    { id: "a2", name: "PPN only", kind: "alert", scope: "PPN", severity: "warn", expr: "true" },
    { id: "a3", name: "Paused", kind: "alert", scope: "ALL", severity: "warn", expr: "true", enabled: false },
  ];
  const r = evaluate({ items, rules, moves: [], dem: {}, hist: [], settings: DEFAULT_SETTINGS });
  assert.equal(r.derived.get("PPN~A").cols.c1, 10);
  assert.deepEqual(r.derived.get("PPN~A").alerts.map((x) => x.id), ["a2"]);
  assert.deepEqual(r.derived.get("NON~B").alerts.map((x) => x.id), ["a1"]);
  assert.equal(r.derived.get("NON~B").sev, "crit");
  assert.equal(r.alerts[0].r.id, "a1", "critical alerts sort first");
});

test("stock on sent purchase orders counts toward the reorder decision", () => {
  const pos = [
    { status: "sent", lines: [{ itemKey: "PPN~A", qty: 50, received: 0 }] },
    { status: "partial", lines: [{ itemKey: "PPN~A", qty: 20, received: 15 }] },
    { status: "draft", lines: [{ itemKey: "PPN~A", qty: 99, received: 0 }] },
    { status: "received", lines: [{ itemKey: "PPN~A", qty: 7, received: 7 }] },
  ];
  assert.equal(onOrderByItem(pos).get("PPN~A"), 55);
  const s = { ...DEFAULT_SETTINGS, leadTime: 30, reviewDays: 30, serviceLevel: 95 };
  const ds = { n: 12, mean: 30.4, sd: 10, so: 0, mixed: 0 };
  const without = baseVars(it, new Map(), ds, s, 0);
  const withPo = baseVars(it, new Map(), ds, s, 55);
  assert.equal(without.suggested_order, 109);
  assert.equal(withPo.inventory_position, 60);
  assert.equal(withPo.suggested_order, 54, "orders up to 114 from a position of 60");
  assert.equal(baseVars(it, new Map(), ds, s, 100).suggested_order, 0, "enough on order: nothing to suggest");
});

test("invoices count as sales for months without an uploaded report; reports win where both exist", () => {
  const hist = salesHist(["2025-01", "2025-02"]);
  const dem = { "PPN~A": { m: { "2025-01": 10, "2025-02": 10 }, s: {} } };
  const inv = { dem: { "PPN~A": { m: { "2025-02": 999, "2025-03": 40, "2025-04": 40 } } }, months: { PPN: ["2025-02", "2025-03", "2025-04"], NON: [] } };
  const { stats, win } = demandStats({ [it.key]: it }, dem, hist, DEFAULT_SETTINGS, inv);
  assert.deepEqual(win.PPN, ["2025-04", "2025-03", "2025-02", "2025-01"]);
  const d = stats.get(it.key);
  assert.equal(d.n, 4);
  assert.equal(d.mean, 25, "Feb uses the report (10), not the invoices (999)");
});
