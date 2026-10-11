import { api, subscribe, setUnauthorizedHandler } from "./api.js";
import { parse, evalAst, VARS, colVar } from "./formula.js";
import { evaluate, baseVars, moveStats, coverage, MON_N, ymOf, ymAdd, ymLabel, DEFAULT_SETTINGS } from "./stock.js";
import { detectPlan, detectMonth, monthOfName, hasKodeHeader, taxFromHeader, parseSales, parseStock, parseWorkbook, readProductList } from "./reports.js";
import { fmtRp, fmtN, esc, keyOf, taxLabel, today } from "./util.js";
import { channelLabel, supplierChannels, waNumber, whatsappUrl, mailtoUrl, telUrl, defaultOrderQty, poMessage, poSubject } from "./contact.js";
import { lineAmount, invoiceTotals, lineNets, paymentState, terbilang, invoiceMessage, invoiceHtml } from "./invoice.js";

/* ---------- state ---------- */
const S = {
  items: {}, rules: [], suppliers: [], customers: [], pos: [], supplierPays: [], expenses: [], employees: [], salaries: [], invoices: [], invDem: undefined, users: [], me: null, owner: false,
  files: [], hist: [], dem: {}, moves: [], settings: { ...DEFAULT_SETTINGS, ent: {} }, usage: { bytes: 0 },
  derived: new Map(), alerts: [], colRules: [], dstats: new Map(), win: { PPN: [], NON: [] },
  sort: { k: "sku", d: 1 }, page: 0, per: 100, editKey: null, editRule: null, loaded: false,
};
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const nf = (n) => n.toLocaleString("id-ID");
const plural = (n, w, pl = w + "s") => `${nf(n)} ${n === 1 ? w : pl}`;
const initial = (name) => (String(name).match(/[\p{L}\p{N}]/u) || ["?"])[0].toUpperCase();
const entName = (t) => S.settings.ent?.[t]?.name || taxLabel(t);
const ledgerChip = (tax) => `<span class="chip ${tax === "PPN" ? "ppn" : "non"}">${taxLabel(tax)}</span>`;
const fmtCur = (n, c) => (c === "IDR" || !c ? fmtRp(n) : Number.isFinite(n) ? `${c} ${n.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");
const ymdLabel = (ymd) => (ymd ? new Date(ymd + "T00:00:00").toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }) : "");
const addDaysYmd = (ymd, n) => { const d = new Date(ymd + "T00:00:00"); d.setDate(d.getDate() + n); return today(d); };
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
const dash = '<span class="muted">—</span>';
const isOwner = () => S.me?.role === "admin";
const canEdit = () => S.me && S.me.role !== "viewer";
const supplierById = (id) => S.suppliers.find((x) => x.id === id);
const customerById = (id) => S.customers.find((c) => c.id === id);
const supplierOf = (it) => (it.supplierId ? supplierById(it.supplierId) : null);
const kpiHtml = (tiles) => tiles.map(([c, l, v, s]) => `<div class="kpi"><span class="l">${c ? `<span class="ic ${c}">${ICON.box}</span>` : ""}${l}</span><span class="v">${v}</span><span class="s">${s}</span></div>`).join("");
const ICON = { box: '<svg viewBox="0 0 24 24"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>' };

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3400);
}
function setStatus(state, text) {
  $("#syncStatus").textContent = text;
  $("#syncDot").className = "dot" + (state === "live" ? " live" : state === "down" ? " down" : "");
  $("#syncDot").parentElement.title = text;
}
const handleErr = (e) => {
  console.error(e);
  toast(e.message || "Could not save. Try again.");
};
const xlsxReady = () => typeof XLSX !== "undefined";
/**
 * Runs fn once after the current event. Dialog tables are re-rendered from "change" events; rebuilding them
 * synchronously removes the focused input, which fires another "change" in the middle of the rebuild.
 */
function later(fn) {
  if (later.q.has(fn)) return;
  later.q.add(fn);
  queueMicrotask(() => { later.q.delete(fn); fn(); });
}
later.q = new Set();
/** Sets innerHTML only when it changed, so a button the user is pressing is not swapped out under the pointer. */
function setHtml(el, html) {
  if (el._html === html) return;
  el.innerHTML = html;
  el._html = html;
}
/**
 * Updates an editable table body cell by cell. Only cells whose markup changed are replaced, so the input the user is
 * clicking into stays in place while the line they just left is recalculated.
 */
function patchRows(tbody, html) {
  const cells = (old, tr) => old.cells.length === tr.cells.length && patchKids(old, [...tr.cells]);
  const tpl = document.createElement("tbody");
  tpl.innerHTML = html;
  const next = [...tpl.children], cur = [...tbody.children];
  // Rows that carry data-key are matched by key, so a row dropping out (e.g. filtered away after an edit) doesn't
  // shift every row below it and replace the input the user has already moved to.
  if (!next.length || !cur.length || ![...next, ...cur].every((r) => r.dataset.key)) return patchKids(tbody, next, "tbody", cells);
  const want = new Set(next.map((r) => r.dataset.key));
  cur.filter((r) => !want.has(r.dataset.key)).forEach((r) => r.remove());
  next.forEach((tr, i) => {
    const old = tbody.children[i];
    if (old?.dataset.key === tr.dataset.key) {
      if (old.outerHTML !== tr.outerHTML && !(old.className === tr.className && cells(old, tr))) old.replaceWith(tr);
    } else tbody.insertBefore(tr, old || null);
  });
  while (tbody.children.length > next.length) tbody.lastElementChild.remove();
}
/** Replaces only the children of el whose markup changed; `deeper` may patch a changed child in place instead. */
function patchKids(el, html, tag = "div", deeper = () => false) {
  let next = html;
  if (typeof html === "string") { const tpl = document.createElement(tag); tpl.innerHTML = html; next = [...tpl.children]; }
  const cur = [...el.children];
  next.forEach((n, i) => {
    const old = cur[i];
    if (!old) return el.append(n);
    if (old.outerHTML === n.outerHTML) return;
    if (old.tagName === n.tagName && old.className === n.className && deeper(old, n)) return;
    old.replaceWith(n);
  });
  cur.slice(next.length).forEach((x) => x.remove());
  return true;
}
async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
  catch { toast("Could not copy. Select the text and copy it manually."); }
}

/* ---------- load & recompute ---------- */
async function load() {
  const st = await api.state();
  Object.assign(S, {
    items: st.items, rules: st.rules, files: st.files, hist: st.history, dem: st.dem, moves: st.moves, settings: st.settings, usage: st.usage,
    suppliers: st.suppliers, customers: st.customers, pos: st.pos, supplierPays: st.supplierPays, expenses: st.expenses || [], employees: st.employees || [], salaries: st.salaries || [], invoices: st.invoices, invDem: st.invDem, owner: st.owner,
  });
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
  const r = evaluate({ items: S.items, rules: S.rules, moves: S.moves, dem: S.dem, hist: S.hist, settings: S.settings, invDem: S.invDem });
  Object.assign(S, { derived: r.derived, alerts: r.alerts, colRules: r.colRules, dstats: r.dstats, win: r.win });
  const badge = (sel, n, title) => { const b = $(sel); b.textContent = n; b.classList.toggle("zero", !n); b.title = title; };
  badge("#alertBadge", S.alerts.length, plural(S.alerts.length, "alert"));
  badge("#poBadge", S.pos.filter((p) => p.status === "draft").length, "draft purchase orders");
  badge("#arBadge", arEntries().filter((e) => e.od > 0).length, "overdue invoices");
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
  renderSales();
  renderContacts();
  fillSupplierSelects();
  if (isOwner()) { renderPos(); renderAR(); renderAP(); renderExpenses(); renderEmployees(); renderDash(); }
  refreshPoDialog();
  refreshInvDialog();
  $("#ledgerCount").textContent = plural(Object.keys(S.items).length, "item");
}

/* ---------- navigation ---------- */
const OWNER_TABS = ["dash", "po", "ar", "ap", "expenses", "employees", "settings", "users"];
function showTab(t) {
  if (!$("#page-" + t) || (OWNER_TABS.includes(t) && !isOwner())) t = "inventory";
  $$(".nav-item").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  $$(".page").forEach((p) => (p.hidden = p.id !== "page-" + t));
  try { localStorage.setItem("erp.tab", t); } catch {}
  if (location.hash.slice(1) !== t) history.pushState(null, "", "#" + t);
  if (t === "users") loadUsers();
}
$$(".nav-item").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

/* ---------- inventory ---------- */
function renderKpis() {
  let vP = 0, vN = 0, nP = 0, nN = 0, zero = 0, oo = 0;
  for (const it of Object.values(S.items)) {
    const v = S.derived.get(it.key)?.vars.value || 0;
    if (it.tax === "PPN") { vP += v; nP++; } else { vN += v; nN++; }
    if ((+it.qty || 0) <= 0) zero++;
    if (+it.onOrder > 0) oo++;
  }
  const crit = S.alerts.filter((a) => a.r.severity === "crit").length;
  const tiles = isOwner()
    ? [["ppn", "PPN stock at cost", fmtRp(vP), plural(nP, "SKU")], ["non", "Non-PPN stock at cost", fmtRp(vN), plural(nN, "SKU")]]
    : [["ppn", "PPN SKUs", nf(nP), "items in ledger"], ["non", "Non-PPN SKUs", nf(nN), "items in ledger"]];
  tiles.push(["warn", "Out of stock", nf(zero), "qty ≤ 0"], ["", "On order", nf(oo), "SKUs on open POs"], ["crit", "Alerts", nf(S.alerts.length), crit + " critical"]);
  $("#kpis").innerHTML = kpiHtml(tiles);
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
    if (fa === "onorder" && !(+it.onOrder > 0)) return false;
    if (fa === "noprice" && +it.sellPrice > 0) return false;
    if (q && !(it.sku.toLowerCase().includes(q) || String(it.name || "").toLowerCase().includes(q) || (supplierOf(it)?.company || "").toLowerCase().includes(q))) return false;
    return true;
  });
  const { k, d } = S.sort;
  const val = (it) => {
    if (k.startsWith("col:")) return S.derived.get(it.key)?.cols[k.slice(4)] ?? -Infinity;
    if (k.startsWith("v:")) return S.derived.get(it.key)?.vars[k.slice(2)] ?? 0;
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
  const cols = [["sku", "SKU"], ["name", "Product"], ["tax", "Ledger"], ["unit", "Unit"], ["qty", "On hand", "num"], ["onOrder", "On order", "num"], ["sellPrice", "Sell price", "num"], ["v:price_incl", "Incl. PPN", "num"]];
  if (isOwner()) cols.push(["v:cost", "Avg cost", "num"], ["v:margin_pct", "Margin", "num"], ["v:value", "Value at cost", "num"]);
  cols.push(["minStock", "Min", "num"], ["supplier", "Supplier"], ...S.colRules.map((r) => ["col:" + r.id, r.name, "num"]), ["alerts", "Alerts"]);
  $("#invTbl thead").innerHTML = "<tr>" + cols.map(([k, l, c]) =>
    `<th data-k="${esc(k)}" class="${c || ""}">${esc(l)}${S.sort.k === k ? `<span class="arrow">${S.sort.d > 0 ? "↑" : "↓"}</span>` : ""}</th>`).join("") + "</tr>";
  const tb = $("#invTbl tbody");
  if (!Object.keys(S.items).length) {
    tb.innerHTML = `<tr><td colspan="${cols.length}"><div class="empty"><strong>No products yet</strong><span>Add one with “Add product”, upload your yearly workbook under Files, or import a stock list under Settings.</span></div></td></tr>`;
    $("#pager").innerHTML = "";
    return;
  }
  const rows = invRows();
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="${cols.length}"><div class="empty">${$("#fAlert").value === "noprice" && !$("#q").value ? "Every product has a sell price. Invoices will fill them in." : "No items match these filters."}</div></td></tr>`;
    $("#pager").innerHTML = "";
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / S.per));
  if (S.page >= pages) S.page = pages - 1;
  // Cell-by-cell, so the price box the user is tabbing into isn't replaced when the table refreshes after a save.
  patchRows(tb, rows.slice(S.page * S.per, (S.page + 1) * S.per).map((it) => {
    const d = S.derived.get(it.key) || { vars: {}, cols: {}, alerts: [] };
    const v = d.vars;
    return `<tr data-key="${esc(it.key)}" class="${d.sev ? "sev-" + d.sev : ""}">
      <td class="sku">${esc(it.sku)}</td><td class="name">${esc(it.name)}</td><td>${ledgerChip(it.tax)}</td><td><span class="chip unit">${esc(it.unit)}</span></td>
      <td class="num"><span class="qty ${d.sev}">${fmtN(+it.qty || 0)}</span></td><td class="num">${+it.onOrder > 0 ? `<span class="qty-on">${fmtN(+it.onOrder)}</span>` : dash}</td>
      <td class="num">${canEdit() ? `<input class="sp-in${+it.sellPrice ? "" : " need"}" type="number" min="0" step="1" inputmode="numeric" value="${+it.sellPrice || ""}" placeholder="set price" data-sp="${esc(it.key)}" aria-label="Sell price for ${esc(it.sku)}">` : +it.sellPrice ? fmtRp(+it.sellPrice) : dash}</td><td class="num">${it.tax === "PPN" && +it.sellPrice ? fmtRp(v.price_incl) : dash}</td>
      ${isOwner() ? `<td class="num">${v.cost ? fmtRp(v.cost) : dash}</td><td class="num">${v.cost && v.price_excl ? `<span class="${v.margin_pct < 10 ? "err" : ""}">${v.margin_pct.toFixed(1)}%</span>` : dash}</td><td class="num">${v.value ? fmtRp(v.value) : dash}</td>` : ""}
      <td class="num">${it.minStock ? fmtN(+it.minStock) : dash}</td><td class="name">${esc(supplierOf(it)?.company || "") || dash}</td>
      ${S.colRules.map((r) => { const x = d.cols[r.id]; return `<td class="num">${x == null ? dash : Number.isNaN(x) ? '<span class="err">err</span>' : fmtN(x)}</td>`; }).join("")}
      <td><div class="chips">${d.alerts.map((r) => `<span class="chip ${r.severity}">${esc(r.name)}</span>`).join("")}</div></td></tr>`;
  }).join(""));
  $("#pager").innerHTML = `<span class="hint">${nf(S.page * S.per + 1)}–${nf(Math.min(rows.length, (S.page + 1) * S.per))} of ${nf(rows.length)}</span>
    <button class="btn small" data-pg="-1" ${S.page <= 0 ? "disabled" : ""}>Previous</button>
    <button class="btn small" data-pg="1" ${S.page >= pages - 1 ? "disabled" : ""}>Next</button>`;
}
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
  if (e.target.closest("[data-sp]")) return; // typing a price, not opening the product
  const tr = e.target.closest("tr[data-key]");
  if (tr) openItem(tr.dataset.key);
});
// Sell price straight in the table: saved when the box is left; Enter jumps to the next product's price.
$("#invTbl").addEventListener("change", async (e) => {
  const box = e.target.closest("[data-sp]");
  if (!box) return;
  const it = S.items[box.dataset.sp], v = box.value === "" ? 0 : Math.max(0, Math.round(+box.value || 0));
  if (!it || v === (+it.sellPrice || 0)) return;
  box.classList.add("saving");
  try {
    await api.setSellPrice(it.key, v);
    it.sellPrice = v; // shown at once; the live update refreshes the rest
    box.classList.toggle("need", !v);
    toast(v ? `${it.sku}: sell price ${fmtRp(v)}` : `${it.sku}: sell price cleared`);
  } catch (er) { handleErr(er); box.value = +it.sellPrice || ""; } finally { box.classList.remove("saving"); }
});
$("#invTbl").addEventListener("keydown", (e) => {
  const box = e.target.closest("[data-sp]");
  if (!box) return;
  if (e.key === "Escape") { box.value = +S.items[box.dataset.sp]?.sellPrice || ""; box.blur(); return; }
  if (e.key !== "Enter") return;
  e.preventDefault();
  const all = $$("#invTbl [data-sp]"), next = all[all.indexOf(box) + (e.shiftKey ? -1 : 1)];
  if (next) { next.focus(); next.select(); } else box.blur();
});
$("#pager").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pg]");
  if (!b) return;
  S.page += +b.dataset.pg;
  renderInv();
  window.scrollTo({ top: 0 });
});
function renderDatalist() {
  const its = Object.values(S.items);
  const sig = its.length + ":" + its.reduce((a, it) => a + it.sku.length + (+it.qty || 0), 0);
  if (renderDatalist._sig === sig) return;
  renderDatalist._sig = sig;
  $("#itemList").innerHTML = its.slice(0, 6000).map((it) => `<option value="${esc(it.sku)} · ${it.tax}">${esc(it.name)}</option>`).join("");
}
function findItem(v, tax) {
  v = String(v || "").trim();
  const m = v.match(/^(.*?)\s*·\s*(PPN|NON)$/i);
  if (m) return S.items[keyOf(m[2].toUpperCase(), m[1].trim())] || null;
  if (tax) return S.items[keyOf(tax, v)] || Object.values(S.items).find((it) => it.tax === tax && it.sku.toLowerCase() === v.toLowerCase()) || null;
  const c = Object.values(S.items).filter((it) => it.sku.toLowerCase() === v.toLowerCase());
  return c.length === 1 ? c[0] : null;
}
const itemOptions = (tax) => Object.values(S.items).filter((it) => it.tax === tax).slice(0, 6000)
  .map((it) => `<option value="${esc(it.sku)} · ${it.tax}">${esc(it.name)} · ${fmtN(+it.qty || 0)} ${esc(it.unit)}</option>`).join("");

