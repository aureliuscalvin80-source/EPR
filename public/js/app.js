import { api, subscribe } from "./api.js";
import { parse, evalAst, VARS, colVar } from "./formula.js";
import { evaluate, baseVars, moveStats, coverage, MON_N, ymOf, ymLabel, DEFAULT_SETTINGS } from "./stock.js";
import { detectPlan, detectMonth, monthOfName, hasKodeHeader, taxFromHeader, parseSales, parseStock, parseWorkbook, readProductList } from "./reports.js";
import { fmtRp, fmtN, esc, keyOf, taxLabel, today } from "./util.js";

/* ---------- state ---------- */
const S = {
  items: {}, rules: [], files: [], hist: [], dem: {}, moves: [], settings: { ...DEFAULT_SETTINGS }, usage: { bytes: 0 },
  derived: new Map(), alerts: [], colRules: [], dstats: new Map(), win: { PPN: [], NON: [] },
  sort: { k: "sku", d: 1 }, page: 0, per: 100, editKey: null, editRule: null, loaded: false,
};
const $ = (s) => document.querySelector(s);
const nf = (n) => n.toLocaleString("id-ID");
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
  if (!S.loaded || !document.activeElement?.closest("#page-settings")) fillSettings();
  S.loaded = true;
  recompute();
}
let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => load().catch(handleErr), 120);
}

