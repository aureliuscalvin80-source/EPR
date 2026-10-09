import { test } from "node:test";
import assert from "node:assert/strict";
import { waNumber, whatsappUrl, mailtoUrl, telUrl, supplierChannels, defaultOrderQty, reorderMessage } from "../public/js/contact.js";

test("waNumber converts local Indonesian and international formats", () => {
  assert.equal(waNumber("0812-3456-7890"), "6281234567890");
  assert.equal(waNumber("+62 812 3456 7890"), "6281234567890");
  assert.equal(waNumber("+86 138 0000 0000"), "8613800000000");
  assert.equal(waNumber("0086 138 0000 0000"), "8613800000000");
});

test("links encode the message", () => {
  assert.equal(whatsappUrl("0812", "a & b\nc"), "https://wa.me/62812?text=a%20%26%20b%0Ac");
  assert.equal(mailtoUrl("x@y.com", "PO: 1", "hi there"), "mailto:x%40y.com?subject=PO%3A%201&body=hi%20there");
  assert.equal(telUrl("+62 (21) 555-0123"), "tel:+62215550123");
});

test("supplierChannels lists filled channels, preferred first", () => {
  assert.deepEqual(supplierChannels({ whatsapp: "1", email: "a@b.c", wechat: "", phone: " " }), ["whatsapp", "email"]);
  assert.deepEqual(supplierChannels({ whatsapp: "1", email: "a@b.c", preferred: "email" }), ["email", "whatsapp"]);
  assert.deepEqual(supplierChannels({ whatsapp: "1", preferred: "wechat" }), ["whatsapp"]);
});

test("defaultOrderQty uses the stock model, else tops up to min stock", () => {
  assert.equal(defaultOrderQty({ suggested_order: 40, min_stock: 5, qty: 1 }), 40);
  assert.equal(defaultOrderQty({ suggested_order: 0, min_stock: 6, qty: 4 }), 2);
  assert.equal(defaultOrderQty({ suggested_order: 0, min_stock: 0, qty: 4 }), 0);
});

test("reorderMessage names the person in charge and the item", () => {
  const m = reorderMessage({ supplier: { contact: "Budi" }, item: { sku: "A1", name: "Bolt", unit: "PCS" }, qty: 12 });
  assert.match(m, /^Hello Budi,/);
  assert.match(m, /- A1 Bolt: 12 PCS/);
});