/* ---------- product dialog ---------- */
function fillSupplierSelects() {
  const opts = (blank) => `<option value="">${blank}</option>` + S.suppliers.map((x) => `<option value="${esc(x.id)}">${esc(x.company)}</option>`).join("");
  for (const [sel, blank] of [["#iSupplier", "— No default supplier —"], ["#abSupplier", "Any supplier (one PO each)"]]) {
    const el = $(sel), cur = el.value;
    el.innerHTML = opts(blank);
    el.value = S.suppliers.some((x) => x.id === cur) ? cur : "";
  }
}
function openItem(key) {
  S.editKey = key;
  const it = key ? S.items[key] : { sku: "", name: "", unit: "PCS", qty: 0, sellPrice: 0, cost: 0, tax: "PPN", minStock: 0, moq: 0, lot: 0, supplierId: "" };
  if (!it) return;
  $("#itemDlgTitle").textContent = key ? "Edit product" : "Add product";
  $("#iSku").value = it.sku;
  $("#iTax").value = it.tax;
  $("#iName").value = it.name;
  $("#iUnit").value = it.unit;
  $("#iQty").value = it.qty;
  $("#iSell").value = it.sellPrice || "";
  $("#iCost").value = it.cost ? Math.round(it.cost) : "";
  $("#iMin").value = it.minStock || "";
  $("#iMoq").value = it.moq || "";
  $("#iLot").value = it.lot || "";
  fillSupplierSelects();
  $("#iSupplier").value = it.supplierId || "";
  $("#iErr").textContent = "";
  $("#iDel").hidden = !key;
  $("#iDelRow").hidden = true;
  $("#iSku").disabled = !!key;
  $("#iTax").disabled = !!key;
  priceHint();
  const dv = key ? S.derived.get(key)?.vars : null;
  const dem = $("#iDemand");
  dem.hidden = !dv;
  if (dv) {
    dem.innerHTML = dv.hist_months
      ? `Sales history: ${dv.hist_months} months${dv.stockout_months ? ` (${dv.stockout_months} stock-out months left out)` : ""} · avg ${fmtN(dv.avg_monthly_demand)} ${esc(it.unit)}/month · σ ${fmtN(dv.sd_monthly_demand)}<br>
        Safety stock <strong>${fmtN(dv.safety_stock)}</strong> · reorder point <strong>${fmtN(dv.reorder_point)}</strong> · on order ${fmtN(dv.on_order)} · suggested order <strong>${fmtN(dv.suggested_order)}</strong>
        ${dv.mixed_units ? '<br><span class="err">Also sold in the other unit — check PCS vs SET.</span>' : ""}`
      : "No sales history for this ledger yet, so safety stock is 0.";
  }
  const fs = key ? S.files.filter((f) => f.sku && f.sku.toLowerCase() === it.sku.toLowerCase()) : [];
  $("#iFiles").innerHTML = fs.length ? "Files: " + fs.map((f) => `<a class="file-link" href="${api.fileUrl(f.id)}">${esc(f.name)}</a>`).join(", ") : "";
  $("#itemDlg").showModal();
}
function priceHint() {
  const tax = $("#iTax").value, p = +$("#iSell").value || 0, r = +S.settings.ppnRate || 0, c = +$("#iCost").value || 0;
  const incl = S.settings.priceMode === "incl";
  const excl = tax === "PPN" && incl ? p / (1 + r / 100) : p;
  $("#iPriceHint").textContent = (tax === "PPN"
    ? incl ? `Price incl. PPN · DPP ${fmtRp(excl)} · PPN ${fmtRp(p - excl)}` : `Price excl. PPN · incl. PPN ${r}% = ${fmtRp(p * (1 + r / 100))}`
    : "Non-PPN item · no tax added") + (isOwner() && c && excl ? ` · margin ${(((excl - c) / excl) * 100).toFixed(1)}%` : "");
}
["#iSell", "#iCost"].forEach((s) => $(s).addEventListener("input", priceHint));
$("#iTax").addEventListener("change", priceHint);
$("#iCancel").onclick = $("#iClose").onclick = () => $("#itemDlg").close();
$("#iDel").onclick = () => ($("#iDelRow").hidden = false);
$("#iDelNo").onclick = () => ($("#iDelRow").hidden = true);
$("#iDelYes").onclick = async () => {
  try { await api.deleteItem(S.editKey); $("#itemDlg").close(); toast("Product deleted"); scheduleReload(); } catch (e) { handleErr(e); }
};
$("#itemForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = { sku: $("#iSku").value.trim(), tax: $("#iTax").value, name: $("#iName").value.trim(), unit: $("#iUnit").value, qty: $("#iQty").value,
    sellPrice: $("#iSell").value, minStock: $("#iMin").value, moq: $("#iMoq").value, lot: $("#iLot").value, supplierId: $("#iSupplier").value };
  if (isOwner()) body.cost = $("#iCost").value;
  if (!body.sku || !body.name) { $("#iErr").textContent = "SKU and product name are required."; return; }
  $("#iSave").disabled = true;
  try {
    if (S.editKey) await api.updateItem(S.editKey, body);
    else await api.createItem(body);
    $("#itemDlg").close();
    toast("Saved");
    scheduleReload();
  } catch (e) { $("#iErr").textContent = e.message; } finally { $("#iSave").disabled = false; }
});

/* ---------- alerts ---------- */
/** What current stock is compared against: the reorder point, or min stock when there is no sales history yet. */
function stockTarget(v) {
  if (v.hist_months > 0 || !v.min_stock) return { label: "Reorder point", val: v.reorder_point };
  return { label: "Min stock", val: v.min_stock };
}
function compareHtml(it, v, sev) {
  const t = stockTarget(v);
  // The shortfall counts stock already on order, so an item on an open order isn't ordered again.
  const gap = t.val - v.position;
  const u = `<small> ${esc(it.unit)}</small>`;
  return `<div class="compare">
    <div class="cmp now ${sev}"><span class="l">Current stock</span><span class="v">${fmtN(v.qty)}${u}</span>${v.on_order ? `<span class="sub">+${fmtN(v.on_order)} on order</span>` : ""}</div>
    <div class="cmp target"><span class="l">${t.label}</span><span class="v">${fmtN(t.val)}${u}</span></div>
    <div class="cmp gap"><span class="l">${gap > 0 ? "Short by" : "Covered, spare"}</span><span class="v">${fmtN(Math.abs(gap))}${u}</span></div>
  </div>`;
}
const posFor = (key) => S.pos.filter((p) => ["draft", "sent", "partial"].includes(p.status) && p.lines.some((l) => l.itemKey === key));
const poLink = (p) => `<button type="button" class="linklike" data-po="${esc(p.id)}">${esc(p.number)}</button> <span class="chip st-${p.status}">${PO_ST[p.status]}</span>`;
function supplierLine(it) {
  const sp = supplierOf(it);
  return sp
    ? `<div class="supline">Supplier <strong>${esc(sp.company)}</strong>${sp.contact ? ` · ${esc(sp.contact)}` : ""}</div>`
    : `<div class="supline"><span class="none">No default supplier</span></div>`;
}
function renderAlerts() {
  const el = $("#alertList");
  if (!S.alerts.length) {
    el.innerHTML = `<div class="empty"><strong>No active alerts</strong><span>Alerts appear when stock drops below safety stock, the reorder point or min stock. Reorder points need sales history: upload your yearly workbook under Files.</span></div>`;
    return;
  }
  el.innerHTML = S.alerts.slice(0, 500).map(({ it, r }) => {
    const v = S.derived.get(it.key).vars;
    const sev = r.severity;
    const top = Math.max(v.order_up_to, v.reorder_point, v.min_stock, v.position, 1) * 1.15;
    const pc = (x) => Math.min(100, Math.max(0, (x / top) * 100)).toFixed(1) + "%";
    const open = isOwner() ? posFor(it.key) : [];
    return `<div class="alert-item">
      <div class="t">
        <div class="row"><span class="chip ${sev}">${sev === "crit" ? "Critical" : "Warning"}</span><span class="mono">${esc(it.sku)}</span>${ledgerChip(it.tax)}</div>
        <div class="nm">${esc(it.name)}</div>
        <div class="hint">${esc(r.name)} · ${v.hist_months ? v.hist_months + " months of history" : "no sales history"} · avg ${fmtN(v.avg_monthly_demand)} ${esc(it.unit)}/month${v.moq ? ` · MOQ ${fmtN(v.moq)}` : ""}</div>
        ${supplierLine(it)}
        ${open.length ? `<div class="supline">On order: ${open.map(poLink).join(" ")}</div>` : ""}
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
        <button class="btn small primary" data-reorder="${esc(it.key)}" data-need="admin"><svg viewBox="0 0 24 24"><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 8H6"/><circle cx="10" cy="20" r="1"/><circle cx="17" cy="20" r="1"/></svg>Reorder</button>
        <button class="btn small" data-open="${esc(it.key)}">Open</button>
      </div>
    </div>`;
  }).join("") + (S.alerts.length > 500 ? `<div class="alert-item hint">Showing the first 500 of ${nf(S.alerts.length)}. Use the Inventory filter “With alerts” to see all.</div>` : "");
}
$("#alertList").addEventListener("click", (e) => {
  const po = e.target.closest("[data-po]");
  if (po) return openPo(po.dataset.po);
  const ro = e.target.closest("[data-reorder]");
  if (ro) return openReorder(ro.dataset.reorder);
  const b = e.target.closest("[data-open]");
  if (b) openItem(b.dataset.open);
});

/* alerts → draft purchase orders */
$("#abMake").onclick = async () => {
  const L = $("#abLedger").value, sup = $("#abSupplier").value, un = $("#abUnassigned").checked, msg = $("#abMsg");
  const seen = new Set();
  const its = S.alerts.map((a) => a.it).filter((it) => {
    if (seen.has(it.key) || it.tax !== L) return false;
    seen.add(it.key);
    return defaultOrderQty(S.derived.get(it.key).vars) > 0;
  });
  // One draft per supplier. Items without a default supplier go to the chosen supplier, if one is chosen.
  const groups = new Map();
  let skipped = 0;
  for (const it of its) {
    const s = sup ? (it.supplierId === sup || (!it.supplierId && un) ? sup : null) : it.supplierId || null;
    if (!s) { if (!it.supplierId) skipped++; continue; }
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push({ itemKey: it.key, qty: defaultOrderQty(S.derived.get(it.key).vars) });
  }
  if (!groups.size) {
    msg.className = "hint";
    msg.textContent = `No ${entName(L)} alerts with something to order${sup ? " for this supplier" : ""}.${skipped ? ` ${plural(skipped, "SKU")} have no default supplier: choose a supplier above to include them.` : ""}`;
    return;
  }
  try {
    const made = [];
    for (const [s, lines] of groups) made.push(await api.poFromAlerts(L, s, lines));
    msg.className = "okmsg";
    msg.textContent = `Created ${made.map((m) => m.number).join(", ")}${skipped && !sup ? ` · ${plural(skipped, "SKU")} without a default supplier left out` : ""}`;
    await load();
    openPo(made[0].id);
  } catch (e) { msg.className = "err"; msg.textContent = e.message; }
};

