// Formula engine for alert and column rules. Parses to an AST and evaluates it without eval().

export const FUN = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  sqrt: Math.sqrt,
  round: (x, d = 0) => {
    const p = 10 ** d;
    return Math.round(x * p) / p;
  },
};

export function tokenize(src) {
  const t = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      const v = Number(src.slice(i, j).replace(/_/g, ""));
      if (!Number.isFinite(v)) throw Error("Bad number near " + src.slice(i, j));
      t.push({ t: "n", v });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j).toLowerCase();
      if (w === "and") t.push({ t: "o", v: "&&" });
      else if (w === "or") t.push({ t: "o", v: "||" });
      else if (w === "not") t.push({ t: "o", v: "!" });
      else if (w === "true") t.push({ t: "n", v: 1 });
      else if (w === "false") t.push({ t: "n", v: 0 });
      else t.push({ t: "i", v: w });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if ([">=", "<=", "==", "!=", "&&", "||", "<>"].includes(two)) {
      t.push({ t: "o", v: two === "<>" ? "!=" : two });
      i += 2;
      continue;
    }
    if ("+-*/%^<>!(),=".includes(c)) {
      t.push({ t: "o", v: c === "=" ? "==" : c });
      i++;
      continue;
    }
    throw Error("Unexpected character '" + c + "'");
  }
  return t;
}

export function parse(src) {
  const tk = tokenize(src);
  let p = 0;
  const is = (v) => tk[p] && tk[p].t === "o" && tk[p].v === v;
  const eat = (v) => {
    if (!is(v)) throw Error("Expected '" + v + "'");
    p++;
  };
  const bin = (next, ops) => () => {
    let l = next();
    while (tk[p] && tk[p].t === "o" && ops.includes(tk[p].v)) {
      const op = tk[p++].v;
      l = { k: "b", op, l, r: next() };
    }
    return l;
  };
  const unary = () => {
    if (is("-")) { p++; return { k: "u", op: "-", a: unary() }; }
    if (is("+")) { p++; return unary(); }
    if (is("!")) { p++; return { k: "u", op: "!", a: unary() }; }
    return power();
  };
  const power = () => {
    const b = prim();
    if (is("^")) { p++; return { k: "b", op: "^", l: b, r: unary() }; }
    return b;
  };
  const mul = bin(unary, ["*", "/", "%"]);
  const add = bin(mul, ["+", "-"]);
  const cmp = bin(add, ["<", "<=", ">", ">=", "==", "!="]);
  const and = bin(cmp, ["&&"]);
  const or = bin(and, ["||"]);
  function prim() {
    const x = tk[p];
    if (!x) throw Error("Formula ends too early");
    if (x.t === "n") { p++; return { k: "n", v: x.v }; }
    if (x.t === "i") {
      p++;
      if (is("(")) {
        p++;
        const args = [];
        if (!is(")")) {
          args.push(or());
          while (is(",")) { p++; args.push(or()); }
        }
        eat(")");
        if (x.v !== "if" && !FUN[x.v]) throw Error("Unknown function " + x.v + "()");
        if (x.v === "if" && args.length !== 3) throw Error("if() needs 3 parts: if(condition, then, else)");
        return { k: "f", n: x.v, args };
      }
      return { k: "v", n: x.v };
    }
    if (is("(")) {
      p++;
      const e = or();
      eat(")");
      return e;
    }
    throw Error("Unexpected '" + x.v + "'");
  }
  const ast = or();
  if (p < tk.length) throw Error("Unexpected '" + tk[p].v + "'");
  return ast;
}

export function evalAst(a, V) {
  switch (a.k) {
    case "n":
      return a.v;
    case "v":
      if (!Object.prototype.hasOwnProperty.call(V, a.n)) throw Error("Unknown variable " + a.n);
      return V[a.n];
    case "u": {
      const x = evalAst(a.a, V);
      return a.op === "-" ? -x : x ? 0 : 1;
    }
    case "f":
      if (a.n === "if") return evalAst(a.args[0], V) ? evalAst(a.args[1], V) : evalAst(a.args[2], V);
      return FUN[a.n](...a.args.map((x) => evalAst(x, V)));
    case "b": {
      if (a.op === "&&") return evalAst(a.l, V) && evalAst(a.r, V) ? 1 : 0;
      if (a.op === "||") return evalAst(a.l, V) || evalAst(a.r, V) ? 1 : 0;
      const l = evalAst(a.l, V);
      const r = evalAst(a.r, V);
      switch (a.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return r === 0 ? 0 : l / r;
        case "%": return r === 0 ? 0 : l % r;
        case "^": return l ** r;
        case "<": return +(l < r);
        case "<=": return +(l <= r);
        case ">": return +(l > r);
        case ">=": return +(l >= r);
        case "==": return +(l === r);
        case "!=": return +(l !== r);
      }
    }
  }
  throw Error("Bad formula");
}

/** Variables available to every formula, with the description shown on the Formulas page. */
export const VARS = [
  ["qty", "Quantity on hand"],
  ["price", "Price as stored (Rp)"],
  ["price_excl", "Price excluding PPN"],
  ["price_incl", "Price including PPN (Non-PPN items: same as price)"],
  ["value", "qty × price_excl"],
  ["min_stock", "Minimum stock set on the item"],
  ["is_ppn", "1 if PPN ledger, else 0"],
  ["is_set", "1 if unit is SET, else 0"],
  ["ppn_rate", "Effective PPN rate, e.g. 11"],
  ["lead_time", "Supplier lead time in days"],
  ["in_30", "Units received, last 30 days"],
  ["out_30", "Units out, last 30 days"],
  ["avg_daily_out", "out_30 ÷ 30 (from Stock moves)"],
  ["hist_months", "Months of uploaded sales history used"],
  ["stockout_months", "Months left out because stock was zero"],
  ["avg_monthly_demand", "Average monthly sales from uploaded reports"],
  ["sd_monthly_demand", "Standard deviation of monthly sales"],
  ["avg_daily_demand", "avg_monthly_demand ÷ 30.4"],
  ["review_period", "Days between stock checks (from settings)"],
  ["service_z", "Z for the service level, e.g. 1.645 at 95%"],
  ["safety_stock", "Z × σ × √((lead_time + review_period) ÷ 30.4), rounded up"],
  ["reorder_point", "avg_daily_demand × (lead_time + review_period) + safety_stock"],
  ["order_up_to", "avg_daily_demand × (lead_time + 2 × review_period) + safety_stock"],
  ["on_order", "Still to arrive on sent purchase orders"],
  ["inventory_position", "qty + on_order"],
  ["suggested_order", "order_up_to − inventory_position when that is below reorder_point, else 0"],
  ["mixed_units", "1 if this SKU also sold in the other unit (PCS vs SET)"],
  ["days_cover", "qty ÷ daily sales (report history, else Stock moves; 9999 if none)"],
];

/** Name under which a column rule's value is exposed to later formulas. */
export const colVar = (name) =>
  "col_" + String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
