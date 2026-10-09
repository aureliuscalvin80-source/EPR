import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import { hashPassword, verifyPassword, makeSetupCode } from "../server/auth.js";

let server, base, app, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-auth-"));
  app = createApp({ dataDir: dir, setupCode: "ABCD-EFGH" });
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  app.locals.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, body, jar = "", extra = {}) {
  const headers = { "X-Requested-With": "erp", ...extra };
  if (jar) headers.Cookie = jar;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie");
  return { status: res.status, body: await res.json(), cookie: sc ? sc.split(";")[0] : null, rawCookie: sc };
}
const login = async (username, password) => (await call("POST", "/api/auth/login", { username, password })).cookie;

test("password hashing", async () => {
  const h = await hashPassword("s3cret-pass");
  assert.match(h, /^scrypt\$/);
  assert.equal(await verifyPassword("s3cret-pass", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
  assert.match(makeSetupCode(), /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

let admin, staff, viewer, staffId;

test("first run: setup needs the code, then can't be repeated", async () => {
  assert.equal((await call("GET", "/api/state")).status, 401);
  assert.deepEqual((await call("GET", "/api/auth/status")).body, { setup: true });
  assert.equal((await call("POST", "/api/auth/setup", { code: "WRONG-CODE", username: "boss", password: "long enough" })).status, 403);
  assert.equal((await call("POST", "/api/auth/setup", { code: "abcd-efgh", username: "boss", password: "short" })).status, 400);
  const r = await call("POST", "/api/auth/setup", { code: "abcd-efgh", username: "Boss", name: "The Boss", password: "long enough" });
  assert.equal(r.status, 200);
  assert.match(r.rawCookie, /HttpOnly/i);
  assert.match(r.rawCookie, /SameSite=Strict/i);
  admin = r.cookie;
  assert.equal((await call("GET", "/api/me", null, admin)).body.username, "boss");
  assert.equal((await call("POST", "/api/auth/setup", { code: "ABCD-EFGH", username: "x2x", password: "long enough" })).status, 409);
  assert.deepEqual((await call("GET", "/api/auth/status")).body, { setup: false });
});

test("writes without the X-Requested-With header are refused (CSRF)", async () => {
  const res = await fetch(base + "/api/suppliers", { method: "POST", headers: { Cookie: admin, "Content-Type": "application/json" }, body: JSON.stringify({ company: "X", email: "a@b.co" }) });
  assert.equal(res.status, 403);
});

test("admin manages users; roles limit what each can do", async () => {
  let r = await call("POST", "/api/users", { username: "staff1", name: "Sam Staff", role: "staff", password: "staffpass1" }, admin);
  assert.equal(r.status, 200);
  staffId = r.body.id;
  await call("POST", "/api/users", { username: "view1", name: "Vic Viewer", role: "viewer", password: "viewpass1" }, admin);
  assert.equal((await call("POST", "/api/users", { username: "staff1", role: "staff", password: "whatever12" }, admin)).status, 409);
  staff = await login("staff1", "staffpass1");
  viewer = await login("VIEW1", "viewpass1");
  assert.ok(staff && viewer);

  // viewer: read only
  assert.equal((await call("GET", "/api/state", null, viewer)).status, 200);
  assert.equal((await call("POST", "/api/items", { sku: "V1", tax: "PPN", name: "x" }, viewer)).status, 403);
  // staff: day-to-day work, but not admin things
  assert.equal((await call("POST", "/api/items", { sku: "S1", tax: "PPN", name: "Staff item", qty: 1 }, staff)).status, 200);
  assert.equal((await call("POST", "/api/moves", { key: "PPN~S1", type: "IN", qty: 2 }, staff)).status, 200);
  assert.equal((await call("DELETE", "/api/items/" + encodeURIComponent("PPN~S1"), null, staff)).status, 403);
  assert.equal((await call("PUT", "/api/settings", { ppnRate: 12, leadTime: 1, priceMode: "excl", reviewDays: 1 }, staff)).status, 403);
  assert.equal((await call("GET", "/api/users", null, staff)).status, 403);
  const st = (await call("GET", "/api/state", null, admin)).body;
  assert.equal(st.moves.find((m) => m.sku === "S1").by, "Sam Staff");
});

test("wrong passwords lock the login for that user after 5 tries", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/auth/login", { username: "view1", password: "nope" })).status, 401);
  const r = await call("POST", "/api/auth/login", { username: "view1", password: "viewpass1" });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Too many/);
  // unknown users get the same message as a wrong password
  assert.equal((await call("POST", "/api/auth/login", { username: "ghost", password: "x" })).body.error, "Wrong username or password.");
});

test("switching a user off ends their sessions; the last admin is protected", async () => {
  assert.equal((await call("PUT", `/api/users/${staffId}`, { active: false }, admin)).status, 200);
  assert.equal((await call("GET", "/api/me", null, staff)).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { username: "staff1", password: "staffpass1" })).status, 401);
  const me = (await call("GET", "/api/me", null, admin)).body;
  const r = await call("PUT", `/api/users/${me.id}`, { role: "staff" }, admin);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /at least one active admin/);
});

test("changing your own password keeps this session and ends the others", async () => {
  const other = await login("boss", "long enough");
  assert.equal((await call("PUT", "/api/me/password", { current: "bad", password: "a new password" }, admin)).status, 400);
  assert.equal((await call("PUT", "/api/me/password", { current: "long enough", password: "a new password" }, admin)).status, 200);
  assert.equal((await call("GET", "/api/me", null, admin)).status, 200);
  assert.equal((await call("GET", "/api/me", null, other)).status, 401);
  assert.ok(await login("boss", "a new password"));
});

test("logout ends the session", async () => {
  const c = await login("boss", "a new password");
  assert.equal((await call("POST", "/api/auth/logout", null, c)).status, 200);
  assert.equal((await call("GET", "/api/me", null, c)).status, 401);
});