function recompute() {
  const r = evaluate({ items: S.items, rules: S.rules, moves: S.moves, dem: S.dem, hist: S.hist, settings: S.settings });
  Object.assign(S, { derived: r.derived, alerts: r.alerts, colRules: r.colRules, dstats: r.dstats, win: r.win });
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
    if (q && !(it.sku.toLowerCase().includes(q) || String(it.name || "").toLowerCase().includes(q))) return false;
    return true;
  });
  const { k, d } = S.sort;
  const val = (it) => {
    if (k.startsWith("col:")) return S.derived.get(it.key)?.cols[k.slice(4)] ?? -Infinity;
    if (k === "value" || k === "price_incl") return S.derived.get(it.key)?.vars[k] ?? 0;
    if (k === "alerts") return S.derived.get(it.key)?.alerts.length || 0;
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
    ["sku", "SKU"], ["name", "Product name"], ["tax", "Ledger"], ["unit", "Unit"], ["qty", "Qty", "num"], ["price", "Price", "num"],
    ["price_incl", "Incl. PPN", "num"], ["value", "Stock value", "num"], ["minStock", "Min", "num"],
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
      <td class="num"><span class="qty ${d.sev}">${fmtN(+it.qty || 0)}</span></td><td class="num">${fmtRp(+it.price || 0)}</td>
      <td class="num">${it.tax === "PPN" ? fmtRp(d.vars.price_incl) : dash}</td><td class="num">${fmtRp(d.vars.value)}</td>
      <td class="num">${it.minStock ? fmtN(+it.minStock) : dash}</td>
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
      </div>
      <div class="stockbox ${sev}">
        <div class="sb-top"><span class="sb-l">Current stock</span><span class="sb-q">${fmtN(v.qty)}<small> ${esc(it.unit)}</small></span></div>
        <div class="gauge" role="img" aria-label="Stock ${fmtN(v.qty)}, safety stock ${fmtN(v.safety_stock)}, reorder point ${fmtN(v.reorder_point)}, min stock ${fmtN(v.min_stock)}">
          <div class="g-fill" style="width:${pc(v.qty)}"></div><i class="g-ss" style="left:${pc(v.safety_stock)}"></i><i class="g-rop" style="left:${pc(v.reorder_point)}"></i>${v.min_stock ? `<i class="g-min" style="left:${pc(v.min_stock)}"></i>` : ""}</div>
        <div class="sb-legend"><span><i class="k-ss"></i>Safety ${fmtN(v.safety_stock)}</span><span><i class="k-rop"></i>Reorder ${fmtN(v.reorder_point)}</span>${v.min_stock ? `<span><i class="k-min"></i>Min ${fmtN(v.min_stock)}</span>` : ""}<span>Order <strong>${fmtN(v.suggested_order)}</strong></span></div>
      </div>
      <button class="btn small" data-open="${esc(it.key)}">Open</button>
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
      <div class="row"><button class="btn small" data-redit="${esc(r.id)}">Edit</button><button class="btn small" data-rtoggle="${esc(r.id)}">${r.enabled === false ? "Resume" : "Pause"}</button><span class="spacer"></span><button class="btn small danger" data-rdel="${esc(r.id)}">Delete</button></div>
    </div>`;
  }).join("");
}

function renderMoves() {
  const tb = $("#mvTbl tbody");
  const cutoff = Date.now() - 30 * 864e5;
  const all = S.moves.filter((e) => e.t >= cutoff);
  if (!all.length) {
    tb.innerHTML = `<tr><td colspan="6"><div class="empty">No movements recorded in the last 30 days.</div></td></tr>`;
    return;
  }
  tb.innerHTML = all.slice(0, 400).map((e) => `<tr>
    <td>${new Date(e.t).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
    <td class="sku">${esc(e.sku)}</td><td>${ledgerChip(e.tax)}</td><td><span class="chip ${e.type.toLowerCase()}">${e.type}</span></td>
    <td class="num">${e.qty > 0 ? "+" : ""}${fmtN(e.qty)}</td><td class="name">${esc(e.note)}</td></tr>`).join("");
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
        ${f.kind && f.kind !== "attach" ? `<button class="btn small" data-frp="${esc(f.id)}">Reprocess</button>` : ""}
        <button class="btn small danger" data-fdel="${esc(f.id)}">Delete</button></div></td></tr>`;
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
  const body = { sku: $("#iSku").value.trim(), tax: $("#iTax").value, name: $("#iName").value.trim(), unit: $("#iUnit").value, qty: $("#iQty").value, price: $("#iPrice").value, minStock: $("#iMin").value };
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
    const V = baseVars(it, ms, S.dstats.get(it.key), S.settings);
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
    "Price incl PPN": it.tax === "PPN" ? Math.round(d.vars.price_incl) : "", "Stock value (excl PPN)": Math.round(d.vars.value), "Min stock": +it.minStock || 0 };
  for (const r of S.colRules) o[r.name] = d.cols[r.id];
  o.Alerts = d.alerts.map((r) => r.name).join("; ");
  return o;
}), `stock-ledger-${today()}.xlsx`);
const exportAlerts = () => exportXlsx(S.alerts.map(({ it, r }) => {
  const v = S.derived.get(it.key).vars;
  return { Severity: r.severity === "crit" ? "Critical" : "Warning", Alert: r.name, SKU: it.sku, Name: it.name, Ledger: taxLabel(it.tax), Unit: it.unit,
    "Current stock": v.qty, "Safety stock": v.safety_stock, "Reorder point": v.reorder_point, "Suggested order": v.suggested_order,
    "Days of cover": v.days_cover >= 9999 ? "no sales" : Math.round(v.days_cover) };
}), `stock-alerts-${today()}.xlsx`);
$("#expAlerts").onclick = exportAlerts;
$("#expAlerts2").onclick = exportAlerts;

$("#clearDemo").onclick = async () => {
  const b = $("#clearDemo");
  const n = Object.values(S.items).filter((it) => it.sku.startsWith("DEMO-")).length;
  if (!n) { toast("No example items left."); return; }
  if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = `Confirm: remove ${n}`; return; }
  try {
    await api.removeDemo();
    toast("Examples removed");
    scheduleReload();
  } catch (e) { handleErr(e); }
  b.dataset.confirm = "";
  b.textContent = "Remove examples";
};

/* ---------- boot ---------- */
renderAll();
fillSettings();
load().catch((e) => {
  setStatus("down", "Server unreachable");
  handleErr(e);
});
subscribe(scheduleReload, (s) => {
  if (s === "live") { setStatus("live", "Live · synced"); scheduleReload(); }
  else setStatus("down", "Reconnecting…");
});
