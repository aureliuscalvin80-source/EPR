// Demand history, safety stock and rule evaluation. Pure functions: no DOM, no network.

import { parse, evalAst, colVar } from "./formula.js";

export const MON_N = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const ymOf = (y, m) => y + "-" + String(m).padStart(2, "0");
export function ymAdd(ym, k) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return ymOf(Math.floor(t / 12), (t % 12) + 1);
}
export const ymLabel = (ym) => {
  if (!ym) return "";
  const [y, m] = ym.split("-");
  return MON_N[+m - 1] + " " + y;
};

export const DEFAULT_SETTINGS = {
  ppnRate: 11,
  leadTime: 60,
  priceMode: "excl",
  reviewDays: 90,
  serviceLevel: 95,
  windowMonths: 12,
};

/** Inverse of the standard normal CDF (Acklam's approximation), clamped to 50–99.99 %. */
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  p = Math.min(0.9999, Math.max(0.5, p));
  if (p > 1 - 0.02425) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Units in and out per item over the last 30 days, from recorded stock moves. */
export function moveStats(moves, now = Date.now()) {
  const m = new Map();
  const cutoff = now - 30 * 864e5;
  for (const e of moves) {
    if ((e.t || 0) < cutoff) continue;
    const s = m.get(e.key) || { in: 0, out: 0 };
    if (e.type === "IN") s.in += e.qty;
    else if (e.type === "OUT") s.out += Math.abs(e.qty);
    m.set(e.key, s);
  }
  return m;
}

/** Which months have a processed sales (s) and stock (k) report, per ledger. */
export function coverage(hist) {
  const cov = { PPN: { s: new Map(), k: new Map() }, NON: { s: new Map(), k: new Map() } };
  for (const h of hist) {
    if (!cov[h.tax] || !h.ym || h.check === "error") continue;
    (h.kind === "sales" ? cov[h.tax].s : cov[h.tax].k).set(h.ym, h);
  }
  return cov;
}

/**
 * Monthly demand statistics per item from uploaded sales reports.
 * dem[key] = { m: { "2025-01": pcsSold, "2025-01S": setsSold }, s: { "2025-01": 1 if in stock at month end } }
 * Months where stock was zero at both the start and the end are left out: sales were blocked, not low.
 */