/* reorder one item: add it to its supplier's draft order */
let roKey = null;
function openReorder(key) {
  roKey = key;
  const it = S.items[key];
  if (!it) return;
  const d = S.derived.get(key);
  $("#roTitle").textContent = `Reorder ${it.sku}`;
  $("#roSub").textContent = it.name + " · " + entName(it.tax);
  $("#roCompare").innerHTML = compareHtml(it, d.vars, d.sev || "");
  const open = posFor(key);
  $("#roOnOrder").innerHTML = open.length
    ? `<div class="onorder"><span>Already on ${open.length === 1 ? "an open order" : "open orders"}:</span>${open.map((p) => {
        const l = p.lines.find((x) => x.itemKey === key);
        return `<span>${poLink(p)} · ${fmtN(l.qty - l.received)} ${esc(it.unit)}${p.status === "draft" ? " (not ordered yet)" : " still to come"}</span>`;
      }).join("")}</div>` : "";
  $("#roQty").value = defaultOrderQty(d.vars) || "";
  renderReorderSupplier();
  $("#roDlg").showModal();
}
function renderReorderSupplier() {
  const it = S.items[roKey];
  const sp = supplierOf(it);
  const box = $("#roSupplier");
  if (!sp) {
    box.innerHTML = `<div class="ro-sup"><strong>No default supplier for ${esc(it.sku)}</strong>
      ${S.suppliers.length ? `<div class="field"><label for="roPick">Assign a supplier</label><select id="roPick"><option value="">Choose…</option>${S.suppliers.map((x) => `<option value="${esc(x.id)}">${esc(x.company)}</option>`).join("")}</select></div>` : `<span class="hint">You have no suppliers yet.</span>`}
      <div><button type="button" class="btn small" id="roNewSup">Add a new supplier</button></div></div>`;
    $("#roActions").innerHTML = `<span class="spacer"></span><button type="button" class="btn" data-ro="cancel">Cancel</button>`;
    $("#roNote").textContent = "";
    $("#roPick")?.addEventListener("change", (e) => e.target.value && assignReorderSupplier(e.target.value));
    $("#roNewSup").onclick = () => { $("#roDlg").close(); openContact("supplier", null, (id) => assignReorderSupplier(id, true)); };
    return;
  }
  box.innerHTML = `<div class="ro-sup"><div class="sup-head"><span class="avatar">${esc(initial(sp.company))}</span>
      <div class="t"><h3>${esc(sp.company)}</h3><div class="pic">${sp.contact ? "PIC: " + esc(sp.contact) : "No person in charge"} · ${esc(sp.currency)}</div></div></div></div>`;
  const draft = S.pos.find((p) => p.status === "draft" && p.supplierId === sp.id && p.ledger === it.tax);
  $("#roNote").textContent = draft
    ? `Will be added to draft ${draft.number} (${plural(draft.lines.length, "line")} so far). Send it from Purchasing when it's complete.`
    : `A new draft order will be started for ${sp.company} → ${entName(it.tax)}.`;
  $("#roActions").innerHTML = `<span class="spacer"></span><button type="button" class="btn" data-ro="cancel">Cancel</button>
    <button type="button" class="btn" data-ro="open">Add &amp; open order</button><button type="button" class="btn primary" data-ro="add">Add to order</button>`;
}
async function assignReorderSupplier(id, reopen = false) {
  try {
    await api.setItemSupplier(roKey, id);
    await load();
    toast("Supplier assigned");
    if (reopen) openReorder(roKey); else renderReorderSupplier();
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

/* ---------- stock moves ---------- */
const MOVE_CHIP = { IN: "in", PO: "in", "TRF-IN": "in", OUT: "out", SALE: "out", "TRF-OUT": "out", ADJ: "adj", VOID: "adj" };
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
    <td class="sku">${esc(e.sku)}</td><td>${ledgerChip(e.tax)}</td><td><span class="chip ${MOVE_CHIP[e.type] || "adj"}">${esc(e.type)}</span></td>
    <td class="num">${e.qty > 0 ? "+" : ""}${fmtN(e.qty)}</td><td class="name">${esc(e.note)}</td><td>${esc(e.by || "")}</td></tr>`).join("");
}
$("#mvSave").onclick = async () => {
  const msg = $("#mvMsg");
  msg.className = "hint";
  const it = findItem($("#mvItem").value);
  if (!it) { msg.className = "err"; msg.textContent = "Pick a product from the list. If the SKU exists in both ledgers, choose the one with · PPN or · NON."; return; }
  if ($("#mvQty").value === "" || !(+$("#mvQty").value >= 0)) { msg.className = "err"; msg.textContent = "Enter a quantity."; return; }
  if (!$("#mvNote").value.trim()) { msg.className = "err"; msg.textContent = "Add a reason, so the change can be traced later."; return; }
  $("#mvSave").disabled = true;
  try {
    const r = await api.addMove({ key: it.key, type: $("#mvType").value, qty: +$("#mvQty").value, note: $("#mvNote").value.trim() });
    msg.className = "okmsg";
    msg.textContent = `${r.sku}: ${fmtN(r.from)} → ${fmtN(r.to)} ${r.unit}`;
    $("#mvQty").value = "";
    $("#mvNote").value = "";
    scheduleReload();
  } catch (e) { msg.className = "err"; msg.textContent = e.message; } finally { $("#mvSave").disabled = false; }
};

/* ---------- contacts (customers and suppliers) ---------- */
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
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-copy]");
  if (c) copyText(c.dataset.copy, "WeChat ID");
});
function allContacts() {
  return [
    ...S.customers.map((c) => ({ ...c, type: "customer" })),
    ...S.suppliers.map((x) => ({ ...x, name: x.company, type: "supplier" })),
  ];
}
function renderContacts() {
  const q = $("#cq").value.trim().toLowerCase(), ty = $("#cType").value;
  const owed = new Map();
  for (const e of arEntries()) owed.set(e.customerId, (owed.get(e.customerId) || 0) + e.out);
  const prodCount = new Map();
  for (const it of Object.values(S.items)) if (it.supplierId) prodCount.set(it.supplierId, (prodCount.get(it.supplierId) || 0) + 1);
  const invCount = new Map();
  for (const i of S.invoices) if (i.status === "issued") invCount.set(i.customerId, (invCount.get(i.customerId) || 0) + 1);
  const rows = allContacts()
    .filter((c) => (!ty || c.type === ty) && (!q || [c.name, c.contact, c.phone, c.whatsapp, c.npwp, c.address, c.email].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const tb = $("#cTbl");
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="7"><div class="empty">${S.customers.length + S.suppliers.length ? "No contacts match." : "<strong>No contacts yet</strong><span>Add your customers and suppliers. Mark your own entities as internal so transfers stay out of sales.</span>"}</div></td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((c) => `<tr data-ct="${c.type}:${esc(c.id)}">
    <td class="name"><strong>${esc(c.name)}</strong>${c.internal ? ' <span class="chip internal">Own entity</span>' : ""}${c.contact ? `<div class="hint">${esc(c.contact)}</div>` : ""}</td>
    <td>${c.type === "supplier" ? `<span class="chip unit">Supplier · ${esc(c.currency || "IDR")}</span>` : '<span class="chip col">Customer</span>'}</td>
    <td>${c.terms != null ? plural(c.terms, "day") : '<span class="muted">default</span>'}</td>
    <td>${esc(c.whatsapp || c.phone || "") || dash}</td><td class="name">${esc((c.address || "").split("\n")[0]) || dash}</td>
    <td class="num">${c.type === "supplier" ? nf(prodCount.get(c.id) || 0) : `${nf(invCount.get(c.id) || 0)} inv.`}</td>
    <td class="num" data-need="admin">${owed.get(c.id) ? `<span class="err">${fmtRp(owed.get(c.id))}</span>` : dash}</td></tr>`).join("");
}
["#cq", "#cType"].forEach((s) => $(s).addEventListener("input", renderContacts));
$("#cTbl").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-ct]");
  if (!tr) return;
  const [type, id] = tr.dataset.ct.split(":");
  openContact(type, id);
});
$("#ctNew").onclick = () => openContact($("#cType").value || "customer", null);

let ctEdit = null, ctReturn = null;
const CT_FIELDS = [["name", "#ctName"], ["contact", "#ctContact"], ["whatsapp", "#ctWhatsapp"], ["phone", "#ctPhone"], ["wechat", "#ctWechat"], ["email", "#ctEmail"],
  ["preferred", "#ctPreferred"], ["npwp", "#ctNpwp"], ["address", "#ctAddr"], ["notes", "#ctNote"]];
function syncCt() {
  const sup = $("#ctType").value === "supplier";
  $$("[data-ct=supplier]").forEach((el) => (el.hidden = !sup));
  $$("[data-ct=customer]").forEach((el) => (el.hidden = sup));
  $("#ctLedgerWrap").hidden = sup || !$("#ctInternal").checked;
}
["#ctType", "#ctInternal"].forEach((s) => $(s).addEventListener("change", syncCt));
function openContact(type, id, onSaved = null) {
  ctEdit = id ? { type, id } : null;
  ctReturn = onSaved;
  const c = id ? (type === "supplier" ? { ...supplierById(id), name: supplierById(id)?.company } : customerById(id)) : { currency: "CNY", ledger: "NON" };
  $("#ctTitle").textContent = id ? c.name : `New ${type}`;
  $("#ctType").value = type;
  $("#ctType").disabled = !!id;
  for (const [f, el] of CT_FIELDS) $(el).value = c[f] || "";
  $("#ctTerms").value = c.terms ?? "";
  $("#ctCur").value = c.currency || "CNY";
  $("#ctInternal").checked = !!c.internal;
  $("#ctLedger").value = c.ledger || "NON";
  $("#ctErr").textContent = "";
  $("#ctDel").hidden = !id;
  $("#ctDelRow").hidden = true;
  let h = "";
  if (id && type === "customer") {
    const inv = S.invoices.filter((v) => v.customerId === id && v.status === "issued");
    h = inv.length ? `${plural(inv.length, "invoice")} · ${fmtRp(inv.reduce((a, v) => a + v.total, 0))} · last ${ymdLabel(inv[0].date)}` : "No posted invoices yet.";
  } else if (id && isOwner()) {
    const pos = S.pos.filter((p) => p.supplierId === id);
    h = `${plural(Object.values(S.items).filter((it) => it.supplierId === id).length, "product")} · ${plural(pos.length, "purchase order")}`;
  }
  $("#ctHist").textContent = h;
  syncCt();
  $("#ctDlg").showModal();
}
$("#ctCancel").onclick = $("#ctClose").onclick = () => $("#ctDlg").close();
$("#ctDel").onclick = () => {
  const n = ctEdit.type === "supplier" ? Object.values(S.items).filter((it) => it.supplierId === ctEdit.id).length : 0;
  $("#ctDelText").textContent = n ? `Delete this supplier? ${plural(n, "product")} will have no default supplier.` : "Delete this contact?";
  $("#ctDelRow").hidden = false;
};
$("#ctDelNo").onclick = () => ($("#ctDelRow").hidden = true);
$("#ctDelYes").onclick = async () => {
  try {
    await (ctEdit.type === "supplier" ? api.deleteSupplier(ctEdit.id) : api.deleteCustomer(ctEdit.id));
    $("#ctDlg").close();
    toast("Contact deleted");
    scheduleReload();
  } catch (e) { $("#ctErr").textContent = e.message; }
};
$("#ctForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const type = $("#ctType").value;
  const v = Object.fromEntries(CT_FIELDS.map(([f, el]) => [f, $(el).value]));
  v.terms = $("#ctTerms").value;
  const dup = allContacts().find((c) => c.type === type && c.id !== ctEdit?.id && c.name.trim().toLowerCase() === v.name.trim().toLowerCase());
  if (dup) { $("#ctErr").textContent = `A ${type} called ${dup.name} already exists.`; return; }
  const body = type === "supplier"
    ? { company: v.name, contact: v.contact, whatsapp: v.whatsapp, phone: v.phone, wechat: v.wechat, email: v.email, preferred: v.preferred, npwp: v.npwp, address: v.address, notes: v.notes, terms: v.terms, currency: $("#ctCur").value }
    : { name: v.name, contact: v.contact, whatsapp: v.whatsapp, phone: v.phone, email: v.email, npwp: v.npwp, address: v.address, notes: v.notes, terms: v.terms, internal: $("#ctInternal").checked, ledger: $("#ctLedger").value };
  $("#ctSave").disabled = true;
  try {
    let id = ctEdit?.id;
    if (type === "supplier") { if (id) await api.updateSupplier(id, body); else id = (await api.createSupplier(body)).id; }
    else { if (id) await api.updateCustomer(id, body); else id = (await api.createCustomer(body)).id; }
    $("#ctDlg").close();
    toast("Contact saved");
    await load();
    if (ctReturn) ctReturn(id);
  } catch (e) { $("#ctErr").textContent = e.message; } finally { $("#ctSave").disabled = false; }
});

/* ---------- sales ---------- */
/** [css class, label] for an invoice's status. Staff see "Posted" without payment details. */
function invStatus(i) {
  if (i.status === "draft") return ["draft", "Draft"];
  if (i.status === "void") return ["void", "Cancelled"];
  if (i.internal) return ["internal", "Transfer"];
  if (!isOwner()) return ["unpaid", "Posted"];
  const p = paymentState(i.total, i.paid, i.dueDate, today());
  if (p.state === "paid") return ["paid", "Paid"];
  if (p.overdue) return ["overdue", `Overdue ${daysBetween(i.dueDate, today())}d`];
  return [p.state === "partial" ? "partial" : "unpaid", p.state === "partial" ? "Part paid" : "Open"];
}
const invBalance = (i) => (i.status === "issued" && !i.internal ? Math.max(0, Math.round(i.total - i.paid)) : 0);
function renderSales() {
  const q = $("#sq").value.trim().toLowerCase(), L = $("#sLedger").value;
  const from = addDaysYmd(today(), -(+$("#sRange").value || 31));
  const rows = S.invoices.filter((i) => (i.status === "draft" || i.date >= from) && (!L || i.tax === L) &&
    (!q || [i.number, i.custName, customerById(i.customerId)?.name, ...i.lines.map((l) => l.sku)].join(" ").toLowerCase().includes(q)));
  const tb = $("#sTbl tbody");
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="9"><div class="empty">${S.invoices.length ? "No invoices match." : "<strong>No invoices yet</strong><span>Create one with “New invoice”. Posting takes the items out of stock and feeds the reorder calculation.</span>"}</div></td></tr>`;
    return;
  }
  tb.innerHTML = rows.slice(0, 500).map((i) => {
    const [c, l] = invStatus(i);
    const t = i.status === "draft" ? invoiceTotals(i.lines, i.tax, S.settings.ppnRate, S.settings.priceMode, S.settings.ppnStyle) : { subtotal: i.subtotal, ppn: i.ppn, total: i.total };
    const name = i.status === "draft" ? customerById(i.customerId)?.name || "—" : i.custName;
    return `<tr data-inv="${esc(i.id)}"><td>${ymdLabel(i.date)}</td><td class="sku">${esc(i.number || "Draft")}</td><td class="name">${esc(name)}</td><td>${ledgerChip(i.tax)}</td>
      <td class="num">${i.lines.length}</td><td class="num">${fmtRp(t.subtotal)}</td><td class="num">${t.ppn ? fmtRp(t.ppn) : dash}</td><td class="num"><strong>${fmtRp(t.total)}</strong></td>
      <td><span class="chip ist-${c}">${esc(l)}</span></td></tr>`;
  }).join("");
}
["#sq", "#sLedger", "#sRange"].forEach((s) => $(s).addEventListener("input", renderSales));
$("#sTbl").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-inv]"); if (tr) openInvoice(tr.dataset.inv); });

