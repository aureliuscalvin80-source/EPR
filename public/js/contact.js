// Supplier contact links and the reorder message. Pure functions, no DOM.

export const CHANNELS = [
  ["whatsapp", "WhatsApp"],
  ["wechat", "WeChat"],
  ["email", "Email"],
  ["phone", "Telephone"],
];
export const channelLabel = (c) => (CHANNELS.find(([k]) => k === c) || [c, c])[1];

/** Channels this supplier can be reached on, preferred one first. */
export function supplierChannels(s) {
  const have = CHANNELS.map(([k]) => k).filter((k) => s && String(s[k] || "").trim());
  return s?.preferred && have.includes(s.preferred) ? [s.preferred, ...have.filter((k) => k !== s.preferred)] : have;
}

/**
 * Digits for wa.me links: international format without "+".
 * Indonesian local numbers ("0812…") are assumed to be +62.
 */
export function waNumber(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "62" + d.slice(1);
  return d;
}

export const whatsappUrl = (raw, text) => `https://wa.me/${waNumber(raw)}?text=${encodeURIComponent(text)}`;
export const mailtoUrl = (email, subject, body) =>
  `mailto:${encodeURIComponent(String(email).trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
export const telUrl = (raw) => "tel:" + String(raw || "").replace(/[^\d+]/g, "");

/** Quantity to propose: the stock model's suggestion, else enough to reach min stock. */
export function defaultOrderQty(v) {
  if (v.suggested_order > 0) return v.suggested_order;
  return Math.max(0, Math.ceil((v.min_stock || 0) - v.qty - (v.on_order || 0)));
}

/** Order message listing every line of a purchase order. */
export function poMessage({ supplier, po }) {
  const hello = supplier?.contact ? `Hello ${supplier.contact},` : "Hello,";
  const lines = po.lines.map((l) => `- ${l.sku} ${l.name}: ${l.qty} ${l.unit}`).join("\n");
  return `${hello}

Purchase order ${po.number}:
${lines}
${po.note ? "\n" + po.note + "\n" : ""}
Please confirm the price and delivery time.

Thank you.`;
}

export const poSubject = (po, company) => `Purchase order ${po.number}${company ? " – " + company : ""}`;
