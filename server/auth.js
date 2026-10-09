// Accounts, sessions and permissions.
//
// Passwords are hashed with scrypt. A session is a random token in an HttpOnly, SameSite=Strict cookie;
// the database only stores its SHA-256, so a copy of the database can't be used to log in.
// The first admin is created through a setup page that needs a one-time code printed in the server log,
// so nobody else on the network can claim the account before you do.

import express from "express";
import { randomBytes, randomUUID, scrypt as scryptCb, createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { tx } from "./db.js";
import { HttpError } from "./http.js";
import { str, oneOf } from "./validate.js";

const scrypt = promisify(scryptCb);
const COOKIE = "erp_sid";
const SESSION_DAYS = 14;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
export const ROLES = ["viewer", "staff", "admin"];
const RANK = { viewer: 0, staff: 1, admin: 2 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export async function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored).split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(got, expected);
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Easy-to-type one-time code, e.g. "K7QM-3XPD" (no 0/O, 1/I). */
export function makeSetupCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = randomBytes(8);
  const c = [...b].map((x) => A[x % A.length]).join("");
  return c.slice(0, 4) + "-" + c.slice(4);
}

function usernameIn(v) {
  const u = str(v, 64).toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw new HttpError(400, "Username must be 3–32 characters: letters, numbers, dot, dash or underscore.");
  return u;
}
function passwordIn(v) {
  const p = String(v ?? "");
  if (p.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
  if (p.length > 200) throw new HttpError(400, "Password is too long.");
  return p;
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const userOut = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, createdAt: u.created_at });

