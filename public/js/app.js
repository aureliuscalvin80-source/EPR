import { api, subscribe, setUnauthorizedHandler } from "./api.js";
import { parse, evalAst, VARS, colVar } from "./formula.js";
import { evaluate, baseVars, moveStats, coverage, MON_N, ymOf, ymLabel, DEFAULT_SETTINGS } from "./stock.js";
import { detectPlan, detectMonth, monthOfName, hasKodeHeader, taxFromHeader, parseSales, parseStock, parseWorkbook, readProductList } from "./reports.js";
import { fmtRp, fmtN, esc, keyOf, taxLabel, today } from "./util.js";
import { lineAmount, invoiceTotals, paymentState, terbilang, invoiceMessage, invoiceHtml } from "./invoice.js";
import { channelLabel, supplierChannels, waNumber, whatsappUrl, mailtoUrl, telUrl, defaultOrderQty, poMessage, poSubject } from "./contact.js";

/* ---------- state ---------- */
const S = {
  items: {}, rules: [], suppliers: [], pos: [], customers: [], invoices: [], invDem: undefined, users: [], me: null, onOrder: new Map(), files: [], hist: [], dem: {}, moves: [], settings: { ...DEFAULT_SETTINGS }, usage: { bytes: 0 },
  derived: new Map(), alerts: [], colRules: [], dstats: new Map(), win: { PPN: [], NON: [] },
  sort: { k: "sku", d: 1 }, page: 0, per: 100, editKey: null, editRule: null, loaded: false,
};
const $ = (s) => document.querySelector(s);
const nf = (n) => n.toLocaleString("id-ID");
const plural = (n, w) => `${nf(n)} ${w}${n === 1 ? "" : "s"}`;
const initial = (name) => (String(name).match(/[\p{L}\p{N}]/u) || ["?"])[0].toUpperCase();
const supplierOf = (it) => (it.supplierId ? S.suppliers.find((x) => x.id === it.supplierId) : null);
const ledgerChip = (tax) => `<span class="chip ${tax === "PPN" ? "ppn" : "non"}">${taxLabel(tax)}</span>`;

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
}
function setStatus(state, text) {
  $("#syncStatus").textContent = text;
  $("#syncDot").className = "dot" + (state === "live" ? " live" : state === "down" ? " down" : "");
}
const handleErr = (e) => {
  console.error(e);
  toast(e.message || "Could not save. Try again.");
};
const xlsxReady = () => typeof XLSX !== "undefined";

/* ---------- load & recompute ---------- */
async function load() {
  const st = await api.state();
  S.items = st.items;
  S.rules = st.rules;
  S.files = st.files;
  S.hist = st.history;
  S.dem = st.dem;
  S.moves = st.moves;
  S.settings = st.settings;
  S.usage = st.usage;
  S.suppliers = st.suppliers;
  S.pos = st.pos;
  S.customers = st.customers;
  S.invoices = st.invoices;
  S.invDem = st.invDem;
  if (!S.loaded || !document.activeElement?.closest("#page-settings")) { fillSettings(); fillInvoicing(); }
  S.loaded = true;
  recompute();
}
let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => load().catch(handleErr), 120);
}

function recompute() {
  const r = evaluate({ items: S.items, rules: S.rules, moves: S.moves, dem: S.dem, hist: S.hist, settings: S.settings, pos: S.pos, invDem: S.invDem });
  Object.assign(S, { derived: r.derived, alerts: r.alerts, colRules: r.colRules, dstats: r.dstats, win: r.win, onOrder: r.onOrder });
  const drafts = S.pos.filter((p) => p.status === "draft").length;
  $("#poBadge").textContent = drafts;
  $("#poBadge").classList.toggle("zero", !drafts);
  $("#poBadge").title = plural(drafts, "draft order");
  const overdue = S.invoices.filter((i) => invState(i) === "overdue").length;
  $("#invBadge").textContent = overdue;
  $("#invBadge").classList.toggle("zero", !overdue);
  $("#invBadge").title = plural(overdue, "overdue invoice");
  const b = $("#alertBadge");
  b.textContent = S.alerts.length;
  b.classList.toggle("zero", !S.alerts.length);
  renderAll();
}

/* ---------- rendering ---------- */
function renderAll() {
  renderKpis();
  renderInv();
  renderAlerts();
  renderRules();
  renderMoves();
  renderFiles();
  renderCoverage();
  renderDatalist();
  renderSuppliers();
  fillSupplierSelect();
  renderPos();
  refreshPoDialog();
  renderInvoices();
  renderCustomers();
  refreshInvDialog();
  $("#ledgerCount").textContent = nf(Object.keys(S.items).length) + " items";
}

const ICON = {
  box: '<svg viewBox="0 0 24 24"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>',
  empty: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
};

function renderKpis() {
  let vP = 0, vN = 0, nP = 0, nN = 0, zero = 0;
  for (const it of Object.values(S.items)) {
    const v = S.derived.get(it.key)?.vars.value || 0;
    if (it.tax === "PPN") { vP += v; nP++; } else { vN += v; nN++; }
    if ((+it.qty || 0) <= 0) zero++;
  }
  const crit = S.alerts.filter((a) => a.r.severity === "crit").length;
  $("#kpis").innerHTML = [
    ["ppn", ICON.box, "PPN stock value", fmtRp(vP), nf(nP) + " SKUs · excl. PPN"],
    ["non", ICON.box, "Non-PPN stock value", fmtRp(vN), nf(nN) + " SKUs"],
    ["warn", ICON.empty, "Out of stock", nf(zero), "qty ≤ 0"],
    ["crit", ICON.bell, "Alerts", nf(S.alerts.length), crit + " critical"],
  ].map(([c, ic, l, v, s]) => `<div class="kpi"><span class="l"><span class="ic ${c}">${ic}</span>${l}</span><span class="v">${v}</span><span class="s">${s}</span></div>`).join("");
}

function invRows() {
  const q = $("#q").value.trim().toLowerCase();
  const ft = $("#fTax").value, fu = $("#fUnit").value, fa = $("#fAlert").value;
  const rows = Object.values(S.items).filter((it) => {
    if (ft && it.tax !== ft) return false;
    if (fu && it.unit !== fu) return false;
    const d = S.derived.get(it.key);
    if (fa === "any" && !d?.alerts.length) return false;
    if (fa === "crit" && d?.sev !== "crit") return false;
    if (fa === "zero" && (+it.qty || 0) > 0) return false;
    if (q && !(it.sku.toLowerCase().includes(q) || String(it.name || "").toLowerCase().includes(q) || (supplierOf(it)?.company || "").toLowerCase().includes(q))) return false;
    return true;
  });
  const { k, d } = S.sort;
  const val = (it) => {
    if (k.startsWith("col:")) return S.derived.get(it.key)?.cols[k.slice(4)] ?? -Infinity;
    if (k === "value" || k === "price_incl") return S.derived.get(it.key)?.vars[k] ?? 0;
    if (k === "alerts") return S.derived.get(it.key)?.alerts.length || 0;
    if (k === "supplier") return supplierOf(it)?.company || "";
    return it[k];
  };
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true })) * d;
  });
  return rows;
}