/* new invoice */
function fillNewInvCustomers(selected = "") {
  const cs = S.customers.slice().sort((a, b) => a.internal - b.internal || a.name.localeCompare(b.name));
  $("#invNewCust").innerHTML = `<option value="">Choose a customer…</option>` + cs.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.internal ? " (own entity)" : ""}</option>`).join("");
  $("#invNewCust").value = selected;
}
$("#invNew").onclick = () => { fillNewInvCustomers(); $("#invNewDlg").showModal(); };
$("#invNewCancel").onclick = () => $("#invNewDlg").close();
$("#invNewCustAdd").onclick = () => { $("#invNewDlg").close(); openContact("customer", null, (id) => { fillNewInvCustomers(id); $("#invNewDlg").showModal(); }); };
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
  $("#invActions")._html = null; // a fresh dialog drops any half-confirmed button
  ["#invAddItem", "#invAddQty", "#invAddPrice"].forEach((x) => ($(x).value = ""));
  $("#invAddPrice").dataset.typed = "";
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
  if (draft && !invEdit) invEdit = { customerId: inv.customerId, date: inv.date, terms: inv.terms, note: inv.note, lines: inv.lines.map((l) => ({ ...l })) };
  const [stCls, stLabel] = invStatus(inv);
  const lines = draft ? invEdit.lines : inv.lines;
  $("#invTitle").innerHTML = `${esc(inv.number || "Draft invoice")} <span class="chip ist-${stCls}">${stLabel}</span> ${ledgerChip(inv.tax)}`;
  $("#invMeta").textContent = `${entName(inv.tax)} · ` + (draft ? `created by ${inv.createdBy}` : `posted ${inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString("id-ID") : ""} by ${inv.issuedBy}`);
  const cust = customerById(draft ? invEdit.customerId : inv.customerId);
  const note = $("#invVoidNote");
  if (inv.status === "void") { note.hidden = false; note.className = "note warnbox"; note.textContent = `Cancelled ${new Date(inv.voidedAt).toLocaleDateString("id-ID")}: ${inv.voidReason}. The stock was put back.`; }
  else if ((draft && cust?.internal) || inv.internal) {
    note.hidden = false; note.className = "note";
    const to = draft ? (cust.ledger && cust.ledger !== inv.tax ? cust.ledger : "") : inv.transferTo;
    note.textContent = `Internal transfer to ${draft ? cust.name : inv.custName}. ${to ? `Stock moves from ${entName(inv.tax)} into ${entName(to)} at this invoice's net price. ` : ""}It is left out of demand, sales and receivables.`;
  } else note.hidden = true;

  // header fields
  if (draft) {
    patchKids($("#invHead"), `
      <div class="field span2"><label for="ivCust">Customer</label><select id="ivCust" ${edit ? "" : "disabled"}>${S.customers.map((c) => `<option value="${esc(c.id)}"${c.id === invEdit.customerId ? " selected" : ""}>${esc(c.name)}${c.internal ? " (own entity)" : ""}</option>`).join("")}</select></div>
      <div class="field"><label for="ivDate">Invoice date</label><input id="ivDate" type="date" value="${esc(invEdit.date)}" ${edit ? "" : "disabled"}></div>
      <div class="field"><label for="ivTerms">Terms (days)</label><input id="ivTerms" type="number" min="0" max="365" step="1" value="${invEdit.terms}" ${edit ? "" : "disabled"}></div>
      <div class="field"><label for="ivDue">Due date</label><input id="ivDue" type="date" value="${esc(addDaysYmd(invEdit.date, +invEdit.terms || 0))}" disabled></div>`);
  } else {
    patchKids($("#invHead"), `
      <div class="field span2"><span class="group-l">Bill to</span><div><strong>${esc(inv.custName)}</strong><div class="hint">${esc(inv.custAddress).replace(/\n/g, "<br>")}</div>${inv.custNpwp ? `<div class="hint">NPWP ${esc(inv.custNpwp)}</div>` : ""}</div></div>
      <div class="field"><span class="group-l">Invoice date</span><div>${ymdLabel(inv.date)}</div></div>
      <div class="field"><label for="ivDue">Due date</label><input id="ivDue" type="date" value="${esc(inv.dueDate)}" ${inv.status === "issued" && canEdit() ? "" : "disabled"}></div>
      ${inv.tax === "PPN" ? `<div class="field"><label for="ivNsfp">e-Faktur number (NSFP)</label><input id="ivNsfp" class="mono" value="${esc(inv.nsfp)}" placeholder="from Coretax" ${inv.status === "issued" && canEdit() ? "" : "disabled"}></div>` : ""}`);
  }

  // lines
  const stockLeft = (key) => S.items[key] ? +S.items[key].qty || 0 : 0;
  const needBy = new Map();
  for (const l of lines) needBy.set(l.itemKey, (needBy.get(l.itemKey) || 0) + l.qty);
  $("#invLines thead").innerHTML = `<tr><th class="hide-sm">SKU</th><th>Product</th>${draft ? `<th class="num hide-sm">In stock</th>` : ""}<th class="num">Qty</th><th class="num">Price</th><th class="num hide-sm">Disc %</th><th class="num${draft ? " hide-sm" : ""}">Amount</th>${edit ? "<th></th>" : ""}</tr>`;
  patchRows($("#invLines tbody"), lines.length ? lines.map((l, i) => {
    const short = draft && needBy.get(l.itemKey) > stockLeft(l.itemKey);
    return `<tr><td class="sku hide-sm">${esc(l.sku)}</td><td class="name">${esc(l.name)}<div class="hint mono sm-only">${esc(l.sku)}</div>${draft && !(+l.price) ? '<div class="err">No price</div>' : ""}</td>
      ${draft ? `<td class="num hide-sm${short ? " short" : ""}" title="${short ? "Not enough stock to issue" : ""}">${fmtN(stockLeft(l.itemKey))}</td>` : ""}
      <td class="num">${edit ? `<input class="q" type="number" min="1" step="1" value="${l.qty}" data-il="${i}" data-if="qty" aria-label="Quantity for ${esc(l.sku)}">` : fmtN(l.qty)} <span class="hint">${esc(l.unit)}</span></td>
      <td class="num">${edit ? `<input type="number" min="0" step="1" value="${l.price}" data-il="${i}" data-if="price" aria-label="Price for ${esc(l.sku)}">` : fmtRp(l.price)}</td>
      <td class="num hide-sm">${edit ? `<input class="disc" type="number" min="0" max="100" step="0.5" value="${l.discPct || 0}" data-il="${i}" data-if="discPct" aria-label="Discount for ${esc(l.sku)}">` : l.discPct ? fmtN(l.discPct) + "%" : ""}</td>
      <td class="num${draft ? " hide-sm" : ""}">${fmtRp(lineAmount(l))}</td>${edit ? `<td><button type="button" class="icon-btn" data-ildel="${i}" aria-label="Remove ${esc(l.sku)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td>` : ""}</tr>`;
  }).join("") : `<tr><td colspan="8"><div class="empty">No products yet. Add one below.</div></td></tr>`);
  $("#invAddRow").hidden = !edit;
  $("#invAddPrice").placeholder = inv.tax === "PPN" ? (S.settings.priceMode === "incl" ? "Price incl. PPN" : "Price excl. PPN") : "Sell price";
  if (edit) $("#invItemList").innerHTML = itemOptions(inv.tax);

  // note
  $("#invNote").value = draft ? invEdit.note : inv.note;
  $("#invNote").disabled = !edit;
  $("#invNoteWrap").hidden = !draft && !inv.note;

  // totals
  const t = draft ? invoiceTotals(lines, inv.tax, S.settings.ppnRate, S.settings.priceMode, S.settings.ppnStyle) : { subtotal: inv.subtotal, dppLain: inv.dppLain, ppn: inv.ppn, total: inv.total, scheme: inv.dppLain ? "dpp-lain" : inv.ppn ? "flat" : "none" };
  const row = (l, v, cls = "") => `<div class="tr ${cls}"><span>${l}</span><span>${v}</span></div>`;
  $("#invTotals").innerHTML = (draft ? `<div class="hint">${inv.tax === "PPN" ? (S.settings.priceMode === "incl" ? "Line prices include PPN" : "Line prices exclude PPN") : "Non-PPN: no tax added"}</div>` : "") + row("Subtotal (DPP)", fmtRp(t.subtotal)) +
    (t.scheme === "dpp-lain" ? row("DPP Nilai Lain (11/12)", fmtRp(t.dppLain)) + row("PPN 12%", fmtRp(t.ppn)) : t.scheme === "flat" ? row(`PPN ${S.settings.ppnRate}%`, fmtRp(t.ppn)) : "") +
    row("Total", fmtRp(t.total), "grand") +
    (inv.status === "issued" && inv.paid ? row("Paid", fmtRp(inv.paid)) + row("Still owed", fmtRp(invBalance(inv)), invBalance(inv) ? "owed" : "") : "") +
    `<div class="words">${esc(terbilang(t.total))}</div>`;

  // payments
  const pays = inv.payments.map((p) => `<div class="pay"><span>${ymdLabel(p.date)}</span><span class="chip unit">${esc(p.method)}</span><span class="hint">${esc(p.note)}${p.by ? " · " + esc(p.by) : ""}</span><span class="amt">${fmtRp(p.amount)}</span>
    <button type="button" class="icon-btn" data-pdel="${esc(p.id)}" data-need="admin" aria-label="Remove payment"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join("");
  const bal = invBalance(inv);
  $("#invPayments").innerHTML = inv.status === "issued" && isOwner() && !inv.internal ? `<div class="field"><span class="group-l">Payments</span>
      ${pays ? `<div class="pay-list">${pays}</div>` : '<span class="hint">No payments yet.</span>'}</div>
      ${bal && isOwner() ? `<div class="pay-form">
        <div class="field"><label for="payAmt">Amount received</label><input id="payAmt" type="number" min="1" step="1" value="${bal}"></div>
        <div class="field"><label for="payDate">Date</label><input id="payDate" type="date" value="${today()}"></div>
        <div class="field"><label for="payMethod">Method</label><select id="payMethod"><option value="transfer">Bank transfer</option><option value="cash">Cash</option><option value="giro">Giro / cheque</option><option value="offset">Offset</option><option value="other">Other</option></select></div>
        <div class="field"><label for="payNote">Reference</label><input id="payNote" placeholder="e.g. BCA ref"></div>
        <button type="button" class="btn" id="payGo">Record payment</button></div>` : ""}` : "";

  // send box
  $("#invSendBox").hidden = !(invSendOpen && inv.status === "issued");
  if (invSendOpen && inv.status === "issued") {
    if ($("#invMsg").dataset.for !== inv.id) {
      $("#invMsg").value = invoiceMessage({ customer: cust, inv, issuer: S.settings.ent?.[inv.tax], balance: isOwner() ? bal : null });
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
      <button type="button" class="btn" data-ia="save" data-need="staff">Save draft</button>
      <button type="button" class="btn primary" data-ia="issue" data-need="staff" ${lines.length ? "" : "disabled"}>Post invoice</button>`;
  else if (inv.status === "issued") a = `<button type="button" class="btn ghost-danger" data-ia="void" data-need="admin">Cancel invoice</button><span class="spacer"></span>
      <button type="button" class="btn" data-ia="savehead" data-need="staff">Save due date${inv.tax === "PPN" ? " / NSFP" : ""}</button>
      <button type="button" class="btn" data-ia="send">${invSendOpen ? "Hide message" : "Send to customer"}</button>
      <button type="button" class="btn primary" data-ia="print">Print / PDF</button>`;
  else a = `<span class="spacer"></span><button type="button" class="btn" data-ia="print">Print</button>`;
  setHtml($("#invActions"), a);
  $("#invActions [data-ia=save]")?.toggleAttribute("disabled", !invDirty);
}
function invMarkDirty() {
  invDirty = true;
  later(renderInvoiceDialog);
}
$("#invHead").addEventListener("change", (e) => {
  const inv = curInv();
  if (!inv || inv.status !== "draft") return;
  if (e.target.id === "ivCust") invEdit.customerId = e.target.value;
  if (e.target.id === "ivCust") {
    const c = customerById(e.target.value);
    if (c) invEdit.terms = c.internal ? 0 : c.terms != null ? c.terms : +S.settings.invoiceTerms || 0;
  }
  if (e.target.id === "ivDate") invEdit.date = e.target.value;
  if (e.target.id === "ivTerms") invEdit.terms = Math.max(0, Math.round(+e.target.value || 0));
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
// Picking a product fills the price box with its sell price; whatever is in the box when adding goes on the line.
$("#invAddItem").addEventListener("input", () => {
  const inv = curInv(), it = inv && findItem($("#invAddItem").value, inv.tax), box = $("#invAddPrice");
  if (!inv || !it || it.tax !== inv.tax || box.dataset.typed) return;
  box.value = +it.sellPrice || "";
  $("#invErr").textContent = it.sellPrice ? "" : `${it.sku} has no sell price saved. Type the price here; set it on the product to have it filled in next time.`;
});
$("#invAddPrice").addEventListener("input", (e) => { e.target.dataset.typed = e.target.value === "" ? "" : "1"; });
["#invAddItem", "#invAddQty", "#invAddPrice"].forEach((s) => $(s).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#invAddBtn").click(); } }));
$("#invAddBtn").onclick = () => {
  const inv = curInv(), it = findItem($("#invAddItem").value, inv.tax), qty = +$("#invAddQty").value || 1;
  if (!it || it.tax !== inv.tax) { $("#invErr").textContent = `Pick a ${entName(inv.tax)} product from the list.`; return; }
  const box = $("#invAddPrice"), price = box.value !== "" ? Math.max(0, +box.value || 0) : +it.sellPrice || 0;
  $("#invErr").textContent = price ? "" : `${it.sku} has no price. Type it on the line before posting.`;
  invEdit.lines.push({ itemKey: it.key, sku: it.sku, name: it.name, unit: it.unit, qty, price, discPct: 0 });
  $("#invAddItem").value = "";
  $("#invAddQty").value = "";
  box.value = "";
  box.dataset.typed = "";
  invMarkDirty();
  $("#invAddItem").focus();
};
async function saveInvDraft() {
  await api.invSave(invId, { customerId: invEdit.customerId, date: invEdit.date, terms: invEdit.terms, note: invEdit.note,
    lines: invEdit.lines.map((l) => ({ itemKey: l.itemKey, qty: l.qty, price: l.price, discPct: l.discPct || 0 })) });
  invDirty = false;
  invEdit = null;
  await load();
}
function printInvoice() {
  const inv = curInv();
  const draft = inv.status === "draft";
  const doc = invoiceHtml({
    inv: draft ? { ...inv, ...invEdit, dueDate: addDaysYmd(invEdit.date, +invEdit.terms || 0), customer: customerById(invEdit.customerId), priceMode: S.settings.priceMode, ppnStyle: S.settings.ppnStyle } : inv,
    lines: draft ? invEdit.lines : inv.lines, issuer: { ...S.settings.ent?.[inv.tax], footer: S.settings.footer }, payments: inv.payments, ppnRate: S.settings.ppnRate,
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
        if (b.dataset.confirm !== "1") {
          b.dataset.confirm = "1";
          b.textContent = "Confirm: post and take items out of stock";
          $("#invErr").textContent = "Not posted yet. Click Confirm to give it a number and add it to receivables.";
          return;
        }
        b.disabled = true;
        if (invDirty) await saveInvDraft();
        const r = await api.invIssue(invId);
        toast(r.internal ? `Transfer ${r.number} posted.${r.transferTo ? " Stock moved to " + entName(r.transferTo) + "." : ""}` : `Posted ${r.number}: ${fmtRp(r.total)}. Stock updated.`);
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
        if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirm cancel…"; return; }
        const reason = prompt(`Why is ${inv.number} being cancelled? (kept with the invoice; the number is not reused)`);
        if (!reason) { b.dataset.confirm = ""; b.textContent = "Cancel invoice"; return; }
        await api.invVoid(invId, reason); toast(`${inv.number} cancelled. Stock was put back.`); await load(); break;
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
/** Closing never throws work away: a changed draft is saved first (drafts don't touch stock or numbers). */
async function closeInvoice() {
  if (invDirty && curInv()?.status === "draft") {
    try { await saveInvDraft(); } catch (e) { $("#invErr").textContent = e.message + " The draft was not saved."; return; }
  }
  $("#invDlg").close();
}
$("#invClose").onclick = closeInvoice;
$("#invDlg").addEventListener("cancel", (e) => { if (invDirty) { e.preventDefault(); closeInvoice(); } });
$("#invDlg").addEventListener("close", () => {
  const inv = curInv();
  if (inv?.status === "draft" && inv.lines.length) toast("Draft saved. It is not in receivables until you post it.");
  invDirty = false; invId = null; $("#invMsg").dataset.for = "";
});

/* invoice settings */

/* ---------- purchasing (owners) ---------- */
const PO_ST = { draft: "Draft", sent: "Ordered", partial: "Part received", received: "Received", closed: "Closed short", cancelled: "Cancelled" };
const poGoods = (p) => p.lines.reduce((a, l) => a + l.qty * l.price, 0);
const poPayable = (p) => (p.status === "draft" ? 0 : p.status === "cancelled" || p.status === "closed" ? p.lines.reduce((a, l) => a + l.received * l.price, 0) : poGoods(p));
const poPaid = (p) => S.supplierPays.filter((x) => x.poId === p.id).reduce((a, x) => a + x.amount, 0);
const poFx = (p) => (p.currency === "IDR" ? 1 : +p.fx || 0);
/** Landed cost per unit in rupiah: price × rate, plus freight, duty and other costs spread over the lines by value. */
function landedUnit(p, l) {
  const g = poGoods(p), ch = (+p.freight || 0) + (+p.duty || 0) + (+p.otherCost || 0);
  return (+l.price || 0) * poFx(p) + (g > 0 ? (ch * (+l.price || 0)) / g : 0);
}
const transitValue = (p) => p.lines.reduce((b, l) => b + Math.max(0, l.qty - l.received) * landedUnit(p, l), 0);
function renderPos() {
  const open = S.pos.filter((p) => ["sent", "partial"].includes(p.status));
  const late = open.filter((p) => p.eta && p.eta < today()).length;
  $("#poKpis").innerHTML = kpiHtml([
    ["", "Open orders", nf(open.length), plural(S.pos.filter((p) => p.status === "draft").length, "draft")],
    ["non", "Goods on the way", fmtRp(open.reduce((a, p) => a + transitValue(p), 0)), "landed value, not yet received"],
    ["crit", "Past ETA", nf(late), "ordered, arrival date passed"],
  ]);
  const q = $("#poq").value.trim().toLowerCase(), all = $("#poStatus").value === "all";
  const rows = S.pos.filter((p) => (all || ["draft", "sent", "partial"].includes(p.status)) &&
    (!q || [p.number, supplierById(p.supplierId)?.company, ...p.lines.map((l) => l.sku)].join(" ").toLowerCase().includes(q)));
  const tb = $("#poTbl tbody");
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="9"><div class="empty">${S.pos.length ? "No purchase orders here." : "<strong>No purchase orders yet</strong><span>Create one here, use “Reorder” on an alert, or turn all alerts into a draft from the Alerts tab.</span>"}</div></td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((p) => {
    const tq = p.lines.reduce((a, l) => a + l.qty, 0), rq = p.lines.reduce((a, l) => a + l.received, 0);
    const isLate = ["sent", "partial"].includes(p.status) && p.eta && p.eta < today();
    return `<tr data-po="${esc(p.id)}"><td class="sku">${esc(p.number)}</td><td class="name">${esc(supplierById(p.supplierId)?.company || "—")}</td><td>${ledgerChip(p.ledger)}</td>
      <td>${ymdLabel(p.orderDate)}</td><td class="${isLate ? "late" : ""}">${ymdLabel(p.eta) || dash}</td><td class="num">${p.lines.length}</td><td class="num">${fmtCur(poGoods(p), p.currency)}</td>
      <td>${p.status === "draft" ? dash : `<span class="progress"><span class="bar"><i style="width:${tq ? Math.round((rq / tq) * 100) : 0}%"></i></span>${tq ? Math.round((rq / tq) * 100) : 0}%</span>`}</td>
      <td><span class="chip st-${p.status}">${PO_ST[p.status]}</span></td></tr>`;
  }).join("");
}
["#poq", "#poStatus"].forEach((s) => $(s).addEventListener("input", renderPos));
$("#poTbl").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-po]"); if (tr) openPo(tr.dataset.po); });
$("#poNew").onclick = async () => {
  if (!S.suppliers.length) { toast("Add a supplier under Contacts first."); showTab("contacts"); return; }
  try {
    const r = await api.poCreate(S.suppliers[0].id, "PPN");
    await load();
    openPo(r.id);
  } catch (e) { handleErr(e); }
};

// The dialog edits a local copy; nothing is saved until "Save", "Order" or "Receive".
let poId = null, poEdit = null, poDirty = false, poSendOpen = false;
const curPo = () => S.pos.find((x) => x.id === poId);
function openPo(id) {
  poId = id;
  $("#poActions")._html = null;
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
const HEAD = [["supplierId", "#pSupp"], ["ledger", "#pLedger"], ["orderDate", "#pDate"], ["eta", "#pEta"], ["currency", "#pCur"], ["fx", "#pFx"], ["freight", "#pFreight"], ["duty", "#pDuty"], ["otherCost", "#pOther"]];
function renderPoDialog() {
  const p0 = curPo();
  if (!p0) return;
  const draft = p0.status === "draft", rcv = ["sent", "partial"].includes(p0.status);
  if (!poEdit) poEdit = { ...p0, lines: p0.lines.map((l) => ({ ...l, now: Math.max(0, l.qty - l.received) })) };
  const p = poEdit;
  const sp = supplierById(p.supplierId);
  $("#poTitle").innerHTML = `${esc(p.number)} <span class="chip st-${p0.status}">${PO_ST[p0.status]}</span> ${ledgerChip(p.ledger)}`;
  $("#poMeta").textContent = [`Created ${new Date(p0.createdAt).toLocaleDateString("id-ID")}${p0.createdBy ? " by " + p0.createdBy : ""}`, p0.sentAt ? `ordered ${new Date(p0.sentAt).toLocaleDateString("id-ID")}${p0.sentVia && p0.sentVia !== "other" ? " via " + channelLabel(p0.sentVia) : ""}` : ""].filter(Boolean).join(" · ");
  $("#pSupp").innerHTML = S.suppliers.map((x) => `<option value="${esc(x.id)}">${esc(x.company)}</option>`).join("");
  for (const [k, sel] of HEAD) $(sel).value = p[k] ?? "";
  $("#pFxWrap").hidden = p.currency === "IDR";
  ["#pSupp", "#pLedger", "#pDate", "#pCur"].forEach((s) => ($(s).disabled = !draft));
  ["#pEta", "#pFx", "#pFreight", "#pDuty", "#pOther", "#poNote"].forEach((s) => ($(s).disabled = !(draft || rcv)));
  $("#poSupplier").innerHTML = sp && supplierChannels(sp).length ? `<div class="ro-sup"><div class="contacts">${contactRows(sp)}</div></div>` : "";
  const cur = p.currency;
  $("#poLines thead").innerHTML = `<tr><th class="hide-sm">SKU</th><th>Product</th><th class="num">Qty</th><th class="num">Price (${esc(cur)})</th>${draft ? "" : `<th class="num">Received</th>`}${rcv ? `<th class="num">Receive now</th>` : ""}<th class="num hide-sm">Landed / unit</th>${draft ? "<th></th>" : ""}</tr>`;
  patchRows($("#poLines tbody"), p.lines.length ? p.lines.map((l, i) => {
    const it = S.items[l.itemKey];
    const v = it && S.derived.get(it.key)?.vars;
    const left = Math.max(0, l.qty - l.received);
    return `<tr><td class="sku hide-sm">${esc(l.sku)}</td><td class="name">${esc(l.name)}<div class="hint mono sm-only">${esc(l.sku)}</div>${draft && v ? `<div class="hint">${fmtN(v.qty)} on hand · suggested ${fmtN(v.suggested_order)}${v.moq ? ` · MOQ ${fmtN(v.moq)}` : ""}</div>` : ""}</td>
      <td class="num">${draft ? `<input class="q" type="number" min="1" step="1" value="${l.qty}" data-li="${i}" data-lf="qty" aria-label="Quantity for ${esc(l.sku)}">` : fmtN(l.qty)} <span class="hint">${esc(l.unit)}</span></td>
      <td class="num">${draft || rcv ? `<input type="number" min="0" step="0.0001" value="${l.price}" data-li="${i}" data-lf="price" aria-label="Price for ${esc(l.sku)}">` : fmtN(l.price)}</td>
      ${draft ? "" : `<td class="num">${fmtN(l.received)}</td>`}
      ${rcv ? `<td class="num">${left ? `<input type="number" min="0" max="${left}" step="1" value="${l.now}" data-li="${i}" data-lf="now" aria-label="Received now for ${esc(l.sku)}">` : '<span class="okmsg">✓ complete</span>'}</td>` : ""}
      <td class="num hide-sm">${fmtRp(landedUnit(p, l))}</td>
      ${draft ? `<td><button type="button" class="icon-btn" data-ldel="${i}" aria-label="Remove ${esc(l.sku)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td>` : ""}</tr>`;
  }).join("") : `<tr><td colspan="8"><div class="empty">No products on this order yet. Add one below.</div></td></tr>`);
  $("#poAddRow").hidden = !draft;
  if (draft) $("#poItemList").innerHTML = itemOptions(p.ledger);
  $("#poNote").value = p.note || "";
  $("#poNoteWrap").hidden = !draft && !rcv && !p.note;
  const g = poGoods(p), ch = (+p.freight || 0) + (+p.duty || 0) + (+p.otherCost || 0), fx = poFx(p);
  const row = (l, v, cls = "") => `<div class="tr ${cls}"><span>${l}</span><span>${v}</span></div>`;
  $("#poTotals").innerHTML = row("Goods", fmtCur(g, cur)) + (cur !== "IDR" ? row("Goods in Rp", fx ? fmtRp(g * fx) : '<span class="err">set the rate</span>') : "") +
    row("Freight, duty, other", fmtRp(ch)) + row("Landed total", fmtRp(g * fx + ch), "grand") +
    (draft ? "" : row("Paid to supplier", fmtCur(poPaid(p0), cur)));
  $("#poSend").hidden = !(poSendOpen && sp);
  if (poSendOpen && sp) renderSendBox(p0, sp);
  let a = "";
  if (draft) a = `<button type="button" class="btn ghost-danger" data-pa="delete">Delete draft</button><span class="spacer"></span>
      <button type="button" class="btn" data-pa="save">Save draft</button>
      <button type="button" class="btn" data-pa="order" ${p.lines.length ? "" : "disabled"}>Mark as ordered</button>
      <button type="button" class="btn primary" data-pa="send" ${p.lines.length ? "" : "disabled"}>${poSendOpen ? "Hide message" : "Send to supplier…"}</button>`;
  else if (rcv) a = `<button type="button" class="btn ghost-danger" data-pa="close">${p0.status === "sent" ? "Cancel PO" : "Close, cancel the rest"}</button><span class="spacer"></span>
      <button type="button" class="btn" data-pa="xlsx">Excel for supplier</button>
      <button type="button" class="btn" data-pa="save">Save changes</button>
      <button type="button" class="btn" data-pa="resend">${poSendOpen ? "Hide message" : "Message again"}</button>
      <button type="button" class="btn primary" data-pa="receive">Receive goods</button>`;
  else a = `<span class="spacer"></span><button type="button" class="btn" data-pa="xlsx">Excel for supplier</button><button type="button" class="btn" data-pa="x">Close</button>`;
  setHtml($("#poActions"), a);
  $("#poActions [data-pa=save]")?.toggleAttribute("disabled", !poDirty);
}
function renderSendBox(p, sp) {
  if ($("#poMsg").dataset.for !== p.id + ":" + p.status) {
    $("#poMsg").value = poMessage({ supplier: sp, po: p });
    $("#poMsg").dataset.for = p.id + ":" + p.status;
  }
  const label = { whatsapp: "Send on WhatsApp", wechat: "Copy for WeChat", email: "Send email", phone: "Call" };
  $("#poChannels").innerHTML = supplierChannels(sp).map((ch) => `<button type="button" class="btn ch-${ch}${sp.preferred === ch ? " pref" : ""}" data-ch="${ch}">${label[ch]}</button>`).join("") ||
    '<span class="hint">This supplier has no WhatsApp, WeChat, email or phone saved.</span>';
  $("#poSendNote").textContent = (p.status === "draft" ? "The order is marked as ordered when you use one of these buttons. " : "") +
    (supplierChannels(sp).includes("wechat") ? "WeChat: the message is copied; paste it in WeChat." : "");
}
function poMarkDirty(rerender = true) {
  poDirty = true;
  poSendOpen = false;
  $("#poMsg").dataset.for = "";
  if (rerender) later(renderPoDialog);
  else $("#poActions [data-pa=save]")?.removeAttribute("disabled");
}
$("#poHead").addEventListener("change", (e) => {
  const f = HEAD.find(([, sel]) => sel === "#" + e.target.id);
  if (!f) return;
  const [k] = f;
  poEdit[k] = ["fx", "freight", "duty", "otherCost"].includes(k) ? Math.max(0, +e.target.value || 0) : e.target.value;
  if (k === "supplierId") { const sp = supplierById(e.target.value); if (sp) poEdit.currency = sp.currency || "IDR"; }
  if (k === "currency" && poEdit.currency === "IDR") poEdit.fx = 1;
  if (k === "ledger") poEdit.lines = poEdit.lines.filter((l) => S.items[l.itemKey]?.tax === poEdit.ledger);
  poMarkDirty();
});
$("#poLines").addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.li == null) return;
  const l = poEdit.lines[+t.dataset.li];
  const v = Math.max(0, +t.value || 0);
  if (t.dataset.lf === "now") { l.now = Math.min(v, Math.max(0, l.qty - l.received)); return; }
  l[t.dataset.lf] = v;
  poMarkDirty();
});
$("#poLines").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ldel]");
  if (!b) return;
  poEdit.lines.splice(+b.dataset.ldel, 1);
  poMarkDirty();
});
$("#poNote").addEventListener("input", () => { if (poEdit) { poEdit.note = $("#poNote").value; poMarkDirty(false); } });
$("#poAddBtn").onclick = () => {
  const it = findItem($("#poAddItem").value, poEdit.ledger), qty = +$("#poAddQty").value || defaultOrderQty(S.derived.get(it?.key)?.vars || {}) || 1;
  if (!it || it.tax !== poEdit.ledger) { $("#poErr").textContent = `Pick a ${entName(poEdit.ledger)} product from the list.`; return; }
  $("#poErr").textContent = "";
  const ex = poEdit.lines.find((l) => l.itemKey === it.key);
  if (ex) ex.qty += qty;
  else poEdit.lines.push({ itemKey: it.key, sku: it.sku, tax: it.tax, name: it.name, unit: it.unit, qty, received: 0, now: 0,
    price: it.lastCur === poEdit.currency && it.lastFob ? it.lastFob : poEdit.currency === "IDR" ? Math.round(+it.cost || 0) : 0 });
  $("#poAddItem").value = "";
  $("#poAddQty").value = "";
  poMarkDirty();
};
async function savePo() {
  const p = poEdit, p0 = curPo();
  const body = { eta: p.eta, fx: p.fx, freight: p.freight, duty: p.duty, otherCost: p.otherCost, note: p.note };
  if (p0.status === "draft") Object.assign(body, { supplierId: p.supplierId, ledger: p.ledger, orderDate: p.orderDate, currency: p.currency, lines: p.lines.map((l) => ({ itemKey: l.itemKey, qty: l.qty, price: l.price })) });
  else body.lines = p.lines.map((l) => ({ id: l.id, price: l.price }));
  await api.poSave(poId, body);
  poDirty = false;
}
function poXlsx() {
  const p = poEdit;
  exportXlsx(p.lines.map((l) => ({ PO: p.number, "Item code": l.sku, Description: l.name, Unit: l.unit, Qty: l.qty, [`Unit price (${p.currency})`]: l.price, [`Amount (${p.currency})`]: Math.round(l.qty * l.price * 100) / 100 })), p.number.replace(/[\/\\]/g, "-") + ".xlsx");
}
$("#poClose").onclick = () => { if (poDirty && !confirm("Discard your unsaved changes to this order?")) return; $("#poDlg").close(); };
$("#poDlg").addEventListener("cancel", (e) => { if (poDirty && !confirm("Discard your unsaved changes to this order?")) e.preventDefault(); });
$("#poDlg").addEventListener("close", () => { poDirty = false; poId = null; poEdit = null; $("#poMsg").dataset.for = ""; });
$("#poActions").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-pa]");
  if (!b) return;
  const p0 = curPo();
  $("#poErr").textContent = "";
  try {
    switch (b.dataset.pa) {
      case "x": return $("#poDlg").close();
      case "xlsx": return poXlsx();
      case "save": await savePo(); poEdit = null; toast(`Saved ${p0.number}`); await load(); break;
      case "send":
      case "resend":
        if (!poSendOpen && poDirty) { await savePo(); poEdit = null; await load(); }
        poSendOpen = !poSendOpen;
        renderPoDialog();
        break;
      case "order":
        if (poDirty) await savePo();
        await api.poSend(poId, "other");
        poEdit = null;
        toast(`${p0.number} ordered · stock on order updated`);
        await load();
        break;
      case "delete":
        if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirm: delete draft"; return; }
        await api.poDelete(poId); poDirty = false; $("#poDlg").close(); toast(`${p0.number} deleted`); await load(); break;
      case "close":
        if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirm: nothing more is coming"; return; }
        await api.poClose(poId); toast(`${p0.number} ${p0.status === "sent" ? "cancelled" : "closed"}`); await load(); break;
      case "receive": {
        const lines = poEdit.lines.filter((l) => +l.now > 0).map((l) => ({ id: l.id, qty: +l.now }));
        if (!lines.length) { $("#poErr").textContent = "Type the quantity received in “Receive now” for at least one line."; return; }
        b.disabled = true;
        if (poDirty) await savePo(); // rate, costs and prices first, so the landed cost is right
        const r = await api.poReceive(poId, lines);
        poEdit = null;
        toast(`Received into ${entName(p0.ledger)} · average cost updated${r.status === "received" ? ` · ${p0.number} complete` : ""}`);
        await load();
        b.disabled = false; // a part receipt can leave the same buttons in place
        break;
      }
    }
  } catch (er) { $("#poErr").textContent = er.message; b.disabled = false; }
});
$("#poChannels").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ch]");
  if (!b) return;
  const p = curPo(), sp = supplierById(p.supplierId), msg = $("#poMsg").value, ch = b.dataset.ch;
  // Open the channel straight away (inside the click) so the browser doesn't block the new window.
  if (ch === "whatsapp") window.open(whatsappUrl(sp.whatsapp, msg), "_blank", "noopener");
  else if (ch === "email") location.href = mailtoUrl(sp.email, poSubject(p, sp.company), msg);
  else if (ch === "phone") location.href = telUrl(sp.phone);
  else if (ch === "wechat") await copyText(msg, "Order message");
  if (p.status !== "draft") return;
  try {
    await api.poSend(p.id, ch);
    poSendOpen = false;
    poEdit = null;
    toast(`${p.number} marked as ordered${ch === "wechat" ? ". Paste the message in WeChat to " + sp.wechat : ""}`);
    await load();
  } catch (er) { $("#poErr").textContent = er.message; }
});

/* ---------- payments dialog (receivables and payables) ---------- */
let PAY = null;
function openPayment(kind, obj) {
  PAY = { kind, obj };
  const info = (pairs) => pairs.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join("");
  if (kind === "ar") {
    $("#payTitle").textContent = `Payment for ${obj.number}`;
    $("#payInfo").innerHTML = info([["Customer", esc(obj.custName)], ["Invoice total", fmtRp(obj.total)], ["Already paid", fmtRp(obj.paid)], ["Outstanding", `<strong>${fmtRp(obj.out)}</strong>`]]);
    $("#pdAmtL").textContent = "Amount (Rp)";
    $("#pdAmt").value = obj.out;
    $("#pdFxWrap").hidden = true;
  } else {
    const out = poPayable(obj) - poPaid(obj);
    $("#payTitle").textContent = `Pay supplier for ${obj.number}`;
    $("#payInfo").innerHTML = info([["Supplier", esc(supplierById(obj.supplierId)?.company || "")], ["Payable", fmtCur(poPayable(obj), obj.currency)], ["Already paid", fmtCur(poPaid(obj), obj.currency)], ["Outstanding", `<strong>${fmtCur(out, obj.currency)}</strong>`]]);
    $("#pdAmtL").textContent = `Amount (${obj.currency})`;
    $("#pdAmt").value = Math.round(out * 100) / 100;
    $("#pdFxWrap").hidden = obj.currency === "IDR";
    $("#pdFx").value = obj.fx || "";
  }
  $("#pdDate").value = today();
  $("#pdMethod").value = "transfer";
  $("#pdNote").value = "";
  $("#pdErr").textContent = "";
  $("#payDlg").showModal();
}
$("#pdCancel").onclick = $("#payClose").onclick = () => $("#payDlg").close();
$("#payForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = { amount: $("#pdAmt").value, date: $("#pdDate").value, method: $("#pdMethod").value, note: $("#pdNote").value };
  $("#pdSave").disabled = true;
  try {
    if (PAY.kind === "ar") await api.invPay(PAY.obj.id, body);
    else await api.poPay(PAY.obj.id, { ...body, fx: $("#pdFx").value });
    $("#payDlg").close();
    toast(`Payment recorded for ${PAY.obj.number}`);
    await load();
  } catch (e) { $("#pdErr").textContent = e.message; } finally { $("#pdSave").disabled = false; }
});

/* ---------- receivables (owners) ---------- */
/** Open invoices to outside customers, with days overdue. */
function arEntries() {
  return S.invoices.filter((i) => invBalance(i) > 0).map((i) => ({
    id: i.id, number: i.number, customerId: i.customerId, custName: i.custName, date: i.date, due: i.dueDate,
    total: i.total, paid: i.paid, out: invBalance(i), od: daysBetween(i.dueDate, today()),
  }));
}
function renderAR() {
  const all = arEntries();
  const sum = (xs) => xs.reduce((a, e) => a + e.out, 0);
  const ov = all.filter((e) => e.od > 0), ov90 = all.filter((e) => e.od > 90);
  $("#arKpis").innerHTML = kpiHtml([
    ["", "Outstanding", fmtRp(sum(all)), plural(all.length, "open invoice")],
    ["warn", "Overdue", fmtRp(sum(ov)), plural(ov.length, "invoice") + " past due"],
    ["crit", "Over 90 days overdue", fmtRp(sum(ov90)), plural(ov90.length, "invoice")],
    ["", "Customers overdue", nf(new Set(ov.map((e) => e.customerId)).size), "with at least one late invoice"],
  ]);
  // Invoices that look like sales but aren't owed money yet: unposted drafts and transfers to our own entities.
  const drafts = S.invoices.filter((i) => i.status === "draft" && i.lines.length && !customerById(i.customerId)?.internal);
  const transfers = S.invoices.filter((i) => i.status === "issued" && i.internal && i.date >= addDaysYmd(today(), -31));
  const notes = [];
  if (drafts.length) notes.push(`<strong>${plural(drafts.length, "invoice is", "invoices are")} still a draft</strong> and not in receivables until posted: ${drafts.map((i) => `<button type="button" class="linklike" data-inv="${esc(i.id)}">${esc(customerById(i.customerId)?.name || "draft")} · ${fmtRp(invoiceTotals(i.lines, i.tax, S.settings.ppnRate, S.settings.priceMode, S.settings.ppnStyle).total)}</button>`).join(", ")}. Open one and press <em>Post invoice</em>, then <em>Confirm</em>.`);
  if (transfers.length) notes.push(`${plural(transfers.length, "invoice")} in the last 31 days went to your own entities (${transfers.map((i) => esc(i.number)).join(", ")}). Those are stock transfers, not receivables. If one was a real sale, untick “internal” on that contact.`);
  $("#arNote").hidden = !notes.length;
  $("#arNote").innerHTML = notes.join("<br>");
  const q = $("#arq").value.trim().toLowerCase(), f = $("#arFilter").value;
  const rows = all.filter((e) => (!q || [e.number, e.custName].join(" ").toLowerCase().includes(q)) && (!f || (f === "overdue" ? e.od > 0 : e.od > 90))).sort((a, b) => b.od - a.od);
  const byC = new Map();
  for (const e of rows) {
    const c = byC.get(e.customerId) || { name: e.custName, n: 0, out: 0, ov: 0, old: -1e9 };
    c.n++; c.out += e.out; if (e.od > 0) c.ov += e.out; c.old = Math.max(c.old, e.od);
    byC.set(e.customerId, c);
  }
  $("#arCust").innerHTML = byC.size ? [...byC].sort((a, b) => b[1].ov - a[1].ov || b[1].out - a[1].out).map(([id, c]) => `<tr data-cust="${esc(id)}"><td class="name">${esc(c.name)}</td>
    <td class="num">${c.n}</td><td class="num">${fmtRp(c.out)}</td><td class="num${c.ov ? " err" : ""}">${c.ov ? fmtRp(c.ov) : "—"}</td><td class="num">${c.old > 0 ? c.old + "d late" : "not due"}</td></tr>`).join("")
    : `<tr><td colspan="5"><div class="empty">No open receivables${q || f ? " match" : ""}.</div></td></tr>`;
  $("#arTbl").innerHTML = rows.length ? rows.map((e) => `<tr><td class="sku"><button type="button" class="linklike" data-inv="${esc(e.id)}">${esc(e.number)}</button></td><td class="name">${esc(e.custName)}</td>
    <td>${ymdLabel(e.date)}</td><td>${ymdLabel(e.due)}</td><td class="num">${e.od > 0 ? `<span class="chip ist-overdue">${e.od}</span>` : dash}</td>
    <td class="num">${fmtRp(e.total)}</td><td class="num">${e.paid ? fmtRp(e.paid) : "—"}</td><td class="num"><strong>${fmtRp(e.out)}</strong></td>
    <td><button class="btn small" data-arpay="${esc(e.id)}">Record payment</button></td></tr>`).join("")
    : `<tr><td colspan="9"><div class="empty">${all.length ? "No invoices match." : "<strong>No open receivables</strong><span>Posted invoices to outside customers appear here.</span>"}</div></td></tr>`;
  const pays = S.invoices.flatMap((i) => i.payments.map((p) => ({ ...p, number: i.number, custName: i.custName }))).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  $("#arPays").innerHTML = pays.length ? pays.map((p) => `<tr><td>${ymdLabel(p.date)}</td><td class="sku">${esc(p.number)}</td><td class="name">${esc(p.custName)}</td><td class="num">${fmtRp(p.amount)}</td><td>${esc(p.method)}</td></tr>`).join("")
    : `<tr><td colspan="5"><div class="empty">No payments recorded yet.</div></td></tr>`;
}
["#arq", "#arFilter"].forEach((s) => $(s).addEventListener("input", renderAR));
$("#arNote").addEventListener("click", (e) => { const b = e.target.closest("[data-inv]"); if (b) openInvoice(b.dataset.inv); });
$("#arCust").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-cust]"); if (tr) { $("#arq").value = customerById(tr.dataset.cust)?.name || ""; renderAR(); } });
$("#arTbl").addEventListener("click", (e) => {
  const inv = e.target.closest("[data-inv]");
  if (inv) return openInvoice(inv.dataset.inv);
  const b = e.target.closest("[data-arpay]");
  if (b) openPayment("ar", arEntries().find((x) => x.id === b.dataset.arpay));
});

/* ---------- payables (owners) ---------- */
function renderAP() {
  const rows = S.pos.filter((p) => p.status !== "draft").map((p) => {
    const pay = poPayable(p), paid = poPaid(p);
    return { p, pay, paid, out: pay - paid, idr: (pay - paid) * poFx(p) };
  });
  const byCur = {};
  for (const r of rows) if (r.out > 0.005) byCur[r.p.currency] = (byCur[r.p.currency] || 0) + r.out;
  $("#apKpis").innerHTML = kpiHtml([["crit", "Owed to suppliers", fmtRp(rows.reduce((a, r) => a + Math.max(0, r.idr), 0)), "at each PO's rate"],
    ...Object.entries(byCur).map(([c, v]) => ["", `Owed in ${c}`, fmtCur(v, c), "outstanding"])]);
  const q = $("#apq").value.trim().toLowerCase(), only = $("#apOpenOnly").checked;
  const vis = rows.filter((r) => (!only || r.out > 0.005) && (!q || [r.p.number, supplierById(r.p.supplierId)?.company].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => (a.p.orderDate || "").localeCompare(b.p.orderDate || ""));
  $("#apTbl").innerHTML = vis.length ? vis.map((r) => `<tr><td class="sku"><button type="button" class="linklike" data-po="${esc(r.p.id)}">${esc(r.p.number)}</button></td><td class="name">${esc(supplierById(r.p.supplierId)?.company || "")}</td>
    <td><span class="chip st-${r.p.status}">${PO_ST[r.p.status]}</span></td><td>${esc(r.p.currency)}</td><td class="num">${fmtCur(r.pay, r.p.currency)}</td>
    <td class="num">${r.paid ? fmtCur(r.paid, r.p.currency) : "—"}</td><td class="num"><strong>${fmtCur(r.out, r.p.currency)}</strong></td><td class="num">${fmtRp(r.idr)}</td>
    <td>${r.out > 0.005 ? `<button class="btn small" data-appay="${esc(r.p.id)}">Record payment</button>` : '<span class="chip ist-paid">Paid</span>'}</td></tr>`).join("")
    : `<tr><td colspan="9"><div class="empty">${rows.length ? "Nothing owed" + (q ? " matches" : "") + "." : "<strong>No supplier payables yet</strong><span>Purchase orders become payable once they are marked as ordered.</span>"}</div></td></tr>`;
  $("#apPays").innerHTML = S.supplierPays.length ? S.supplierPays.slice(0, 40).map((x) => {
    const p = S.pos.find((y) => y.id === x.poId);
    return `<tr><td>${ymdLabel(x.date)}</td><td class="sku">${esc(p?.number || "")}</td><td class="name">${esc(supplierById(p?.supplierId)?.company || "")}</td>
      <td class="num">${fmtCur(x.amount, x.currency)}</td><td class="num">${x.currency === "IDR" ? "—" : fmtN(x.fx)}</td><td class="num">${fmtRp(x.idr)}</td><td class="name">${esc(x.note)}</td>
      <td><button class="icon-btn" data-spdel="${esc(x.id)}" data-po="${esc(x.poId)}" aria-label="Remove payment"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td></tr>`;
  }).join("") : `<tr><td colspan="8"><div class="empty">No supplier payments recorded yet.</div></td></tr>`;
}
["#apq", "#apOpenOnly"].forEach((s) => $(s).addEventListener("input", renderAP));
$("#apTbl").addEventListener("click", (e) => {
  const b = e.target.closest("[data-appay]");
  if (b) return openPayment("ap", S.pos.find((x) => x.id === b.dataset.appay));
  const po = e.target.closest("[data-po]");
  if (po) openPo(po.dataset.po);
});
$("#apPays").addEventListener("click", async (e) => {
  const d = e.target.closest("[data-spdel]");
  if (!d) return;
  if (d.dataset.confirm !== "1") { d.dataset.confirm = "1"; d.style.color = "var(--crit)"; d.title = "Click again to remove"; return; }
  try { await api.poDeletePay(d.dataset.po, d.dataset.spdel); toast("Payment removed"); await load(); } catch (er) { handleErr(er); }
});

/* ---------- dashboard (owners) ---------- */
function renderDash() {
  const stock = { PPN: 0, NON: 0 };
  for (const it of Object.values(S.items)) stock[it.tax] += S.derived.get(it.key)?.vars.value || 0;
  const ar = arEntries();
  const arOut = ar.reduce((a, e) => a + e.out, 0), arOv = ar.filter((e) => e.od > 0).reduce((a, e) => a + e.out, 0);
  const apOut = S.pos.filter((p) => p.status !== "draft").reduce((a, p) => a + Math.max(0, poPayable(p) - poPaid(p)) * poFx(p), 0);
  const transit = S.pos.filter((p) => ["sent", "partial"].includes(p.status)).reduce((a, p) => a + transitValue(p), 0);
  // Monthly net sales (excl. PPN) and cost of goods at current average cost, per entity, from invoices posted here.
  const sales = S.invoices.filter((i) => i.status === "issued" && !i.internal);
  const monthOf = (ym, L) => {
    let rev = 0, cogs = 0;
    for (const i of sales) {
      if (i.tax !== L || !i.date.startsWith(ym)) continue;
      rev += i.subtotal;
      for (const l of i.lines) cogs += l.qty * (+S.items[l.itemKey]?.cost || 0);
    }
    return { rev, cogs };
  };
  const cy = today().slice(0, 7);
  const thisM = ["PPN", "NON"].map((L) => monthOf(cy, L)).reduce((a, m) => ({ rev: a.rev + m.rev, cogs: a.cogs + m.cogs }), { rev: 0, cogs: 0 });
  $("#dKpis").innerHTML = kpiHtml([
    ["ppn", "Stock at cost", fmtRp(stock.PPN + stock.NON), `PPN ${fmtRp(stock.PPN)} · Non-PPN ${fmtRp(stock.NON)}`],
    ["non", "Goods on the way", fmtRp(transit), "open POs, landed value"],
    ["warn", "Receivables", fmtRp(arOut), arOv ? `${fmtRp(arOv)} overdue` : "nothing overdue"],
    ["crit", "Owed to suppliers", fmtRp(apOut), "unpaid, at each PO's rate"],
    ["", "Sales this month", fmtRp(thisM.rev), (thisM.rev ? `margin ${(((thisM.rev - thisM.cogs) / thisM.rev) * 100).toFixed(1)}%` : "no invoices yet") + ` · after expenses ${fmtRp(thisM.rev - thisM.cogs - monthCosts(cy, false).total)}`],
  ]);
  const bk = [["Not yet due", (e) => e.od <= 0], ["1–30 days late", (e) => e.od > 0 && e.od <= 30], ["31–60 days", (e) => e.od > 30 && e.od <= 60], ["61–90 days", (e) => e.od > 60 && e.od <= 90], ["Over 90 days", (e) => e.od > 90]]
    .map(([l, f], i) => ({ l, i, v: ar.filter(f).reduce((a, e) => a + e.out, 0), n: ar.filter(f).length }));
  const mx = Math.max(1, ...bk.map((b) => b.v));
  $("#dAgingNote").textContent = ar.length ? plural(ar.length, "open invoice") : "";
  $("#dAging").innerHTML = ar.length ? bk.map((b) => `<div class="ag-row b${b.i}" title="${esc(b.l)}: ${fmtRp(b.v)} in ${plural(b.n, "invoice")}"><span>${b.l}</span><div class="ag-bar"><i style="width:${((b.v / mx) * 100).toFixed(1)}%"></i></div><span>${fmtRp(b.v)}</span></div>`).join("")
    : '<div class="empty">No open receivables.</div>';
  const months = [0, -1, -2].map((k) => ymAdd(cy, k));
  const srows = [];
  for (const ym of months) for (const L of ["PPN", "NON"]) {
    const m = monthOf(ym, L), ex = monthCosts(ym, false).byL[L], op = m.rev - m.cogs - ex;
    if (m.rev || ex || ym === cy) srows.push(`<tr><td>${ymLabel(ym)}</td><td>${ledgerChip(L)}</td><td class="num">${fmtRp(m.rev)}</td><td class="num">${fmtRp(m.rev - m.cogs)}</td><td class="num">${m.rev ? (((m.rev - m.cogs) / m.rev) * 100).toFixed(1) + "%" : "—"}</td>
      <td class="num">${ex ? fmtRp(ex) : dash}</td><td class="num"><strong class="${op < 0 ? "err" : ""}">${fmtRp(op)}</strong></td></tr>`);
  }
  $("#dSales").innerHTML = srows.join("");
  const from = months[2] + "-01";
  const top = new Map();
  for (const i of sales) {
    if (i.date < from) continue;
    const nets = lineNets(i.lines, i.subtotal);
    i.lines.forEach((l, k) => { const t = top.get(l.itemKey) || { r: 0, q: 0, sku: l.sku, name: l.name }; t.r += nets[k]; t.q += l.qty; top.set(l.itemKey, t); });
  }
  const tr = [...top].filter(([, t]) => t.r > 0).sort((a, b) => b[1].r - a[1].r).slice(0, 10);
  $("#dTop").innerHTML = tr.length ? tr.map(([k, t]) => {
    const c = +S.items[k]?.cost || 0;
    const m = c ? ((t.r - t.q * c) / t.r) * 100 : null;
    return `<tr><td class="sku">${esc(t.sku)}</td><td class="name">${esc(t.name)}</td><td class="num">${fmtN(t.q)}</td><td class="num">${fmtRp(t.r)}</td><td class="num">${m == null ? '<span class="muted">no cost</span>' : `<span class="${m < 10 ? "err" : ""}">${m.toFixed(1)}%</span>`}</td></tr>`;
  }).join("") : `<tr><td colspan="5"><div class="empty">Appears once invoices are posted here.</div></td></tr>`;
  const cut = Object.values(S.items).map((it) => ({ it, v: S.derived.get(it.key)?.vars, ds: S.dstats.get(it.key) }))
    .filter((x) => x.v && x.ds && x.ds.months >= 6 && x.ds.recent6 === 0 && x.v.qty > 0).sort((a, b) => b.v.value - a.v.value || b.v.qty - a.v.qty);
  $("#dCutSum").textContent = cut.length ? `${plural(cut.length, "SKU")} · ${fmtRp(cut.reduce((a, x) => a + x.v.value, 0))}` : "";
  $("#dCut").innerHTML = cut.length ? cut.slice(0, 25).map((x) => `<tr data-key="${esc(x.it.key)}"><td class="sku">${esc(x.it.sku)}</td><td class="name">${esc(x.it.name)}</td><td>${ledgerChip(x.it.tax)}</td><td class="num">${fmtN(x.v.qty)}</td><td class="num">${x.v.value ? fmtRp(x.v.value) : '<span class="muted">no cost</span>'}</td></tr>`).join("")
    : `<tr><td colspan="5"><div class="empty">${Object.keys(S.dem).length || S.invDem?.months?.PPN?.length ? "Every SKU in stock sold at least once in the last 6 months." : "Needs at least 6 months of sales history. Upload your yearly workbook under Files."}</div></td></tr>`;
}
$("#dCut").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-key]"); if (tr) openItem(tr.dataset.key); });

/* ---------- expenses (owners) ---------- */
const METHOD_L = { transfer: "Transfer", cash: "Cash", giro: "Giro / cheque", other: "Other" };
const EX_CATS = ["Rent", "Electricity", "Water", "Internet & phone", "Fuel & transport", "Shipping & courier", "Office supplies", "Repairs & maintenance", "Bank fees", "Taxes & permits", "Meals & entertainment", "Marketing", "Security & cleaning", "Other"];
const exLedgerOk = (L) => !$("#exLedger").value || $("#exLedger").value === L;
/** Expenses and salaries for one month, respecting the entity filter. */
function monthCosts(ym, filter = true) {
  const ok = (L) => !filter || exLedgerOk(L);
  const ex = S.expenses.filter((e) => e.date.startsWith(ym) && ok(e.ledger));
  const sal = S.salaries.filter((p) => p.period === ym && ok(p.ledger));
  const byL = { PPN: 0, NON: 0 };
  for (const e of ex) byL[e.ledger] += e.amount;
  for (const p of sal) byL[p.ledger] += p.net;
  const salTotal = sal.reduce((a, p) => a + p.net, 0);
  return { ex, sal, byL, salTotal, total: byL.PPN + byL.NON };
}
let exEdit = null;
function exMonth() {
  if (!$("#exMonth").value) $("#exMonth").value = today().slice(0, 7);
  return $("#exMonth").value;
}
function resetExForm() {
  exEdit = null;
  $("#exForm").reset();
  const ym = exMonth();
  $("#exDate").value = ym === today().slice(0, 7) ? today() : ym + "-01";
  $("#exEnt").value = $("#exLedger").value || "PPN";
  $("#exFormTitle").textContent = "Add an expense";
  $("#exSave").textContent = "Add expense";
  $("#exCancelEdit").hidden = true;
  $("#exErr").textContent = "";
}
function renderExpenses() {
  const ym = exMonth(), cur = monthCosts(ym), prev = monthCosts(ymAdd(ym, -1));
  const delta = prev.total ? ((cur.total - prev.total) / prev.total) * 100 : null;
  const ent = $("#exLedger").value;
  $("#exKpis").innerHTML = kpiHtml([
    ["crit", `Total ${ymLabel(ym)}`, fmtRp(cur.total), delta == null ? "no costs the month before" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% vs ${ymLabel(ymAdd(ym, -1))}`],
    ["", "Salaries", fmtRp(cur.salTotal), plural(cur.sal.length, "person", "people") + " paid"],
    ["", "Other expenses", fmtRp(cur.total - cur.salTotal), plural(cur.ex.length, "entry", "entries")],
    ...(ent ? [] : [["ppn", entName("PPN"), fmtRp(cur.byL.PPN), "this month"], ["non", entName("NON"), fmtRp(cur.byL.NON), "this month"]]),
  ]);
  // categories
  const cats = new Map();
  for (const e of cur.ex) cats.set(e.category, (cats.get(e.category) || 0) + e.amount);
  const rows = [...cats].sort((a, b) => b[1] - a[1]);
  if (cur.salTotal) rows.unshift(["Salaries", cur.salTotal, true]);
  const mx = Math.max(1, ...rows.map((r) => r[1]));
  $("#exCatNote").textContent = ymLabel(ym);
  $("#exCats").innerHTML = rows.length ? rows.map(([c, v, sal]) => `<div class="cat-row${sal ? " sal" : ""}"><span>${esc(c)}</span><span class="bar"><i style="width:${((v / mx) * 100).toFixed(1)}%"></i></span><span class="amt">${fmtRp(v)}<span class="pct">${((v / cur.total) * 100).toFixed(0)}%</span></span></div>`).join("")
    : '<div class="empty">Nothing recorded for this month yet.</div>';
  // list
  $("#exListTitle").textContent = `Expenses · ${ymLabel(ym)}`;
  const recPrev = S.expenses.some((e) => e.recurring && e.date.startsWith(ymAdd(ym, -1)) && !S.expenses.some((x) => x.sourceId === e.id && x.date.startsWith(ym)));
  $("#exCopy").disabled = !recPrev;
  $("#exCopy").title = recPrev ? "" : "No repeating expenses from last month left to copy";
  const salRows = cur.sal.length ? `<tr class="muted-row"><td>${ymdLabel(cur.sal.map((p) => p.date).sort().pop())}</td><td>${[...new Set(cur.sal.map((p) => p.ledger))].map(ledgerChip).join(" ")}</td><td>Salaries</td>
    <td class="name">${plural(cur.sal.length, "employee")} · <button type="button" class="linklike" data-gopay="1">see Payroll</button></td><td></td><td class="num">${fmtRp(cur.salTotal)}</td><td></td></tr>` : "";
  $("#exTbl").innerHTML = cur.ex.length || salRows ? salRows + cur.ex.map((e) => `<tr><td>${ymdLabel(e.date)}</td><td>${ledgerChip(e.ledger)}</td><td>${esc(e.category)}${e.recurring ? ' <span class="chip unit" title="Repeats every month">monthly</span>' : ""}</td>
      <td class="name">${esc(e.description)}${e.by ? `<div class="hint">${esc(e.by)}</div>` : ""}</td><td>${METHOD_L[e.method] || esc(e.method)}</td><td class="num">${fmtRp(e.amount)}</td>
      <td><div class="row" style="flex-wrap:nowrap;gap:6px"><button class="btn small" data-exedit="${esc(e.id)}">Edit</button><button class="icon-btn" data-exdel="${esc(e.id)}" aria-label="Delete expense"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div></td></tr>`).join("")
    : `<tr><td colspan="7"><div class="empty">No expenses in ${ymLabel(ym)}${ent ? " for " + esc(entName(ent)) : ""}.${recPrev ? " Last month had repeating costs: use “Copy recurring from last month”." : ""}</div></td></tr>`;
  // history: the 12 months up to the later of this month and the one shown
  const end = ym > today().slice(0, 7) ? ym : today().slice(0, 7);
  const hist = [];
  for (let k = 0; k < 12; k++) {
    const m = ymAdd(end, -k), c = monthCosts(m), p = monthCosts(ymAdd(m, -1));
    if (!c.total && m !== ym && k) continue;
    const d = p.total ? ((c.total - p.total) / p.total) * 100 : null;
    hist.push(`<tr data-ym="${m}" class="${m === ym ? "cur" : ""}"><td>${ymLabel(m)}</td><td class="num">${fmtRp(c.byL.PPN)}</td><td class="num">${fmtRp(c.byL.NON)}</td><td class="num">${fmtRp(c.salTotal)}</td>
      <td class="num"><strong>${fmtRp(c.total)}</strong></td><td class="num">${d == null ? dash : `<span class="${d > 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${d.toFixed(1)}%</span>`}</td></tr>`);
  }
  $("#exHist").innerHTML = hist.join("");
  const cats2 = new Set([...EX_CATS, ...S.expenses.map((e) => e.category)]);
  $("#exCatList").innerHTML = [...cats2].map((c) => `<option value="${esc(c)}">`).join("");
  if (!exEdit && !$("#exDate").value) resetExForm();
}
$("#exMonth").onchange = () => { resetExForm(); renderExpenses(); };
$("#exLedger").onchange = () => { if (!exEdit) $("#exEnt").value = $("#exLedger").value || $("#exEnt").value; renderExpenses(); };
$("#exHist").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-ym]"); if (tr) { $("#exMonth").value = tr.dataset.ym; resetExForm(); renderExpenses(); } });
$("#exCancelEdit").onclick = resetExForm;
$("#exForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = { date: $("#exDate").value, ledger: $("#exEnt").value, category: $("#exCat").value, description: $("#exDesc").value, amount: $("#exAmt").value, method: $("#exMethod").value, recurring: $("#exRec").checked };
  $("#exSave").disabled = true;
  try {
    if (exEdit) await api.expenseSave(exEdit, body); else await api.expenseCreate(body);
    toast(exEdit ? "Expense updated" : `Added ${fmtRp(+body.amount)} · ${body.category}`);
    const keepDate = body.date, keepEnt = body.ledger;
    if (body.date.slice(0, 7) !== exMonth()) $("#exMonth").value = body.date.slice(0, 7);
    resetExForm();
    $("#exDate").value = keepDate; // entering several receipts from the same day is common
    $("#exEnt").value = keepEnt;
    await load();
    $("#exCat").focus();
  } catch (e) { $("#exErr").textContent = e.message; } finally { $("#exSave").disabled = false; }
});
$("#exTbl").addEventListener("click", async (e) => {
  if (e.target.closest("[data-gopay]")) { $("#prMonth").value = exMonth(); showTab("employees"); renderPayroll(); return; }
  const ed = e.target.closest("[data-exedit]");
  if (ed) {
    const x = S.expenses.find((v) => v.id === ed.dataset.exedit);
    if (!x) return;
    exEdit = x.id;
    Object.entries({ exDate: x.date, exEnt: x.ledger, exCat: x.category, exDesc: x.description, exAmt: x.amount, exMethod: x.method }).forEach(([k, v]) => ($("#" + k).value = v));
    $("#exRec").checked = x.recurring;
    $("#exFormTitle").textContent = "Edit expense";
    $("#exSave").textContent = "Save changes";
    $("#exCancelEdit").hidden = false;
    $("#exErr").textContent = "";
    $("#exForm").scrollIntoView({ behavior: "smooth", block: "center" });
    $("#exAmt").focus();
    return;
  }
  const d = e.target.closest("[data-exdel]");
  if (d) {
    if (d.dataset.confirm !== "1") { d.dataset.confirm = "1"; d.title = "Click again to delete"; d.style.color = "var(--crit)"; return; }
    try { await api.expenseDelete(d.dataset.exdel); if (exEdit === d.dataset.exdel) resetExForm(); toast("Expense deleted"); await load(); } catch (er) { handleErr(er); }
  }
});
$("#exCopy").onclick = async () => {
  try {
    const r = await api.expenseCopyRecurring(exMonth());
    toast(r.copied ? `Copied ${plural(r.copied, "repeating expense")} into ${ymLabel(exMonth())}. Check the amounts.` : "Nothing new to copy.");
    await load();
  } catch (e) { handleErr(e); }
};

