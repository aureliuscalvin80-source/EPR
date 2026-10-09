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
  assert.equal((await call("POST", "/api/moves", { key: "NON~M1", type: "IN", qty: 5 })).body.to, 7);
  assert.equal((await call("POST", "/api/moves", { key: "NON~M1", type: "OUT", qty: 3 })).body.to, 4);
  assert.equal((await call("POST", "/api/moves", { key: "NON~M1", type: "OUT", qty: 9 })).status, 409);
  assert.equal((await call("POST", "/api/moves", { key: "NON~M1", type: "ADJ", qty: 1 })).body.to, 1);
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
  let r = await call("POST", "/api/suppliers", { company: "PT Jaya", contact: "Budi" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least one way/);
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

  // Editing a product keeps the supplier it is given; importing products leaves suppliers alone.
  await call("POST", "/api/items/import", { rows: [{ sku: "S1", tax: "NON", name: "Supplied v2", qty: 3 }] });
  assert.equal((await call("GET", "/api/state")).body.items["NON~S1"].supplierId, sid);

  r = await call("DELETE", "/api/suppliers/" + sid);
  assert.equal(r.body.unassigned, 2);
  st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["NON~S1"].supplierId, "");
  assert.equal(st.suppliers.length, 0);
});

test("purchase orders: draft, merge, send, partial receipt, close", async () => {
  const sid = (await call("POST", "/api/suppliers", { company: "PO Supplier", whatsapp: "0812 1111 2222" })).body.id;
  await call("POST", "/api/items", { sku: "P1", tax: "PPN", name: "Pump", qty: 2, price: 1000, supplierId: sid });
  await call("POST", "/api/items", { sku: "P2", tax: "NON", name: "Pipe", qty: 0, price: 50, supplierId: sid });
  await call("POST", "/api/items", { sku: "P3", tax: "NON", name: "No supplier", qty: 0 });

  assert.equal((await call("POST", "/api/pos/add-line", { itemKey: "NON~P3", qty: 1 })).status, 400, "needs a supplier");
  const a = (await call("POST", "/api/pos/add-line", { itemKey: "PPN~P1", qty: 5 })).body;
  assert.equal(a.created, true);
  assert.match(a.number, /^PO-\d{4}-0001$/);
  const b = (await call("POST", "/api/pos/add-line", { itemKey: "PPN~P1", qty: 3 })).body;
  assert.equal(b.id, a.id, "goes into the same draft");
  assert.equal(b.merged, true);
  await call("POST", "/api/pos/add-line", { itemKey: "NON~P2", qty: 10 });
  let po = (await call("GET", "/api/state")).body.pos.find((p) => p.id === a.id);
  assert.deepEqual(po.lines.map((l) => [l.sku, l.qty, l.price]), [["P1", 8, 1000], ["P2", 10, 50]]);

  // edit the draft, then it can't be received before it is sent
  const lines = po.lines.map((l) => ({ itemKey: l.itemKey, qty: l.sku === "P1" ? 6 : l.qty, price: l.price }));
  assert.equal((await call("PUT", `/api/pos/${a.id}`, { lines, note: "Urgent" })).status, 200);
  assert.equal((await call("POST", `/api/pos/${a.id}/receive`, { lines: [] })).status, 409);
  assert.equal((await call("POST", `/api/pos/${a.id}/send`, { via: "whatsapp" })).status, 200);
  assert.equal((await call("PUT", `/api/pos/${a.id}`, { lines })).status, 409, "sent orders are locked");
  assert.equal((await call("DELETE", `/api/suppliers/${sid}`)).status, 409, "supplier with orders can't be deleted");

  po = (await call("GET", "/api/state")).body.pos.find((p) => p.id === a.id);
  assert.equal(po.status, "sent");
  assert.equal(po.sentVia, "whatsapp");
  assert.equal(po.note, "Urgent");
  const l1 = po.lines.find((l) => l.sku === "P1"), l2 = po.lines.find((l) => l.sku === "P2");

  let r = await call("POST", `/api/pos/${a.id}/receive`, { lines: [{ id: l1.id, qty: 7 }] });
  assert.equal(r.status, 400, "can't receive more than ordered");
  r = await call("POST", `/api/pos/${a.id}/receive`, { lines: [{ id: l1.id, qty: 6 }, { id: l2.id, qty: 4 }] });
  assert.deepEqual(r.body, { status: "partial", booked: 2 });
  let st = (await call("GET", "/api/state")).body;
  assert.equal(st.items["PPN~P1"].qty, 8);
  assert.equal(st.items["NON~P2"].qty, 4);
  const mv = st.moves.find((m) => m.sku === "P2");
  assert.equal(mv.type, "IN");
  assert.match(mv.note, /Received PO-/);

  // a new add-line now opens a fresh draft, since the first order was sent
  const c = (await call("POST", "/api/pos/add-line", { itemKey: "NON~P2", qty: 1 })).body;
  assert.notEqual(c.id, a.id);
  assert.match(c.number, /-0002$/);
  assert.equal((await call("DELETE", `/api/pos/${c.id}`)).status, 200);

  r = await call("POST", `/api/pos/${a.id}/close`);
  assert.equal(r.body.status, "closed");
  assert.equal((await call("POST", `/api/pos/${a.id}/receive`, { lines: [{ id: l2.id, qty: 1 }] })).status, 409);
});

test("unknown API routes return JSON 404", async () => {
  assert.equal((await call("GET", "/api/nope")).status, 404);
});
