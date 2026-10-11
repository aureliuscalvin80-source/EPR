import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";

let server, base, app, dir, cookie = "";
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-test-"));
  app = createApp({ dataDir: dir, setupCode: "TEST-CODE" });
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + "/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "erp" },
    body: JSON.stringify({ code: "TEST-CODE", username: "admin", name: "Admin", password: "correct horse" }) });
  assert.equal(res.status, 200);
  cookie = res.headers.get("set-cookie").split(";")[0];
});
after(() => {
  app.locals.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, body, jar = cookie) {
  const headers = { Cookie: jar, "X-Requested-With": "erp" };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

test("first run seeds settings and starter formulas", async () => {
  const { body } = await call("GET", "/api/state");
  assert.equal(body.settings.ppnRate, 11);
  assert.ok(body.rules.some((r) => r.name === "Below safety stock"));
});

test("items: create, reject duplicates, edit records an ADJ move", async () => {
  let r = await call("POST", "/api/items", { sku: "A1", tax: "PPN", name: "Alpha", unit: "PCS", qty: 5, price: 1000 });
  assert.equal(r.status, 200);
  r = await call("POST", "/api/items", { sku: "A1", tax: "PPN", name: "Again" });
  assert.equal(r.status, 409);
  r = await call("POST", "/api/items", { sku: "bad~sku", tax: "PPN", name: "x" });
  assert.equal(r.status, 400);
  r = await call("PUT", "/api/items/" + encodeURIComponent("PPN~A1"), { name: "Alpha 2", unit: "PCS", qty: 8, price: 1000, minStock: 1 });
  assert.equal(r.status, 200);
  const st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["PPN~A1"].qty, 8);
  assert.equal(st.moves[0].type, "ADJ");
  assert.equal(st.moves[0].qty, 3);
  assert.equal(st.moves[0].by, "Admin");
});

test("moves: IN/OUT/ADJ update stock and OUT cannot go negative", async () => {
  await call("POST", "/api/items", { sku: "M1", tax: "NON", name: "Move me", qty: 2 });
  assert.equal((await call("POST", "/api/moves", { key: "NON~M1", type: "IN", qty: 5 })).status, 400, "a reason is required");
  assert.equal((await call("POST", "/api/moves", { key: "NON~M1", type: "IN", qty: 5, note: "found" })).body.to, 7);
  assert.equal((await call("POST", "/api/moves", { key: "NON~M1", type: "OUT", qty: 3, note: "damaged" })).body.to, 4);
  assert.equal((await call("POST", "/api/moves", { key: "NON~M1", type: "OUT", qty: 9, note: "x" })).status, 409);
  assert.equal((await call("POST", "/api/moves", { key: "NON~M1", type: "ADJ", qty: 1, note: "stock count" })).body.to, 1);
});

test("rules: invalid formulas are refused", async () => {
  const r = await call("POST", "/api/rules", { name: "Broken", kind: "alert", scope: "ALL", severity: "warn", expr: "qty <" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Formula error/);
});

test("files and reports: upload, store demand, set stock, delete", async () => {
  const up = await fetch(`${base}/api/files?name=stock.xlsx&kind=stock&tax=PPN&ym=2025-03`, { method: "POST", headers: { Cookie: cookie, "X-Requested-With": "erp" }, body: Buffer.from("fake") });
  const { id } = await up.json();
  assert.ok(id);
  const raw = await fetch(`${base}/api/files/${id}/raw`, { headers: { Cookie: cookie } });
  assert.equal(await raw.text(), "fake");
  assert.match(raw.headers.get("content-disposition"), /attachment/);

  const results = [{ fileId: id, histId: id, name: "stock.xlsx", kind: "stock", tax: "PPN", ym: "2025-03", check: "ok",
    items: [{ code: "A1", name: "Alpha", qty: 4, unit: "PCS", price: 900 }, { code: "Z9", name: "New part", qty: 6, unit: "SET", price: 50 }] }];
  const r = await call("POST", "/api/reports", { results, setStock: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.message, /PPN stock set from Mar 2025 \(2 SKUs/);
  let st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["PPN~A1"].qty, 4);
  assert.equal(st.items["PPN~Z9"].unit, "SET");
  assert.equal(st.dem["PPN~A1"].s["2025-03"], 1);
  assert.equal(st.history.length, 1);

  assert.equal((await call("DELETE", `/api/files/${id}`)).status, 200);
  st = (await call("GET", "/api/state")).body;
  assert.equal(st.files.length, 0);
  assert.equal(st.history.length, 0);
});

test("suppliers: validation, assignment, delete unassigns products", async () => {
  let r = await call("POST", "/api/suppliers", { contact: "Budi" });
  assert.equal(r.status, 400, "name required");
  r = await call("POST", "/api/suppliers", { company: "PT Jaya", currency: "EUR" });
  assert.equal(r.status, 400, "unknown currency");
  r = await call("POST", "/api/suppliers", { company: "PT Jaya", email: "not-an-email" });
  assert.equal(r.status, 400);
  r = await call("POST", "/api/suppliers", { company: "PT Jaya", whatsapp: "0812 555", preferred: "email" });
  assert.match(r.body.error, /preferred channel/);
  r = await call("POST", "/api/suppliers", { company: "PT Jaya", contact: "Budi", whatsapp: "+62 812 3456 7890", preferred: "whatsapp" });
  assert.equal(r.status, 200);
  const sid = r.body.id;

  await call("POST", "/api/items", { sku: "S1", tax: "NON", name: "Supplied", supplierId: sid });
  await call("POST", "/api/items", { sku: "S2", tax: "NON", name: "Later" });
  assert.equal((await call("PUT", "/api/items/" + encodeURIComponent("NON~S2") + "/supplier", { supplierId: sid })).status, 200);
  assert.equal((await call("PUT", "/api/items/" + encodeURIComponent("NON~S2") + "/supplier", { supplierId: "nope" })).status, 400);
  let st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["NON~S1"].supplierId, sid);
  assert.equal(st.items["NON~S2"].supplierId, sid);
  assert.equal(st.suppliers[0].company, "PT Jaya");

  // Importing products leaves suppliers alone, and only changes the columns the file has.
  await call("POST", "/api/items/import", { rows: [{ sku: "S1", tax: "NON", name: "Supplied v2", qty: 3 }] });
  let it = (await call("GET", "/api/state")).body.items["NON~S1"];
  assert.equal(it.supplierId, sid);
  assert.equal(it.qty, 3);
  await call("POST", "/api/items/import", { rows: [{ sku: "S1", tax: "NON", sellPrice: 777 }] });
  it = (await call("GET", "/api/state")).body.items["NON~S1"];
  assert.equal(it.qty, 3, "qty kept when the file has no qty column");
  assert.equal(it.sellPrice, 777);
  assert.equal(it.name, "Supplied v2");

  r = await call("DELETE", "/api/suppliers/" + sid);
  assert.equal(r.body.unassigned, 2);
  st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["NON~S1"].supplierId, "");
  assert.equal(st.suppliers.length, 0);
});

test("purchase orders: draft, merge, currency, landed cost, partial receipt, payables, close", async () => {
  const sid = (await call("POST", "/api/suppliers", { company: "Guangzhou Parts", wechat: "gz", currency: "CNY" })).body.id;
  await call("POST", "/api/items", { sku: "P1", tax: "PPN", name: "Pump", qty: 2, cost: 100000, supplierId: sid });
  await call("POST", "/api/items", { sku: "P2", tax: "PPN", name: "Pipe", qty: 0, supplierId: sid });
  await call("POST", "/api/items", { sku: "P3", tax: "NON", name: "No supplier", qty: 0 });

  assert.equal((await call("POST", "/api/pos/add-line", { itemKey: "NON~P3", qty: 1 })).status, 400, "needs a supplier");
  const a = (await call("POST", "/api/pos/add-line", { itemKey: "PPN~P1", qty: 5 })).body;
  assert.equal(a.created, true);
  assert.match(a.number, /^PO\/\d{4}\/0001$/);
  const b = (await call("POST", "/api/pos/add-line", { itemKey: "PPN~P1", qty: 3 })).body;
  assert.equal(b.id, a.id, "goes into the same draft");
  assert.equal(b.merged, true);
  await call("POST", "/api/pos/add-line", { itemKey: "PPN~P2", qty: 10 });
  let po = (await call("GET", "/api/state")).body.pos.find((p) => p.id === a.id);
  assert.equal(po.currency, "CNY", "takes the supplier's currency");
  assert.equal(po.ledger, "PPN");
  assert.deepEqual(po.lines.map((l) => [l.sku, l.qty]), [["P1", 8], ["P2", 10]]);

  // Draft: prices in CNY, freight and duty in Rp. Ordering needs a rate.
  const lines = [{ itemKey: "PPN~P1", qty: 6, price: 50 }, { itemKey: "PPN~P2", qty: 10, price: 10 }];
  assert.equal((await call("PUT", `/api/pos/${a.id}`, { lines, note: "Urgent", fx: 0, freight: 80000, duty: 20000 })).status, 200);
  assert.equal((await call("POST", `/api/pos/${a.id}/send`, { via: "wechat" })).status, 400, "rate required");
  await call("PUT", `/api/pos/${a.id}`, { lines, fx: 2200, freight: 80000, duty: 20000 });
  assert.equal((await call("POST", `/api/pos/${a.id}/receive`, { lines: [] })).status, 409, "not ordered yet");
  assert.equal((await call("POST", `/api/pos/${a.id}/send`, { via: "wechat" })).status, 200);
  assert.equal((await call("DELETE", `/api/suppliers/${sid}`)).status, 409, "supplier with orders can't be deleted");

  let st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["PPN~P1"].onOrder, 6, "on order comes from the server");
  po = st.pos.find((p) => p.id === a.id);
  const l1 = po.lines.find((l) => l.sku === "P1"), l2 = po.lines.find((l) => l.sku === "P2");

  // Goods = 6×50 + 10×10 = 400 CNY. Charges Rp 100.000 spread by value: P1 gets 100000×50/400 = 12.500 per unit.
  // Landed P1 = 50×2200 + 12.500 = 122.500. Average with 2 in stock at 100.000: (2×100000 + 4×122500) / 6 = 115.000.
  let r = await call("POST", `/api/pos/${a.id}/receive`, { lines: [{ id: l1.id, qty: 7 }] });
  assert.equal(r.status, 400, "can't receive more than ordered");
  r = await call("POST", `/api/pos/${a.id}/receive`, { lines: [{ id: l1.id, qty: 4 }] });
  assert.deepEqual(r.body, { status: "partial", booked: 1 });
  st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["PPN~P1"].qty, 6);
  assert.equal(Math.round(st.items["PPN~P1"].cost), 115000);
  assert.equal(st.items["PPN~P1"].onOrder, 2);
  assert.equal(st.moves.find((m) => m.sku === "P1" && m.type === "PO").note, po.number);

  // Payables: 400 CNY ordered.
  assert.equal((await call("POST", `/api/pos/${a.id}/payments`, { amount: 500, fx: 2210 })).status, 400, "can't overpay");
  assert.equal((await call("POST", `/api/pos/${a.id}/payments`, { amount: 300 })).status, 400, "rate required for CNY");
  assert.equal((await call("POST", `/api/pos/${a.id}/payments`, { amount: 300, fx: 2210, note: "TT" })).status, 200);
  st = (await call("GET", "/api/state")).body;
  assert.equal(st.supplierPays[0].idr, 663000);

  // From alerts: a fresh draft with the given lines
  const fa = (await call("POST", "/api/pos/from-alerts", { ledger: "PPN", supplierId: sid, lines: [{ itemKey: "PPN~P2", qty: 4 }] })).body;
  assert.notEqual(fa.id, a.id);
  assert.match(fa.number, /\/0002$/);
  assert.equal((await call("POST", "/api/pos/from-alerts", { ledger: "PPN", supplierId: sid, lines: [{ itemKey: "NON~P3", qty: 1 }] })).status, 400, "wrong entity");
  assert.equal((await call("DELETE", `/api/pos/${fa.id}`)).status, 200);

  r = await call("POST", `/api/pos/${a.id}/close`);
  assert.equal(r.body.status, "closed");
  st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["PPN~P1"].onOrder, 0, "closed orders no longer count as on order");
  assert.equal((await call("POST", `/api/pos/${a.id}/receive`, { lines: [{ id: l2.id, qty: 1 }] })).status, 409);
});

