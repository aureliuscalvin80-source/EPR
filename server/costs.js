// Running costs: expenses per entity and month, employees, and monthly salary payments. Owner (admin) only.

import express from "express";
import { randomUUID } from "node:crypto";
import { tx } from "./db.js";
import { HttpError } from "./http.js";
import { str, numIn, oneOf } from "./validate.js";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
export const PAY_METHODS = ["transfer", "cash", "giro", "other"];
const KEEP_MONTHS = 24;

const ymdIn = (v, label, optional = false) => {
  const s = str(v, 10);
  if (!s && optional) return "";
  if (!YMD.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `${label} must be a date.`);
  return s;
};
const ymIn = (v) => {
  const s = str(v, 7);
  if (!YM.test(s)) throw new HttpError(400, "Month must look like 2026-10.");
  return s;
};
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** The month before "2026-01" is "2025-12". */
export const prevYm = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
/** Same day in another month, kept inside that month (31 Jan → 28/29 Feb). */
export function sameDayIn(ymd, ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${ym}-${String(Math.min(+ymd.slice(8, 10), last)).padStart(2, "0")}`;
}
const cutoff = () => { const d = new Date(); d.setMonth(d.getMonth() - KEEP_MONTHS); return d.toISOString().slice(0, 7) + "-01"; };

export function expenseFields(b) {
  const f = {
    ledger: oneOf(b.ledger, ["PPN", "NON"], "Entity"),
    date: ymdIn(b.date, "Date"),
    category: str(b.category, 80),
    description: str(b.description, 300),
    amount: numIn(b.amount, "Amount", { min: 0 }),
    method: oneOf(b.method ?? "transfer", PAY_METHODS, "Paid by"),
    recurring: b.recurring ? 1 : 0,
    note: str(b.note, 1000),
  };
  if (!f.category) throw new HttpError(400, "Choose a category.");
  if (/^(salary|salaries|gaji)$/i.test(f.category)) throw new HttpError(400, "Record salaries under Employees → Payroll, so they are not counted twice.");
  if (!(f.amount > 0)) throw new HttpError(400, "Amount must be more than 0.");
  return f;
}
export function employeeFields(b) {
  const f = {
    name: str(b.name, 200),
    position: str(b.position, 120),
    ledger: oneOf(b.ledger, ["PPN", "NON"], "Employed by"),
    phone: str(b.phone, 40),
    bank: str(b.bank, 300),
    startDate: ymdIn(b.startDate, "Start date", true),
    baseSalary: numIn(b.baseSalary, "Base salary", { min: 0 }),
    allowance: numIn(b.allowance, "Fixed allowance", { min: 0 }),
    active: b.active === undefined ? 1 : b.active ? 1 : 0,
    notes: str(b.notes, 2000),
  };
  if (!f.name) throw new HttpError(400, "Employee name is required.");
  if (f.phone && !/^\+?[\d\s().-]{6,}$/.test(f.phone)) throw new HttpError(400, "Phone number can only contain digits, spaces, +, -, ( and ).");
  return f;
}

const expenseOut = (e) => ({ id: e.id, ledger: e.ledger, date: e.exp_date, category: e.category, description: e.description, amount: e.amount, method: e.method,
  recurring: !!e.recurring, sourceId: e.source_id, note: e.note, by: e.created_by });
const employeeOut = (e) => ({ id: e.id, name: e.name, position: e.position, ledger: e.ledger, phone: e.phone, bank: e.bank, startDate: e.start_date,
  baseSalary: e.base_salary, allowance: e.allowance, active: !!e.active, notes: e.notes });
const salaryOut = (p) => ({ id: p.id, employeeId: p.employee_id, period: p.period, date: p.pay_date, ledger: p.ledger, name: p.name, base: p.base, allowance: p.allowance,
  bonus: p.bonus, deduction: p.deduction, net: p.net, method: p.method, note: p.note, by: p.created_by });

export const listExpenses = (db) => db.prepare("SELECT * FROM expenses WHERE exp_date >= ? ORDER BY exp_date DESC, created_at DESC").all(cutoff()).map(expenseOut);
export const listEmployees = (db) => db.prepare("SELECT * FROM employees ORDER BY active DESC, name COLLATE NOCASE").all().map(employeeOut);
export const listSalaries = (db) => db.prepare("SELECT * FROM salary_payments WHERE period >= ? ORDER BY period DESC, name COLLATE NOCASE").all(cutoff().slice(0, 7)).map(salaryOut);

export function createCosts(db, { need, write }) {
  const expenses = express.Router();
  const employees = express.Router();
  const payroll = express.Router();
  const json = express.json({ limit: "256kb" });
  for (const r of [expenses, employees, payroll]) r.use(need("admin"));

  // ---------- expenses ----------
  const insExp = db.prepare(`INSERT INTO expenses (id, ledger, exp_date, category, description, amount, method, recurring, source_id, note, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  expenses.post("/", json, write((req) => {
    const f = expenseFields(req.body);
    const id = randomUUID(), now = Date.now();
    insExp.run(id, f.ledger, f.date, f.category, f.description, f.amount, f.method, f.recurring, null, f.note, req.user.name, now, now);
    return { id };
  }));
  expenses.put("/:id", json, write((req) => {
    const f = expenseFields(req.body);
    const r = db.prepare(`UPDATE expenses SET ledger = ?, exp_date = ?, category = ?, description = ?, amount = ?, method = ?, recurring = ?, note = ?, updated_at = ? WHERE id = ?`)
      .run(f.ledger, f.date, f.category, f.description, f.amount, f.method, f.recurring, f.note, Date.now(), req.params.id);
    if (!r.changes) throw new HttpError(404, "This expense no longer exists.");
  }));
  expenses.delete("/:id", write((req) => {
    if (!db.prepare("DELETE FROM expenses WHERE id = ?").run(req.params.id).changes) throw new HttpError(404, "This expense no longer exists.");
  }));
  // Copy last month's recurring expenses (rent, internet…) into this month, once each.
  expenses.post("/copy-recurring", json, write((req) => tx(db, () => {
    const ym = ymIn(req.body.month);
    const from = db.prepare("SELECT * FROM expenses WHERE recurring = 1 AND substr(exp_date, 1, 7) = ?").all(prevYm(ym));
    const has = db.prepare("SELECT 1 FROM expenses WHERE source_id = ? AND substr(exp_date, 1, 7) = ?");
    const now = Date.now();
    let copied = 0;
    for (const e of from) {
      if (has.get(e.id, ym)) continue;
      insExp.run(randomUUID(), e.ledger, sameDayIn(e.exp_date, ym), e.category, e.description, e.amount, e.method, 1, e.id, e.note, req.user.name, now, now);
      copied++;
    }
    return { copied, found: from.length };
  })));

  // ---------- employees ----------
  employees.post("/", json, write((req) => {
    const f = employeeFields(req.body);
    const id = randomUUID(), now = Date.now();
    db.prepare(`INSERT INTO employees (id, name, position, ledger, phone, bank, start_date, base_salary, allowance, active, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, f.name, f.position, f.ledger, f.phone, f.bank, f.startDate, f.baseSalary, f.allowance, f.active, f.notes, now, now);
    return { id };
  }));
  employees.put("/:id", json, write((req) => {
    const f = employeeFields(req.body);
    const r = db.prepare(`UPDATE employees SET name = ?, position = ?, ledger = ?, phone = ?, bank = ?, start_date = ?, base_salary = ?, allowance = ?, active = ?, notes = ?,
      updated_at = ? WHERE id = ?`)
      .run(f.name, f.position, f.ledger, f.phone, f.bank, f.startDate, f.baseSalary, f.allowance, f.active, f.notes, Date.now(), req.params.id);
    if (!r.changes) throw new HttpError(404, "This employee no longer exists.");
  }));
  employees.delete("/:id", write((req) => {
    if (db.prepare("SELECT 1 FROM salary_payments WHERE employee_id = ? LIMIT 1").get(req.params.id))
      throw new HttpError(409, "This employee has salary history, so they can't be deleted. Switch them to inactive instead.");
    if (!db.prepare("DELETE FROM employees WHERE id = ?").run(req.params.id).changes) throw new HttpError(404, "This employee no longer exists.");
  }));

  // ---------- payroll ----------
  const insPay = db.prepare(`INSERT INTO salary_payments (id, employee_id, period, pay_date, ledger, name, base, allowance, bonus, deduction, net, method, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const paid = db.prepare("SELECT 1 FROM salary_payments WHERE employee_id = ? AND period = ?");
  function pay(emp, period, b, user) {
    if (paid.get(emp.id, period)) throw new HttpError(409, `${emp.name} has already been paid for ${period}. Remove that payment first to change it.`);
    const base = numIn(b.base ?? emp.base_salary, "Base salary", { min: 0 });
    const allowance = numIn(b.allowance ?? emp.allowance, "Allowance", { min: 0 });
    const bonus = numIn(b.bonus, "Bonus / overtime", { min: 0 });
    const deduction = numIn(b.deduction, "Deductions", { min: 0 });
    const net = base + allowance + bonus - deduction;
    if (net < 0) throw new HttpError(400, `Deductions for ${emp.name} are more than the salary.`);
    if (!(net > 0)) throw new HttpError(400, `${emp.name} has no salary to pay. Set a base salary on the employee first.`);
    const id = randomUUID();
    insPay.run(id, emp.id, period, ymdIn(b.date ?? todayYmd(), "Pay date"), emp.ledger, emp.name, base, allowance, bonus, deduction, net,
      oneOf(b.method ?? "transfer", PAY_METHODS, "Paid by"), str(b.note, 500), user.name, Date.now());
    return id;
  }
  const empIn = (id) => {
    const e = db.prepare("SELECT * FROM employees WHERE id = ?").get(str(id, 100));
    if (!e) throw new HttpError(404, "This employee no longer exists.");
    return e;
  };
  payroll.post("/", json, write((req) => tx(db, () => ({ id: pay(empIn(req.body.employeeId), ymIn(req.body.period), req.body, req.user) }))));
  // Pay every active employee not yet paid for the month, at their standard salary.
  payroll.post("/run", json, write((req) => tx(db, () => {
    const period = ymIn(req.body.period);
    let n = 0, total = 0;
    for (const e of db.prepare("SELECT * FROM employees WHERE active = 1 AND base_salary + allowance > 0").all()) {
      if (paid.get(e.id, period)) continue;
      pay(e, period, { date: req.body.date, method: req.body.method }, req.user);
      n++;
      total += e.base_salary + e.allowance;
    }
    if (!n) throw new HttpError(400, `Everyone active is already paid for ${period}.`);
    return { paid: n, total };
  })));
  payroll.delete("/:id", write((req) => {
    if (!db.prepare("DELETE FROM salary_payments WHERE id = ?").run(req.params.id).changes) throw new HttpError(404, "This salary payment no longer exists.");
  }));

  return { expenses, employees, payroll };
}
