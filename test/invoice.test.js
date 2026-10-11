import { test } from "node:test";
import assert from "node:assert/strict";
import { lineAmount, invoiceTotals, lineNets, terbilang, paymentState, invoiceHtml, invoiceMessage } from "../public/js/invoice.js";

test("line amounts round to whole rupiah after discount", () => {
  assert.equal(lineAmount({ qty: 3, price: 10000, discPct: 0 }), 30000);
  assert.equal(lineAmount({ qty: 3, price: 3333, discPct: 10 }), 8999);
  assert.equal(lineAmount({ qty: 1, price: 5000, discPct: 150 }), 0, "discount is capped at 100%");
});

test("PPN 11%: flat by default, or DPP Nilai Lain 11/12 × 12% in the Coretax format", () => {
  const f11 = invoiceTotals([{ qty: 1, price: 1000000 }], "PPN", 11);
  assert.deepEqual(f11, { subtotal: 1000000, dppLain: 0, ppn: 110000, total: 1110000, scheme: "flat", rate: 11 });
  const t = invoiceTotals([{ qty: 1, price: 1000000 }], "PPN", 11, "excl", "dpp-lain");
  assert.deepEqual(t, { subtotal: 1000000, dppLain: 916666, ppn: 109999, total: 1109999, scheme: "dpp-lain" }, "Rp 1 less after rounding");
  const flat = invoiceTotals([{ qty: 1, price: 1000000 }], "PPN", 12);
  assert.equal(flat.ppn, 120000);
  const non = invoiceTotals([{ qty: 2, price: 500 }], "NON", 11);
  assert.deepEqual(non, { subtotal: 1000, dppLain: 0, ppn: 0, total: 1000, scheme: "none" });
});

test("terbilang", () => {
  assert.equal(terbilang(0), "Nol rupiah");
  assert.equal(terbilang(11), "Sebelas rupiah");
  assert.equal(terbilang(115), "Seratus lima belas rupiah");
  assert.equal(terbilang(1000), "Seribu rupiah");
  assert.equal(terbilang(1250000), "Satu juta dua ratus lima puluh ribu rupiah");
  assert.equal(terbilang(2001001), "Dua juta seribu satu rupiah");
  assert.equal(terbilang(1109999), "Satu juta seratus sembilan ribu sembilan ratus sembilan puluh sembilan rupiah");
  assert.equal(terbilang(3000000000), "Tiga miliar rupiah");
});

test("payment state", () => {
  assert.deepEqual(paymentState(1000, 1000, "2025-01-01", "2025-02-01"), { balance: 0, state: "paid" });
  assert.deepEqual(paymentState(1000, 400, "2025-01-01", "2025-02-01"), { balance: 600, state: "partial", overdue: true });
  assert.deepEqual(paymentState(1000, 0, "2025-03-01", "2025-02-01"), { balance: 1000, state: "unpaid", overdue: false });
});

test("printable invoice escapes text and shows tax lines", () => {
  const inv = { status: "issued", number: "INV/P/2026/0001", tax: "PPN", date: "2026-10-09", dueDate: "2026-11-08", note: "", nsfp: "04002600000001",
    custName: "PT <Script> Jaya", custAddress: "Jl. A", custNpwp: "0123456789012345", subtotal: 1000000, dppLain: 916666, ppn: 109999, total: 1109999 };
  const html = invoiceHtml({ inv, lines: [{ sku: "A1", name: "Bolt & nut", qty: 1, unit: "PCS", price: 1000000, discPct: 0 }], issuer: { name: "CV Hashiru" }, ppnRate: 11 });
  assert.match(html, /PT &lt;Script&gt; Jaya/);
  assert.match(html, /Bolt &amp; nut/);
  assert.match(html, /DPP Nilai Lain \(11\/12\)/);
  assert.match(html, /PPN 12%/);
  assert.match(html, /No\. Faktur Pajak/);
  assert.match(html, /Satu juta seratus sembilan ribu/);
  assert.match(html, /bukan Faktur Pajak/);
  const msg = invoiceMessage({ customer: { contact: "Pak Budi" }, inv, issuer: { name: "CV Hashiru", bank: "BCA 123" }, balance: 1109999 });
  assert.match(msg, /^Yth\. Pak Budi,/);
  assert.match(msg, /INV\/P\/2026\/0001/);
  assert.match(msg, /BCA 123/);
});

test("selling prices that include PPN: total as entered, DPP worked back", () => {
  const t = invoiceTotals([{ qty: 1, price: 1110000 }], "PPN", 11, "incl");
  assert.equal(t.total, 1110000);
  assert.equal(t.subtotal, 1000000);
  assert.equal(t.ppn, 110000);
  assert.equal(t.scheme, "flat");
  assert.equal(invoiceTotals([{ qty: 1, price: 1110000 }], "PPN", 11, "incl", "dpp-lain").dppLain, 916666);
  assert.deepEqual(lineNets([{ qty: 1, price: 555000 }, { qty: 1, price: 555000 }], 1000000), [500000, 500000]);
});
