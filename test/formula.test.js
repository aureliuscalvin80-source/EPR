import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, evalAst, colVar } from "../public/js/formula.js";

const run = (src, V = {}) => evalAst(parse(src), V);

test("arithmetic follows precedence", () => {
  assert.equal(run("1 + 2 * 3"), 7);
  assert.equal(run("(1 + 2) * 3"), 9);
  assert.equal(run("2 ^ 3 ^ 2"), 512);
  assert.equal(run("-2 ^ 2"), -4);
  assert.equal(run("10 % 4"), 2);
});

test("division by zero yields 0 instead of Infinity", () => {
  assert.equal(run("5 / 0"), 0);
});

test("comparisons and logic return 1 or 0", () => {
  assert.equal(run("qty < 5 and price > 0", { qty: 3, price: 10 }), 1);
  assert.equal(run("qty < 5 and price > 0", { qty: 3, price: 0 }), 0);
  assert.equal(run("not (qty = 3)", { qty: 3 }), 0);
  assert.equal(run("qty <> 3 or true", { qty: 3 }), 1);
});

test("functions, including if()", () => {
  assert.equal(run("max(1, qty, 4)", { qty: 9 }), 9);
  assert.equal(run("round(3.14159, 2)"), 3.14);
  assert.equal(run("if(qty > 0, 100, 200)", { qty: 0 }), 200);
});

test("errors are readable", () => {
  assert.throws(() => parse("qty <"), /ends too early/);
  assert.throws(() => parse("foo(1)"), /Unknown function foo/);
  assert.throws(() => parse("if(1, 2)"), /if\(\) needs 3 parts/);
  assert.throws(() => parse("qty $ 2"), /Unexpected character/);
  assert.throws(() => run("missing + 1", {}), /Unknown variable missing/);
});

test("inherited object properties are not variables", () => {
  assert.throws(() => run("constructor", {}), /Unknown variable/);
  assert.throws(() => run("tostring", {}), /Unknown variable/);
});

test("colVar normalises column names", () => {
  assert.equal(colVar("Suggested order (PCS)"), "col_suggested_order_pcs");
});
