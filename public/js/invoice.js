// Sales invoice maths, Indonesian amount-in-words, the customer message and the printable document.
// Pure functions: the browser and the server compute totals with the same code.

import { esc } from "./util.js";

const clampPct = (p) => Math.min(100, Math.max(0, +p || 0));

/** Line amount in whole rupiah, after the line discount. Prices exclude PPN. */
export const lineAmount = (l) => Math.round((+l.qty || 0) * (+l.price || 0) * (1 - clampPct(l.discPct) / 100));

/**
 * Invoice totals. Non-PPN: total = subtotal.
 * style "flat" (default): PPN = rate × subtotal, rounded down, shown as "PPN 11%".
 * style "dpp-lain" at the 11 % rate: the Coretax presentation, DPP Nilai Lain = 11/12 × selling price and PPN = 12 % of
 * that. Same tax, but rounding can differ from flat 11 % by Rp 1, so pick the one your e-Faktur matches.
 * priceMode "incl": the line prices already include PPN; the total stays as entered and DPP is worked back from it.
 */
export function invoiceTotals(lines, tax, ppnRate, priceMode = "excl", style = "flat") {
  const gross = lines.reduce((a, l) => a + lineAmount(l), 0);
  if (tax !== "PPN") return { subtotal: gross, dppLain: 0, ppn: 0, total: gross, scheme: "none" };
  const rate = +ppnRate || 0;
  const lain = rate === 11 && style === "dpp-lain";
  if (priceMode === "incl") {
    const subtotal = Math.round(gross / (1 + rate / 100));
    return { subtotal, dppLain: lain ? Math.floor((subtotal * 11) / 12) : 0, ppn: gross - subtotal, total: gross, scheme: lain ? "dpp-lain" : "flat", rate };
  }
  const subtotal = gross;
  if (lain) {
    const dppLain = Math.floor((subtotal * 11) / 12);
    const ppn = Math.floor((dppLain * 12) / 100);
    return { subtotal, dppLain, ppn, total: subtotal + ppn, scheme: "dpp-lain" };
  }
  const ppn = Math.floor((subtotal * rate) / 100);
  return { subtotal, dppLain: 0, ppn, total: subtotal + ppn, scheme: "flat", rate };
}

/** Each line's net sales excluding PPN (for margin and transfer cost), scaled when prices include PPN. */
export function lineNets(lines, subtotal) {
  const gross = lines.reduce((a, l) => a + lineAmount(l), 0);
  const f = gross ? subtotal / gross : 1;
  return lines.map((l) => Math.round(lineAmount(l) * f));
}

/** Payment state of an issued invoice. */
export function paymentState(total, paid, dueDate, today) {
  const balance = Math.max(0, Math.round(total - paid));
  if (balance === 0) return { balance, state: "paid" };
  return { balance, state: paid > 0 ? "partial" : "unpaid", overdue: !!dueDate && dueDate < today };
}

