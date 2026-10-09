// Adds a handful of DEMO- products and a month of stock moves so the app has something to show.
// Remove them later from Import & settings → "Remove examples".
import path from "node:path";
import { openDb, tx } from "../server/db.js";
import { randomUUID } from "node:crypto";
import { keyOf } from "../public/js/util.js";

const db = openDb(path.join(path.resolve(process.env.DATA_DIR || "data"), "erp.sqlite"));
const items = [
  ["DEMO-BRK-001", "PPN", "Brake pad set front (demo)", "SET", 4, 185000, 6],
  ["DEMO-BRK-002", "NON", "Brake shoe rear (demo)", "SET", 22, 96000, 8],
  ["DEMO-FLT-010", "PPN", "Oil filter (demo)", "PCS", 0, 42000, 20],
  ["DEMO-FLT-011", "NON", "Air filter element (demo)", "PCS", 35, 68000, 10],
  ["DEMO-BLT-020", "PPN", "V-belt 13x1050 (demo)", "PCS", 12, 54000, 5],
  ["DEMO-SPK-030", "NON", "Spark plug iridium (demo)", "PCS", 3, 89000, 12],
  ["DEMO-BRG-040", "PPN", "Wheel bearing 6205 (demo)", "PCS", 18, 47000, 6],
  ["DEMO-GKT-050", "NON", "Head gasket kit (demo)", "SET", 2, 320000, 2],
];
const now = Date.now();
// Company names start with "[Demo]" so "Remove examples" can find them.
const suppliers = [
  { id: randomUUID(), company: "[Demo] Sumber Jaya Parts", contact: "Budi Santoso", whatsapp: "0812 3456 7890", email: "sales@example.com", preferred: "whatsapp" },
  { id: randomUUID(), company: "[Demo] Guangzhou Auto Parts", contact: "Li Wei", wechat: "liwei_parts", email: "liwei@example.com", preferred: "wechat" },
];
tx(db, () => {
  db.prepare("DELETE FROM suppliers WHERE company LIKE '[Demo]%'").run();
  const sup = db.prepare("INSERT INTO suppliers (id, company, contact, wechat, whatsapp, email, phone, preferred, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', ?, '', ?, ?)");
  for (const x of suppliers) sup.run(x.id, x.company, x.contact, x.wechat || "", x.whatsapp || "", x.email, x.preferred, now, now);
  const ins = db.prepare(`INSERT INTO items (key, sku, tax, name, unit, qty, price, min_stock, supplier_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET name = excluded.name, unit = excluded.unit, qty = excluded.qty, price = excluded.price, min_stock = excluded.min_stock,
      supplier_id = excluded.supplier_id`);
  const mv = db.prepare("INSERT INTO moves (t, key, sku, tax, type, qty, note) VALUES (?, ?, ?, ?, ?, ?, ?)");
  items.forEach(([sku, tax, name, unit, qty, price, min], i) => {
    const key = keyOf(tax, sku);
    // The last product is left without a supplier to show the "assign a supplier" path.
    ins.run(key, sku, tax, name, unit, qty, price, min, i === items.length - 1 ? null : suppliers[i % 2].id, now);
    mv.run(now - (i + 2) * 864e5, key, sku, tax, "IN", 10, "Demo receipt");
    mv.run(now - (i + 1) * 3600e3, key, sku, tax, "OUT", -(i % 4 + 1), "Demo sale");
  });
});
db.close();
console.log(`Seeded ${items.length} demo products and ${suppliers.length} demo suppliers.`);
