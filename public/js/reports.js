// Readers for Hashiru report layouts (Laporan Penjualan Detail, Persediaan Barang, yearly workbooks),
// with a header-based fallback for other spreadsheets. They work on rows (arrays of cell values),
// so they can be tested without a spreadsheet library.

import { fmtN, fmtRp } from "./util.js";
import { ymOf } from "./stock.js";

export const MONTHS = {
  JAN: 1, JANUARI: 1, JANUARY: 1, FEB: 2, PEB: 2, FEBRUARI: 2, FEBRUARY: 2, MAR: 3, MARET: 3, MARCH: 3,
  APR: 4, APRIL: 4, MEI: 5, MAY: 5, JUN: 6, JUNI: 6, JUNE: 6, JUL: 7, JULI: 7, JULY: 7,
  AGU: 8, AGT: 8, AGS: 8, AGUS: 8, AGUSTUS: 8, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OKT: 10, OKTOBER: 10, OCT: 10, OCTOBER: 10, NOV: 11, NOP: 11, NOPEMBER: 11, NOVEMBER: 11,
  DES: 12, DESEMBER: 12, DEC: 12, DECEMBER: 12,
};

/** Report month from a file name, e.g. "Penjualan PPN Okt 25.xlsx" → "2025-10". */
export function detectMonth(name) {
  const s = name.toUpperCase().replace(/\.[A-Z0-9]+$/, "");
  const m = s.match(/(\d{1,2})[\s\-/.](\d{1,2})[\s\-/.](\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    if (+m[2] >= 1 && +m[2] <= 12) return ymOf(y, +m[2]);
  }
  const tk = s.replace(/([A-Z])(\d)/g, "$1 $2").replace(/(\d)([A-Z])/g, "$1 $2").split(/[^A-Z0-9]+/);
  let mo = 0;
  let y = 0;
  tk.forEach((t, i) => {
    if (!mo && MONTHS[t]) {
      mo = MONTHS[t];
      const n = tk[i + 1];
      if (n && /^\d{2}$/.test(n)) y = 2000 + +n;
    }
    if (/^20\d{2}$/.test(t)) y = +t;
  });
  return mo && y ? ymOf(y, mo) : "";
}

/** First guess at how an uploaded file should be used, from its name alone. */
export function detectPlan(fileName) {
  const n = fileName.toUpperCase();
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  let kind = "attach";
  let tax = "NON";
  let taxSure = false;
  if (/^(xlsx|xls|csv)$/.test(ext)) {
    if (/PERSEDIAAN|STOK|STOCK|INVENTORY/.test(n)) kind = "stock";
    else if (/PENJUALAN|SALES|JUAL/.test(n)) kind = "sales";
  }
  if (/NON\s*[-_ ]?\s*PPN/.test(n)) { tax = "NON"; taxSure = true; }
  else if (/PPN/.test(n)) { tax = "PPN"; taxSure = true; }
  return { kind, tax, taxSure, ym: kind === "attach" ? "" : detectMonth(fileName) };
}

export function monthOfName(n) {
  for (const t of String(n).toUpperCase().split(/[^A-Z]+/)) if (MONTHS[t]) return MONTHS[t];
  return 0;
}

export const hasKodeHeader = (rows) => rows.slice(0, 15).some((r) => r.some((c) => /^\s*kode/i.test(String(c))));

/** Ledger from the company name in a report header (Amasan = Non-PPN, CV Hashiru = PPN). */
export function taxFromHeader(rows) {
  const head = rows.slice(0, 15).map((r) => r.join(" ")).join(" ").toUpperCase();
  if (/AMASAN/.test(head)) return "NON";
  if (/CV\.?\s*HASHIRU/.test(head)) return "PPN";
  if (/HASHIRU/.test(head)) return "NON";
  return null;
}

/** Indonesian and English number formats: "1.234.567", "1.234,50", "Rp 12,000". */
export function toNum(v) {
  if (typeof v === "number") return v;
  let s = String(v ?? "").replace(/rp/i, "").trim();
  if (!s) return 0;
  if (/^-?[\d.]+,\d+$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
export const isNum = (v) =>
  typeof v === "number" ? Number.isFinite(v) : /^\s*-?[\d.,]+\s*$/.test(String(v)) && /\d/.test(String(v));
export const num = (v) => (typeof v === "number" ? v : toNum(v));

export function normUnit(u, other) {
  const s = String(u || "").trim().toUpperCase();
  if (/^(SET|STEL|SETEL|ST)$/.test(s) || /SET/.test(s)) return "SET";
  if (s && !/^(PCS|PC|PIECE|BH|BUAH)$/.test(s)) other.add(s);
  return "PCS";
}

const HMAP = {
  sku: ["sku", "kode", "kode barang", "code", "item code", "part number", "part no", "no part"],
  name: ["name", "nama", "nama barang", "product", "product name", "description", "deskripsi"],
  unit: ["unit", "satuan", "uom"],
  qty: ["qty", "quantity", "stok", "stock", "jumlah", "kuantitas"],
  price: ["price", "harga", "harga beli", "harga jual", "unit price"],
  tax: ["tax", "ppn", "pajak", "ledger"],
  minStock: ["min", "min stock", "minimum", "stok minimum"],
};
export function mapHeader(h) {
  h = String(h || "").trim().toLowerCase();
  for (const [k, arr] of Object.entries(HMAP)) if (arr.includes(h)) return k;
  return null;
}

function tailNums(rows, n = 12) {
  const out = [];
  for (const r of rows.slice(-n)) for (const c of r) if (isNum(c)) out.push(num(c));
  return out;
}

function genericLines(rows) {
  const hi = rows.findIndex((r) => {
    const m = r.map(mapHeader);
    return m.includes("sku") && m.includes("qty");
  });
  if (hi < 0) return null;
  const map = rows[hi].map(mapHeader);
  const ix = (k) => map.indexOf(k);
  const totI = rows[hi].findIndex((h) => /^(total|jumlah|subtotal|netto)$/i.test(String(h).trim()));
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const code = String(r[ix("sku")] ?? "").trim();
    if (!code || !isNum(r[ix("qty")])) continue;
    out.push({
      code,
      name: String(r[ix("name")] ?? "").trim(),
      qty: num(r[ix("qty")]),
      unitRaw: ix("unit") >= 0 ? r[ix("unit")] : "",
      total: totI >= 0 ? num(r[totI]) : 0,
      price: ix("price") >= 0 ? num(r[ix("price")]) : 0,
    });
  }
  return out;
}

/** One month's sales report (Laporan Penjualan Detail). Columns differ between the PPN and Non-PPN exports. */
export function parseSales(rows, tax) {
  const c = tax === "PPN"
    ? { code: 2, name: 3, qty: 7, unit: 10, total: 25, skip: (r) => /^#/.test(String(r[1]).trim()) }
    : { code: 4, name: 5, qty: 12, unit: 16, total: 30, skip: (r) => /^SI/i.test(String(r[3]).trim()) };
  let lines = [];
  for (const r of rows) {
    if (c.skip(r)) continue;
    const code = String(r[c.code] ?? "").trim();
    if (!code || /^(kode|code)/i.test(code) || !isNum(r[c.qty])) continue;
    lines.push({ code, name: String(r[c.name] ?? "").trim(), qty: num(r[c.qty]), unitRaw: r[c.unit], total: isNum(r[c.total]) ? num(r[c.total]) : 0 });
  }
  let layout = "hashiru";
  if (!lines.length) { lines = genericLines(rows) || []; layout = "generic"; }
  if (!lines.length) throw Error(`No item rows found. Is this a ${tax === "PPN" ? "PPN" : "Non-PPN"} sales report?`);
  const other = new Set();
  for (const l of lines) l.unit = normUnit(l.unitRaw, other);
  const qty = lines.reduce((a, l) => a + l.qty, 0);
  const rp = lines.reduce((a, l) => a + l.total, 0);
  const tail = tailNums(rows);
  const totOk = rp > 0 && tail.some((v) => Math.abs(v - rp) <= 1);
  const cntOk = tail.some((v) => v === lines.length);
  return {
    lines, qty, rp, otherUnits: [...other].join(", "),
    check: totOk ? "ok" : "unverified",
    msg: totOk ? "" : layout === "generic" ? "read by column headers; report total not found" : "report total not found" + (cntOk ? " (line count matches)" : ""),
  };
}

/** One month's stock report (Persediaan Barang Harga Beli). Product names can sit on the row above the code. */
export function parseStock(rows) {
  let items = [];
  let pending = null;
  let totQty = null;
  let totVal = null;
  for (const r of rows) {
    if (r.slice(0, 6).some((c) => /^\s*total\s*:?\s*$/i.test(String(c)))) {
      if (isNum(r[5])) totQty = num(r[5]);
      if (isNum(r[10])) totVal = num(r[10]);
      continue;
    }
    const code = String(r[0] ?? "").trim();
    const name = String(r[2] ?? "").trim();
    if (!code && name && !isNum(r[6])) { pending = name; continue; }
    if (code && isNum(r[6])) {
      items.push({ code, name: name || pending || "", qty: num(r[6]), unitRaw: r[8], price: isNum(r[10]) ? num(r[10]) : 0, total: isNum(r[11]) ? num(r[11]) : 0 });
      pending = null;
      continue;
    }
    if (code && !isNum(r[6])) pending = null;
  }
  let layout = "hashiru";
  if (!items.length) {
    items = (genericLines(rows) || []).map((l) => ({ ...l, total: l.total || l.qty * l.price }));
    layout = "generic";
  }
  if (!items.length) throw Error("No item rows found. Is this a Persediaan stock report?");
  const other = new Set();
  for (const l of items) l.unit = normUnit(l.unitRaw, other);
  const qty = items.reduce((a, l) => a + l.qty, 0);
  const rp = items.reduce((a, l) => a + l.total, 0);
  let check = "unverified";
  let msg = layout === "generic" ? "read by column headers; report total not found" : "report total row not found";
  if (totQty != null || totVal != null) {
    const qOk = totQty == null || Math.abs(totQty - qty) < 0.01;
    const vOk = totVal == null || Math.abs(totVal - rp) <= 1;
    check = qOk && vOk ? "ok" : "mismatch";
    msg = check === "ok" ? "" : `items sum to qty ${fmtN(qty)} / ${fmtRp(rp)}, report says ${totQty != null ? fmtN(totQty) : "?"} / ${totVal != null ? fmtRp(totVal) : "?"}`;
  }
  return { items, qty, rp, otherUnits: [...other].join(", "), check, msg };
}

/**
 * A yearly workbook tab holds several tables side by side, each starting at a "Kode" header column.
 * The table title above the header (or its column position) says whether it is sales or stock, PPN or Non-PPN.
 */
export function findBlocks(rows) {
  const out = [];
  let hr = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if (rows[i].some((c) => /^\s*kode/i.test(String(c)))) { hr = i; break; }
  }
  if (hr < 0) return out;
  const H = rows[hr];
  const starts = [];
  H.forEach((c, j) => { if (/^\s*kode/i.test(String(c))) starts.push(j); });
  starts.forEach((c0, bi) => {
    const c1 = bi + 1 < starts.length ? starts[bi + 1] - 1 : H.length - 1;
    const hdr = (j) => String(H[j] ?? "").trim();
    const find = (re) => {
      for (let j = c0; j <= c1; j++) if (re.test(hdr(j))) return j;
      return -1;
    };
    const textIn = (r0, r1) => {
      let t = "";
      for (let i = r0; i <= r1; i++) for (let j = c0; j <= c1; j++) t += " " + String(rows[i]?.[j] ?? "");
      return t.toUpperCase();
    };
    const title = hr >= 2 ? textIn(hr - 2, hr - 1) : textIn(0, hr - 1);
    const above = textIn(0, hr - 1);
    let kind = /SALES|PENJUALAN|JUAL/.test(title) ? "sales" : /STOCK|STOK|PERSEDIAAN/.test(title) ? "stock" : null;
    let tax = /NON\s*[-_ ]?\s*PPN|AMASAN/.test(title) ? "NON" : /PPN/.test(title) ? "PPN" : null;
    const pos = { 0: ["stock", "NON"], 7: ["stock", "PPN"], 26: ["sales", "PPN"], 40: ["sales", "NON"] }[c0];
    if (pos) { kind ??= pos[0]; tax ??= pos[1]; }
    if (!kind || !tax) return;
    const ci = { name: find(/^(nama|name|deskripsi)/i), qty: find(/^(qty|quantity)/i), unit: find(/^(satuan|unit|uom)/i), price: find(/^harga/i), total: find(/^total$/i) };
    if (ci.qty < 0) ci.qty = find(/jumlah|kuantitas/i);
    if (ci.qty < 0 && kind === "stock") ci.qty = find(/^(stok|stock)/i);
    if (ci.total < 0) ci.total = find(/total|netto|nilai/i);
    if (ci.qty < 0) return;
    const lines = [];
    for (let i = hr + 1; i < rows.length; i++) {
      const r = rows[i];
      const code = String(r[c0] ?? "").trim();
      if (!code || !isNum(r[ci.qty])) continue;
      lines.push({
        code,
        name: ci.name >= 0 ? String(r[ci.name] ?? "").trim() : "",
        qty: num(r[ci.qty]),
        unitRaw: ci.unit >= 0 ? r[ci.unit] : "",
        price: ci.price >= 0 && isNum(r[ci.price]) ? num(r[ci.price]) : 0,
        total: ci.total >= 0 && isNum(r[ci.total]) ? num(r[ci.total]) : 0,
      });
    }
    if (!lines.length) return;
    const other = new Set();
    for (const l of lines) l.unit = normUnit(l.unitRaw, other);
    const qty = lines.reduce((a, l) => a + l.qty, 0);
    const rp = lines.reduce((a, l) => a + l.total, 0);
    let check = "unverified";
    let msg = "no check cell found";
    if (/COCOK/.test(above) && !/SELISIH/.test(above)) { check = "ok"; msg = ""; }
    else if (/SELISIH|✗/.test(above)) { check = "mismatch"; msg = "the workbook's own check cell shows a difference"; }
    else {
      for (let i = 0; i < hr; i++) {
        const v = rows[i]?.[ci.qty];
        if (qty && isNum(v) && Math.abs(num(v) - qty) < 0.01) { check = "ok"; msg = ""; break; }
      }
    }
    const p = { kind, tax, check, msg, qty, rp, otherUnits: [...other].join(", ") };
    if (kind === "sales") p.lines = lines;
    else p.items = lines;
    out.push(p);
  });
  return out;
}

/** sheets: [{ name, rows }]. Only tabs named after a month are read. */
export function parseWorkbook(sheets, year) {
  const parts = [];
  for (const { name, rows } of sheets) {
    const mo = monthOfName(name);
    if (!mo) continue;
    for (const b of findBlocks(rows)) parts.push({ ...b, ym: ymOf(+year, mo), tab: name });
  }
  if (!parts.length) throw Error("No month tabs with Kode tables found");
  return parts;
}

/** Rows of a product list (Excel/CSV) mapped to items. Returns { rows, skipped, columns } or { error }. */
export function readProductList(raw, defTax) {
  const hi = raw.findIndex((r) => r.map(mapHeader).includes("sku"));
  if (hi < 0) return { error: "Could not find a SKU / Kode column in the first sheet." };
  const map = raw[hi].map(mapHeader);
  if (!map.includes("name")) return { error: "Found SKU but no Name / Nama column." };
  const rows = [];
  let skipped = 0;
  for (const r of raw.slice(hi + 1)) {
    const o = {};
    map.forEach((k, i) => { if (k) o[k] = r[i]; });
    const sku = String(o.sku ?? "").trim();
    if (!sku || sku.includes("~")) { skipped++; continue; }
    let tax = defTax;
    if (map.includes("tax")) {
      const t = String(o.tax).trim().toUpperCase();
      tax = /NON|TIDAK|NO|^0$|^N$/.test(t) ? "NON" : /PPN|YA|YES|^1$|^Y$/.test(t) ? "PPN" : defTax;
    }
    const u = String(o.unit ?? "").trim().toUpperCase();
    rows.push({ sku, name: String(o.name ?? "").trim(), unit: /SET|STEL|SETEL/.test(u) ? "SET" : "PCS", qty: toNum(o.qty), price: toNum(o.price), tax, minStock: toNum(o.minStock) });
  }
  const dedup = new Map(rows.map((r) => [r.tax + "~" + r.sku, r]));
  return { rows: [...dedup.values()], skipped, merged: rows.length - dedup.size, columns: map.filter(Boolean) };
}