/* ---------- employees & payroll (owners) ---------- */
let emEdit = null;
const monthlyPay = (e) => (+e.baseSalary || 0) + (+e.allowance || 0);
function renderEmployees() {
  const q = $("#empQ").value.trim().toLowerCase(), showOff = $("#empInactive").checked;
  const act = S.employees.filter((e) => e.active);
  const cy = today().slice(0, 7), paidNow = S.salaries.filter((p) => p.period === cy);
  $("#empKpis").innerHTML = kpiHtml([
    ["", "Active employees", nf(act.length), `${entName("PPN")} ${act.filter((e) => e.ledger === "PPN").length} · ${entName("NON")} ${act.filter((e) => e.ledger === "NON").length}`],
    ["crit", "Standard monthly payroll", fmtRp(act.reduce((a, e) => a + monthlyPay(e), 0)), "base + fixed allowances"],
    ["", `Paid for ${ymLabel(cy)}`, fmtRp(paidNow.reduce((a, p) => a + p.net, 0)), `${paidNow.length} of ${act.length} people`],
  ]);
  const rows = S.employees.filter((e) => (showOff || e.active) && (!q || [e.name, e.position, e.phone].join(" ").toLowerCase().includes(q)));
  $("#empTbl").innerHTML = rows.length ? rows.map((e) => `<tr class="${e.active ? "" : "muted-row"}"><td><strong>${esc(e.name)}</strong>${e.position ? `<div class="hint">${esc(e.position)}</div>` : ""}</td><td>${ledgerChip(e.ledger)}</td>
      <td>${e.phone ? esc(e.phone) : dash}</td><td class="name">${e.bank ? esc(e.bank) : dash}</td><td>${e.startDate ? ymdLabel(e.startDate) : dash}</td>
      <td class="num">${fmtRp(e.baseSalary)}</td><td class="num">${e.allowance ? fmtRp(e.allowance) : dash}</td><td class="num"><strong>${fmtRp(monthlyPay(e))}</strong></td>
      <td>${e.active ? "" : '<span class="muted">Inactive</span> '}<button class="btn small" data-emedit="${esc(e.id)}">Edit</button></td></tr>`).join("")
    : `<tr><td colspan="9"><div class="empty">${S.employees.length ? "No employees match." : "No employees yet. Add your team with “Add employee”."}</div></td></tr>`;
  renderPayroll();
}
const prDraft = new Map(); // employeeId → { bonus, deduction } typed but not yet paid
function renderPayroll() {
  if (!$("#prMonth").value) $("#prMonth").value = today().slice(0, 7);
  if (!$("#prDate").value) $("#prDate").value = today();
  const ym = $("#prMonth").value;
  const paid = S.salaries.filter((p) => p.period === ym);
  const paidIds = new Set(paid.map((p) => p.employeeId));
  const unpaid = S.employees.filter((e) => e.active && !paidIds.has(e.id));
  const rows = [
    ...paid.map((p) => `<tr><td><strong>${esc(p.name)}</strong></td><td>${ledgerChip(p.ledger)}</td><td class="num">${fmtRp(p.base)}</td><td class="num">${p.allowance ? fmtRp(p.allowance) : dash}</td>
      <td class="num">${p.bonus ? fmtRp(p.bonus) : dash}</td><td class="num">${p.deduction ? "−" + fmtRp(p.deduction) : dash}</td><td class="num"><strong>${fmtRp(p.net)}</strong></td>
      <td><div class="row" style="flex-wrap:nowrap;gap:6px"><span class="okmsg">Paid ${ymdLabel(p.date)}</span><span class="hint">${METHOD_L[p.method] || ""}</span>
      <button class="icon-btn" data-prdel="${esc(p.id)}" aria-label="Remove this payment" title="Remove this payment"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div></td></tr>`),
    ...unpaid.map((e) => {
      const d = prDraft.get(e.id) || { bonus: 0, deduction: 0 };
      const net = monthlyPay(e) + (+d.bonus || 0) - (+d.deduction || 0);
      return `<tr data-emp="${esc(e.id)}"><td><strong>${esc(e.name)}</strong>${e.position ? `<div class="hint">${esc(e.position)}</div>` : ""}</td><td>${ledgerChip(e.ledger)}</td>
        <td class="num">${fmtRp(e.baseSalary)}</td><td class="num">${e.allowance ? fmtRp(e.allowance) : dash}</td>
        <td class="num"><input type="number" min="0" step="1" value="${d.bonus || ""}" placeholder="0" data-prf="bonus" aria-label="Bonus for ${esc(e.name)}"></td>
        <td class="num"><input type="number" min="0" step="1" value="${d.deduction || ""}" placeholder="0" data-prf="deduction" aria-label="Deductions for ${esc(e.name)}"></td>
        <td class="num"><strong class="${net < 0 ? "err" : ""}">${fmtRp(net)}</strong></td>
        <td><button class="btn small primary" data-prpay="${esc(e.id)}" ${monthlyPay(e) > 0 ? "" : 'disabled title="Set a base salary first"'}>Pay</button></td></tr>`;
    }),
  ];
  patchRows($("#prTbl"), rows.length ? rows.join("") : `<tr><td colspan="8"><div class="empty">${S.employees.length ? "No active employees." : "Add employees first."}</div></td></tr>`);
  const total = paid.reduce((a, p) => a + p.net, 0);
  $("#prRun").disabled = !unpaid.some((e) => monthlyPay(e) > 0);
  $("#prRun").dataset.confirm = "";
  $("#prRun").textContent = unpaid.length ? `Pay ${plural(unpaid.length, "person", "people")} unpaid` : "Everyone is paid";
  $("#prHint").innerHTML = `${ymLabel(ym)}: ${fmtRp(total)} paid to ${plural(paid.length, "person", "people")}. Type bonus or deductions on a row and press Pay; the button above pays the standard salary. Deductions (BPJS, PPh 21, advances) are entered by hand; the app doesn't calculate them.`;
  // history
  const months = [...new Set(S.salaries.map((p) => p.period))].sort().reverse().slice(0, 12);
  $("#prHist").innerHTML = months.length ? months.map((m) => {
    const ps = S.salaries.filter((p) => p.period === m), by = (L) => ps.filter((p) => p.ledger === L).reduce((a, p) => a + p.net, 0);
    return `<tr data-ym="${m}" class="${m === ym ? "cur" : ""}"><td>${ymLabel(m)}</td><td class="num">${ps.length}</td><td class="num">${fmtRp(by("PPN"))}</td><td class="num">${fmtRp(by("NON"))}</td><td class="num"><strong>${fmtRp(by("PPN") + by("NON"))}</strong></td></tr>`;
  }).join("") : `<tr><td colspan="5"><div class="empty">No salaries paid yet.</div></td></tr>`;
}
$("#empQ").addEventListener("input", renderEmployees);
$("#empInactive").onchange = renderEmployees;
$("#prMonth").onchange = () => { prDraft.clear(); renderPayroll(); };
$("#prHist").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-ym]"); if (tr) { $("#prMonth").value = tr.dataset.ym; prDraft.clear(); renderPayroll(); } });
$("#prTbl").addEventListener("change", (e) => {
  const t = e.target, tr = t.closest("tr[data-emp]");
  if (!t.dataset.prf || !tr) return;
  const d = prDraft.get(tr.dataset.emp) || { bonus: 0, deduction: 0 };
  d[t.dataset.prf] = Math.max(0, +t.value || 0);
  prDraft.set(tr.dataset.emp, d);
  later(renderPayroll);
});
$("#prTbl").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-prpay]");
  if (b) {
    const id = b.dataset.prpay, tr = b.closest("tr");
    const d = { bonus: +tr.querySelector('[data-prf="bonus"]').value || 0, deduction: +tr.querySelector('[data-prf="deduction"]').value || 0 };
    b.disabled = true;
    try {
      await api.salaryPay({ employeeId: id, period: $("#prMonth").value, date: $("#prDate").value, method: $("#prMethod").value, ...d });
      prDraft.delete(id);
      toast(`Salary paid · ${S.employees.find((x) => x.id === id)?.name || ""}`);
      await load();
    } catch (er) { handleErr(er); b.disabled = false; }
    return;
  }
  const x = e.target.closest("[data-prdel]");
  if (x) {
    if (x.dataset.confirm !== "1") { x.dataset.confirm = "1"; x.title = "Click again to remove this payment"; x.style.color = "var(--crit)"; return; }
    try { await api.salaryDelete(x.dataset.prdel); toast("Salary payment removed"); await load(); } catch (er) { handleErr(er); }
  }
});
$("#prRun").onclick = async () => {
  const b = $("#prRun"), ym = $("#prMonth").value;
  if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = `Confirm: pay standard salaries for ${ymLabel(ym)}`; return; }
  b.dataset.confirm = "";
  b.disabled = true;
  try {
    const r = await api.payrollRun(ym, $("#prDate").value, $("#prMethod").value);
    toast(`Paid ${plural(r.paid, "person", "people")} · ${fmtRp(r.total)}`);
    await load();
  } catch (e) { handleErr(e); renderPayroll(); }
};
function openEmployee(id) {
  emEdit = id;
  const e = id ? S.employees.find((x) => x.id === id) : { name: "", position: "", ledger: "PPN", phone: "", bank: "", startDate: "", baseSalary: "", allowance: "", active: true, notes: "" };
  $("#empTitle").textContent = id ? "Edit employee" : "Add employee";
  Object.entries({ emName: e.name, emPos: e.position, emEnt: e.ledger, emPhone: e.phone, emBank: e.bank, emStart: e.startDate, emBase: e.baseSalary, emAllow: e.allowance || "", emNotes: e.notes }).forEach(([k, v]) => ($("#" + k).value = v ?? ""));
  $("#emActive").checked = e.active;
  $("#emErr").textContent = "";
  const del = $("#emDel");
  del.hidden = !id;
  del.dataset.confirm = "";
  del.textContent = "Delete";
  $("#empDlg").showModal();
}
$("#empNew").onclick = () => openEmployee(null);
$("#empTbl").addEventListener("click", (e) => { const b = e.target.closest("[data-emedit]"); if (b) openEmployee(b.dataset.emedit); });
$("#emCancel").onclick = $("#empClose").onclick = () => $("#empDlg").close();
$("#empForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = { name: $("#emName").value, position: $("#emPos").value, ledger: $("#emEnt").value, phone: $("#emPhone").value, bank: $("#emBank").value, startDate: $("#emStart").value,
    baseSalary: $("#emBase").value, allowance: $("#emAllow").value, notes: $("#emNotes").value, active: $("#emActive").checked };
  $("#emSave").disabled = true;
  try {
    if (emEdit) await api.employeeSave(emEdit, body); else await api.employeeCreate(body);
    $("#empDlg").close();
    toast("Employee saved");
    await load();
  } catch (e) { $("#emErr").textContent = e.message; } finally { $("#emSave").disabled = false; }
});
$("#emDel").onclick = async () => {
  const b = $("#emDel");
  if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirm: delete"; return; }
  try { await api.employeeDelete(emEdit); $("#empDlg").close(); toast("Employee deleted"); await load(); } catch (e) { $("#emErr").textContent = e.message; }
};

