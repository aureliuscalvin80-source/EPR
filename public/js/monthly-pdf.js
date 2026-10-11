// Monthly report as a downloadable PDF (jsPDF + AutoTable, served from /vendor). Pure layout: the data comes from
// GET /api/reports/month, already limited to what the signed-in user may see.

import { fmtRp, fmtN } from "./util.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLong = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const dShort = (ymd) => (ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}` : "");
const tShort = (t) => { const d = new Date(t); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const rp = (n) => (n ? fmtRp(n) : "-");
const sum = (xs, f) => xs.reduce((a, x) => a + (+f(x) || 0), 0);

export const PARTS = [
  ["summary", "Summary", true],
  ["sales", "Sales", false],
  ["receivables", "Receivables", true],
  ["purchasing", "Purchasing", true],
  ["payables", "Payables", true],
  ["expenses", "Expenses", true],
  ["payroll", "Payroll", true],
  ["inventory", "Closing stock", false],
  ["moves", "Stock moves", false],
];

export function pdfReady() {
  return typeof globalThis.jspdf?.jsPDF === "function" && typeof globalThis.autoTable === "function";
}

/**
 * Builds the PDF and returns the jsPDF document.
 * @param d      month data from the server
 * @param parts  set of part keys to include
 * @param ledger "" for both entities, or "PPN" / "NON"
 * @param ent    { PPN: {name}, NON: {name} } from settings
 */
export function buildMonthlyPdf(d, { parts, ledger = "", ent = {} }) {
  const { jsPDF } = globalThis.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 14;
  const entName = (t) => ent[t]?.name || (t === "PPN" ? "PPN" : "Non-PPN");
  const only = (xs, key = "tax") => (ledger ? xs.filter((x) => x[key] === ledger) : xs);
  const entities = ledger ? [ledger] : ["PPN", "NON"];
  const ink = [33, 37, 48], muted = [122, 131, 150], accent = [91, 108, 240];
  let y = M;

  // ---- title ----
  doc.setFont("helvetica", "bold").setFontSize(18).setTextColor(...ink).text(`Monthly report · ${monthLong(d.month)}`, M, y + 6);
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...muted)
    .text(`${entities.map(entName).join("  ·  ")}`, M, y + 13)
    .text(`Period ${d.from} to ${d.to} · generated ${new Date(d.generatedAt).toLocaleString("id-ID")}`, M, y + 18);
  doc.setDrawColor(...accent).setLineWidth(0.6).line(M, y + 22, W - M, y + 22);
  y += 30;

  const heading = (title, note) => {
    if (y > H - 50) { doc.addPage(); y = M; }
    doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(...ink).text(title, M, y);
    y += 2;
    if (note) { doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...muted); const ls = doc.splitTextToSize(note, W - 2 * M); doc.text(ls, M, y + 4); y += 4 * ls.length; }
    y += 3;
  };
  const table = (head, body, { foot, num = [], widths = {} } = {}) => {
    const columnStyles = {};
    for (const i of num) columnStyles[i] = { halign: "right" };
    for (const [i, w] of Object.entries(widths)) columnStyles[i] = { ...columnStyles[i], cellWidth: w };
    globalThis.autoTable(doc, {
      startY: y, head: [head], body: body.length ? body : [[{ content: "Nothing this month.", colSpan: head.length, styles: { textColor: muted, halign: "center" } }]],
      foot: foot && body.length ? [foot] : undefined, margin: { left: M, right: M, bottom: 16 }, theme: "plain",
      styles: { font: "helvetica", fontSize: 8, cellPadding: { top: 1.6, bottom: 1.6, left: 1.8, right: 1.8 }, textColor: ink, overflow: "linebreak" },
      headStyles: { fillColor: [244, 246, 251], textColor: muted, fontStyle: "bold" },
      footStyles: { fillColor: [244, 246, 251], textColor: ink, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [251, 252, 254] },
      columnStyles,
      didParseCell: (c) => { if ((c.section === "head" || c.section === "foot") && num.includes(c.column.index)) c.cell.styles.halign = "right"; },
    });
    y = doc.lastAutoTable.finalY + 9;
  };
  const kv = (rows) => table(["", ...entities.map(entName), ...(entities.length > 1 ? ["Total"] : [])],
    rows.map(([label, f]) => [label, ...entities.map((t) => rp(f(t))), ...(entities.length > 1 ? [rp(entities.reduce((a, t) => a + f(t), 0))] : [])]),
    { num: entities.map((_, i) => i + 1).concat(entities.length > 1 ? [entities.length + 1] : []), widths: { 0: 62 } });

  const sales = only(d.invoices).filter((i) => i.status === "issued" && !i.internal);
  const want = (k) => parts.has(k) && (d.owner || !PARTS.find((p) => p[0] === k)[2]);

  // ---- summary ----
  if (want("summary")) {
    heading("Summary", "Sales exclude PPN and transfers between your own entities. Gross margin uses each product's current average landed cost. Receivables and payables are what was still open on the last day of the month.");
    const by = (xs, t, f, key = "tax") => sum(xs.filter((x) => x[key] === t), f);
    const margin = (t) => by(sales, t, (i) => i.subtotal) - by(sales, t, (i) => i.cogs);
    const costs = (t) => by(d.expenses, t, (e) => e.amount) + by(d.salaries, t, (s) => s.net);
    const stockVal = (t) => by(d.stock.items, t, (s) => s.qty * (s.cost || 0));
    kv([
      ["Net sales (DPP)", (t) => by(sales, t, (i) => i.subtotal)],
      ["PPN invoiced", (t) => by(sales, t, (i) => i.ppn)],
      ["Gross margin", margin],
      ["Expenses", (t) => by(d.expenses, t, (e) => e.amount)],
      ["Salaries", (t) => by(d.salaries, t, (s) => s.net)],
      ["Operating profit", (t) => margin(t) - costs(t)],
      ["Received from customers", (t) => by(d.arPayments, t, (p) => p.amount)],
      ["Paid to suppliers (Rp)", (t) => by(d.apPayments, t, (p) => p.idr)],
      ["Receivables at month end", (t) => by(d.arOpen, t, (r) => r.out)],
      ["Payables at month end (Rp)", (t) => by(d.apOpen, t, (r) => r.idr)],
      ["Stock value at month end", stockVal],
    ]);
  }

  // ---- sales ----
  if (want("sales")) {
    const all = only(d.invoices);
    heading("Sales invoices", `${sales.length} posted · ${all.filter((i) => i.status === "void").length} cancelled · ${all.filter((i) => i.internal && i.status === "issued").length} transfers to own entities (not counted in totals).`);
    const owner = d.owner;
    table(["Date", "Invoice", "Customer", "Entity", "DPP", "PPN", "Total", ...(owner ? ["Margin"] : []), "Status"],
      all.map((i) => [dShort(i.date), i.number, i.customer, i.tax === "PPN" ? "PPN" : "Non-PPN", rp(i.subtotal), rp(i.ppn), rp(i.total),
        ...(owner ? [i.status === "issued" && !i.internal && i.subtotal ? `${(((i.subtotal - i.cogs) / i.subtotal) * 100).toFixed(1)}%` : ""] : []),
        i.status === "void" ? "Cancelled" : i.internal ? "Transfer" : "Posted"]),
      { num: owner ? [4, 5, 6, 7] : [4, 5, 6], widths: { 0: 11, 1: 30, 3: 18, 4: 22, 5: 20, 6: 22, ...(owner ? { 7: 14, 8: 17 } : { 7: 17 }) },
        foot: ["", "Total (posted sales)", "", "", rp(sum(sales, (i) => i.subtotal)), rp(sum(sales, (i) => i.ppn)), rp(sum(sales, (i) => i.total)), ...(owner ? [""] : []), ""] });
    const top = only(d.topProducts);
    if (top.length) {
      heading("Best-selling products");
      table(["SKU", "Product", "Entity", "Qty", "Sales (before PPN)"], top.map((p) => [p.sku, p.name, p.tax === "PPN" ? "PPN" : "Non-PPN", `${fmtN(p.qty)} ${p.unit}`, rp(p.gross)]), { num: [3, 4] });
    }
  }

  // ---- receivables ----
  if (want("receivables")) {
    const pays = only(d.arPayments), open = only(d.arOpen);
    heading("Payments received", `${pays.length} payment${pays.length === 1 ? "" : "s"}, ${rp(sum(pays, (p) => p.amount))}.`);
    table(["Date", "Invoice", "Customer", "Method", "Reference", "Amount"], pays.map((p) => [dShort(p.date), p.number, p.customer, p.method, p.note, rp(p.amount)]),
      { num: [5], foot: ["", "Total", "", "", "", rp(sum(pays, (p) => p.amount))] });
    heading(`Receivables open on ${d.to}`, "Days overdue as of the last day of the month.");
    const od = (r) => Math.max(0, Math.round((Date.parse(d.to) - Date.parse(r.due)) / 864e5));
    table(["Invoice", "Customer", "Date", "Due", "Days late", "Total", "Paid", "Outstanding"],
      open.map((r) => [r.number, r.customer, dShort(r.date), r.due, od(r) ? String(od(r)) : "-", rp(r.total), rp(r.paid), rp(r.out)]),
      { num: [4, 5, 6, 7], foot: ["Total", "", "", "", "", "", "", rp(sum(open, (r) => r.out))] });
  }

  // ---- purchasing ----
  if (want("purchasing")) {
    const ord = only(d.poOrdered), rec = only(d.poReceived);
    heading("Purchase orders placed", "Landed value = goods at the order's rate plus freight, duty and other costs.");
    table(["Date", "PO", "Supplier", "Entity", "Currency", "Goods", "Rate", "Landed (Rp)", "Status"],
      ord.map((p) => [dShort(p.date), p.number, p.supplier, p.tax === "PPN" ? "PPN" : "Non-PPN", p.currency, fmtN(p.goods), p.currency === "IDR" ? "" : fmtN(p.fx), rp(p.landed), p.status]),
      { num: [5, 6, 7], foot: ["", "Total", "", "", "", "", "", rp(sum(ord, (p) => p.landed)), ""] });
    heading("Goods received", "Valued at the landed cost each receipt was booked at.");
    table(["Date", "PO", "Supplier", "SKU", "Qty", "Landed / unit", "Value"], rec.map((r) => [tShort(r.date), r.number, r.supplier, r.sku, fmtN(r.qty), rp(Math.round(r.unit)), rp(r.value)]),
      { num: [4, 5, 6], foot: ["", "Total", "", "", fmtN(sum(rec, (r) => r.qty)), "", rp(sum(rec, (r) => r.value))] });
  }

  // ---- payables ----
  if (want("payables")) {
    const pays = only(d.apPayments);
    const open = only(d.apOpen);
    heading("Payments to suppliers");
    table(["Date", "PO", "Supplier", "Amount", "Rate", "Rp", "Method"], pays.map((p) => [dShort(p.date), p.number, p.supplier, `${p.currency} ${fmtN(p.amount)}`, p.currency === "IDR" ? "" : fmtN(p.fx), rp(p.idr), p.method]),
      { num: [3, 4, 5], foot: ["", "Total", "", "", "", rp(sum(pays, (p) => p.idr)), ""] });
    heading(`Payables open on ${d.to}`, "Rupiah at each order's rate.");
    table(["PO", "Supplier", "Ordered", "Currency", "Payable", "Paid", "Outstanding", "In Rp"],
      open.map((r) => [r.number, r.supplier, dShort(r.date), r.currency, fmtN(r.payable), fmtN(r.paid), fmtN(r.out), rp(r.idr)]),
      { num: [4, 5, 6, 7], foot: ["Total", "", "", "", "", "", "", rp(sum(open, (r) => r.idr))] });
  }

  // ---- expenses ----
  if (want("expenses")) {
    const ex = only(d.expenses), sal = only(d.salaries);
    const cats = new Map();
    for (const e of ex) cats.set(e.category, (cats.get(e.category) || 0) + e.amount);
    if (sal.length) cats.set("Salaries", sum(sal, (s) => s.net));
    const total = [...cats.values()].reduce((a, v) => a + v, 0);
    heading("Expenses by category", "Salaries are included from payroll.");
    table(["Category", "Amount", "Share"], [...cats].sort((a, b) => b[1] - a[1]).map(([c, v]) => [c, rp(v), total ? `${((v / total) * 100).toFixed(1)}%` : ""]),
      { num: [1, 2], foot: ["Total", rp(total), ""], widths: { 0: 90 } });
    heading("Expense entries");
    table(["Date", "Entity", "Category", "Description", "Paid by", "Amount"], ex.map((e) => [dShort(e.date), e.tax === "PPN" ? "PPN" : "Non-PPN", e.category, e.description, e.method, rp(e.amount)]),
      { num: [5], foot: ["", "", "", "Total (excl. salaries)", "", rp(sum(ex, (e) => e.amount))] });
  }

  // ---- payroll ----
  if (want("payroll")) {
    const sal = only(d.salaries);
    heading("Payroll", `${sal.length} people paid for ${monthLong(d.month)}.`);
    table(["Employee", "Entity", "Paid on", "Base", "Allowance", "Bonus", "Deductions", "Net pay"],
      sal.map((s) => [s.name, s.tax === "PPN" ? "PPN" : "Non-PPN", dShort(s.date), rp(s.base), rp(s.allowance), rp(s.bonus), s.deduction ? "-" + fmtRp(s.deduction) : "-", rp(s.net)]),
      { num: [3, 4, 5, 6, 7], foot: ["Total", "", "", rp(sum(sal, (s) => s.base)), rp(sum(sal, (s) => s.allowance)), rp(sum(sal, (s) => s.bonus)), rp(sum(sal, (s) => s.deduction)), rp(sum(sal, (s) => s.net))] });
  }

  // ---- closing stock ----
  if (want("inventory")) {
    const items = only(d.stock.items).filter((s) => s.qty);
    const src = d.stock.source === "snapshot" ? `Recorded ${new Date(d.stock.takenAt).toLocaleString("id-ID")} (the last stock change in the month).`
      : d.stock.source === "current" ? "This month isn't over: stock as it is now."
      : `No closing stock was recorded for this month (records start ${d.firstSnapshot ? monthLong(d.firstSnapshot) : "from now on"}).`;
    heading("Closing stock", `${src} Products with zero stock are left out.`);
    const owner = d.owner;
    table(["SKU", "Product", "Entity", "Qty", "Sell price", ...(owner ? ["Avg cost", "Value at cost"] : [])],
      items.map((s) => [s.sku, s.name, s.tax === "PPN" ? "PPN" : "Non-PPN", `${fmtN(s.qty)} ${s.unit}`, rp(s.sellPrice), ...(owner ? [rp(Math.round(s.cost || 0)), rp(Math.round(s.qty * (s.cost || 0)))] : [])]),
      { num: owner ? [3, 4, 5, 6] : [3, 4], foot: ["Total", `${items.length} products`, "", fmtN(sum(items, (s) => s.qty)), "", ...(owner ? ["", rp(Math.round(sum(items, (s) => s.qty * (s.cost || 0))))] : [])] });
  }

  // ---- stock moves ----
  if (want("moves")) {
    const mv = only(d.moves);
    heading("Stock moves", `${mv.length} moves: sales, receipts, transfers, adjustments and cancellations.`);
    table(["Time", "SKU", "Entity", "Type", "Qty", "Note", "By"], mv.map((m) => [tShort(m.t), m.sku, m.tax === "PPN" ? "PPN" : "Non-PPN", m.type, (m.qty > 0 ? "+" : "") + fmtN(m.qty), m.note, m.by || ""]),
      { num: [4], widths: { 0: 20, 3: 16, 4: 14 } });
  }

  // ---- footer on every page ----
  const n = doc.internal.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...muted)
      .text(`Sparepart ERP · Monthly report ${monthLong(d.month)}${ledger ? " · " + entName(ledger) : ""}`, M, H - 8)
      .text(`Page ${i} of ${n}`, W - M, H - 8, { align: "right" });
  }
  return doc;
}