function renderInv() {
  const cols = [
    ["sku", "SKU"], ["name", "Product name"], ["tax", "Ledger"], ["unit", "Unit"], ["qty", "Qty", "num"], ["price", "Purchase", "num"], ["sellPrice", "Sell", "num"],
    ["price_incl", "Incl. PPN", "num"], ["value", "Stock value", "num"], ["minStock", "Min", "num"], ["supplier", "Supplier"],
    ...S.colRules.map((r) => ["col:" + r.id, r.name, "num"]), ["alerts", "Alerts"],
  ];
  $("#invTbl thead").innerHTML = "<tr>" + cols.map(([k, l, c]) =>
    `<th data-k="${esc(k)}" class="${c || ""}">${esc(l)}${S.sort.k === k ? `<span class="arrow">${S.sort.d > 0 ? "↑" : "↓"}</span>` : ""}</th>`).join("") + "</tr>";
  const tb = $("#invTbl tbody");
  if (!Object.keys(S.items).length) {
    tb.innerHTML = `<tr><td colspan="${cols.length}"><div class="empty"><strong>No products yet</strong><span>Add one with “Add product”, or import your stock list under Import &amp; settings.</span></div></td></tr>`;
    $("#pager").innerHTML = "";
    return;
  }
  const rows = invRows();
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="${cols.length}"><div class="empty">No items match these filters.</div></td></tr>`;
    $("#pager").innerHTML = "";
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / S.per));
  if (S.page >= pages) S.page = pages - 1;
  const slice = rows.slice(S.page * S.per, (S.page + 1) * S.per);
  const dash = '<span class="muted">—</span>';
  tb.innerHTML = slice.map((it) => {
    const d = S.derived.get(it.key) || { vars: {}, cols: {}, alerts: [] };
    return `<tr data-key="${esc(it.key)}" class="${d.sev ? "sev-" + d.sev : ""}">
      <td class="sku">${esc(it.sku)}</td><td class="name">${esc(it.name)}</td><td>${ledgerChip(it.tax)}</td><td><span class="chip unit">${esc(it.unit)}</span></td>
      <td class="num"><span class="qty ${d.sev}">${fmtN(+it.qty || 0)}</span>${d.vars.on_order ? `<span class="qty-on" title="On order">+${fmtN(d.vars.on_order)}</span>` : ""}</td><td class="num">${fmtRp(+it.price || 0)}</td><td class="num">${it.sellPrice ? fmtRp(+it.sellPrice) : dash}</td>
      <td class="num">${it.tax === "PPN" ? fmtRp(d.vars.price_incl) : dash}</td><td class="num">${fmtRp(d.vars.value)}</td>
      <td class="num">${it.minStock ? fmtN(+it.minStock) : dash}</td>
      <td class="name">${esc(supplierOf(it)?.company || "") || dash}</td>
      ${S.colRules.map((r) => {
        const v = d.cols[r.id];
        return `<td class="num">${v == null ? dash : Number.isNaN(v) ? '<span class="err">err</span>' : fmtN(v)}</td>`;
      }).join("")}
      <td><div class="chips">${d.alerts.map((r) => `<span class="chip ${r.severity}">${esc(r.name)}</span>`).join("")}</div></td></tr>`;
  }).join("");
  $("#pager").innerHTML = `<span class="hint">${nf(S.page * S.per + 1)}–${nf(Math.min(rows.length, (S.page + 1) * S.per))} of ${nf(rows.length)}</span>
    <button class="btn small" data-pg="-1" ${S.page <= 0 ? "disabled" : ""}>Previous</button>
    <button class="btn small" data-pg="1" ${S.page >= pages - 1 ? "disabled" : ""}>Next</button>`;
}

/** What current stock is compared against: the reorder point, or min stock when there is no sales history yet. */
function stockTarget(v) {
  if (v.hist_months > 0 || !v.min_stock) return { label: "Reorder point", val: v.reorder_point };
  return { label: "Min stock", val: v.min_stock };
}
function compareHtml(it, v, sev) {
  const t = stockTarget(v);
  // Shortfall counts stock already on order, so an item on an open order isn't ordered again.
  const gap = t.val - v.inventory_position;
  const u = `<small> ${esc(it.unit)}</small>`;
  return `<div class="compare">
    <div class="cmp now ${sev}"><span class="l">Current stock</span><span class="v">${fmtN(v.qty)}${u}</span>${v.on_order ? `<span class="sub">+${fmtN(v.on_order)} on order</span>` : ""}</div>
    <div class="cmp target"><span class="l">${t.label}</span><span class="v">${fmtN(t.val)}${u}</span></div>
    <div class="cmp gap"><span class="l">${gap > 0 ? "Short by" : "Covered, spare"}</span><span class="v">${fmtN(Math.abs(gap))}${u}</span></div>
  </div>`;
}
/** Open orders (draft, sent, partly received) that include this product. */
const posFor = (key) => S.pos.filter((p) => ["draft", "sent", "partial"].includes(p.status) && p.lines.some((l) => l.itemKey === key));
const poLink = (p) => `<button type="button" class="linklike" data-po="${esc(p.id)}">${esc(p.number)}</button> <span class="chip st-${p.status}">${STATUS[p.status]}</span>`;
function supplierLine(it) {
  const sp = supplierOf(it);
  return sp
    ? `<div class="supline">Supplier <strong>${esc(sp.company)}</strong>${sp.contact ? ` · ${esc(sp.contact)}` : ""}</div>`
    : `<div class="supline"><span class="none">No supplier assigned</span></div>`;
}

function renderAlerts() {
  const el = $("#alertList");
  if (!S.alerts.length) {
    el.innerHTML = `<div class="empty"><strong>No active alerts</strong><span>Alerts appear here when an alert formula is true for an item.</span></div>`;
    return;
  }
  el.innerHTML = S.alerts.slice(0, 500).map(({ it, r }) => {
    const v = S.derived.get(it.key).vars;
    const sev = r.severity;
    const top = Math.max(v.order_up_to, v.reorder_point, v.min_stock, v.qty, 1) * 1.15;
    const pc = (x) => Math.min(100, Math.max(0, (x / top) * 100)).toFixed(1) + "%";
    return `<div class="alert-item">
      <div class="t">
        <div class="row"><span class="chip ${sev}">${sev === "crit" ? "Critical" : "Warning"}</span><span class="mono">${esc(it.sku)}</span>${ledgerChip(it.tax)}</div>
        <div class="nm">${esc(it.name)}</div>
        <div class="hint">${esc(r.name)} · ${v.hist_months ? v.hist_months + " months of history" : "no sales history"} · avg ${fmtN(v.avg_monthly_demand)} ${esc(it.unit)}/month</div>
        ${supplierLine(it)}
        ${posFor(it.key).length ? `<div class="supline">On order: ${posFor(it.key).map(poLink).join(" ")}</div>` : ""}
      </div>
      <div class="side">
        ${compareHtml(it, v, sev)}
        <div class="stockbox ${sev}">
          <div class="gauge" role="img" aria-label="Stock ${fmtN(v.qty)}, safety stock ${fmtN(v.safety_stock)}, reorder point ${fmtN(v.reorder_point)}, min stock ${fmtN(v.min_stock)}">
            <div class="g-fill" style="width:${pc(v.qty)}"></div><i class="g-ss" style="left:${pc(v.safety_stock)}"></i><i class="g-rop" style="left:${pc(v.reorder_point)}"></i>${v.min_stock ? `<i class="g-min" style="left:${pc(v.min_stock)}"></i>` : ""}</div>
          <div class="sb-legend"><span><i class="k-ss"></i>Safety ${fmtN(v.safety_stock)}</span><span><i class="k-rop"></i>Reorder ${fmtN(v.reorder_point)}</span>${v.min_stock ? `<span><i class="k-min"></i>Min ${fmtN(v.min_stock)}</span>` : ""}<span>Suggested order <strong>${fmtN(defaultOrderQty(v))}</strong></span></div>
        </div>
      </div>
      <div class="acts">
        <button class="btn small primary" data-reorder="${esc(it.key)}" data-need="staff"><svg viewBox="0 0 24 24"><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 8H6"/><circle cx="10" cy="20" r="1"/><circle cx="17" cy="20" r="1"/></svg>Reorder</button>
        <button class="btn small" data-open="${esc(it.key)}">Open</button>
      </div>
    </div>`;
  }).join("") + (S.alerts.length > 500 ? `<div class="alert-item hint">Showing the first 500 of ${nf(S.alerts.length)}. Use the Inventory filter “With alerts” to see all.</div>` : "");
}

function renderRules() {
  $("#varList").innerHTML = VARS.map(([k, d]) => `<code>${k}</code><span>${d}</span>`).join("") +
    S.colRules.map((r) => `<code>${esc(colVar(r.name))}</code><span>Column: ${esc(r.name)}</span>`).join("");
  if (!S.rules.length) {
    $("#ruleList").innerHTML = `<div class="card"><div class="empty">No formulas yet. Create one above.</div></div>`;
    return;
  }
  $("#ruleList").innerHTML = S.rules.slice().sort((a, b) => (a.kind > b.kind ? 1 : a.kind < b.kind ? -1 : 0)).map((r) => {
    const hits = r.kind === "alert" ? S.alerts.filter((a) => a.r.id === r.id).length : null;
    const tag = r.kind === "alert" ? `<span class="chip ${r.severity}">${r.severity === "crit" ? "Critical alert" : "Warning alert"}</span>` : `<span class="chip col">Column</span>`;
    return `<div class="rule${r.enabled === false ? " paused" : ""}">
      <div class="row"><h3>${esc(r.name)}</h3>${tag}</div>
      <code>${esc(r.expr)}</code>
      <div class="hint">${r.scope === "ALL" ? "All items" : r.scope === "PPN" ? "PPN only" : "Non-PPN only"}${hits != null ? " · " + nf(hits) + " items triggered" : ""}${r.enabled === false ? " · paused" : ""}</div>
      ${r._err ? `<div class="err">${esc(r._err)}</div>` : ""}
      <div class="row" data-need="admin"><button class="btn small" data-redit="${esc(r.id)}">Edit</button><button class="btn small" data-rtoggle="${esc(r.id)}">${r.enabled === false ? "Resume" : "Pause"}</button><span class="spacer"></span><button class="btn small danger" data-rdel="${esc(r.id)}">Delete</button></div>
    </div>`;
  }).join("");
}

function renderMoves() {
  const tb = $("#mvTbl tbody");
  const cutoff = Date.now() - 30 * 864e5;
  const all = S.moves.filter((e) => e.t >= cutoff);
  if (!all.length) {
    tb.innerHTML = `<tr><td colspan="7"><div class="empty">No movements recorded in the last 30 days.</div></td></tr>`;
    return;
  }
  tb.innerHTML = all.slice(0, 400).map((e) => `<tr>
    <td>${new Date(e.t).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
    <td class="sku">${esc(e.sku)}</td><td>${ledgerChip(e.tax)}</td><td><span class="chip ${e.type.toLowerCase()}">${e.type}</span></td>
    <td class="num">${e.qty > 0 ? "+" : ""}${fmtN(e.qty)}</td><td class="name">${esc(e.note)}</td><td>${esc(e.by || "")}</td></tr>`).join("");
}

const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : nf(Math.max(b ? 1 : 0, Math.round(b / 1024))) + " KB");
const histFor = (fileId) => S.hist.filter((h) => h.fileId === fileId);
function usedAs(f) {
  if (!f.kind || f.kind === "attach") return '<span class="muted">Attachment</span>';
  const hs = histFor(f.id);
  if (f.kind === "workbook") {
    if (!hs.length) return `<span class="chip unit">Workbook</span> ${esc(f.ym)} · <span class="muted">not processed</span>`;
    const err = hs.find((h) => h.check === "error");
    if (err && hs.length === 1) return `<span class="chip unit">Workbook</span> ${esc(f.ym)} · <span class="err">✗ ${esc(err.msg)}</span>`;
    const ok = hs.filter((h) => h.check === "ok").length, bad = hs.filter((h) => h.check === "mismatch").length;
    const months = new Set(hs.map((h) => h.ym)).size;
    return `<span class="chip unit">Workbook</span> ${esc(f.ym)} · ${months} month tabs · ${hs.length} tables: <span class="okmsg">${ok} ✓</span>${hs.length - ok - bad ? ` · <span class="chip warn">${hs.length - ok - bad} ?</span>` : ""}${bad ? ` · <span class="err">${bad} ✗</span>` : ""}
      <div class="hint">${hs.filter((h) => h.kind === "sales").length} sales tables · ${hs.filter((h) => h.kind === "stock").length} stock tables · see Report coverage</div>`;
  }
  const h = hs[0];
  const mark = !h ? '<span class="muted">not processed</span>'
    : h.check === "ok" ? '<span class="okmsg">✓ reconciled</span>'
    : h.check === "error" || h.check === "mismatch" ? `<span class="err">✗ ${esc(h.msg || "total mismatch")}</span>`
    : '<span class="chip warn">? total not verified</span>';
  return `<span class="chip ${f.tax === "PPN" ? "ppn" : "non"}">${f.kind === "sales" ? "Sales" : "Stock"} ${taxLabel(f.tax)}</span> ${esc(ymLabel(f.ym))} · ${mark}
    ${h && h.lines != null && h.check !== "error" ? `<div class="hint">${fmtN(h.lines)} lines · ${fmtN(h.skus || 0)} SKUs · qty ${fmtN(h.qty)} · ${fmtRp(h.rp)}${h.otherUnits ? ` · other units read as PCS: ${esc(h.otherUnits)}` : ""}</div>` : ""}`;
}

function renderFiles() {
  const q = $("#fq").value.trim().toLowerCase();
  const rows = S.files.filter((f) => !q || [f.name, f.sku, f.note, f.ym].join(" ").toLowerCase().includes(q)).sort((a, b) => (b.at || 0) - (a.at || 0));
  $("#fUsage").textContent = `${fmtSize(S.usage.bytes)} stored`;
  const tb = $("#fTbl");
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="7"><div class="empty">${S.files.length ? "No files match." : "No files yet. Upload sales and stock reports, invoices or product photos above."}</div></td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((f) => {
    const sheet = /\.(xlsx|xls|csv)$/i.test(f.name);
    return `<tr>
      <td class="name"><a class="file-link" href="${api.fileUrl(f.id)}">${esc(f.name)}</a></td>
      <td class="name">${usedAs(f)}</td><td class="sku">${esc(f.sku || "")}</td><td class="name">${esc(f.note || "")}</td>
      <td class="num">${fmtSize(f.size || 0)}</td><td>${f.at ? new Date(f.at).toLocaleDateString("id-ID") : ""}</td>
      <td><div class="row" style="flex-wrap:nowrap;gap:6px">
        ${sheet ? `<button class="btn small" data-fpv="${esc(f.id)}">Preview</button>` : ""}
        ${f.kind && f.kind !== "attach" ? `<button class="btn small" data-frp="${esc(f.id)}" data-need="staff">Reprocess</button>` : ""}
        <button class="btn small danger" data-fdel="${esc(f.id)}" data-need="admin">Delete</button></div></td></tr>`;
  }).join("");
}

function renderCoverage() {
  const wrap = $("#covWrap");
  const cov = coverage(S.hist);
  const years = new Set();
  for (const t of ["PPN", "NON"]) for (const k of ["s", "k"]) for (const y of cov[t][k].keys()) years.add(y.slice(0, 4));
  if (!years.size) {
    wrap.innerHTML = `<div class="empty">No reports processed yet. Upload Laporan Penjualan Detail files (PPN and Non-PPN) for at least 6 months, plus the matching Persediaan stock reports.</div>`;
    $("#covHint").textContent = "";
    return;
  }
  const cell = (h) => (!h ? "" : h.check === "ok" ? '<span class="c-ok">✓</span>' : h.check === "mismatch" ? '<span class="c-x">✗</span>' : '<span class="c-q">?</span>');
  let html = `<table><thead><tr><th></th>${MON_N.map((m) => `<th>${m}</th>`).join("")}</tr></thead><tbody>`;
  for (const y of [...years].sort().reverse()) {
    for (const [t, k, l] of [["PPN", "s", "Sales PPN"], ["NON", "s", "Sales Non-PPN"], ["PPN", "k", "Stock PPN"], ["NON", "k", "Stock Non-PPN"]]) {
      html += `<tr><td>${y} · ${l}</td>${MON_N.map((_, i) => `<td>${cell(cov[t][k].get(ymOf(+y, i + 1)))}</td>`).join("")}</tr>`;
    }
  }
  wrap.innerHTML = html + "</tbody></table>";
  const w = (t) => (S.win[t].length ? `${S.win[t].length} months (${ymLabel(S.win[t][S.win[t].length - 1])} – ${ymLabel(S.win[t][0])})` : "none");
  $("#covHint").textContent = `Safety stock uses the last ${S.settings.windowMonths} months with a sales report · PPN: ${w("PPN")} · Non-PPN: ${w("NON")}`;
}

function renderDatalist() {
  const its = Object.values(S.items);
  const sig = its.length + ":" + its.reduce((a, it) => a + it.sku.length, 0);
  if (renderDatalist._sig === sig) return;
  renderDatalist._sig = sig;
  $("#itemList").innerHTML = its.slice(0, 5000).map((it) => `<option value="${esc(it.sku)} · ${it.tax}">${esc(it.name)}</option>`).join("");
}

/* ---------- navigation ---------- */
function showTab(t) {
  document.querySelectorAll(".nav-item").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  document.querySelectorAll(".page").forEach((p) => (p.hidden = p.id !== "page-" + t));
  try { localStorage.setItem("erp.tab", t); } catch {}
  if (location.hash.slice(1) !== t) history.pushState(null, "", "#" + t);
}
document.querySelectorAll(".nav-item").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1);
  if ($("#page-" + t)) showTab(t);
});
try {
  const t = location.hash.slice(1) || localStorage.getItem("erp.tab");
  if (t && $("#page-" + t)) showTab(t);
} catch {}

/* ---------- product dialog ---------- */
function openItem(key) {
  S.editKey = key;
  const it = key ? S.items[key] : { sku: "", name: "", unit: "PCS", qty: 0, price: 0, tax: "PPN", minStock: 0 };
  if (!it) return;
  $("#itemDlgTitle").textContent = key ? "Edit product" : "Add product";
  $("#iSku").value = it.sku;
  $("#iTax").value = it.tax;
  $("#iName").value = it.name;
  $("#iUnit").value = it.unit;
  $("#iQty").value = it.qty;
  $("#iPrice").value = it.price;
  $("#iMin").value = it.minStock || "";
  $("#iSell").value = it.sellPrice || "";
  fillSupplierSelect();
  $("#iSupplier").value = it.supplierId || "";
  $("#iErr").textContent = "";
  $("#iDel").hidden = !key;
  $("#iDelRow").hidden = true;
  $("#iSku").disabled = !!key;
  $("#iTax").disabled = !!key;
  priceHint();
  const fs = key ? S.files.filter((f) => f.sku && f.sku.toLowerCase() === it.sku.toLowerCase()) : [];
  $("#iFiles").innerHTML = fs.length ? "Files: " + fs.map((f) => `<a class="file-link" href="${api.fileUrl(f.id)}">${esc(f.name)}</a>`).join(", ") : "";
  const dv = key ? S.derived.get(key)?.vars : null;
  const dem = $("#iDemand");
  dem.hidden = !dv;
  if (dv) {
    dem.innerHTML = dv.hist_months
      ? `Sales history: ${dv.hist_months} months${dv.stockout_months ? ` (${dv.stockout_months} stock-out months left out)` : ""} · avg ${fmtN(dv.avg_monthly_demand)} ${esc(it.unit)}/month · σ ${fmtN(dv.sd_monthly_demand)}<br>
        Safety stock <strong>${fmtN(dv.safety_stock)}</strong> · reorder point <strong>${fmtN(dv.reorder_point)}</strong> · order up to ${fmtN(dv.order_up_to)} · suggested order <strong>${fmtN(dv.suggested_order)}</strong>
        ${dv.mixed_units ? '<br><span class="err">Also sold in the other unit — check PCS vs SET.</span>' : ""}`
      : "No sales reports uploaded for this ledger yet, so safety stock is 0.";
  }
  $("#itemDlg").showModal();
}
function priceHint() {
  const tax = $("#iTax").value, p = +$("#iPrice").value || 0, r = +S.settings.ppnRate || 0;
  $("#iPriceHint").textContent = tax === "PPN"
    ? S.settings.priceMode === "incl"
      ? `Stored incl. PPN · DPP ${fmtRp(p / (1 + r / 100))} · PPN ${fmtRp(p - p / (1 + r / 100))}`
      : `Stored excl. PPN · incl. PPN ${r}% = ${fmtRp(p * (1 + r / 100))}`
    : "Non-PPN item · no tax added";
}
$("#iPrice").addEventListener("input", priceHint);
$("#iTax").addEventListener("change", priceHint);
$("#iCancel").onclick = $("#iClose").onclick = () => $("#itemDlg").close();
$("#iDel").onclick = () => ($("#iDelRow").hidden = false);
$("#iDelNo").onclick = () => ($("#iDelRow").hidden = true);
$("#iDelYes").onclick = async () => {
  try {
    await api.deleteItem(S.editKey);
    $("#itemDlg").close();
    toast("Product deleted");
    scheduleReload();
  } catch (e) { handleErr(e); }
};
$("#itemForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = { sku: $("#iSku").value.trim(), tax: $("#iTax").value, name: $("#iName").value.trim(), unit: $("#iUnit").value, qty: $("#iQty").value, price: $("#iPrice").value, minStock: $("#iMin").value, sellPrice: $("#iSell").value, supplierId: $("#iSupplier").value };
  if (!body.sku || !body.name) { $("#iErr").textContent = "SKU and product name are required."; return; }
  $("#iSave").disabled = true;
  try {
    if (S.editKey) await api.updateItem(S.editKey, body);
    else await api.createItem(body);
    $("#itemDlg").close();
    toast("Saved");
    scheduleReload();
  } catch (e) {
    $("#iErr").textContent = e.message;
  } finally {
    $("#iSave").disabled = false;
  }
});

/* ---------- inventory events ---------- */
["#q", "#fTax", "#fUnit", "#fAlert"].forEach((s) => $(s).addEventListener("input", () => { S.page = 0; renderInv(); }));
$("#addBtn").onclick = () => openItem(null);
$("#invTbl").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-k]");
  if (th) {
    const k = th.dataset.k;
    S.sort = S.sort.k === k ? { k, d: -S.sort.d } : { k, d: 1 };
    renderInv();
    return;
  }
  const tr = e.target.closest("tr[data-key]");
  if (tr) openItem(tr.dataset.key);
});
$("#pager").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pg]");
  if (!b) return;
  S.page += +b.dataset.pg;
  renderInv();
  window.scrollTo({ top: 0 });
});
$("#alertList").addEventListener("click", (e) => {
  const po = e.target.closest("[data-po]");
  if (po) return openPo(po.dataset.po);
  const ro = e.target.closest("[data-reorder]");
  if (ro) return openReorder(ro.dataset.reorder);
  const b = e.target.closest("[data-open]");
  if (b) openItem(b.dataset.open);
});

/* ---------- stock moves ---------- */
function findItem(v) {
  v = v.trim();
  const m = v.match(/^(.*?)\s*·\s*(PPN|NON)$/i);
  if (m) return S.items[keyOf(m[2].toUpperCase(), m[1].trim())];
  const c = Object.values(S.items).filter((it) => it.sku.toLowerCase() === v.toLowerCase());
  return c.length === 1 ? c[0] : null;
}
$("#mvSave").onclick = async () => {
  const msg = $("#mvMsg");
  msg.className = "hint";
  const it = findItem($("#mvItem").value);
  if (!it) {
    msg.className = "err";
    msg.textContent = "Pick a product from the list. If the SKU exists in both ledgers, choose the one with · PPN or · NON.";
    return;
  }
  if ($("#mvQty").value === "" || !(+$("#mvQty").value >= 0)) {
    msg.className = "err";
    msg.textContent = "Enter a quantity.";
    return;
  }
  $("#mvSave").disabled = true;
  try {
    const r = await api.addMove({ key: it.key, type: $("#mvType").value, qty: +$("#mvQty").value, note: $("#mvNote").value.trim() });
    msg.className = "okmsg";
    msg.textContent = `${r.sku}: ${fmtN(r.from)} → ${fmtN(r.to)} ${r.unit}`;
    $("#mvQty").value = "";
    $("#mvNote").value = "";
    scheduleReload();
  } catch (e) {
    msg.className = "err";
    msg.textContent = e.message;
  } finally {
    $("#mvSave").disabled = false;
  }
};

/* ---------- formulas ---------- */
const syncSev = () => ($("#rSevWrap").hidden = $("#rKind").value !== "alert");
$("#rKind").onchange = () => { syncSev(); testRule(); };
$("#rScope").onchange = testRule;
function testRule() {
  const el = $("#rTest"), src = $("#rExpr").value.trim();
  el.className = "hint";
  if (!src) { el.textContent = "Write a formula to see how many items it matches."; return null; }
  let ast;
  try { ast = parse(src); } catch (e) { el.className = "err"; el.textContent = e.message; return null; }
  const ms = moveStats(S.moves), scope = $("#rScope").value, kind = $("#rKind").value;
  let n = 0, hit = 0, sample = null, err = null;
  for (const it of Object.values(S.items)) {
    if (scope !== "ALL" && it.tax !== scope) continue;
    n++;
    const V = baseVars(it, ms, S.dstats.get(it.key), S.settings, S.onOrder.get(it.key) || 0);
    for (const r of S.colRules) {
      if (r._ast && r.id !== S.editRule) { try { V[colVar(r.name)] = evalAst(r._ast, V); } catch {} }
    }
    try {
      const v = evalAst(ast, V);
      if (kind === "alert" ? v : true) hit++;
      if (sample == null) sample = { sku: it.sku, v };
    } catch (e) { err = e.message; break; }
  }
  if (err) { el.className = "err"; el.textContent = err; return null; }
  el.className = "okmsg";
  el.textContent = kind === "alert" ? `Valid · would trigger on ${nf(hit)} of ${nf(n)} items` : `Valid${sample ? ` · e.g. ${sample.sku} → ${fmtN(sample.v)}` : ""}`;
  return ast;
}
$("#rExpr").addEventListener("input", () => { clearTimeout(testRule._t); testRule._t = setTimeout(testRule, 250); });
function resetRuleForm() {
  S.editRule = null;
  $("#rName").value = "";
  $("#rExpr").value = "";
  $("#rKind").value = "alert";
  $("#rScope").value = "ALL";
  $("#rSev").value = "warn";
  $("#ruleFormTitle").textContent = "New formula";
  $("#rCancel").hidden = true;
  syncSev();
  testRule();
}
$("#rCancel").onclick = resetRuleForm;
$("#rSave").onclick = async () => {
  const name = $("#rName").value.trim();
  if (!name) { $("#rTest").className = "err"; $("#rTest").textContent = "Give the formula a name."; return; }
  if (!testRule()) return;
  const data = { name, kind: $("#rKind").value, scope: $("#rScope").value, severity: $("#rSev").value, expr: $("#rExpr").value.trim() };
  try {
    if (S.editRule) await api.updateRule(S.editRule, data);
    else await api.createRule(data);
    toast("Formula saved");
    resetRuleForm();
    scheduleReload();
  } catch (e) { handleErr(e); }
};
$("#ruleList").addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  try {
    if (t.dataset.redit) {
      const r = S.rules.find((x) => x.id === t.dataset.redit);
      if (!r) return;
      S.editRule = r.id;
      $("#rName").value = r.name;
      $("#rExpr").value = r.expr;
      $("#rKind").value = r.kind;
      $("#rScope").value = r.scope;
      $("#rSev").value = r.severity || "warn";
      $("#ruleFormTitle").textContent = "Edit formula";
      $("#rCancel").hidden = false;
      syncSev();
      testRule();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (t.dataset.rtoggle) {
      const r = S.rules.find((x) => x.id === t.dataset.rtoggle);
      await api.setRuleEnabled(r.id, r.enabled === false);
      scheduleReload();
    } else if (t.dataset.rdel) {
      if (t.dataset.confirm !== "1") { t.dataset.confirm = "1"; t.textContent = "Confirm delete"; return; }
      await api.deleteRule(t.dataset.rdel);
      toast("Formula deleted");
      scheduleReload();
    }
  } catch (er) { handleErr(er); }
});
syncSev();

/* ---------- files & reports ---------- */
const sheetRowsOf = (wb, name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true });
// CSV cells stay text (raw) so Indonesian numbers like "1.500" reach toNum() instead of SheetJS reading them as 1.5.
const readWb = (buf, name) => XLSX.read(buf, /\.csv$/i.test(name) ? { type: "array", raw: true } : { type: "array" });
function firstSheetRows(buf, name) {
  if (!xlsxReady()) throw Error("Spreadsheet reader did not load");
  const wb = readWb(buf, name);
  return sheetRowsOf(wb, wb.SheetNames[0]);
}

let plan = [];
function renderPlan() {
  $("#fPlanWrap").hidden = !plan.length;
  $("#fPlan").innerHTML = plan.map((p, i) => {
    const kindSel = `<select data-pi="${i}" data-pf="kind" aria-label="Use as">${[["attach", "Attachment"], ["workbook", "Yearly workbook (stock + sales per month tab)"], ["sales", "Sales report (one month)"], ["stock", "Stock report (one month)"]]
      .map(([v, l]) => `<option value="${v}"${p.kind === v ? " selected" : ""}>${l}</option>`).join("")}</select>`;
    const ledger = p.kind === "workbook" ? '<span class="hint">Both, from table titles</span>'
      : `<select data-pi="${i}" data-pf="tax" aria-label="Ledger" ${p.kind === "attach" ? "disabled" : ""}><option value="PPN"${p.tax === "PPN" ? " selected" : ""}>PPN</option><option value="NON"${p.tax === "NON" ? " selected" : ""}>Non-PPN</option></select>`;
    const yOk = /^\d{4}$/.test(p.ym), mOk = /^\d{4}-\d{2}$/.test(p.ym);
    const when = p.kind === "workbook"
      ? `<input type="number" min="2000" max="2100" step="1" placeholder="Year" data-pi="${i}" data-pf="ym" value="${yOk ? esc(p.ym) : ""}" aria-label="Workbook year" style="width:96px" class="${yOk ? "" : "missing"}">`
      : `<input type="month" data-pi="${i}" data-pf="ym" value="${mOk ? esc(p.ym) : ""}" aria-label="Report month" ${p.kind === "attach" ? "disabled" : ""} class="${p.kind !== "attach" && !mOk ? "missing" : ""}">`;
    return `<tr><td class="name">${esc(p.file.name)}</td><td>${kindSel}</td><td>${ledger}</td><td>${when}</td></tr>`;
  }).join("");
}
$("#fPlan").addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.pi == null) return;
  const p = plan[+t.dataset.pi];
  if (t.dataset.pf === "kind" && t.value !== p.kind) {
    p.ym = t.value === "workbook" ? (p.file.name.match(/20\d{2}/) || [""])[0] : t.value === "attach" ? "" : detectMonth(p.file.name);
  }
  p[t.dataset.pf] = t.value;
  renderPlan();
});
$("#fInput").addEventListener("change", async () => {
  plan = [...$("#fInput").files].map((file) => ({ file, ...detectPlan(file.name) }));
  renderPlan();
  $("#fMsg").textContent = "";
  // Look inside Excel files: a workbook with month tabs, or the company name revealing the ledger.
  for (const p of plan) {
    if (!/\.(xlsx|xls)$/i.test(p.file.name) || !xlsxReady()) continue;
    try {
      const wb = XLSX.read(await p.file.arrayBuffer(), { type: "array" });
      const monthTabs = wb.SheetNames.filter(monthOfName);
      if (monthTabs.length && hasKodeHeader(sheetRowsOf(wb, monthTabs[0]))) {
        p.kind = "workbook";
        let y = (p.file.name.match(/20\d{2}/) || [""])[0];
        if (!y) y = (sheetRowsOf(wb, monthTabs[0]).slice(0, 4).map((r) => r.join(" ")).join(" ").match(/20\d{2}/) || [""])[0];
        p.ym = y;
        continue;
      }
      if (p.kind === "attach" || p.taxSure) continue;
      p.tax = taxFromHeader(sheetRowsOf(wb, wb.SheetNames[0])) || p.tax;
    } catch {}
  }
  renderPlan();
});

/** Parse reports in the browser, then send the results to the server to store. */
async function processReports(list) {
  const results = [];
  for (const e of list) {
    try {
      if (e.kind === "workbook") {
        if (!xlsxReady()) throw Error("Spreadsheet reader did not load");
        const wb = readWb(e.buf, e.name);
        const sheets = wb.SheetNames.filter(monthOfName).map((name) => ({ name, rows: sheetRowsOf(wb, name) }));
        for (const p of parseWorkbook(sheets, e.ym)) results.push({ fileId: e.fileId, name: e.name + " · " + p.tab, histId: `${e.fileId}~${p.ym}~${p.kind}~${p.tax}`, ...p });
      } else {
        const rows = firstSheetRows(e.buf, e.name);
        results.push({ fileId: e.fileId, name: e.name, kind: e.kind, tax: e.tax, ym: e.ym, histId: e.fileId, ...(e.kind === "sales" ? parseSales(rows, e.tax) : parseStock(rows)) });
      }
    } catch (err) {
      results.push({ fileId: e.fileId, name: e.name, kind: e.kind, tax: e.tax, ym: e.ym, histId: e.fileId, check: "error", msg: err.message || "could not read file" });
    }
  }
  const r = await api.applyReports(results, $("#fSetStock").checked);
  return r.message;
}

$("#fq").addEventListener("input", renderFiles);
$("#fUpload").onclick = async () => {
  const msg = $("#fMsg");
  if (!plan.length) { msg.className = "err"; msg.textContent = "Choose at least one file."; return; }
  const missing = plan.filter((p) => (p.kind === "workbook" ? !/^\d{4}$/.test(p.ym) : p.kind !== "attach" && !/^\d{4}-\d{2}$/.test(p.ym)));
  if (missing.length) { msg.className = "err"; msg.textContent = "Set the year or month for: " + missing.map((p) => p.file.name).join(", "); return; }
  $("#fUpload").disabled = true;
  let ok = 0;
  const fails = [], toProcess = [];
  for (const p of plan) {
    const f = p.file;
    try {
      if (f.size > 15 * 1048576) throw Error("over 15 MB");
      msg.className = "hint";
      msg.textContent = `Uploading ${f.name}…`;
      const rep = p.kind !== "attach";
      const { id } = await api.uploadFile(f, { sku: $("#fSku").value.split("·")[0].trim(), note: $("#fNote").value.trim(), kind: p.kind, tax: rep && p.kind !== "workbook" ? p.tax : "", ym: rep ? p.ym : "" });
      ok++;
      if (rep) toProcess.push({ fileId: id, name: f.name, kind: p.kind, tax: p.tax, ym: p.ym, buf: await f.arrayBuffer() });
    } catch (e) {
      fails.push(`${f.name} (${e.message})`);
    }
  }
  let rep = "";
  if (toProcess.length) {
    msg.textContent = `Reading ${toProcess.length} report(s)…`;
    try { rep = await processReports(toProcess); } catch (e) { handleErr(e); rep = "Reports uploaded but not processed. Use Reprocess on each file."; }
  }
  $("#fUpload").disabled = false;
  $("#fInput").value = "";
  plan = [];
  renderPlan();
  msg.className = fails.length ? "err" : "okmsg";
  msg.textContent = `${ok} uploaded` + (fails.length ? ` · not uploaded: ${fails.join(", ")}` : "") + (rep ? " · " + rep : "");
  scheduleReload();
};
$("#fTbl").addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const id = t.dataset.fdel || t.dataset.fpv || t.dataset.frp;
  const f = S.files.find((x) => x.id === id);
  if (!f) return;
  if (t.dataset.fpv) {
    try {
      const rows = firstSheetRows(await api.fileBuffer(f.id), f.name).slice(0, 40);
      $("#pvTitle").textContent = f.name;
      $("#pvBody").innerHTML = `<table><tbody>${rows.map((r, i) => `<tr><td class="muted">${i + 1}</td>${r.slice(0, 30).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      $("#pvDlg").showModal();
    } catch { toast("Could not open this file for preview."); }
  }
  if (t.dataset.frp) {
    t.disabled = true;
    try {
      toast(await processReports([{ fileId: f.id, name: f.name, kind: f.kind, tax: f.tax, ym: f.ym, buf: await api.fileBuffer(f.id) }]));
      scheduleReload();
    } catch (er) { handleErr(er); } finally { t.disabled = false; }
  }
  if (t.dataset.fdel) {
    if (t.dataset.confirm !== "1") { t.dataset.confirm = "1"; t.textContent = "Confirm"; return; }
    try { await api.deleteFile(f.id); toast("File deleted"); scheduleReload(); } catch (er) { handleErr(er); }
  }
});
$("#pvClose").onclick = () => $("#pvDlg").close();

/* ---------- import products ---------- */
let impRows = null;
$("#impFile").onchange = async () => {
  const f = $("#impFile").files[0], pv = $("#impPreview");
  impRows = null;
  $("#impGo").disabled = true;
  pv.className = "hint";
  pv.textContent = "";
  if (!f) return;
  if (!xlsxReady()) { pv.className = "err"; pv.textContent = "The spreadsheet reader did not load. Check your internet connection and reload."; return; }
  try {
    const raw = firstSheetRows(await f.arrayBuffer(), f.name);
    const res = readProductList(raw, $("#impTax").value);
    if (res.error) { pv.className = "err"; pv.textContent = res.error; return; }
    impRows = res.rows;
    const upd = impRows.filter((r) => S.items[keyOf(r.tax, r.sku)]).length;
    pv.className = "okmsg";
    pv.innerHTML = `${nf(impRows.length)} rows ready · ${nf(impRows.length - upd)} new, ${nf(upd)} update existing${res.skipped ? ` · ${res.skipped} rows skipped (no SKU)` : ""}${res.merged ? ` · ${res.merged} duplicate SKUs merged` : ""}<br><span class="hint">Columns used: ${esc(res.columns.join(", "))}</span>`;
    $("#impGo").disabled = false;
  } catch (e) {
    console.error(e);
    pv.className = "err";
    pv.textContent = "Could not read this file. Check it opens in Excel, or save it as CSV.";
  }
};
$("#impTax").onchange = () => { if ($("#impFile").files[0]) $("#impFile").onchange(); };
$("#impGo").onclick = async () => {
  if (!impRows) return;
  $("#impGo").disabled = true;
  try {
    const r = await api.importItems(impRows);
    $("#impPreview").className = "okmsg";
    $("#impPreview").textContent = `Imported ${nf(r.imported)} products.`;
    impRows = null;
    $("#impFile").value = "";
    scheduleReload();
  } catch (e) {
    $("#impPreview").className = "err";
    $("#impPreview").textContent = e.message + " Nothing was imported; fix the file and try again.";
    $("#impGo").disabled = false;
  }
};

/* ---------- settings ---------- */
function fillSettings() {
  $("#sPpn").value = S.settings.ppnRate;
  $("#sLead").value = S.settings.leadTime;
  $("#sPriceMode").value = S.settings.priceMode;
  $("#sReview").value = S.settings.reviewDays;
  $("#sService").value = S.settings.serviceLevel;
  $("#sWindow").value = S.settings.windowMonths;
}
$("#sSave").onclick = async () => {
  const m = $("#sMsg");
  try {
    await api.saveSettings({ ppnRate: $("#sPpn").value, leadTime: $("#sLead").value, priceMode: $("#sPriceMode").value, reviewDays: $("#sReview").value, serviceLevel: $("#sService").value, windowMonths: $("#sWindow").value });
    m.className = "okmsg";
    m.textContent = "Saved";
    S.loaded = false; // refill the form with the values the server stored (they may be clamped)
    scheduleReload();
  } catch (e) {
    m.className = "err";
    m.textContent = e.message;
  }
};

/* ---------- export ---------- */
function exportXlsx(rows, filename) {
  if (!xlsxReady()) { toast("Spreadsheet writer did not load."); return; }
  if (!rows.length) { toast("Nothing to export."); return; }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Data");
  XLSX.writeFile(wb, filename);
}
$("#expAll").onclick = () => exportXlsx(Object.values(S.items).map((it) => {
  const d = S.derived.get(it.key);
  const o = { SKU: it.sku, Name: it.name, Ledger: taxLabel(it.tax), Unit: it.unit, Qty: +it.qty || 0, Price: +it.price || 0,
    "Price incl PPN": it.tax === "PPN" ? Math.round(d.vars.price_incl) : "", "Stock value (excl PPN)": Math.round(d.vars.value), "Min stock": +it.minStock || 0, "Sell price": +it.sellPrice || 0, Supplier: supplierOf(it)?.company || "" };
  for (const r of S.colRules) o[r.name] = d.cols[r.id];
  o.Alerts = d.alerts.map((r) => r.name).join("; ");
  return o;
}), `stock-ledger-${today()}.xlsx`);
const exportAlerts = () => exportXlsx(S.alerts.map(({ it, r }) => {
  const v = S.derived.get(it.key).vars;
  return { Severity: r.severity === "crit" ? "Critical" : "Warning", Alert: r.name, SKU: it.sku, Name: it.name, Ledger: taxLabel(it.tax), Unit: it.unit, Supplier: supplierOf(it)?.company || "",
    "Current stock": v.qty, "Safety stock": v.safety_stock, "Reorder point": v.reorder_point, "Suggested order": v.suggested_order,
    "Days of cover": v.days_cover >= 9999 ? "no sales" : Math.round(v.days_cover) };
}), `stock-alerts-${today()}.xlsx`);
$("#expAlerts").onclick = exportAlerts;
$("#expAlerts2").onclick = exportAlerts;

$("#clearDemo").onclick = async () => {
  const b = $("#clearDemo");
  const n = Object.values(S.items).filter((it) => it.sku.startsWith("DEMO-")).length + S.suppliers.filter((x) => x.company.startsWith("[Demo]")).length;
  if (!n) { toast("No examples left."); return; }
  if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = `Confirm: remove ${n}`; return; }
  try {
    await api.removeDemo();
    toast("Examples removed");
    scheduleReload();
  } catch (e) { handleErr(e); }
  b.dataset.confirm = "";
  b.textContent = "Remove examples";
};

/* ---------- suppliers ---------- */
function fillSupplierSelect() {
  const sel = $("#iSupplier");
  const cur = sel.value;
  sel.innerHTML = `<option value="">— No supplier —</option>` + S.suppliers.map((x) => `<option value="${esc(x.id)}">${esc(x.company)}</option>`).join("");
  sel.value = S.suppliers.some((x) => x.id === cur) ? cur : "";
}
function contactHref(sp, ch) {
  if (ch === "whatsapp") return "https://wa.me/" + waNumber(sp.whatsapp);
  if (ch === "email") return "mailto:" + sp.email;
  if (ch === "phone") return telUrl(sp.phone);
  return null; // WeChat has no web link; the ID is copied instead
}
function contactRows(sp) {
  return supplierChannels(sp).map((ch) => {
    const href = contactHref(sp, ch);
    const inner = `<span class="ch">${channelLabel(ch)}</span><span class="val">${esc(sp[ch])}</span>${sp.preferred === ch ? '<span class="chip col pref">Preferred</span>' : ""}`;
    return href
      ? `<a class="contact" href="${esc(href)}" ${ch === "whatsapp" ? 'target="_blank" rel="noopener"' : ""}>${inner}</a>`
      : `<button type="button" class="contact" data-copy="${esc(sp[ch])}" title="Copy WeChat ID" style="font:inherit;text-align:left;cursor:copy">${inner}</button>`;
  }).join("");
}
function renderSuppliers() {
  const q = $("#supQ").value.trim().toLowerCase();
  const counts = new Map();
  for (const it of Object.values(S.items)) if (it.supplierId) counts.set(it.supplierId, (counts.get(it.supplierId) || 0) + 1);
  const unassigned = Object.values(S.items).filter((it) => !it.supplierId).length;
  $("#supSummary").textContent = `${plural(S.suppliers.length, "supplier")} · ${plural(unassigned, "product")} without a supplier`;
  const rows = S.suppliers.filter((x) => !q || [x.company, x.contact, x.whatsapp, x.wechat, x.email, x.phone].join(" ").toLowerCase().includes(q));
  const el = $("#supList");
  if (!S.suppliers.length) {
    el.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty"><strong>No suppliers yet</strong><span>Add your suppliers, then pick one on each product so “Reorder” knows who to contact.</span></div></div>`;
    return;
  }
  if (!rows.length) { el.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty">No suppliers match.</div></div>`; return; }
  el.innerHTML = rows.map((x) => `<div class="sup-card" id="sup-${esc(x.id)}">
    <div class="sup-head"><span class="avatar">${esc(initial(x.company))}</span>
      <div class="t"><h3>${esc(x.company)}</h3><div class="pic">${x.contact ? "PIC: " + esc(x.contact) : "No person in charge"}</div></div>
      <button class="btn small" data-sedit="${esc(x.id)}" data-need="staff">Edit</button></div>
    <div class="contacts">${contactRows(x)}</div>
    ${x.notes ? `<div class="hint">${esc(x.notes)}</div>` : ""}
    <div class="sup-foot"><span>${plural(counts.get(x.id) || 0, "product")}</span>${counts.get(x.id) ? `<span class="spacer"></span><button class="btn small" data-sitems="${esc(x.company)}">View products</button>` : ""}</div>
  </div>`).join("");
}
$("#supQ").addEventListener("input", renderSuppliers);
async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
  catch { toast(`Could not copy. Select the text and copy it manually.`); }
}
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-copy]");
  if (c) copyText(c.dataset.copy, "WeChat ID");
});
$("#supList").addEventListener("click", (e) => {
  const ed = e.target.closest("[data-sedit]");
  if (ed) return openSupplier(ed.dataset.sedit);
  const v = e.target.closest("[data-sitems]");
  if (v) { $("#q").value = v.dataset.sitems; S.page = 0; showTab("inventory"); renderInv(); }
});

