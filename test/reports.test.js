import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMonth, detectPlan, toNum, parseSales, parseStock, findBlocks, readProductList } from "../public/js/reports.js";

test("detectMonth reads Indonesian and English month names and dates", () => {
  assert.equal(detectMonth("Laporan Penjualan PPN Okt 25.xlsx"), "2025-10");
  assert.equal(detectMonth("Persediaan Barang AGUSTUS 2024.xlsx"), "2024-08");
  assert.equal(detectMonth("sales 01-03-2025.xlsx"), "2025-03");
  assert.equal(detectMonth("random.xlsx"), "");
});

test("detectPlan guesses kind and ledger from the name", () => {
  assert.deepEqual(detectPlan("Penjualan NON PPN Jan 2025.xlsx"), { kind: "sales", tax: "NON", taxSure: true, ym: "2025-01" });
  assert.equal(detectPlan("Persediaan PPN Feb 2025.xls").kind, "stock");
  assert.equal(detectPlan("invoice.pdf").kind, "attach");
});

test("toNum handles Indonesian thousands and decimal separators", () => {
  assert.equal(toNum("1.234.567"), 1234567);
  assert.equal(toNum("1.234,50"), 1234.5);
  assert.equal(toNum("Rp 12.000"), 12000);
  assert.equal(toNum("12,5"), 12.5);
  assert.equal(toNum("1,234,567"), 1234567);
  assert.equal(toNum(""), 0);
});

test("parseSales (PPN layout) sums lines and reconciles to the report total", () => {
  const row = (code, qty, unit, total) => { const r = Array(26).fill(""); r[2] = code; r[3] = "Item " + code; r[7] = qty; r[10] = unit; r[25] = total; return r; };
  const rows = [row("Kode", "Qty", "Satuan", "Total"), row("A1", 2, "PCS", 1000), row("B2", 1, "SET", 500), ["", "", "", "", "", "", "", "", "Grand total", 1500]];
  const r = parseSales(rows, "PPN");
  assert.equal(r.lines.length, 2);
  assert.equal(r.qty, 3);
  assert.equal(r.rp, 1500);
  assert.equal(r.check, "ok");
  assert.equal(r.lines[1].unit, "SET");
});

test("parseStock flags a mismatch with the total row", () => {
  const row = (code, name, qty, total) => { const r = Array(12).fill(""); r[0] = code; r[2] = name; r[6] = qty; r[8] = "PCS"; r[10] = 100; r[11] = total; return r; };
  const totals = (q, v) => { const r = Array(12).fill(""); r[0] = "Total"; r[5] = q; r[10] = v; return r; };
  const ok = parseStock([row("A1", "Alpha", 3, 300), row("B2", "Beta", 2, 200), totals(5, 500)]);
  assert.equal(ok.check, "ok");
  const bad = parseStock([row("A1", "Alpha", 3, 300), totals(5, 500)]);
  assert.equal(bad.check, "mismatch");
});

test("findBlocks reads side-by-side tables in a workbook tab", () => {
  const H = Array(14).fill("");
  H[0] = "Kode"; H[1] = "Nama"; H[2] = "Qty"; H[7] = "Kode"; H[8] = "Nama"; H[9] = "Qty";
  const title = Array(14).fill(""); title[0] = "STOK NON PPN"; title[7] = "PENJUALAN PPN";
  const line = Array(14).fill(""); line[0] = "A1"; line[1] = "Alpha"; line[2] = 4; line[7] = "B2"; line[8] = "Beta"; line[9] = 7;
  const blocks = findBlocks([title, Array(14).fill(""), H, line]);
  assert.deepEqual(blocks.map((b) => [b.kind, b.tax, b.qty]), [["stock", "NON", 4], ["sales", "PPN", 7]]);
});

test("readProductList maps headers and merges duplicate SKUs", () => {
  const raw = [["Kode", "Nama", "Satuan", "Stok", "Harga"], ["X1", "Bolt", "pcs", "10", "1.500"], ["X1", "Bolt M8", "SET", 4, 2000], ["", "no sku"]];
  const r = readProductList(raw, "NON");
  assert.equal(r.rows.length, 1);
  assert.equal(r.merged, 1);
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.rows[0], { sku: "X1", name: "Bolt M8", unit: "SET", qty: 4, price: 2000, tax: "NON", minStock: 0 });
});