test("internal transfer: a sale to our own other entity moves stock between ledgers and stays out of demand", async () => {
  const own = (await call("POST", "/api/customers", { name: "CV Amasan (own)", internal: true, ledger: "NON" })).body.id;
  await call("POST", "/api/items", { sku: "T1", tax: "PPN", name: "Transferred part", qty: 5, cost: 1000 });
  const inv = (await call("POST", "/api/invoices", { tax: "PPN", customerId: own })).body.id;
  await call("PUT", `/api/invoices/${inv}`, { lines: [{ itemKey: "PPN~T1", qty: 2, price: 1500 }] });
  const r = await call("POST", `/api/invoices/${inv}/issue`);
  assert.equal(r.body.internal, true);
  assert.equal(r.body.transferTo, "NON");
  let st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["PPN~T1"].qty, 3);
  assert.equal(st.items["NON~T1"].qty, 2, "created in the receiving ledger");
  assert.equal(st.items["NON~T1"].cost, 1500, "at the transfer price");
  assert.deepEqual(st.moves.filter((m) => m.sku === "T1").map((m) => m.type).sort(), ["ADJ", "TRF-IN", "TRF-OUT"]);
  assert.equal(st.invoices.find((i) => i.id === inv).internal, true);
  assert.equal((await call("POST", `/api/invoices/${inv}/void`, { reason: "mistake" })).status, 200);
  st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["PPN~T1"].qty, 5);
  assert.equal(st.items["NON~T1"].qty, 0);
});