let supEdit = null, supReturn = null;
function openSupplier(id, onSaved = null) {
  supEdit = id;
  supReturn = onSaved;
  const x = id ? S.suppliers.find((y) => y.id === id) : {};
  $("#supDlgTitle").textContent = id ? "Edit supplier" : "Add supplier";
  for (const [f, el] of [["company", "#sCompany"], ["contact", "#sContact"], ["whatsapp", "#sWhatsapp"], ["wechat", "#sWechat"], ["email", "#sEmail"], ["phone", "#sPhone"], ["preferred", "#sPreferred"], ["notes", "#sNotes"]]) $(el).value = x[f] || "";
  $("#supErr").textContent = "";
  $("#supDel").hidden = !id;
  $("#supDelRow").hidden = true;
  $("#supDlg").showModal();
}
$("#supAdd").onclick = () => openSupplier(null);
$("#supCancel").onclick = $("#supClose").onclick = () => $("#supDlg").close();
$("#supDel").onclick = () => {
  const n = Object.values(S.items).filter((it) => it.supplierId === supEdit).length;
  $("#supDelText").textContent = n ? `Delete this supplier? ${n} product(s) will have no supplier.` : "Delete this supplier?";
  $("#supDelRow").hidden = false;
};
$("#supDelNo").onclick = () => ($("#supDelRow").hidden = true);
$("#supDelYes").onclick = async () => {
  try { await api.deleteSupplier(supEdit); $("#supDlg").close(); toast("Supplier deleted"); scheduleReload(); }
  catch (e) { $("#supErr").textContent = e.message; }
};
$("#supForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = { company: $("#sCompany").value, contact: $("#sContact").value, whatsapp: $("#sWhatsapp").value, wechat: $("#sWechat").value, email: $("#sEmail").value, phone: $("#sPhone").value, preferred: $("#sPreferred").value, notes: $("#sNotes").value };
  $("#supSave").disabled = true;
  try {
    const r = supEdit ? (await api.updateSupplier(supEdit, body), { id: supEdit }) : await api.createSupplier(body);
    $("#supDlg").close();
    toast("Supplier saved");
    await load();
    if (supReturn) supReturn(r.id);
  } catch (e) {
    $("#supErr").textContent = e.message;
  } finally {
    $("#supSave").disabled = false;
  }
});

