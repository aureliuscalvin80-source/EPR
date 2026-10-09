// Small formatting and helper functions shared by the browser app, the server and the tests.

export const fmtRp = (n) => (Number.isFinite(n) ? "Rp " + Math.round(n).toLocaleString("id-ID") : "—");

export const fmtN = (n) => (Number.isFinite(n) ? (Math.round(n * 100) / 100).toLocaleString("id-ID") : "—");

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** Items are unique per ledger: the same SKU can exist once in PPN and once in Non-PPN. */
export const keyOf = (tax, sku) => tax + "~" + sku;

export const taxLabel = (tax) => (tax === "PPN" ? "PPN" : "Non-PPN");

export function today(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