export function createAuth(db, { setupCode, secureCookies = false, onUserRevoked = () => {} }) {
  const fails = new Map(); // `${ip}|${username}` → { n, until }

  const cookieOpts = (req) => ({
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookies || req.secure,
    path: "/",
    maxAge: SESSION_DAYS * 864e5,
  });
  function startSession(req, res, userId) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
    db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), userId, now, now + SESSION_DAYS * 864e5);
    res.cookie(COOKIE, token, cookieOpts(req));
  }
  const userCount = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
  function revoke(userId, exceptSessionId = null) {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?").run(userId, exceptSessionId);
    onUserRevoked(userId, exceptSessionId);
  }

  /** Sets req.user and req.sessionId from the cookie, or answers 401. */
  function authenticate(req, res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const id = sha256(token);
      const row = db.prepare(`SELECT s.id AS sid, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ? AND u.active = 1`).get(id, Date.now());
      if (row) {
        // Sliding expiry, refreshed at most once a day.
        const fresh = Date.now() + SESSION_DAYS * 864e5;
        if (fresh - row.expires_at > 864e5) {
          db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(fresh, id);
          res.cookie(COOKIE, token, cookieOpts(req));
        }
        req.user = userOut(row);
        req.sessionId = id;
        return next();
      }
    }
    res.status(401).json({ error: "Please sign in." });
  }

  /** Allow the request only for this role or higher. */
  const need = (role) => (req, res, next) => {
    if (RANK[req.user?.role] >= RANK[role]) return next();
    res.status(403).json({ error: role === "admin" ? "Only an admin can do this." : "Your account can only view, not change." });
  };

  // ---------- public routes: status, first-run setup, login, logout ----------
  const pub = express.Router();
  const json = express.json({ limit: "20kb" });
  pub.get("/status", (req, res) => res.json({ setup: userCount() === 0 }));

  pub.post("/setup", json, async (req, res, next) => {
    try {
      if (userCount() > 0) throw new HttpError(409, "Setup is already done. Sign in instead.");
      if (str(req.body.code, 20).toUpperCase() !== setupCode) throw new HttpError(403, "That setup code is wrong. It is printed in the window where the server is running.");
      const username = usernameIn(req.body.username);
      const name = str(req.body.name, 100) || username;
      const hash = await hashPassword(passwordIn(req.body.password));
      const id = randomUUID();
      const now = Date.now();
      tx(db, () => {
        if (userCount() > 0) throw new HttpError(409, "Setup is already done. Sign in instead.");
        db.prepare("INSERT INTO users (id, username, name, role, password_hash, active, created_at, updated_at) VALUES (?, ?, ?, 'admin', ?, 1, ?, ?)").run(id, username, name, hash, now, now);
      });
      startSession(req, res, id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  pub.post("/login", json, async (req, res, next) => {
    try {
      const username = str(req.body.username, 64).toLowerCase();
      const k = `${req.ip}|${username}`;
      const f = fails.get(k);
      if (f && f.until > Date.now()) {
        throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minutes.`);
      }
      const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
      // Hash even for unknown users so response time doesn't reveal which usernames exist.
      const ok = u ? await verifyPassword(String(req.body.password ?? ""), u.password_hash) : (await hashPassword("x"), false);
      if (!ok || !u.active) {
        const n = (f && f.until <= Date.now() && f.n >= MAX_FAILS ? 0 : f?.n || 0) + 1;
        if (fails.size > 10000) for (const [key, v] of fails) if (v.until < Date.now()) fails.delete(key); // keep memory bounded
        fails.set(k, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
        throw new HttpError(401, ok && !u.active ? "This account is switched off. Ask an admin." : "Wrong username or password.");
      }
      fails.delete(k);
      startSession(req, res, u.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  pub.post("/logout", (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(sha256(token));
    res.clearCookie(COOKIE, { ...cookieOpts(req), maxAge: undefined });
    res.json({ ok: true });
  });

  // ---------- signed-in routes: me, own password, user management ----------
  const priv = express.Router();
  priv.get("/me", (req, res) => res.json(req.user));
  priv.put("/me/password", json, async (req, res, next) => {
    try {
      const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
      if (!(await verifyPassword(String(req.body.current ?? ""), u.password_hash))) throw new HttpError(400, "Your current password is wrong.");
      const hash = await hashPassword(passwordIn(req.body.password));
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hash, Date.now(), u.id);
      revoke(u.id, req.sessionId); // sign out everywhere else
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  priv.get("/users", need("admin"), (req, res) => {
    res.json(db.prepare("SELECT * FROM users ORDER BY name COLLATE NOCASE").all().map(userOut));
  });
  priv.post("/users", need("admin"), json, async (req, res, next) => {
    try {
      const username = usernameIn(req.body.username);
      if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw new HttpError(409, `The username ${username} is already taken.`);
      const role = oneOf(req.body.role, ROLES, "Role");
      const hash = await hashPassword(passwordIn(req.body.password));
      const id = randomUUID();
      const now = Date.now();
      db.prepare("INSERT INTO users (id, username, name, role, password_hash, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
        .run(id, username, str(req.body.name, 100) || username, role, hash, now, now);
      res.json({ id });
    } catch (e) {
      next(e);
    }
  });
  priv.put("/users/:id", need("admin"), json, async (req, res, next) => {
    try {
      const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
      if (!u) throw new HttpError(404, "This user no longer exists.");
      const role = oneOf(req.body.role ?? u.role, ROLES, "Role");
      const active = req.body.active === undefined ? !!u.active : !!req.body.active;
      const name = str(req.body.name ?? u.name, 100) || u.username;
      const hash = req.body.password ? await hashPassword(passwordIn(req.body.password)) : null;
      tx(db, () => {
        db.prepare("UPDATE users SET name = ?, role = ?, active = ?, password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?")
          .run(name, role, active ? 1 : 0, hash, Date.now(), u.id);
        if (activeAdmins() === 0) throw new HttpError(409, "There must always be at least one active admin.");
      });
      // Switching an account off, changing its role or resetting its password signs it out.
      if (!active || hash || role !== u.role) revoke(u.id, u.id === req.user.id ? req.sessionId : null);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return { pub, priv, authenticate, need, userCount };
}