/* ---------- reorder: add to a purchase order ---------- */
const STATUS = { draft: "Draft", sent: "Sent", partial: "Partly received", received: "Received", closed: "Closed short", cancelled: "Cancelled" };
let roKey = null;
function openReorder(key) {
  roKey = key;
  const it = S.items[key];
  if (!it) return;
  const d = S.derived.get(key);
  $("#roTitle").textContent = `Reorder ${it.sku}`;
  $("#roSub").textContent = it.name + " · " + taxLabel(it.tax);
  $("#roCompare").innerHTML = compareHtml(it, d.vars, d.sev || "");
  const open = posFor(key);
  $("#roOnOrder").innerHTML = open.length
    ? `<div class="onorder"><span>Already on ${open.length === 1 ? "an open order" : "open orders"}:</span>${open.map((p) => {
        const l = p.lines.find((x) => x.itemKey === key);
        return `<span>${poLink(p)} · ${fmtN(l.qty - l.received)} ${esc(it.unit)}${p.status === "draft" ? " (not sent yet)" : " still to come"}</span>`;
      }).join("")}</div>`
    : "";
  $("#roQty").value = defaultOrderQty(d.vars) || "";
  renderReorderSupplier();
  $("#roDlg").showModal();
}
function renderReorderSupplier() {
  const it = S.items[roKey];
  const sp = supplierOf(it);
  const box = $("#roSupplier");
  if (!sp) {
    box.innerHTML = `<div class="ro-sup"><strong>No supplier assigned to ${esc(it.sku)}</strong>
      ${S.suppliers.length ? `<div class="field"><label for="roPick">Assign a supplier</label><select id="roPick"><option value="">Choose…</option>${S.suppliers.map((x) => `<option value="${esc(x.id)}">${esc(x.company)}</option>`).join("")}</select></div>` : `<span class="hint">You have no suppliers yet.</span>`}
      <div><button type="button" class="btn small" id="roNewSup">Add a new supplier</button></div></div>`;
    $("#roActions").innerHTML = `<span class="spacer"></span><button type="button" class="btn" data-ro="cancel">Cancel</button>`;
    $("#roNote").textContent = "";
    $("#roPick")?.addEventListener("change", (e) => e.target.value && assignReorderSupplier(e.target.value));
    $("#roNewSup").onclick = () => { $("#roDlg").close(); openSupplier(null, (id) => assignReorderSupplier(id, true)); };
    return;
  }
  box.innerHTML = `<div class="ro-sup">
    <div class="sup-head"><span class="avatar">${esc(initial(sp.company))}</span>
      <div class="t"><h3>${esc(sp.company)}</h3><div class="pic">${sp.contact ? "PIC: " + esc(sp.contact) : "No person in charge"}</div></div>
      <button type="button" class="btn small" id="roViewSup">View supplier</button></div></div>`;
  $("#roViewSup").onclick = () => {
    $("#roDlg").close();
    showTab("suppliers");
    $("#supQ").value = "";
    renderSuppliers();
    const card = document.getElementById("sup-" + sp.id);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    card?.classList.add("flash");
    setTimeout(() => card?.classList.remove("flash"), 1800);
  };
  const draft = S.pos.find((p) => p.status === "draft" && p.supplierId === sp.id);
  $("#roNote").textContent = draft
    ? `Will be added to draft ${draft.number} for ${sp.company} (${plural(draft.lines.length, "line")} so far). Send it from Purchase orders when it's complete.`
    : `A new draft order will be started for ${sp.company}. Add other items, then send it from Purchase orders.`;
  $("#roActions").innerHTML = `<span class="spacer"></span><button type="button" class="btn" data-ro="cancel">Cancel</button>
    <button type="button" class="btn" data-ro="open">Add &amp; open order</button><button type="button" class="btn primary" data-ro="add">Add to order</button>`;
}
async function assignReorderSupplier(id, reopen = false) {
  try {
    await api.setItemSupplier(roKey, id);
    await load();
    toast("Supplier assigned");
    if (reopen) openReorder(roKey);
    else renderReorderSupplier();
  } catch (e) { handleErr(e); }
}
$("#roClose").onclick = () => $("#roDlg").close();
$("#roActions").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ro]");
  if (!b) return;
  if (b.dataset.ro === "cancel") return $("#roDlg").close();
  const it = S.items[roKey], qty = +$("#roQty").value;
  if (!(qty > 0)) { toast("Enter an order quantity first."); $("#roQty").focus(); return; }
  b.disabled = true;
  try {
    const r = await api.poAddLine(roKey, qty);
    $("#roDlg").close();
    toast(`${it.sku}: ${fmtN(qty)} ${it.unit} ${r.merged ? "added to the line on" : "added to"} ${r.number}`);
    await load();
    if (b.dataset.ro === "open") openPo(r.id);
  } catch (er) { handleErr(er); } finally { b.disabled = false; }
});
$("#roOnOrder").addEventListener("click", (e) => {
  const po = e.target.closest("[data-po]");
  if (po) { $("#roDlg").close(); openPo(po.dataset.po); }
});