export function demandStats(items, dem, hist, settings, inv = { dem: {}, months: { PPN: [], NON: [] } }) {
  const stats = new Map();
  const N = Math.max(3, +settings.windowMonths || 12);
  const cov = coverage(hist);
  const win = { PPN: [], NON: [] };
  // A month counts if it has an uploaded sales report or issued invoices. Where both exist, the report wins
  // (it is the complete record for that month), so sales are never counted twice.
  const invMonths = { PPN: new Set(inv.months?.PPN || []), NON: new Set(inv.months?.NON || []) };
  const hasMonth = (t, y) => cov[t].s.has(y) || invMonths[t].has(y);
  for (const t of ["PPN", "NON"]) {
    const ys = [...new Set([...cov[t].s.keys(), ...invMonths[t]])].sort();
    if (!ys.length) continue;
    const last = ys[ys.length - 1];
    for (let i = 0; i < N; i++) {
      const y = ymAdd(last, -i);
      if (hasMonth(t, y)) win[t].push(y);
    }
  }
  for (const it of Object.values(items)) {
    const w = win[it.tax] || [];
    if (!w.length) { stats.set(it.key, null); continue; }
    const rec = dem[it.key] || {};
    const fromReports = rec.m || {};
    const fromInvoices = inv.dem?.[it.key]?.m || {};
    const s = rec.s || {};
    const st = cov[it.tax].k;
    const suf = it.unit === "SET" ? "S" : "";
    const oth = it.unit === "SET" ? "" : "S";
    let vals = [];
    const all = [];
    let so = 0;
    let mixed = 0;
    for (const y of w) {
      const m = cov[it.tax].s.has(y) ? fromReports : fromInvoices;
      const v = +m[y + suf] || 0;
      all.push(v);
      if (+m[y + oth] > 0) mixed = 1;
      const prev = ymAdd(y, -1);
      const closeZero = st.has(y) && s[y] !== 1;
      const openZero = st.has(prev) && s[prev] !== 1;
      if (closeZero && openZero && v === 0) { so++; continue; }
      vals.push(v);
    }
    if (vals.length < 3) { vals = all; so = 0; }
    const n = vals.length;
    const mean = n ? vals.reduce((a, b) => a + b, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    stats.set(it.key, { n, mean, sd, so, mixed });
  }
  return { stats, win };
}

/** All variables a formula can use for one item. */
export function baseVars(it, ms, ds, settings, onOrder = 0) {
  const rate = +settings.ppnRate || 0;
  const isP = it.tax === "PPN";
  const price = +it.price || 0;
  const incl = settings.priceMode === "incl";
  const excl = isP && incl ? price / (1 + rate / 100) : price;
  const withTax = isP ? (incl ? price : price * (1 + rate / 100)) : price;
  const s = ms.get(it.key) || { in: 0, out: 0 };
  const adoAvg = s.out / 30;
  const qty = +it.qty || 0;
  const L = +settings.leadTime || 0;
  const R = +settings.reviewDays || 0;
  const Z = normInv((+settings.serviceLevel || 95) / 100);
  const d = ds || { n: 0, mean: 0, sd: 0, so: 0, mixed: 0 };
  const dd = d.mean / 30.4;
  const ss = Math.ceil(Z * d.sd * Math.sqrt((L + R) / 30.4));
  const rop = Math.ceil(dd * (L + R) + ss);
  const up = Math.ceil(dd * (L + 2 * R) + ss);
  const daily = dd > 0 ? dd : adoAvg;
  // Inventory position = on hand + already ordered. Reorder decisions use it so nothing is ordered twice.
  const position = qty + onOrder;
  return {
    qty, price, price_excl: excl, price_incl: withTax, value: qty * excl,
    min_stock: +it.minStock || 0, is_ppn: isP ? 1 : 0, is_set: it.unit === "SET" ? 1 : 0,
    ppn_rate: rate, lead_time: L, in_30: s.in, out_30: s.out, avg_daily_out: adoAvg,
    hist_months: d.n, stockout_months: d.so, avg_monthly_demand: d.mean, sd_monthly_demand: d.sd,
    avg_daily_demand: dd, review_period: R, service_z: Z,
    safety_stock: ss, reorder_point: rop, order_up_to: up,
    on_order: onOrder, inventory_position: position,
    suggested_order: position < rop ? Math.max(0, up - position) : 0, mixed_units: d.mixed,
    days_cover: daily > 0 ? qty / daily : 9999,
  };
}

export function compileRules(rules) {
  for (const r of rules) {
    try {
      r._ast = parse(r.expr);
      r._err = null;
    } catch (e) {
      r._ast = null;
      r._err = e.message;
    }
  }
  return rules;
}

const inScope = (r, it) => r.scope === "ALL" || r.scope === it.tax;

/**
 * Evaluate every rule against every item.
 * Column rules run first, in order, so later formulas can reference earlier columns as col_<name>.
 */
/** Quantity still to arrive per item from sent and partly received purchase orders. */
export function onOrderByItem(pos) {
  const m = new Map();
  for (const p of pos || []) {
    if (p.status !== "sent" && p.status !== "partial") continue;
    for (const l of p.lines) m.set(l.itemKey, (m.get(l.itemKey) || 0) + Math.max(0, l.qty - l.received));
  }
  return m;
}

export function evaluate({ items, rules, moves, dem, hist, settings, pos = [], invDem, now = Date.now() }) {
  compileRules(rules);
  const ms = moveStats(moves, now);
  const onOrder = onOrderByItem(pos);
  const { stats: dstats, win } = demandStats(items, dem, hist, settings, invDem);
  const colRules = rules.filter((r) => r.kind === "column" && r.enabled !== false);
  const alertRules = rules.filter((r) => r.kind === "alert" && r.enabled !== false && r._ast);
  const derived = new Map();
  const alerts = [];
  for (const it of Object.values(items)) {
    const V = baseVars(it, ms, dstats.get(it.key), settings, onOrder.get(it.key) || 0);
    const d = { vars: V, cols: {}, alerts: [] };
    for (const r of colRules) {
      if (!r._ast || !inScope(r, it)) { d.cols[r.id] = null; continue; }
      try {
        const v = evalAst(r._ast, V);
        d.cols[r.id] = v;
        V[colVar(r.name)] = v;
      } catch {
        d.cols[r.id] = NaN;
      }
    }
    for (const r of alertRules) {
      if (!inScope(r, it)) continue;
      try {
        if (evalAst(r._ast, V)) { d.alerts.push(r); alerts.push({ it, r }); }
      } catch {
        // A formula referencing a column that is out of scope for this item simply doesn't fire.
      }
    }
    d.sev = d.alerts.some((r) => r.severity === "crit") ? "crit" : d.alerts.length ? "warn" : "";
    derived.set(it.key, d);
  }
  alerts.sort((a, b) => (a.r.severity === "crit" ? 0 : 1) - (b.r.severity === "crit" ? 0 : 1) || a.it.sku.localeCompare(b.it.sku));
  return { derived, alerts, colRules, dstats, win, ms, onOrder };
}