test("invoices: draft, ledger check, stock check, issue, numbering, payments, void", async () => {
  let r = await call("POST", "/api/customers", { name: "PT Pelanggan", npwp: "123" });
  assert.equal(r.status, 400, "NPWP must be 15 or 16 digits");
  const cid = (await call("POST", "/api/customers", { name: "PT Pelanggan", contact: "Pak Budi", npwp: "01.234.567.8-901.000", address: "Jl. Raya 1" })).body.id;
  await call("POST", "/api/items", { sku: "I1", tax: "PPN", name: "Item one", qty: 10, price: 700, sellPrice: 1000 });
  await call("POST", "/api/items", { sku: "N1", tax: "NON", name: "Non item", qty: 5, price: 50, sellPrice: 80 });

  const inv = (await call("POST", "/api/invoices", { tax: "PPN", customerId: cid })).body.id;
  r = await call("PUT", `/api/invoices/${inv}`, { lines: [{ itemKey: "NON~N1", qty: 1, price: 80 }] });
  assert.equal(r.status, 400, "Non-PPN item can't go on a PPN invoice");
  assert.equal((await call("PUT", `/api/invoices/${inv}`, { lines: [{ itemKey: "PPN~I1", qty: 11, price: 1000 }] })).status, 200);
  r = await call("POST", `/api/invoices/${inv}/issue`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Not enough stock: I1 \(need 11, have 10\)/);
  await call("PUT", `/api/invoices/${inv}`, { lines: [{ itemKey: "PPN~I1", qty: 4, price: 250000, discPct: 0 }], note: "Thanks" });
  r = await call("POST", `/api/invoices/${inv}/issue`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.number, /^HM\/\d{4}\/\d{2}\/\d{4}$/);
  const firstSeq = Number(r.body.number.slice(-4));
  assert.equal(r.body.total, 1110000, "PPN 11% of the price by default");

  let st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["PPN~I1"].qty, 6, "stock went down");
  const mv = st.moves.find((m) => m.sku === "I1" && m.type === "SALE");
  assert.equal(mv.type, "SALE");
  assert.match(mv.note, /^HM\//);
  let i = st.invoices.find((x) => x.id === inv);
  assert.equal(i.status, "issued");
  assert.equal(i.custName, "PT Pelanggan");
  assert.equal(i.ppn, 110000);
  assert.equal(i.dppLain, 0);

  // issued: lines locked, but e-Faktur number can be added
  assert.equal((await call("PUT", `/api/invoices/${inv}`, { nsfp: "04002600000001", lines: [] })).status, 200);
  st = (await call("GET", "/api/state")).body;
  i = st.invoices.find((x) => x.id === inv);
  assert.equal(i.nsfp, "04002600000001");
  assert.equal(i.lines.length, 1, "lines unchanged");

  // payments
  assert.equal((await call("POST", `/api/invoices/${inv}/payments`, { amount: 2000000 })).status, 400, "can't overpay");
  assert.equal((await call("POST", `/api/invoices/${inv}/payments`, { amount: 1000000, method: "transfer" })).body.balance, 110000);
  assert.equal((await call("POST", `/api/invoices/${inv}/void`, { reason: "x" })).status, 409, "can't void with payments");
  st = (await call("GET", "/api/state")).body;
  const pay = st.invoices.find((x) => x.id === inv).payments[0];
  assert.equal(pay.by, "Admin");
  assert.equal((await call("DELETE", `/api/invoices/${inv}/payments/${pay.id}`)).status, 200);
  assert.equal((await call("POST", `/api/invoices/${inv}/void`, {})).status, 400, "void needs a reason");
  assert.equal((await call("POST", `/api/invoices/${inv}/void`, { reason: "Wrong customer" })).status, 200);
  st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["PPN~I1"].qty, 10, "stock came back");
  assert.equal(st.invoices.find((x) => x.id === inv).status, "void");

  // next PPN invoice continues the numbering; Non-PPN has its own
  const inv2 = (await call("POST", "/api/invoices", { tax: "PPN", customerId: cid })).body.id;
  await call("PUT", `/api/invoices/${inv2}`, { lines: [{ itemKey: "PPN~I1", qty: 1, price: 1000 }] });
  assert.equal(Number((await call("POST", `/api/invoices/${inv2}/issue`)).body.number.slice(-4)), firstSeq + 1, "numbering continues");
  const inv3 = (await call("POST", "/api/invoices", { tax: "NON", customerId: cid })).body.id;
  await call("PUT", `/api/invoices/${inv3}`, { lines: [{ itemKey: "NON~N1", qty: 1, price: 80 }] });
  r = await call("POST", `/api/invoices/${inv3}/issue`);
  assert.match(r.body.number, /^AMB\/\d{4}\/\d{2}\/0001$/);
  assert.equal(r.body.total, 80, "no PPN on Non-PPN");
  assert.equal((await call("DELETE", `/api/invoices/${inv3}`)).status, 409, "issued invoices can't be deleted");
  assert.equal((await call("DELETE", `/api/customers/${cid}`)).status, 409, "customer with invoices can't be deleted");
});

