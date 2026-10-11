// Request validation. Each function returns clean values or throws an HttpError with a message for the user.

import { HttpError } from "./http.js";
import { parse } from "../public/js/formula.js";

export const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);
export function numIn(v, label, { min = -Infinity } = {}) {
  const n = v === "" || v == null ? 0 : Number(v);
  if (!Number.isFinite(n) || n < min) throw new HttpError(400, `${label} must be a number${min === 0 ? " of 0 or more" : ""}.`);
  return n;
}
export const oneOf = (v, allowed, label) => {
  if (!allowed.includes(v)) throw new HttpError(400, `${label} must be one of ${allowed.join(", ")}.`);
  return v;
};
export function itemFields(b) {
  return {
    name: str(b.name),
    unit: oneOf(b.unit ?? "PCS", ["PCS", "SET"], "Unit"),
    qty: numIn(b.qty, "Quantity"),
    cost: numIn(b.cost ?? b.price, "Cost", { min: 0 }),
    price: numIn(b.cost ?? b.price, "Cost", { min: 0 }),
    minStock: numIn(b.minStock, "Min stock", { min: 0 }),
    sellPrice: numIn(b.sellPrice, "Selling price", { min: 0 }),
    moq: numIn(b.moq, "Minimum order quantity", { min: 0 }),
    lot: numIn(b.lot, "Order multiple", { min: 0 }),
  };
}
export function ruleFields(b) {
  const r = {
    name: str(b.name, 120),
    kind: oneOf(b.kind, ["alert", "column"], "Type"),
    scope: oneOf(b.scope ?? "ALL", ["ALL", "PPN", "NON"], "Applies to"),
    severity: oneOf(b.severity ?? "warn", ["warn", "crit"], "Severity"),
    expr: str(b.expr, 2000),
  };
  if (!r.name) throw new HttpError(400, "Give the formula a name.");
  try {
    parse(r.expr);
  } catch (e) {
    throw new HttpError(400, "Formula error: " + e.message);
  }
  return r;
}

export const CHANNELS = ["whatsapp", "wechat", "email", "phone"];
export const CURRENCIES = ["IDR", "CNY", "USD"];
/** Payment terms in days; empty means "use the default". */
export function termsIn(v) {
  if (v === "" || v == null) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 365) throw new HttpError(400, "Payment terms must be 0–365 days.");
  return n;
}
export function supplierFields(b) {
  const f = {
    company: str(b.company, 200),
    contact: str(b.contact, 200),
    wechat: str(b.wechat, 100),
    whatsapp: str(b.whatsapp, 40),
    email: str(b.email, 200),
    phone: str(b.phone, 40),
    preferred: oneOf(b.preferred ?? "", ["", ...CHANNELS], "Preferred channel"),
    notes: str(b.notes, 2000),
    currency: oneOf(b.currency || "IDR", CURRENCIES, "Currency"),
    terms: termsIn(b.terms),
    npwp: str(b.npwp, 40),
    address: str(b.address, 1000),
  };
  if (!f.company) throw new HttpError(400, "Supplier name is required.");
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) throw new HttpError(400, "That email address doesn't look right.");
  for (const c of ["whatsapp", "phone"]) {
    if (f[c] && !/^\+?[\d\s().-]{6,}$/.test(f[c])) throw new HttpError(400, `${c === "phone" ? "Telephone" : "WhatsApp"} number can only contain digits, spaces, +, -, ( and ).`);
  }
  if (f.preferred && !f[f.preferred]) throw new HttpError(400, "The preferred channel has no contact details filled in.");
  return f;
}