/* ---------- formulas, files & coverage rendering ---------- */
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
      <div class="hint">${r.scope === "ALL" ? "All items" : `${entName(r.scope)} only`}${hits != null ? " · " + nf(hits) + " items triggered" : ""}${r.enabled === false ? " · paused" : ""}</div>
      ${r._err ? `<div class="err">${esc(r._err)}</div>` : ""}
      <div class="row" data-need="admin"><button class="btn small" data-redit="${esc(r.id)}">Edit</button><button class="btn small" data-rtoggle="${esc(r.id)}">${r.enabled === false ? "Resume" : "Pause"}</button><span class="spacer"></span><button class="btn small danger" data-rdel="${esc(r.id)}">Delete</button></div>
    </div>`;
  }).join("");
}

const fmtDate = (t) => (t ? new Date(t).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }) : "");
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
    const costNote = res.columns.includes("cost") && !isOwner() ? " · the cost column is ignored (only the owner can set costs)" : "";
    pv.className = "okmsg";
    pv.innerHTML = `${nf(impRows.length)} rows ready · ${nf(impRows.length - upd)} new, ${nf(upd)} update existing${res.skipped ? ` · ${res.skipped} rows skipped (no SKU)` : ""}${res.merged ? ` · ${res.merged} duplicate SKUs merged` : ""}${costNote}<br><span class="hint">Columns used: ${esc(res.columns.join(", "))}. Columns missing from the file keep their current values.</span>`;
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
const ENT_FIELDS = [["name", "Company name"], ["prefix", "Invoice prefix"], ["npwp", "NPWP"], ["phone", "Telephone"], ["address", "Address", true], ["bank", "Bank account for payment", true]];
function fillSettings() {
  const st = S.settings;
  $("#sPpn").value = st.ppnRate;
  $("#sLead").value = st.leadTime;
  $("#sPriceMode").value = st.priceMode;
  $("#sPpnStyle").value = st.ppnStyle || "flat";
  $("#sReview").value = st.reviewDays;
  $("#sService").value = st.serviceLevel;
  $("#sWindow").value = st.windowMonths;
  $("#stTerms").value = st.invoiceTerms ?? 90;
  $("#stFooter").value = st.footer || "";
  $("#entForm").innerHTML = ["PPN", "NON"].map((t) => {
    const x = st.ent?.[t] || {};
    const f = ([k, label, area]) => `<div class="field"><label for="e${t}${k}">${label}</label>${area ? `<textarea id="e${t}${k}" rows="2">${esc(x[k] || "")}</textarea>` : `<input id="e${t}${k}" value="${esc(x[k] || "")}"${k === "prefix" ? ' maxlength="8" class="mono"' : ""}>`}</div>`;
    return `<div class="issuer"><strong>${t === "PPN" ? "PPN entity" : "Non-PPN entity"}</strong>${ENT_FIELDS.map(f).join("")}</div>`;
  }).join("");
  fillEntityLabels();
}
/** Shows the company names wherever the user picks an entity. */
function fillEntityLabels() {
  const set = (sel, txt) => { const o = $(`${sel} option[value="${txt[0]}"]`); if (o) o.textContent = txt[1]; };
  for (const t of ["PPN", "NON"]) {
    const n = entName(t);
    for (const sel of ["#invNewTax", "#abLedger", "#pLedger", "#impTax", "#exEnt", "#emEnt"]) set(sel, [t, n]);
    for (const sel of ["#sLedger", "#fTax", "#exLedger"]) set(sel, [t, `${n} only`]);
  }
  for (const id of ["#exHPpn", "#prHPpn"]) $(id).textContent = entName("PPN");
  for (const id of ["#exHNon", "#prHNon"]) $(id).textContent = entName("NON");
}
$("#stInvSave").onclick = async () => {
  const ent = {};
  for (const t of ["PPN", "NON"]) ent[t] = Object.fromEntries(ENT_FIELDS.map(([k]) => [k, $(`#e${t}${k}`).value]));
  const m = $("#stInvMsg");
  try {
    await api.saveInvoicing({ ent, invoiceTerms: $("#stTerms").value, footer: $("#stFooter").value });
    m.className = "okmsg";
    m.textContent = "Saved";
    S.loaded = false; // refill with what the server stored (prefixes are uppercased)
    scheduleReload();
  } catch (e) { m.className = "err"; m.textContent = e.message; }
};
$("#sSave").onclick = async () => {
  const m = $("#sMsg");
  try {
    await api.saveSettings({ ppnRate: $("#sPpn").value, leadTime: $("#sLead").value, priceMode: $("#sPriceMode").value, ppnStyle: $("#sPpnStyle").value, reviewDays: $("#sReview").value, serviceLevel: $("#sService").value, windowMonths: $("#sWindow").value });
    m.className = "okmsg";
    m.textContent = "Saved";
    S.loaded = false; // the server may clamp values
    scheduleReload();
  } catch (e) { m.className = "err"; m.textContent = e.message; }
};