test("settings: entities, prefixes, and saving the stock model keeps them", async () => {
  let s = (await call("GET", "/api/state")).body.settings;
  assert.deepEqual([s.ent.PPN.name, s.ent.PPN.prefix, s.ent.NON.prefix], ["CV. Hashiru Motorindo", "HM", "AMB"]);
  assert.equal((await call("PUT", "/api/settings/invoicing", { invoiceTerms: 14, ent: { PPN: { name: "A", prefix: "X" }, NON: { name: "B", prefix: "x" } } })).status, 400, "prefixes must differ");
  await call("PUT", "/api/settings/invoicing", { invoiceTerms: 14, footer: "Thank you", ent: { PPN: { name: "CV Hashiru", prefix: "hm", npwp: "0123" }, NON: { name: "Amasan", prefix: "AMB" } } });
  await call("PUT", "/api/settings", { ppnRate: 11, leadTime: 30, priceMode: "excl", reviewDays: 30, serviceLevel: 95, windowMonths: 12 });
  s = (await call("GET", "/api/state")).body.settings;
  assert.equal(s.ent.PPN.name, "CV Hashiru");
  assert.equal(s.ent.PPN.prefix, "HM");
  assert.equal(s.footer, "Thank you");
  assert.equal(s.invoiceTerms, 14);
  assert.equal(s.leadTime, 30);
  assert.equal(s.ppnStyle, "flat", "PPN 11% unless switched");
  assert.equal((await call("PUT", "/api/settings", { ...s, ppnStyle: "coretax?" })).status, 400);
  await call("PUT", "/api/settings", { ...s, ppnStyle: "dpp-lain" });
  assert.equal((await call("GET", "/api/state")).body.settings.ppnStyle, "dpp-lain");
});

