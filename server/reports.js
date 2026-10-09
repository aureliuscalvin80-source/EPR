// Writes parsed sales and stock reports into demand history, report history and (optionally) current stock.
// The browser parses the spreadsheets; this module only stores the results, in one transaction.

import { tx } from "./db.js";
import { HttpError } from "./http.js";
import { ymLabel } from "../public/js/stock.js";
import { keyOf, taxLabel } from "../public/js/util.js";

const YM = /^\d{4}-\d{2}$/;

function cleanLines(lines) {
  if (!Array.isArray(lines)) throw new HttpError(400, "Report has no item lines.");
  return lines
    .map((l) => ({
      code: String(l?.code ?? "").trim(),
      name: String(l?.name ?? "").trim(),
      qty: Number(l?.qty),
      unit: l?.unit === "SET" ? "SET" : "PCS",
      price: Number.isFinite(Number(l?.price)) ? Number(l.price) : 0,
    }))
    .filter((l) => l.code && !l.code.includes("~") && Number.isFinite(l.qty));
}

function cleanResult(r) {
  const check = ["ok", "unverified", "mismatch", "error"].includes(r?.check) ? r.check : "unverified";
  const out = {
    fileId: String(r?.fileId ?? ""),
    histId: String(r?.histId ?? ""),
    name: String(r?.name ?? ""),
    kind: r?.kind === "sales" ? "sales" : r?.kind === "stock" ? "stock" : r?.kind === "workbook" ? "workbook" : null,
    tax: r?.tax === "PPN" || r?.tax === "NON" ? r.tax : "",
    ym: String(r?.ym ?? ""),
    check,
    msg: String(r?.msg ?? ""),
    qty: Number(r?.qty) || 0,
    rp: Number(r?.rp) || 0,
    otherUnits: String(r?.otherUnits ?? ""),
  };
  if (!out.fileId || !out.histId || !out.kind) throw new HttpError(400, "Report result is missing its file, id or kind.");
  if (check === "error") return out;
  if (out.kind === "workbook" || !out.tax || !YM.test(out.ym)) throw new HttpError(400, `Report ${out.name} has no valid ledger or month.`);
  if (out.kind === "sales") out.lines = cleanLines(r.lines);
  else out.items = cleanLines(r.items);
  return out;
}

