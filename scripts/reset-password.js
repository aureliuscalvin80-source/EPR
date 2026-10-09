// Emergency access: sets a new random password for a user, switches the account on and signs it out everywhere.
// Usage: npm run reset-password -- <username>
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openDb } from "../server/db.js";
import { hashPassword } from "../server/auth.js";

const username = String(process.argv[2] || "").toLowerCase();
const db = openDb(path.join(path.resolve(process.env.DATA_DIR || "data"), "erp.sqlite"));
const users = db.prepare("SELECT username, role FROM users ORDER BY username").all();
const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
if (!u) {
  console.error(username ? `No user called "${username}".` : "Give a username: npm run reset-password -- <username>");
  console.error("Users: " + (users.map((x) => `${x.username} (${x.role})`).join(", ") || "none yet — start the app to create the admin."));
  process.exit(1);
}
const password = randomBytes(9).toString("base64url");
db.prepare("UPDATE users SET password_hash = ?, active = 1, updated_at = ? WHERE id = ?").run(await hashPassword(password), Date.now(), u.id);
db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
db.close();
console.log(`New password for ${u.username}: ${password}\nSign in with it, then change it under your name → Change password.`);
