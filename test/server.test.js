import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";

let server, base, app, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-test-"));
  app = createApp({ dataDir: dir });
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  app.locals.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
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
  const up = await fetch(`${base}/api/files?name=stock.xlsx&kind=stock&tax=PPN&ym=2025-03`, { method: "POST", body: Buffer.from("fake") });
  const { id } = await up.json();
  assert.ok(id);
  const raw = await fetch(`${base}/api/files/${id}/raw`);
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

test("unknown API routes return JSON 404", async () => {
  assert.equal((await call("GET", "/api/nope")).status, 404);
});