export function applyReports(db, rawResults, setStock) {
  if (!Array.isArray(rawResults) || !rawResults.length) throw new HttpError(400, "No report results sent.");
  const results = rawResults.map(cleanResult);
  for (const r of results) {
    if (!db.prepare("SELECT 1 FROM files WHERE id = ?").get(r.fileId)) throw new HttpError(404, `File for ${r.name} no longer exists.`);
  }
  const notes = [];
  tx(db, () => {
    const now = Date.now();
    for (const r of results) {
      if (r.check === "error") continue;
      if (r.kind === "sales") {
        // A sales report replaces that ledger's demand for the month: SKUs not in it sold 0.
        const agg = new Map();
        for (const l of r.lines) {
          const a = agg.get(l.code) || { p: 0, s: 0 };
          if (l.unit === "SET") a.s += l.qty;
          else a.p += l.qty;
          agg.set(l.code, a);
        }
        db.prepare("DELETE FROM demand WHERE tax = ? AND ym = ?").run(r.tax, r.ym);
        const ins = db.prepare("INSERT INTO demand (tax, sku, ym, pcs, sets) VALUES (?, ?, ?, ?, ?)");
        for (const [sku, a] of agg) ins.run(r.tax, sku, r.ym, a.p, a.s);
        r.skus = agg.size;
      } else {
        db.prepare("DELETE FROM stock_seen WHERE tax = ? AND ym = ?").run(r.tax, r.ym);
        const ins = db.prepare("INSERT OR IGNORE INTO stock_seen (tax, sku, ym) VALUES (?, ?, ?)");
        for (const l of r.items) if (l.qty > 0) ins.run(r.tax, l.code, r.ym);
        r.skus = new Set(r.items.map((l) => l.code)).size;
      }
    }

    // Replace this batch's report history; drop entries from earlier runs of the same files that no longer apply.
    const keep = new Set(results.map((r) => r.histId));
    const del = db.prepare("DELETE FROM history WHERE id = ?");
    for (const fid of new Set(results.map((r) => r.fileId))) {
      for (const { id } of db.prepare("SELECT id FROM history WHERE file_id = ?").all(fid)) if (!keep.has(id)) del.run(id);
    }
    const up = db.prepare(`INSERT INTO history (id, file_id, file, kind, tax, ym, status, msg, lines, skus, qty, rp, other_units, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET file_id = excluded.file_id, file = excluded.file, kind = excluded.kind, tax = excluded.tax, ym = excluded.ym,
        status = excluded.status, msg = excluded.msg, lines = excluded.lines, skus = excluded.skus, qty = excluded.qty, rp = excluded.rp,
        other_units = excluded.other_units, at = excluded.at`);
    for (const r of results) {
      const lines = r.check === "error" ? null : (r.lines || r.items).length;
      up.run(r.histId, r.fileId, r.name, r.kind, r.tax, r.ym, r.check, r.msg, lines, r.skus || 0, r.qty, r.rp, r.otherUnits, now);
    }

    // Current stock from the newest reconciled stock report per ledger.
    if (!setStock) return;
    const batchFiles = [...new Set(results.map((r) => r.fileId))];
    for (const t of ["PPN", "NON"]) {
      const cand = results
        .filter((r) => r.kind === "stock" && r.tax === t && r.check !== "error")
        .sort((a, b) => b.ym.localeCompare(a.ym))[0];
      if (!cand) continue;
      const latest = db
        .prepare(`SELECT MAX(ym) AS ym FROM history WHERE kind = 'stock' AND tax = ? AND status != 'error'
          AND file_id NOT IN (SELECT value FROM json_each(?))`)
        .get(t, JSON.stringify(batchFiles))?.ym;
      if (latest && latest > cand.ym) {
        notes.push(`${taxLabel(t)} stock kept (a newer report, ${ymLabel(latest)}, exists)`);
        continue;
      }
      if (cand.check !== "ok") {
        notes.push(`${taxLabel(t)} stock not updated: report total not verified`);
        continue;
      }
      const seen = new Map();
      for (const l of cand.items) {
        const prev = seen.get(l.code);
        seen.set(l.code, prev ? { ...prev, qty: prev.qty + l.qty } : l);
      }
      const get = db.prepare("SELECT price, name FROM items WHERE key = ?");
      const insert = db.prepare("INSERT INTO items (key, sku, tax, name, unit, qty, price, min_stock, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)");
      const update = db.prepare("UPDATE items SET qty = ?, price = ?, name = CASE WHEN name = '' THEN ? ELSE name END, updated_at = ? WHERE key = ?");
      for (const [sku, l] of seen) {
        const key = keyOf(t, sku);
        const ex = get.get(key);
        if (ex) update.run(l.qty, l.price || ex.price, l.name, now, key);
        else insert.run(key, sku, t, l.name, l.unit, l.qty, l.price, now);
      }
      const untouched = db.prepare("SELECT COUNT(*) AS n FROM items WHERE tax = ?").get(t).n - seen.size;
      notes.push(`${taxLabel(t)} stock set from ${ymLabel(cand.ym)} (${seen.size} SKUs${untouched > 0 ? `; ${untouched} ledger items not in the report left unchanged` : ""})`);
    }
  });
  const ok = results.filter((r) => r.check === "ok").length;
  const bad = results.filter((r) => r.check === "error" || r.check === "mismatch").length;
  const unv = results.length - ok - bad;
  return (
    `${results.length} table(s) processed: ${ok} reconciled` +
    (unv ? `, ${unv} not verified` : "") +
    (bad ? `, ${bad} failed (see file list)` : "") +
    (notes.length ? " · " + notes.join(" · ") : "")
  );
}