/* ---------- purchase orders ---------- */
let poFilter = "open";
const poTotal = (lines) => lines.reduce((a, l) => a + l.qty * l.price, 0);
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }) : "");
const supplierById = (id) => S.suppliers.find((x) => x.id === id);
function renderPos() {
  const match = { open: ["draft", "sent", "partial"], draft: ["draft"], sent: ["sent", "partial"], done: ["received", "closed", "cancelled"], all: Object.keys(STATUS) }[poFilter];
  const rows = S.pos.filter((p) => match.includes(p.status));
  const tb = $("#poTbl tbody");
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="8"><div class="empty">${S.pos.length ? "No orders here." : `<strong>No purchase orders yet</strong><span>Use “Reorder” on an alert, or “New order”, to start one.</span>`}</div></td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((p) => {
    const sp = supplierById(p.supplierId);
    const ord = p.lines.reduce((a, l) => a + l.qty, 0), rec = p.lines.reduce((a, l) => a + l.received, 0);
    const pct = ord ? Math.round((rec / ord) * 100) : 0;
    return `<tr data-po="${esc(p.id)}"><td class="sku">${esc(p.number)}</td><td class="name">${esc(sp?.company || "—")}</td>
      <td><span class="chip st-${p.status}">${STATUS[p.status]}</span></td><td class="num">${p.lines.length}</td><td class="num">${fmtRp(poTotal(p.lines))}</td>
      <td>${p.status === "draft" ? '<span class="muted">—</span>' : `<span class="progress"><span class="bar"><i style="width:${pct}%"></i></span>${pct}%</span>`}</td>
      <td>${fmtDate(p.createdAt)}<div class="hint">${esc(p.createdBy)}</div></td><td>${p.sentAt ? fmtDate(p.sentAt) + `<div class="hint">${esc(channelLabel(p.sentVia) === "other" ? "" : channelLabel(p.sentVia))}</div>` : '<span class="muted">—</span>'}</td></tr>`;
  }).join("");
}
$("#poSeg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  poFilter = b.dataset.f;
  $("#poSeg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  renderPos();
});
$("#poTbl").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-po]");
  if (tr) openPo(tr.dataset.po);
});
$("#poNew").onclick = () => {
  if (!S.suppliers.length) { toast("Add a supplier first."); showTab("suppliers"); return; }
  $("#poNewPick").innerHTML = `<option value="">Choose a supplier…</option>` + S.suppliers.map((x) => `<option value="${esc(x.id)}">${esc(x.company)}</option>`).join("");
  $("#poNewDlg").showModal();
};
$("#poNewCancel").onclick = () => $("#poNewDlg").close();
$("#poNewGo").onclick = async () => {
  const id = $("#poNewPick").value;
  if (!id) { toast("Choose a supplier."); return; }
  const existing = S.pos.find((p) => p.status === "draft" && p.supplierId === id);
  try {
    const r = existing ? { id: existing.id } : await api.poCreate(id);
    $("#poNewDlg").close();
    if (existing) toast(`${existing.number} is already a draft for this supplier. Add to it.`);
    await load();
    openPo(r.id);
  } catch (e) { handleErr(e); }
};