/* ---------- export & backup ---------- */
function exportXlsx(rows, filename) {
  if (!xlsxReady()) { toast("Spreadsheet writer did not load."); return; }
  if (!rows.length) { toast("Nothing to export."); return; }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Data");
  XLSX.writeFile(wb, filename);
}
$("#expAll").onclick = () => exportXlsx(Object.values(S.items).map((it) => {
  const d = S.derived.get(it.key), v = d.vars;
  const o = { SKU: it.sku, Name: it.name, Entity: entName(it.tax), Unit: it.unit, Qty: +it.qty || 0, "On order": it.onOrder || 0, "Sell price": +it.sellPrice || 0 };
  if (isOwner()) Object.assign(o, { "Avg cost": Math.round(+it.cost || 0), "Stock value": Math.round(v.value), "Margin %": Number.isFinite(v.margin_pct) ? Math.round(v.margin_pct * 10) / 10 : "" });
  Object.assign(o, { "Min stock": +it.minStock || 0, MOQ: +it.moq || 0, "Order multiple": +it.lot || 0, Supplier: supplierOf(it)?.company || "" });
  for (const r of S.colRules) o[r.name] = d.cols[r.id];
  o.Alerts = d.alerts.map((r) => r.name).join("; ");
  return o;
}), `stock-list-${today()}.xlsx`);
const exportAlerts = () => exportXlsx(S.alerts.map(({ it, r }) => {
  const v = S.derived.get(it.key).vars;
  return { Severity: r.severity === "crit" ? "Critical" : "Warning", Alert: r.name, SKU: it.sku, Name: it.name, Entity: entName(it.tax), Unit: it.unit, Supplier: supplierOf(it)?.company || "",
    "Current stock": v.qty, "On order": v.on_order, "Safety stock": v.safety_stock, "Reorder point": v.reorder_point, "Suggested order": v.suggested_order,
    "Days of cover": v.days_cover >= 9999 ? "no sales" : Math.round(v.days_cover) };
}), `stock-alerts-${today()}.xlsx`);
$("#expAlerts").onclick = exportAlerts;
$("#expAlerts2").onclick = exportAlerts;