test("backup: owners get every record; staff are refused", async () => {
  const r = await call("GET", "/api/backup");
  assert.equal(r.status, 200);
  for (const k of ["items", "customers", "suppliers", "invoices", "invoiceLines", "invoicePays", "pos", "poLines", "supplierPays", "moves"]) assert.ok(Array.isArray(r.body[k]), k);
  assert.ok(r.body.items.length > 0 && r.body.moves.length > 0);
  assert.ok(r.body.poLines.every((l) => l.po_number), "lines carry their PO number");
  await call("POST", "/api/users", { name: "Staff", username: "bk-staff", password: "staff password", role: "staff" });
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "erp" }, body: JSON.stringify({ username: "bk-staff", password: "staff password" }) });
  const staff = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await call("GET", "/api/backup", undefined, staff)).status, 403);
});

test("expenses: per entity and month, recurring copy, salaries refused", async () => {
  assert.equal((await call("POST", "/api/expenses", { ledger: "PPN", date: "2026-01-31", category: "Salaries", amount: 5 })).status, 400, "salaries go through payroll");
  assert.equal((await call("POST", "/api/expenses", { ledger: "PPN", date: "2026-01-31", category: "Rent", amount: 0 })).status, 400);
  const rent = (await call("POST", "/api/expenses", { ledger: "PPN", date: "2026-01-31", category: "Rent", description: "Shop", amount: 4000000, recurring: true })).body.id;
  await call("POST", "/api/expenses", { ledger: "NON", date: "2026-01-10", category: "Fuel", amount: 150000 });
  let r = await call("POST", "/api/expenses/copy-recurring", { month: "2026-02" });
  assert.deepEqual(r.body, { copied: 1, found: 1 });
  r = await call("POST", "/api/expenses/copy-recurring", { month: "2026-02" });
  assert.equal(r.body.copied, 0, "copying twice adds nothing");
  const st = (await call("GET", "/api/state")).body;
  const feb = st.expenses.filter((e) => e.date.startsWith("2026-02"));
  assert.equal(feb.length, 1);
  assert.equal(feb[0].date, "2026-02-28", "31 Jan becomes the last day of February");
  assert.equal(feb[0].sourceId, rent);
  assert.equal((await call("PUT", `/api/expenses/${feb[0].id}`, { ...feb[0], amount: 4200000 })).status, 200);
  assert.equal((await call("DELETE", `/api/expenses/${feb[0].id}`)).status, 200);
});