// The dialog edits a local copy of a draft; nothing is saved until "Save" or "Send".
let poId = null, poEdit = null, poDirty = false, poSendOpen = false;
const canEdit = () => S.me && S.me.role !== "viewer";
function openPo(id) {
  poId = id;
  poEdit = null;
  poDirty = false;
  poSendOpen = false;
  $("#poErr").textContent = "";
  renderPoDialog();
  if (!$("#poDlg").open) $("#poDlg").showModal();
}
function refreshPoDialog() {
  if (!$("#poDlg").open || !poId) return;
  if (!S.pos.some((p) => p.id === poId)) { $("#poDlg").close(); toast("That order was deleted."); return; }
  if (!poDirty) { poEdit = null; renderPoDialog(); }
}
function renderPoDialog() {
  const p = S.pos.find((x) => x.id === poId);
  if (!p) return;
  const sp = supplierById(p.supplierId);
  const draft = p.status === "draft", receiving = p.status === "sent" || p.status === "partial";
  if (draft && !poEdit) poEdit = { lines: p.lines.map((l) => ({ ...l })), note: p.note };
  const lines = draft ? poEdit.lines : p.lines;
  $("#poTitle").innerHTML = `${esc(p.number)} <span class="chip st-${p.status}">${STATUS[p.status]}</span>`;
  $("#poMeta").textContent = [`Created ${fmtDate(p.createdAt)}${p.createdBy ? " by " + p.createdBy : ""}`, p.sentAt ? `sent ${fmtDate(p.sentAt)}${p.sentVia && p.sentVia !== "other" ? " via " + channelLabel(p.sentVia) : ""}` : "", p.closedAt ? `finished ${fmtDate(p.closedAt)}` : ""].filter(Boolean).join(" · ");
  $("#poSupplier").innerHTML = sp ? `<div class="ro-sup"><div class="sup-head"><span class="avatar">${esc(initial(sp.company))}</span>
      <div class="t"><h3>${esc(sp.company)}</h3><div class="pic">${sp.contact ? "PIC: " + esc(sp.contact) : "No person in charge"}</div></div></div>
      <div class="contacts">${contactRows(sp)}</div></div>` : "";
  const edit = draft && canEdit();
  // On phones the SKU, ledger and money columns are hidden (class hide-sm) so ordering and receiving fit the screen.
  $("#poLines thead").innerHTML = `<tr><th class="hide-sm">SKU</th><th>Product</th><th class="hide-sm">Ledger</th><th class="num">Ordered</th>${draft ? "" : `<th class="num">Received</th>`}${receiving && canEdit() ? `<th class="num">Receive now</th>` : ""}<th class="num hide-sm">Price</th><th class="num hide-sm">Subtotal</th>${edit ? "<th></th>" : ""}</tr>`;
  $("#poLines tbody").innerHTML = lines.length ? lines.map((l, i) => {
    const left = Math.max(0, l.qty - l.received);
    return `<tr><td class="sku hide-sm">${esc(l.sku)}</td><td class="name">${esc(l.name)}<div class="hint mono sm-only">${esc(l.sku)}</div></td><td class="hide-sm">${ledgerChip(l.tax)}</td>
      <td class="num">${edit ? `<input type="number" min="1" step="1" value="${l.qty}" data-li="${i}" data-lf="qty" aria-label="Quantity for ${esc(l.sku)}">` : fmtN(l.qty)} ${esc(l.unit)}</td>
      ${draft ? "" : `<td class="num">${fmtN(l.received)}</td>`}
      ${receiving && canEdit() ? `<td class="num">${left ? `<input type="number" min="0" max="${left}" step="1" value="${left}" data-rid="${esc(l.id)}" aria-label="Received now for ${esc(l.sku)}">` : '<span class="okmsg">✓ complete</span>'}</td>` : ""}
      <td class="num hide-sm">${edit ? `<input type="number" min="0" step="1" value="${l.price}" data-li="${i}" data-lf="price" aria-label="Price for ${esc(l.sku)}">` : fmtRp(l.price)}</td>
      <td class="num hide-sm">${fmtRp(l.qty * l.price)}</td>${edit ? `<td><button type="button" class="icon-btn" data-ldel="${i}" aria-label="Remove ${esc(l.sku)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td>` : ""}</tr>`;
  }).join("") : `<tr><td colspan="9"><div class="empty">No products on this order yet. Add one below.</div></td></tr>`;
  const span = 4 + (draft ? 0 : 1) + (receiving && canEdit() ? 1 : 0) + 1; // columns before Subtotal
  $("#poLines tfoot").innerHTML = lines.length ? `<tr><td colspan="${span}">Total</td><td class="num">${fmtRp(poTotal(lines))}</td>${edit ? "<td></td>" : ""}</tr>` : "";
  $("#poAddRow").hidden = !edit;
  $("#poNote").value = draft ? poEdit.note : p.note;
  $("#poNote").disabled = !edit;
  $("#poNoteWrap").hidden = !draft && !p.note;
  $("#poSend").hidden = !(poSendOpen && sp);
  if (poSendOpen && sp) renderSendBox(p, sp);
  let acts = "";
  if (draft) acts = `<button type="button" class="btn ghost-danger" data-pa="delete" data-need="staff">Delete draft</button><span class="spacer"></span>
      <button type="button" class="btn" data-pa="save" data-need="staff" ${poDirty ? "" : "disabled"}>Save changes</button>
      <button type="button" class="btn primary" data-pa="send" data-need="staff" ${lines.length ? "" : "disabled"}>${poSendOpen ? "Hide message" : "Send to supplier…"}</button>`;
  else if (receiving) acts = `<button type="button" class="btn ghost-danger" data-pa="close" data-need="staff">${p.status === "sent" ? "Cancel order" : "Close: no more coming"}</button><span class="spacer"></span>
      <button type="button" class="btn" data-pa="resend" data-need="staff">${poSendOpen ? "Hide message" : "Message again"}</button>
      <button type="button" class="btn primary" data-pa="receive" data-need="staff">Book goods received</button>`;
  else acts = `<span class="spacer"></span><button type="button" class="btn" data-pa="x">Close</button>`;
  $("#poActions").innerHTML = acts;
}
function renderSendBox(p, sp) {
  const draft = p.status === "draft";
  const po = draft ? { ...p, lines: poEdit.lines, note: poEdit.note } : p;
  if (!$("#poMsg").dataset.for || $("#poMsg").dataset.for !== p.id + (draft ? ":draft" : ":sent")) {
    $("#poMsg").value = poMessage({ supplier: sp, po });
    $("#poMsg").dataset.for = p.id + (draft ? ":draft" : ":sent");
  }
  const label = { whatsapp: "Send on WhatsApp", wechat: "Copy for WeChat", email: "Send email", phone: "Call" };
  $("#poChannels").innerHTML = supplierChannels(sp).map((ch) => `<button type="button" class="btn ch-${ch}${sp.preferred === ch ? " pref" : ""}" data-ch="${ch}">${label[ch]}</button>`).join("") +
    (draft ? `<span class="spacer"></span><button type="button" class="btn" data-ch="other">Mark as sent (sent another way)</button>` : "");
  $("#poSendNote").textContent = (draft ? "The order is marked as sent when you use one of these buttons. " : "") +
    (supplierChannels(sp).includes("wechat") ? "WeChat: the message is copied; paste it in WeChat." : "");
}
$("#poClose").onclick = () => {
  if (poDirty && !confirm("Discard your unsaved changes to this order?")) return;
  $("#poDlg").close();
};
$("#poDlg").addEventListener("cancel", (e) => {
  if (poDirty && !confirm("Discard your unsaved changes to this order?")) e.preventDefault();
});
$("#poDlg").addEventListener("close", () => { poDirty = false; poId = null; $("#poMsg").dataset.for = ""; });
function markDirty() {
  poDirty = true;
  poSendOpen = false;
  $("#poMsg").dataset.for = "";
  renderPoDialog();
}
$("#poLines").addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.li == null) return;
  poEdit.lines[+t.dataset.li][t.dataset.lf] = Math.max(0, +t.value || 0);
  markDirty();
});
$("#poLines").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ldel]");
  if (!b) return;
  poEdit.lines.splice(+b.dataset.ldel, 1);
  markDirty();
});
$("#poNote").addEventListener("input", () => {
  if (!poEdit) return;
  poEdit.note = $("#poNote").value;
  poDirty = true;
  poSendOpen = false;
  $("#poSend").hidden = true;
  $("#poMsg").dataset.for = "";
  $("#poActions [data-pa=save]")?.removeAttribute("disabled");
});
$("#poAddBtn").onclick = () => {
  const it = findItem($("#poAddItem").value), qty = +$("#poAddQty").value || 1;
  if (!it) { $("#poErr").textContent = "Pick a product from the list."; return; }
  $("#poErr").textContent = "";
  const ex = poEdit.lines.find((l) => l.itemKey === it.key);
  if (ex) ex.qty += qty;
  else poEdit.lines.push({ itemKey: it.key, sku: it.sku, tax: it.tax, name: it.name, unit: it.unit, qty, received: 0, price: +it.price || 0 });
  $("#poAddItem").value = "";
  $("#poAddQty").value = "";
  markDirty();
};
async function savePoDraft() {
  await api.poSave(poId, { note: poEdit.note, lines: poEdit.lines.map((l) => ({ itemKey: l.itemKey, qty: l.qty, price: l.price })) });
  poDirty = false;
  poEdit = null;
  await load();
}
$("#poActions").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-pa]");
  if (!b) return;
  const p = S.pos.find((x) => x.id === poId);
  $("#poErr").textContent = "";
  try {
    switch (b.dataset.pa) {
      case "x": return $("#poDlg").close();
      case "save": await savePoDraft(); toast("Order saved"); break;
      case "send":
      case "resend":
        if (!poSendOpen && poDirty) await savePoDraft();
        poSendOpen = !poSendOpen;
        renderPoDialog();
        break;
      case "delete":
        if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirm: delete draft"; return; }
        await api.poDelete(poId); poDirty = false; $("#poDlg").close(); toast(`${p.number} deleted`); await load(); break;
      case "close":
        if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = p.status === "sent" ? "Confirm: cancel order" : "Confirm: nothing more is coming"; return; }
        await api.poClose(poId); toast(`${p.number} ${p.status === "sent" ? "cancelled" : "closed"}`); await load(); break;
      case "receive": {
        const lines = [...document.querySelectorAll("#poLines [data-rid]")].map((i) => ({ id: i.dataset.rid, qty: +i.value || 0 })).filter((l) => l.qty > 0);
        if (!lines.length) { $("#poErr").textContent = "Enter what arrived in “Receive now”."; return; }
        b.disabled = true;
        const r = await api.poReceive(poId, lines);
        toast(r.status === "received" ? `${p.number} fully received. Stock updated.` : `Receipt booked on ${p.number}. Stock updated; the rest is still to come.`);
        await load();
        break;
      }
    }
  } catch (er) { $("#poErr").textContent = er.message; b.disabled = false; }
});
$("#poChannels").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ch]");
  if (!b) return;
  const p = S.pos.find((x) => x.id === poId), sp = supplierById(p.supplierId), msg = $("#poMsg").value, ch = b.dataset.ch;
  // Open the channel straight away (inside the click) so the browser doesn't block the new window.
  if (ch === "whatsapp") window.open(whatsappUrl(sp.whatsapp, msg), "_blank", "noopener");
  else if (ch === "email") location.href = mailtoUrl(sp.email, poSubject(p, sp.company), msg);
  else if (ch === "phone") location.href = telUrl(sp.phone);
  else if (ch === "wechat") await copyText(msg, "Order message");
  if (p.status !== "draft") return;
  try {
    await api.poSend(p.id, ch);
    poSendOpen = false;
    toast(`${p.number} marked as sent${ch === "wechat" ? ". Paste the message in WeChat to " + sp.wechat : ""}`);
    await load();
  } catch (er) { $("#poErr").textContent = er.message; }
});

/* ---------- sales invoices ---------- */
const IST = { draft: "Draft", unpaid: "Unpaid", partial: "Partly paid", overdue: "Overdue", paid: "Paid", void: "Void" };
/** draft | void | paid | overdue | partial | unpaid */
function invState(i) {
  if (i.status !== "issued") return i.status;
  const p = paymentState(i.total, i.paid, i.dueDate, today());
  return p.state === "paid" ? "paid" : p.overdue ? "overdue" : p.state;
}
const invBalance = (i) => (i.status === "issued" ? Math.max(0, Math.round(i.total - i.paid)) : 0);
const customerById = (id) => S.customers.find((c) => c.id === id);
const ymdLabel = (ymd) => (ymd ? new Date(ymd + "T00:00:00").toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }) : "");
const addDaysYmd = (ymd, n) => { const d = new Date(ymd + "T00:00:00"); d.setDate(d.getDate() + n); return today(d); };
let invFilter = "unpaid";

function renderInvoices() {
  const issued = S.invoices.filter((i) => i.status === "issued");
  const owed = issued.reduce((a, i) => a + invBalance(i), 0);
  const od = issued.filter((i) => invState(i) === "overdue");
  const month = today().slice(0, 7);
  const sales = issued.filter((i) => i.date.startsWith(month)).reduce((a, i) => a + i.total, 0);
  const drafts = S.invoices.filter((i) => i.status === "draft").length;
  $("#invKpis").innerHTML = [
    ["non", "Still owed to you", fmtRp(owed), plural(issued.filter((i) => invBalance(i) > 0).length, "unpaid invoice")],
    ["crit", "Overdue", fmtRp(od.reduce((a, i) => a + invBalance(i), 0)), plural(od.length, "invoice")],
    ["ppn", "Sales this month", fmtRp(sales), "issued, incl. PPN"],
    ["warn", "Drafts", nf(drafts), "not issued yet"],
  ].map(([c, l, v, sub]) => `<div class="kpi"><span class="l"><span class="ic ${c}">${ICON.box}</span>${l}</span><span class="v">${v}</span><span class="s">${sub}</span></div>`).join("");
  const q = $("#invQ").value.trim().toLowerCase();
  const pick = { unpaid: (st) => ["unpaid", "partial", "overdue"].includes(st), overdue: (st) => st === "overdue", draft: (st) => st === "draft", paid: (st) => st === "paid", void: (st) => st === "void", all: () => true }[invFilter];
  const rows = S.invoices.filter((i) => pick(invState(i)) && (!q || [i.number, i.custName, customerById(i.customerId)?.name].join(" ").toLowerCase().includes(q)));
  const tb = $("#invTblList tbody");
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="8"><div class="empty">${S.invoices.length ? "No invoices here." : `<strong>No invoices yet</strong><span>Add your customers, set sell prices on products, then click “New invoice”.</span>`}</div></td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((i) => {
    const st = invState(i), name = i.status === "draft" ? customerById(i.customerId)?.name || "—" : i.custName;
    const total = i.status === "draft" ? invoiceTotals(i.lines, i.tax, S.settings.ppnRate).total : i.total;
    return `<tr data-inv="${esc(i.id)}"><td class="sku">${esc(i.number || "Draft")}</td><td>${ymdLabel(i.date)}</td><td class="name">${esc(name)}</td><td>${ledgerChip(i.tax)}</td>
      <td class="num">${fmtRp(total)}</td><td class="num">${i.status === "issued" ? fmtRp(invBalance(i)) : '<span class="muted">—</span>'}</td>
      <td><span class="chip ist-${st}">${IST[st]}</span></td><td>${i.status === "issued" && invBalance(i) ? ymdLabel(i.dueDate) : '<span class="muted">—</span>'}</td></tr>`;
  }).join("");
}
$("#invSeg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  invFilter = b.dataset.f;
  $("#invSeg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  renderInvoices();
});
$("#invQ").addEventListener("input", renderInvoices);
$("#invTblList").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-inv]"); if (tr) openInvoice(tr.dataset.inv); });

/* customers */
function renderCustomers() {
  const q = $("#custQ").value.trim().toLowerCase();
  const stats = new Map();
  for (const i of S.invoices) {
    if (i.status !== "issued") continue;
    const x = stats.get(i.customerId) || { n: 0, owed: 0 };
    x.n++;
    x.owed += invBalance(i);
    stats.set(i.customerId, x);
  }
  $("#custSummary").textContent = plural(S.customers.length, "customer");
  const rows = S.customers.filter((c) => !q || [c.name, c.contact, c.npwp, c.phone, c.whatsapp, c.email].join(" ").toLowerCase().includes(q));
  const tb = $("#custTbl tbody");
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="6"><div class="empty">${S.customers.length ? "No customers match." : "<strong>No customers yet</strong><span>Add the people and companies you sell to.</span>"}</div></td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((c) => {
    const x = stats.get(c.id) || { n: 0, owed: 0 };
    return `<tr data-cust="${esc(c.id)}"><td class="name"><strong>${esc(c.name)}</strong></td><td>${esc(c.contact)}</td><td>${esc(c.whatsapp || c.phone)}</td><td class="sku">${esc(c.npwp)}</td>
      <td class="num">${x.n}</td><td class="num">${x.owed ? `<span class="err">${fmtRp(x.owed)}</span>` : '<span class="muted">—</span>'}</td></tr>`;
  }).join("");
}
$("#custQ").addEventListener("input", renderCustomers);
$("#custTbl").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-cust]"); if (tr) openCustomer(tr.dataset.cust); });
let custEdit = null, custReturn = null;
function openCustomer(id, onSaved = null) {
  custEdit = id;
  custReturn = onSaved;
  const c = id ? customerById(id) : {};
  $("#custTitle").textContent = id ? "Edit customer" : "Add customer";
  for (const [f, el] of [["name", "#cName"], ["contact", "#cContact"], ["whatsapp", "#cWhatsapp"], ["phone", "#cPhone"], ["email", "#cEmail"], ["address", "#cAddress"], ["npwp", "#cNpwp"], ["notes", "#cNotes"]]) $(el).value = c[f] || "";
  $("#custErr").textContent = "";
  $("#custDel").hidden = !id;
  $("#custDel").dataset.confirm = "";
  $("#custDel").textContent = "Delete";
  $("#custDlg").showModal();
}
$("#custAdd").onclick = () => openCustomer(null);
$("#custCancel").onclick = $("#custClose").onclick = () => $("#custDlg").close();
$("#custDel").onclick = async () => {
  const b = $("#custDel");
  if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirm delete"; return; }
  try { await api.deleteCustomer(custEdit); $("#custDlg").close(); toast("Customer deleted"); scheduleReload(); }
  catch (e) { $("#custErr").textContent = e.message; }
};
$("#custForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = { name: $("#cName").value, contact: $("#cContact").value, whatsapp: $("#cWhatsapp").value, phone: $("#cPhone").value, email: $("#cEmail").value, address: $("#cAddress").value, npwp: $("#cNpwp").value, notes: $("#cNotes").value };
  $("#custSave").disabled = true;
  try {
    const r = custEdit ? (await api.updateCustomer(custEdit, body), { id: custEdit }) : await api.createCustomer(body);
    $("#custDlg").close();
    toast("Customer saved");
    await load();
    if (custReturn) custReturn(r.id);
  } catch (e) { $("#custErr").textContent = e.message; } finally { $("#custSave").disabled = false; }
});