const WORDS = ["", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan", "sepuluh", "sebelas"];
function words(n) {
  if (n < 12) return WORDS[n];
  if (n < 20) return words(n - 10) + " belas";
  if (n < 100) return words(Math.floor(n / 10)) + " puluh" + (n % 10 ? " " + words(n % 10) : "");
  if (n < 200) return "seratus" + (n - 100 ? " " + words(n - 100) : "");
  if (n < 1000) return words(Math.floor(n / 100)) + " ratus" + (n % 100 ? " " + words(n % 100) : "");
  if (n < 2000) return "seribu" + (n - 1000 ? " " + words(n - 1000) : "");
  for (const [size, name] of [[1e12, "triliun"], [1e9, "miliar"], [1e6, "juta"], [1e3, "ribu"]]) {
    if (n >= size) return words(Math.floor(n / size)) + " " + name + (n % size ? " " + words(n % size) : "");
  }
  return "";
}
/** Amount in Indonesian words, e.g. 1250000 → "Satu juta dua ratus lima puluh ribu rupiah". */
export function terbilang(amount) {
  const n = Math.floor(Math.abs(+amount || 0));
  const w = n === 0 ? "nol" : words(n);
  return w.charAt(0).toUpperCase() + w.slice(1) + " rupiah";
}

const rp = (n) => "Rp " + Math.round(n).toLocaleString("id-ID");
const idDate = (ymd) => {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
};

/** Short message to send the customer with the invoice. */
export function invoiceMessage({ customer, inv, issuer, balance }) {
  const to = customer?.contact || customer?.name || "Bapak/Ibu";
  return `Yth. ${to},

Berikut kami sampaikan invoice ${inv.number} tanggal ${idDate(inv.date)} sebesar ${rp(inv.total)}${balance != null && balance !== inv.total ? ` (sisa tagihan ${rp(balance)})` : ""}, jatuh tempo ${idDate(inv.dueDate)}.
${issuer?.bank ? `\nPembayaran dapat ditransfer ke:\n${issuer.bank}\n` : ""}
Terima kasih atas kepercayaan Anda.
${issuer?.name || ""}`.trim();
}

/** Complete, printable HTML document for one invoice (A4). */
export function invoiceHtml({ inv, lines, issuer = {}, payments = [], ppnRate }) {
  const t = inv.status === "draft" ? invoiceTotals(lines, inv.tax, ppnRate, inv.priceMode, inv.ppnStyle) : { subtotal: inv.subtotal, dppLain: inv.dppLain, ppn: inv.ppn, total: inv.total, scheme: inv.dppLain ? "dpp-lain" : inv.ppn ? "flat" : "none" };
  const paid = payments.reduce((a, p) => a + p.amount, 0);
  const cust = inv.status === "draft" ? inv.customer || {} : { name: inv.custName, address: inv.custAddress, npwp: inv.custNpwp };
  const anyDisc = lines.some((l) => +l.discPct);
  const stamp = inv.status === "draft" ? "DRAFT" : inv.status === "void" ? "BATAL / VOID" : "";
  const rows = lines.map((l, i) => `<tr><td>${i + 1}</td><td class="mono">${esc(l.sku)}</td><td>${esc(l.name)}</td><td class="r">${(+l.qty).toLocaleString("id-ID")}</td><td>${esc(l.unit)}</td>
    <td class="r">${rp(l.price)}</td>${anyDisc ? `<td class="r">${+l.discPct ? (+l.discPct).toLocaleString("id-ID") + "%" : ""}</td>` : ""}<td class="r">${rp(lineAmount(l))}</td></tr>`).join("");
  const tot = [
    ["Subtotal (Harga Jual)", t.subtotal],
    ...(t.scheme === "dpp-lain" ? [["DPP Nilai Lain (11/12)", t.dppLain], ["PPN 12%", t.ppn]] : t.scheme === "flat" ? [[`PPN ${ppnRate}%`, t.ppn]] : []),
  ];
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${esc(inv.number || "Draft invoice")}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.45 "Inter", "Segoe UI", Arial, sans-serif; color: #1e2433; margin: 0; }
  .doc { max-width: 800px; margin: 0 auto; padding: 24px; position: relative; }
  .top { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #1e2433; padding-bottom: 14px; }
  h1 { font-size: 26px; letter-spacing: .08em; margin: 0 0 6px; text-align: right; }
  .co { font-size: 16px; font-weight: 700; }
  .muted { color: #6b7280; }
  .meta td { padding: 1px 0 1px 12px; text-align: right; }
  .meta td:first-child { color: #6b7280; }
  .parties { display: flex; justify-content: space-between; gap: 24px; margin: 16px 0; }
  .box { border: 1px solid #e2e6ee; border-radius: 8px; padding: 10px 12px; min-width: 260px; }
  .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; margin-bottom: 4px; }
  table.lines { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.lines th { background: #f6f7fb; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #4a5263; padding: 7px 8px; border-bottom: 1px solid #d8dde6; }
  table.lines td { padding: 7px 8px; border-bottom: 1px solid #eceff4; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  .sum { display: flex; justify-content: space-between; gap: 24px; margin-top: 14px; }
  .words { flex: 1; font-style: italic; }
  table.tot td { padding: 3px 0 3px 18px; text-align: right; }
  table.tot tr.grand td { font-size: 15px; font-weight: 700; border-top: 2px solid #1e2433; padding-top: 6px; }
  .foot { display: flex; justify-content: space-between; gap: 24px; margin-top: 28px; }
  .sign { text-align: center; min-width: 200px; }
  .sign .line { margin-top: 64px; border-top: 1px solid #1e2433; padding-top: 4px; }
  .stamp { position: absolute; top: 34%; left: 0; right: 0; text-align: center; font-size: 84px; font-weight: 800; color: rgba(220, 76, 76, .14); transform: rotate(-18deg); pointer-events: none; }
  .bar { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 24px; max-width: 800px; margin: 0 auto; }
  .bar button { font: 600 13px sans-serif; padding: 8px 14px; border-radius: 8px; border: 1px solid #d8dde6; background: #fff; cursor: pointer; }
  .bar button.p { background: #5b6cf0; color: #fff; border-color: #5b6cf0; }
  @media print { .bar { display: none; } .doc { padding: 0; } }
</style></head><body>
<div class="bar"><button onclick="window.close()">Close</button><button class="p" onclick="window.print()">Print / Save as PDF</button></div>
<div class="doc">
  ${stamp ? `<div class="stamp">${stamp}</div>` : ""}
  <div class="top">
    <div><div class="co">${esc(issuer.name || "Nama perusahaan")}</div>
      <div>${esc(issuer.address || "").replace(/\n/g, "<br>")}</div>
      ${issuer.phone ? `<div>Telp: ${esc(issuer.phone)}</div>` : ""}${issuer.npwp ? `<div>NPWP: ${esc(issuer.npwp)}</div>` : ""}</div>
    <div><h1>INVOICE</h1><table class="meta">
      <tr><td>No.</td><td><b>${esc(inv.number || "DRAFT")}</b></td></tr>
      <tr><td>Tanggal</td><td>${esc(idDate(inv.date))}</td></tr>
      <tr><td>Jatuh tempo</td><td>${esc(idDate(inv.dueDate))}</td></tr>
      ${inv.nsfp ? `<tr><td>No. Faktur Pajak</td><td>${esc(inv.nsfp)}</td></tr>` : ""}
    </table></div>
  </div>
  <div class="parties"><div class="box"><div class="lbl">Kepada / Bill to</div><b>${esc(cust.name || "")}</b>
    <div>${esc(cust.address || "").replace(/\n/g, "<br>")}</div>${cust.npwp ? `<div>NPWP: ${esc(cust.npwp)}</div>` : ""}</div></div>
  <table class="lines"><thead><tr><th>No</th><th>Kode</th><th>Nama barang</th><th class="r">Qty</th><th>Satuan</th><th class="r">Harga</th>${anyDisc ? `<th class="r">Disc</th>` : ""}<th class="r">Jumlah</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="sum"><div class="words"><div class="lbl">Terbilang</div>${esc(terbilang(t.total))}</div>
    <table class="tot">${tot.map(([l, v]) => `<tr><td class="muted">${l}</td><td>${rp(v)}</td></tr>`).join("")}
      <tr class="grand"><td>Total</td><td>${rp(t.total)}</td></tr>
      ${paid ? `<tr><td class="muted">Dibayar</td><td>${rp(paid)}</td></tr><tr><td><b>Sisa tagihan</b></td><td><b>${rp(Math.max(0, t.total - paid))}</b></td></tr>` : ""}</table></div>
  ${inv.note ? `<p><span class="lbl">Catatan</span><br>${esc(inv.note).replace(/\n/g, "<br>")}</p>` : ""}
  ${inv.tax === "PPN" ? `<p class="muted" style="font-size:10px">Dokumen ini bukan Faktur Pajak. Faktur Pajak diterbitkan terpisah melalui Coretax.</p>` : ""}
  <div class="foot"><div>${issuer.bank ? `<div class="lbl">Pembayaran</div>${esc(issuer.bank).replace(/\n/g, "<br>")}` : ""}${issuer.footer ? `<p class="muted">${esc(issuer.footer)}</p>` : ""}</div>
    <div class="sign">Hormat kami,<div class="line">${esc(issuer.name || "")}</div></div></div>
</div></body></html>`;
}