const tsLabel = (t) => (t ? new Date(t).toLocaleString("id-ID") : "");
$("#expBackup").onclick = async () => {
  if (!xlsxReady()) { toast("Spreadsheet writer did not load."); return; }
  const b = $("#expBackup");
  b.disabled = true;
  try {
    const d = await api.backup();
    const cust = new Map(d.customers.map((c) => [c.id, c.name]));
    const sup = new Map(d.suppliers.map((x) => [x.id, x.company]));
    const ent = (t) => d.settings.ent?.[t]?.name || taxLabel(t);
    const invById = new Map(d.invoices.map((i) => [i.id, i]));
    const poById = new Map(d.pos.map((p) => [p.id, p]));
    const goodsBy = new Map();
    for (const l of d.poLines) goodsBy.set(l.po_id, (goodsBy.get(l.po_id) || 0) + l.qty * l.price);
    const landed = (p, l) => {
      const fx = p.currency === "IDR" ? 1 : +p.fx || 0, g = goodsBy.get(p.id) || 0, ch = (+p.freight || 0) + (+p.duty || 0) + (+p.other_cost || 0);
      return Math.round(l.price * fx + (g > 0 ? (ch * l.price) / g : 0));
    };
    const invPaid = new Map();
    for (const p of d.invoicePays) invPaid.set(p.invoice_id, (invPaid.get(p.invoice_id) || 0) + p.amount);
    const sheets = {
      Products: d.items.map((r) => ({ SKU: r.sku, Name: r.name, Entity: ent(r.tax), Unit: r.unit, Qty: r.qty, "Sell price": r.sell_price, "Avg cost": r.price, "Stock value": Math.round(r.qty * r.price), "Min stock": r.min_stock, MOQ: r.moq, "Order multiple": r.lot, Supplier: sup.get(r.supplier_id) || "", "Last FOB": r.last_fob, "FOB currency": r.last_cur })),
      Contacts: [
        ...d.customers.map((c) => ({ Type: c.internal ? "Customer (internal)" : "Customer", Name: c.name, Contact: c.contact, WhatsApp: c.whatsapp, Phone: c.phone, Email: c.email, NPWP: c.npwp, Address: c.address, "Terms (days)": c.terms, Note: c.notes })),
        ...d.suppliers.map((x) => ({ Type: "Supplier", Name: x.company, Contact: x.contact, WhatsApp: x.whatsapp, Phone: x.phone, Email: x.email, WeChat: x.wechat, NPWP: x.npwp, Address: x.address, Currency: x.currency, "Terms (days)": x.terms, Note: x.notes })),
      ],
      Invoices: d.invoiceLines.map((l) => {
        const i = invById.get(l.invoice_id);
        return { Invoice: l.invoice_number || "(draft)", Date: i.inv_date, Status: i.status, Entity: ent(i.tax), Customer: i.cust_name || cust.get(i.customer_id) || "", SKU: l.sku, Name: l.name, Unit: l.unit, Qty: l.qty, Price: l.price, "Disc %": l.disc_pct, "Invoice total": i.total };
      }),
      Receivables: d.invoices.filter((i) => i.status === "issued" && !i.internal && i.total - (invPaid.get(i.id) || 0) > 0.5).map((i) => ({
        Invoice: i.number, Date: i.inv_date, Due: i.due_date, Entity: ent(i.tax), Customer: i.cust_name, Total: i.total, Paid: invPaid.get(i.id) || 0, Outstanding: i.total - (invPaid.get(i.id) || 0), "Days overdue": Math.max(0, daysBetween(i.due_date, today())) })),
      "AR payments": d.invoicePays.map((p) => ({ Invoice: p.invoice_number, Date: p.pay_date, Amount: p.amount, Method: p.method, Note: p.note, By: p.created_by })),
      "Purchase orders": d.poLines.map((l) => {
        const p = poById.get(l.po_id);
        return { PO: l.po_number, "Order date": p.order_date, Status: PO_ST[p.status] || p.status, Entity: ent(p.ledger), Supplier: sup.get(p.supplier_id) || "", Currency: p.currency, Rate: p.fx, SKU: l.sku, Name: l.name, Qty: l.qty, Received: l.received, "Unit price": l.price, "Landed unit (Rp)": landed(p, l) };
      }),
      "AP payments": d.supplierPays.map((p) => ({ PO: p.po_number, Date: p.pay_date, Amount: p.amount, Currency: p.currency, Rate: p.fx, "Amount (Rp)": p.idr, Method: p.method, Note: p.note, By: p.created_by })),
      Expenses: [
        ...d.expenses.map((e) => ({ Month: e.exp_date.slice(0, 7), Date: e.exp_date, Entity: ent(e.ledger), Category: e.category, Description: e.description, Amount: e.amount, "Paid by": e.method, Monthly: e.recurring ? "yes" : "", By: e.created_by })),
        ...d.salaries.map((p) => ({ Month: p.period, Date: p.pay_date, Entity: ent(p.ledger), Category: "Salaries", Description: p.name, Amount: p.net, "Paid by": p.method, Monthly: "", By: p.created_by })),
      ].sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0)),
      Payroll: d.salaries.map((p) => ({ Month: p.period, "Pay date": p.pay_date, Employee: p.name, Entity: ent(p.ledger), Base: p.base, Allowance: p.allowance, "Bonus / overtime": p.bonus, Deductions: p.deduction, "Net pay": p.net, "Paid by": p.method, Note: p.note })),
      Employees: d.employees.map((e) => ({ Name: e.name, Position: e.position, Entity: ent(e.ledger), Phone: e.phone, "Bank account": e.bank, Started: e.start_date, "Base salary": e.base_salary, Allowance: e.allowance, Active: e.active ? "yes" : "no", Notes: e.notes })),
      "Stock moves": d.moves.map((m) => ({ Time: tsLabel(m.t), SKU: m.sku, Entity: ent(m.tax), Type: m.type, Qty: m.qty, Note: m.note, By: m.user_name || "" })),
    };
    const wb = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([["(empty)"]]), name);
    XLSX.writeFile(wb, `erp-backup-${today()}.xlsx`);
    toast("Backup downloaded");
  } catch (e) { handleErr(e); } finally { b.disabled = false; }
};

$("#clearDemo").onclick = async () => {
  const b = $("#clearDemo");
  const n = Object.values(S.items).filter((it) => it.sku.startsWith("DEMO-")).length + S.suppliers.filter((x) => x.company.startsWith("[Demo]")).length + S.customers.filter((c) => c.name.startsWith("[Demo]")).length;
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
  $("#meRole").textContent = me.role === "admin" ? "owner" : me.role;
  $("#meAvatar").textContent = initial(me.name);
  let saved = "";
  try { saved = localStorage.getItem("erp.tab") || ""; } catch {}
  const first = location.hash.slice(1) || saved || (isOwner() ? "dash" : "inventory");
  history.replaceState(null, "", "#" + first);
  showTab(first);
  renderAll();
  fillSettings();
  load().catch((e) => { setStatus("down", "Server unreachable"); handleErr(e); });
  events = subscribe(scheduleReload, (st) => {
    if (st === "live") { setStatus("live", "Live · synced"); scheduleReload(); }
    else setStatus("down", "Reconnecting…");
  });
}

api.me().then(startApp).catch((e) => {
  if (e.status === 401) showAuth();
  else { document.body.classList.remove("booting"); setStatus("down", "Server unreachable"); handleErr(e); }
});