/* new invoice */
function fillNewInvCustomers(selected = "") {
  $("#invNewCust").innerHTML = `<option value="">Choose a customer…</option>` + S.customers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  $("#invNewCust").value = selected;
}
$("#invNew").onclick = () => { fillNewInvCustomers(); $("#invNewDlg").showModal(); };
$("#invNewCancel").onclick = () => $("#invNewDlg").close();
$("#invNewCustAdd").onclick = () => { $("#invNewDlg").close(); openCustomer(null, (id) => { fillNewInvCustomers(id); $("#invNewDlg").showModal(); }); };
$("#invNewGo").onclick = async () => {
  const cust = $("#invNewCust").value;
  if (!cust) { toast("Choose a customer."); return; }
  try {
    const r = await api.invCreate($("#invNewTax").value, cust);
    $("#invNewDlg").close();
    await load();
    openInvoice(r.id);
  } catch (e) { handleErr(e); }
};

/* invoice dialog: drafts are edited locally and saved with Save / Issue */
let invId = null, invEdit = null, invDirty = false, invSendOpen = false;
function openInvoice(id) {
  invId = id;
  invEdit = null;
  invDirty = false;
  invSendOpen = false;
  $("#invErr").textContent = "";
  renderInvoiceDialog();
  if (!$("#invDlg").open) $("#invDlg").showModal();
}
function refreshInvDialog() {
  if (!$("#invDlg").open || !invId) return;
  if (!S.invoices.some((i) => i.id === invId)) { $("#invDlg").close(); toast("That invoice was deleted."); return; }
  if (!invDirty) { invEdit = null; renderInvoiceDialog(); }
}
const curInv = () => S.invoices.find((i) => i.id === invId);
function renderInvoiceDialog() {
  const inv = curInv();
  if (!inv) return;
  const draft = inv.status === "draft", edit = draft && canEdit();
  if (draft && !invEdit) invEdit = { customerId: inv.customerId, date: inv.date, dueDate: inv.dueDate, note: inv.note, lines: inv.lines.map((l) => ({ ...l })) };
  const st = invState(inv);
  const lines = draft ? invEdit.lines : inv.lines;
  $("#invTitle").innerHTML = `${esc(inv.number || "Draft invoice")} <span class="chip ist-${st}">${IST[st]}</span> ${ledgerChip(inv.tax)}`;
  $("#invMeta").textContent = draft ? `Created by ${inv.createdBy}` : `Issued ${inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString("id-ID") : ""} by ${inv.issuedBy}`;
  $("#invVoidNote").hidden = inv.status !== "void";
  $("#invVoidNote").textContent = inv.status === "void" ? `Voided ${new Date(inv.voidedAt).toLocaleDateString("id-ID")}: ${inv.voidReason}. The stock was put back.` : "";

  // header fields
  if (draft) {
    $("#invHead").innerHTML = `
      <div class="field span2"><label for="ivCust">Customer</label><select id="ivCust" ${edit ? "" : "disabled"}>${S.customers.map((c) => `<option value="${esc(c.id)}"${c.id === invEdit.customerId ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="ivDate">Invoice date</label><input id="ivDate" type="date" value="${esc(invEdit.date)}" ${edit ? "" : "disabled"}></div>
      <div class="field"><label for="ivDue">Due date</label><input id="ivDue" type="date" value="${esc(invEdit.dueDate)}" ${edit ? "" : "disabled"}></div>`;
  } else {
    $("#invHead").innerHTML = `
      <div class="field span2"><span class="group-l">Bill to</span><div><strong>${esc(inv.custName)}</strong><div class="hint">${esc(inv.custAddress).replace(/\n/g, "<br>")}</div>${inv.custNpwp ? `<div class="hint">NPWP ${esc(inv.custNpwp)}</div>` : ""}</div></div>
      <div class="field"><span class="group-l">Invoice date</span><div>${ymdLabel(inv.date)}</div></div>
      <div class="field"><label for="ivDue">Due date</label><input id="ivDue" type="date" value="${esc(inv.dueDate)}" ${inv.status === "issued" && canEdit() ? "" : "disabled"}></div>
      ${inv.tax === "PPN" ? `<div class="field"><label for="ivNsfp">e-Faktur number (NSFP)</label><input id="ivNsfp" class="mono" value="${esc(inv.nsfp)}" placeholder="from Coretax" ${inv.status === "issued" && canEdit() ? "" : "disabled"}></div>` : ""}`;
  }

  // lines
  const stockLeft = (key) => S.items[key] ? +S.items[key].qty || 0 : 0;
  const needBy = new Map();
  for (const l of lines) needBy.set(l.itemKey, (needBy.get(l.itemKey) || 0) + l.qty);
  $("#invLines thead").innerHTML = `<tr><th class="hide-sm">SKU</th><th>Product</th>${draft ? `<th class="num hide-sm">In stock</th>` : ""}<th class="num">Qty</th><th class="num">Price</th><th class="num hide-sm">Disc %</th><th class="num${draft ? " hide-sm" : ""}">Amount</th>${edit ? "<th></th>" : ""}</tr>`;
  $("#invLines tbody").innerHTML = lines.length ? lines.map((l, i) => {
    const short = draft && needBy.get(l.itemKey) > stockLeft(l.itemKey);
    return `<tr><td class="sku hide-sm">${esc(l.sku)}</td><td class="name">${esc(l.name)}<div class="hint mono sm-only">${esc(l.sku)}</div>${draft && !(+l.price) ? '<div class="err">No price</div>' : ""}</td>
      ${draft ? `<td class="num hide-sm${short ? " short" : ""}" title="${short ? "Not enough stock to issue" : ""}">${fmtN(stockLeft(l.itemKey))}</td>` : ""}
      <td class="num">${edit ? `<input class="q" type="number" min="1" step="1" value="${l.qty}" data-il="${i}" data-if="qty" aria-label="Quantity for ${esc(l.sku)}">` : fmtN(l.qty)} <span class="hint">${esc(l.unit)}</span></td>
      <td class="num">${edit ? `<input type="number" min="0" step="1" value="${l.price}" data-il="${i}" data-if="price" aria-label="Price for ${esc(l.sku)}">` : fmtRp(l.price)}</td>
      <td class="num hide-sm">${edit ? `<input class="disc" type="number" min="0" max="100" step="0.5" value="${l.discPct || 0}" data-il="${i}" data-if="discPct" aria-label="Discount for ${esc(l.sku)}">` : l.discPct ? fmtN(l.discPct) + "%" : ""}</td>
      <td class="num${draft ? " hide-sm" : ""}">${fmtRp(lineAmount(l))}</td>${edit ? `<td><button type="button" class="icon-btn" data-ildel="${i}" aria-label="Remove ${esc(l.sku)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td>` : ""}</tr>`;
  }).join("") : `<tr><td colspan="8"><div class="empty">No products yet. Add one below.</div></td></tr>`;
  $("#invAddRow").hidden = !edit;
  if (edit) $("#invItemList").innerHTML = Object.values(S.items).filter((it) => it.tax === inv.tax).slice(0, 5000).map((it) => `<option value="${esc(it.sku)} · ${it.tax}">${esc(it.name)}</option>`).join("");

  // note
  $("#invNote").value = draft ? invEdit.note : inv.note;
  $("#invNote").disabled = !edit;
  $("#invNoteWrap").hidden = !draft && !inv.note;

  // totals
  const t = draft ? invoiceTotals(lines, inv.tax, S.settings.ppnRate) : { subtotal: inv.subtotal, dppLain: inv.dppLain, ppn: inv.ppn, total: inv.total, scheme: inv.dppLain ? "dpp-lain" : inv.ppn ? "flat" : "none" };
  const row = (l, v, cls = "") => `<div class="tr ${cls}"><span>${l}</span><span>${v}</span></div>`;
  $("#invTotals").innerHTML = row("Subtotal (excl. PPN)", fmtRp(t.subtotal)) +
    (t.scheme === "dpp-lain" ? row("DPP Nilai Lain (11/12)", fmtRp(t.dppLain)) + row("PPN 12%", fmtRp(t.ppn)) : t.scheme === "flat" ? row(`PPN ${S.settings.ppnRate}%`, fmtRp(t.ppn)) : "") +
    row("Total", fmtRp(t.total), "grand") +
    (inv.status === "issued" && inv.paid ? row("Paid", fmtRp(inv.paid)) + row("Still owed", fmtRp(invBalance(inv)), invBalance(inv) ? "owed" : "") : "") +
    `<div class="words">${esc(terbilang(t.total))}</div>`;

  // payments
  const pays = inv.payments.map((p) => `<div class="pay"><span>${ymdLabel(p.date)}</span><span class="chip unit">${esc(p.method)}</span><span class="hint">${esc(p.note)}${p.by ? " · " + esc(p.by) : ""}</span><span class="amt">${fmtRp(p.amount)}</span>
    <button type="button" class="icon-btn" data-pdel="${esc(p.id)}" data-need="admin" aria-label="Remove payment"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join("");
  const bal = invBalance(inv);
  $("#invPayments").innerHTML = inv.status === "issued" ? `<div class="field"><span class="group-l">Payments</span>
      ${pays ? `<div class="pay-list">${pays}</div>` : '<span class="hint">No payments yet.</span>'}</div>
      ${bal && canEdit() ? `<div class="pay-form">
        <div class="field"><label for="payAmt">Amount received</label><input id="payAmt" type="number" min="1" step="1" value="${bal}"></div>
        <div class="field"><label for="payDate">Date</label><input id="payDate" type="date" value="${today()}"></div>
        <div class="field"><label for="payMethod">Method</label><select id="payMethod"><option value="transfer">Bank transfer</option><option value="cash">Cash</option><option value="giro">Giro / cheque</option><option value="other">Other</option></select></div>
        <div class="field"><label for="payNote">Reference</label><input id="payNote" placeholder="e.g. BCA ref"></div>
        <button type="button" class="btn" id="payGo">Record payment</button></div>` : ""}` : "";

  // send box
  const cust = customerById(inv.customerId);
  $("#invSendBox").hidden = !(invSendOpen && inv.status === "issued");
  if (invSendOpen && inv.status === "issued") {
    if ($("#invMsg").dataset.for !== inv.id) {
      $("#invMsg").value = invoiceMessage({ customer: cust, inv, issuer: S.settings.issuer?.[inv.tax], balance: bal });
      $("#invMsg").dataset.for = inv.id;
    }
    const chs = [cust?.whatsapp && ["whatsapp", "Send on WhatsApp"], cust?.email && ["email", "Send email"]].filter(Boolean);
    $("#invChannels").innerHTML = chs.length ? chs.map(([c, l]) => `<button type="button" class="btn ch-${c}" data-ich="${c}">${l}</button>`).join("") + `<button type="button" class="btn" data-ich="copy">Copy message</button>`
      : `<span class="hint">This customer has no WhatsApp or email saved.</span><button type="button" class="btn" data-ich="copy">Copy message</button>`;
  }

  // actions
  let a = "";
  if (draft) a = `<button type="button" class="btn ghost-danger" data-ia="delete" data-need="staff">Delete draft</button><span class="spacer"></span>
      <button type="button" class="btn" data-ia="print">Preview</button>
      <button type="button" class="btn" data-ia="save" data-need="staff" ${invDirty ? "" : "disabled"}>Save draft</button>
      <button type="button" class="btn primary" data-ia="issue" data-need="staff" ${lines.length ? "" : "disabled"}>Issue invoice</button>`;
  else if (inv.status === "issued") a = `<button type="button" class="btn ghost-danger" data-ia="void" data-need="admin">Void invoice</button><span class="spacer"></span>
      <button type="button" class="btn" data-ia="savehead" data-need="staff">Save due date${inv.tax === "PPN" ? " / NSFP" : ""}</button>
      <button type="button" class="btn" data-ia="send">${invSendOpen ? "Hide message" : "Send to customer"}</button>
      <button type="button" class="btn primary" data-ia="print">Print / PDF</button>`;
  else a = `<span class="spacer"></span><button type="button" class="btn" data-ia="print">Print</button>`;
  $("#invActions").innerHTML = a;
}
function invMarkDirty() {
  invDirty = true;
  renderInvoiceDialog();
}
$("#invHead").addEventListener("change", (e) => {
  const inv = curInv();
  if (!inv || inv.status !== "draft") return;
  if (e.target.id === "ivCust") invEdit.customerId = e.target.value;
  if (e.target.id === "ivDate") {
    // keep the same payment terms when the date moves
    const terms = Math.round((Date.parse(invEdit.dueDate) - Date.parse(invEdit.date)) / 864e5);
    invEdit.date = e.target.value;
    invEdit.dueDate = addDaysYmd(e.target.value, Math.max(0, terms));
  }
  if (e.target.id === "ivDue") invEdit.dueDate = e.target.value;
  invMarkDirty();
});
$("#invLines").addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.il == null) return;
  invEdit.lines[+t.dataset.il][t.dataset.if] = Math.max(0, +t.value || 0);
  invMarkDirty();
});
$("#invLines").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ildel]");
  if (!b) return;
  invEdit.lines.splice(+b.dataset.ildel, 1);
  invMarkDirty();
});
$("#invNote").addEventListener("input", () => {
  if (!invEdit) return;
  invEdit.note = $("#invNote").value;
  invDirty = true;
  $("#invActions [data-ia=save]")?.removeAttribute("disabled");
});
$("#invAddBtn").onclick = () => {
  const inv = curInv(), it = findItem($("#invAddItem").value), qty = +$("#invAddQty").value || 1;
  if (!it || it.tax !== inv.tax) { $("#invErr").textContent = `Pick a ${taxLabel(inv.tax)} product from the list.`; return; }
  $("#invErr").textContent = it.sellPrice ? "" : `${it.sku} has no sell price yet. Enter the price on the line, or set it on the product.`;
  invEdit.lines.push({ itemKey: it.key, sku: it.sku, name: it.name, unit: it.unit, qty, price: +it.sellPrice || 0, discPct: 0 });
  $("#invAddItem").value = "";
  $("#invAddQty").value = "";
  invMarkDirty();
};
async function saveInvDraft() {
  await api.invSave(invId, { customerId: invEdit.customerId, date: invEdit.date, dueDate: invEdit.dueDate, note: invEdit.note,
    lines: invEdit.lines.map((l) => ({ itemKey: l.itemKey, qty: l.qty, price: l.price, discPct: l.discPct || 0 })) });
  invDirty = false;
  invEdit = null;
  await load();
}
function printInvoice() {
  const inv = curInv();
  const draft = inv.status === "draft";
  const doc = invoiceHtml({
    inv: draft ? { ...inv, ...invEdit, customer: customerById(invEdit.customerId) } : inv,
    lines: draft ? invEdit.lines : inv.lines, issuer: S.settings.issuer?.[inv.tax], payments: inv.payments, ppnRate: S.settings.ppnRate,
  });
  const w = window.open("", "_blank");
  if (!w) { toast("Allow pop-ups for this site to print invoices."); return; }
  w.document.open();
  w.document.write(doc);
  w.document.close();
}
$("#invActions").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ia]");
  if (!b) return;
  const inv = curInv();
  $("#invErr").textContent = "";
  try {
    switch (b.dataset.ia) {
      case "print": return printInvoice();
      case "save": await saveInvDraft(); toast("Draft saved"); break;
      case "delete":
        if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirm: delete draft"; return; }
        await api.invDelete(invId); invDirty = false; $("#invDlg").close(); toast("Draft deleted"); await load(); break;
      case "issue": {
        if (invEdit.lines.some((l) => !(+l.price))) { $("#invErr").textContent = "Every line needs a price before issuing."; return; }
        if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirm: issue and take items out of stock"; return; }
        b.disabled = true;
        if (invDirty) await saveInvDraft();
        const r = await api.invIssue(invId);
        toast(`Invoice ${r.number} issued: ${fmtRp(r.total)}. Stock updated.`);
        await load();
        break;
      }
      case "savehead": {
        const body = { dueDate: $("#ivDue").value };
        if ($("#ivNsfp")) body.nsfp = $("#ivNsfp").value;
        await api.invSave(invId, body); toast("Saved"); await load(); break;
      }
      case "send": invSendOpen = !invSendOpen; renderInvoiceDialog(); break;
      case "void": {
        if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirm void…"; return; }
        const reason = prompt(`Why is ${inv.number} being voided? (kept with the invoice)`);
        if (!reason) { b.dataset.confirm = ""; b.textContent = "Void invoice"; return; }
        await api.invVoid(invId, reason); toast(`${inv.number} voided. Stock was put back.`); await load(); break;
      }
    }
  } catch (er) { $("#invErr").textContent = er.message; b.disabled = false; }
});
$("#invPayments").addEventListener("click", async (e) => {
  const inv = curInv();
  try {
    if (e.target.closest("#payGo")) {
      await api.invPay(invId, { amount: $("#payAmt").value, date: $("#payDate").value, method: $("#payMethod").value, note: $("#payNote").value });
      toast(`Payment recorded on ${inv.number}`);
      await load();
    }
    const d = e.target.closest("[data-pdel]");
    if (d) {
      if (d.dataset.confirm !== "1") { d.dataset.confirm = "1"; d.title = "Click again to remove"; d.style.color = "var(--crit)"; return; }
      await api.invDeletePay(invId, d.dataset.pdel); toast("Payment removed"); await load();
    }
  } catch (er) { $("#invErr").textContent = er.message; }
});
$("#invChannels").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ich]");
  if (!b) return;
  const inv = curInv(), cust = customerById(inv.customerId), msg = $("#invMsg").value;
  if (b.dataset.ich === "whatsapp") window.open(whatsappUrl(cust.whatsapp, msg), "_blank", "noopener");
  else if (b.dataset.ich === "email") location.href = mailtoUrl(cust.email, `Invoice ${inv.number}`, msg);
  else copyText(msg, "Message");
});
$("#invClose").onclick = () => {
  if (invDirty && !confirm("Discard your unsaved changes to this invoice?")) return;
  $("#invDlg").close();
};
$("#invDlg").addEventListener("cancel", (e) => { if (invDirty && !confirm("Discard your unsaved changes to this invoice?")) e.preventDefault(); });
$("#invDlg").addEventListener("close", () => { invDirty = false; invId = null; $("#invMsg").dataset.for = ""; });