test("employees and payroll: one payment per month, run for all, history kept", async () => {
  assert.equal((await call("POST", "/api/employees", { name: "", ledger: "PPN" })).status, 400);
  const a = (await call("POST", "/api/employees", { name: "Budi", position: "Gudang", ledger: "PPN", baseSalary: 4000000, allowance: 500000 })).body.id;
  const b = (await call("POST", "/api/employees", { name: "Sari", ledger: "NON", baseSalary: 3500000 })).body.id;
  await call("POST", "/api/employees", { name: "Old", ledger: "NON", baseSalary: 3000000, active: false });
  let r = await call("POST", "/api/payroll", { employeeId: a, period: "2026-03", date: "2026-03-28", bonus: 250000, deduction: 100000 });
  assert.equal(r.status, 200);
  assert.equal((await call("POST", "/api/payroll", { employeeId: a, period: "2026-03" })).status, 409, "already paid this month");
  assert.equal((await call("POST", "/api/payroll", { employeeId: a, period: "2026-04", deduction: 9e9 })).status, 400);
  r = await call("POST", "/api/payroll/run", { period: "2026-03", date: "2026-03-28" });
  assert.deepEqual(r.body, { paid: 1, total: 3500000 }, "only Sari was unpaid; inactive staff are skipped");
  assert.equal((await call("POST", "/api/payroll/run", { period: "2026-03" })).status, 400);
  const st = (await call("GET", "/api/state")).body;
  const mar = st.salaries.filter((p) => p.period === "2026-03");
  assert.equal(mar.find((p) => p.employeeId === a).net, 4000000 + 500000 + 250000 - 100000);
  assert.equal(mar.find((p) => p.employeeId === b).ledger, "NON");
  // A raise later doesn't change what was paid.
  await call("PUT", `/api/employees/${a}`, { name: "Budi", ledger: "PPN", baseSalary: 5000000 });
  assert.equal((await call("GET", "/api/state")).body.salaries.find((p) => p.employeeId === a && p.period === "2026-03").base, 4000000);
  assert.equal((await call("DELETE", `/api/employees/${a}`)).status, 409, "employees with salary history are kept");
  // Staff see none of it and can't change it.
  await call("POST", "/api/users", { name: "Staff2", username: "pay-staff", password: "staff password", role: "staff" });
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "erp" }, body: JSON.stringify({ username: "pay-staff", password: "staff password" }) });
  const staff = login.headers.get("set-cookie").split(";")[0];
  const sst = (await call("GET", "/api/state", undefined, staff)).body;
  assert.deepEqual([sst.expenses.length, sst.employees.length, sst.salaries.length], [0, 0, 0]);
  assert.equal((await call("POST", "/api/expenses", { ledger: "PPN", date: "2026-03-01", category: "Rent", amount: 1 }, staff)).status, 403);
  assert.equal((await call("POST", "/api/payroll/run", { period: "2026-05" }, staff)).status, 403);
});

test("unknown API routes return JSON 404", async () => {
  assert.equal((await call("GET", "/api/nope")).status, 404);
});