/* invoice settings */
function fillInvoicing() {
  $("#stTerms").value = S.settings.invoiceTerms ?? 30;
  $("#issuerForm").innerHTML = ["PPN", "NON"].map((t) => {
    const x = S.settings.issuer?.[t] || {};
    const f = (k, label, ph = "", area = false) => `<div class="field"><label for="is${t}${k}">${label}</label>${area ? `<textarea id="is${t}${k}" rows="2" placeholder="${ph}">${esc(x[k] || "")}</textarea>` : `<input id="is${t}${k}" value="${esc(x[k] || "")}" placeholder="${ph}">`}</div>`;
    return `<div class="issuer"><strong>${t === "PPN" ? "PPN invoices" : "Non-PPN invoices"}</strong>
      ${f("name", "Company name", t === "PPN" ? "e.g. CV Hashiru" : "")}${f("address", "Address", "", true)}${f("phone", "Telephone")}${f("npwp", "NPWP")}
      ${f("bank", "Bank account for payment", "e.g. BCA 123-456-7890 a.n. CV Hashiru", true)}${f("footer", "Footer text", "e.g. Barang yang sudah dibeli tidak dapat dikembalikan")}</div>`;
  }).join("");
}
$("#stInvSave").onclick = async () => {
  const issuer = {};
  for (const t of ["PPN", "NON"]) issuer[t] = Object.fromEntries(["name", "address", "phone", "npwp", "bank", "footer"].map((k) => [k, $(`#is${t}${k}`).value]));
  try {
    await api.saveInvoicing({ invoiceTerms: $("#stTerms").value, issuer });
    $("#stInvMsg").className = "okmsg";
    $("#stInvMsg").textContent = "Saved";
    S.loaded = false;
    scheduleReload();
  } catch (e) { $("#stInvMsg").className = "err"; $("#stInvMsg").textContent = e.message; }
};

/* ---------- users (admin) ---------- */
async function loadUsers() {
  if (S.me?.role !== "admin") return;
  try { S.users = await api.users(); renderUsers(); } catch (e) { handleErr(e); }
}
function renderUsers() {
  $("#uTbl tbody").innerHTML = S.users.map((u) => `<tr>
    <td><div class="row" style="gap:10px;flex-wrap:nowrap"><span class="avatar sm">${esc(initial(u.name))}</span><strong>${esc(u.name)}</strong>${u.id === S.me.id ? '<span class="chip unit">You</span>' : ""}</div></td>
    <td class="sku">${esc(u.username)}</td><td><span class="chip ${u.role === "admin" ? "col" : u.role === "staff" ? "non" : "unit"}">${u.role[0].toUpperCase() + u.role.slice(1)}</span></td>
    <td>${u.active ? '<span class="okmsg">Active</span>' : '<span class="muted">Switched off</span>'}</td><td>${fmtDate(u.createdAt)}</td>
    <td><button class="btn small" data-uedit="${esc(u.id)}">Edit</button></td></tr>`).join("");
}
let uEdit = null;
function openUser(id) {
  uEdit = id;
  const u = id ? S.users.find((x) => x.id === id) : { name: "", username: "", role: "staff", active: true };
  $("#uTitle").textContent = id ? "Edit user" : "Add user";
  $("#uName").value = u.name;
  $("#uUser").value = u.username;
  $("#uUser").disabled = !!id;
  $("#uRole").value = u.role;
  $("#uPass").value = "";
  $("#uPass").required = !id;
  $("#uPassL").textContent = id ? "New password (leave empty to keep the current one)" : "Password (at least 8 characters)";
  $("#uActive").checked = u.active;
  $("#uActiveWrap").hidden = !id;
  $("#uHint").textContent = id ? "Changing the role, switching the account off or setting a new password signs this user out everywhere." : "Give the user their username and password; they can change the password after signing in.";
  $("#uErr").textContent = "";
  $("#uDlg").showModal();
}
$("#uAdd").onclick = () => openUser(null);
$("#uTbl").addEventListener("click", (e) => { const b = e.target.closest("[data-uedit]"); if (b) openUser(b.dataset.uedit); });
$("#uCancel").onclick = $("#uClose").onclick = () => $("#uDlg").close();
$("#uForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = { name: $("#uName").value, role: $("#uRole").value };
  if ($("#uPass").value) body.password = $("#uPass").value;
  $("#uSave").disabled = true;
  try {
    if (uEdit) await api.updateUser(uEdit, { ...body, active: $("#uActive").checked });
    else await api.createUser({ ...body, username: $("#uUser").value });
    $("#uDlg").close();
    toast("User saved");
    if (uEdit === S.me.id && body.role !== "admin") return location.reload();
    loadUsers();
  } catch (e) { $("#uErr").textContent = e.message; } finally { $("#uSave").disabled = false; }
});

/* ---------- own password ---------- */
$("#pwBtn").onclick = () => { $("#pwCur").value = ""; $("#pwNew").value = ""; $("#pwErr").textContent = ""; $("#pwDlg").showModal(); };
$("#pwCancel").onclick = $("#pwClose").onclick = () => $("#pwDlg").close();
$("#pwForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    await api.changePassword($("#pwCur").value, $("#pwNew").value);
    $("#pwDlg").close();
    toast("Password changed. Other devices were signed out.");
  } catch (e) { $("#pwErr").textContent = e.message; }
});

/* ---------- sign in & boot ---------- */
let events = null;
async function showAuth() {
  document.body.classList.remove("booting");
  document.body.classList.add("signed-out");
  $("#auth").hidden = false;
  let setup = false;
  try { setup = (await api.authStatus()).setup; } catch { $("#lErr").textContent = "Can't reach the server. Is it running?"; }
  $("#setupForm").hidden = !setup;
  $("#loginForm").hidden = setup;
  $("#authSub").textContent = setup ? "First-time setup" : "Sign in to continue";
  (setup ? $("#suCode") : $("#lUser")).focus();
}
$("#loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("#lGo").disabled = true;
  try {
    await api.login($("#lUser").value, $("#lPass").value);
    location.reload();
  } catch (e) {
    $("#lErr").textContent = e.message;
    $("#lPass").select();
  } finally { $("#lGo").disabled = false; }
});
$("#setupForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("#suGo").disabled = true;
  try {
    await api.setup({ code: $("#suCode").value, name: $("#suName").value, username: $("#suUser").value, password: $("#suPass").value });
    location.reload();
  } catch (e) { $("#suErr").textContent = e.message; } finally { $("#suGo").disabled = false; }
});
$("#logoutBtn").onclick = async () => {
  try { await api.logout(); } catch {}
  location.reload();
};
setUnauthorizedHandler(() => {
  if (!S.me) return;
  S.me = null;
  events?.close();
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  toast("You were signed out. Please sign in again.");
  showAuth();
});

function startApp(me) {
  S.me = me;
  document.body.classList.remove("booting", "signed-out");
  document.body.classList.add("role-" + me.role);
  $("#auth").hidden = true;
  $("#meName").textContent = me.name;
  $("#meRole").textContent = me.role;
  $("#meAvatar").textContent = initial(me.name);
  const cur = location.hash.slice(1);
  if (cur === "users" && me.role !== "admin") showTab("inventory");
  if (cur === "users") loadUsers();
  renderAll();
  fillSettings();
  load().catch((e) => { setStatus("down", "Server unreachable"); handleErr(e); });
  events = subscribe(scheduleReload, (st) => {
    if (st === "live") { setStatus("live", "Live · synced"); scheduleReload(); }
    else setStatus("down", "Reconnecting…");
  });
}
document.querySelector('[data-tab="users"]').addEventListener("click", loadUsers);
window.addEventListener("hashchange", () => { if (location.hash === "#users") loadUsers(); });

api.me().then(startApp).catch((e) => {
  if (e.status === 401) showAuth();
  else { document.body.classList.remove("booting"); setStatus("down", "Server unreachable"); handleErr(e); }
});
