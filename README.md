# Sparepart ERP

Spare-part inventory system with separate **PPN** and **Non-PPN** ledgers. It is a standalone rebuild of the *Sparepart Stock Ledger* Claude artifact (the original is kept in `legacy/`), with its own server and database and a softer, white-first design.

![Inventory](docs/inventory.png)

![Receiving a purchase order](docs/purchase-order.png)

## Features

| Area | What it does |
|---|---|
| **Inventory** | Products by SKU and ledger, unit (PCS / SET), qty, price, min stock. Search, filters, sortable columns, paging, stock-value KPIs. |
| **Stock moves** | Book IN / OUT / ADJ. Stock is updated on the server in one transaction, so two people booking at once can't overwrite each other. OUT below zero is refused. |
| **Alerts** | Live list driven by alert formulas. Each alert shows **current stock vs reorder point** (or min stock when there is no sales history yet) and how far short it is, plus a gauge and the suggested order. Export to Excel. |
| **Reorder** | From an alert, add the item to its supplier's **draft purchase order** (one draft per supplier collects everything you need from them). No supplier yet? Assign or add one right there. |
| **Purchase orders** | Draft → **Sent** → **Partly received** → **Received** (or *Closed short* / *Cancelled*). Edit lines and prices while it's a draft, then send the whole order in one message: WhatsApp opens with the message, email opens your mail app, telephone dials, WeChat copies the message to paste. Book goods in as they arrive (partial deliveries are fine): stock goes up and an IN move is recorded automatically. Stock still to arrive counts as **on order**, so alerts and suggested quantities don't make you order the same thing twice. |
| **Users & roles** | Sign-in required. **Admin**: everything. **Staff**: products, stock moves, suppliers, orders, files; can't delete, or change formulas, settings or users. **Viewer**: read only. Stock moves record who made them. |
| **Suppliers** | Company name, person in charge, WhatsApp, WeChat ID, email, telephone, preferred channel and notes. Assign a supplier to each product; search inventory by supplier. |
| **Formulas** | Small expression language (no `eval`) for alert rules and computed columns, with live "would trigger on N items" testing. |
| **Files & reports** | Upload any file (≤ 15 MB). Hashiru sales reports, stock reports and yearly workbooks are parsed, reconciled to the report totals, and feed demand history. A coverage grid shows which months are loaded. |
| **Safety stock** | `Z × σ(monthly sales) × √((lead time + check interval) ÷ 30.4)`, plus reorder point, order-up-to and suggested order. Months blocked by a stock-out are left out. |
| **Import / export** | Import products from Excel/CSV (Indonesian number formats understood); export inventory or alerts to Excel. |
| **Live sync** | Every open browser updates when anyone saves (Server-Sent Events). |

New databases start with four formulas: *Below safety stock*, *Reorder now*, *Below min stock* and a *Suggested order* column.

## Running it

Requires **Node.js 22.5 or newer** (uses the built-in `node:sqlite`, so there is nothing to compile).

```bash
npm install
npm run seed:demo    # optional: 8 DEMO- products and 2 [Demo] suppliers to try things out
npm start            # http://127.0.0.1:3000
npm test             # unit + API tests
```

**First run:** the terminal prints a one-time **setup code**. Open the app, enter the code and create your admin account. Then add your staff under **Users**. The code is only accepted until the first admin exists, so nobody else on the network can claim the account first.

**Forgot the admin password?** On the server: `npm run reset-password -- <username>` prints a new temporary password.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` to let other computers on your network use it — **read "Security" first** |
| `COOKIE_SECURE` | off | Set `1` when the app is served over HTTPS, so the sign-in cookie is never sent unencrypted |
| `TRUST_PROXY` | off | Set `1` behind a reverse proxy (nginx, Caddy) so login rate-limiting sees real client IPs |
| `DATA_DIR` | `./data` | SQLite database (`erp.sqlite`) and uploaded files (`uploads/`) |

**Back up `DATA_DIR`.** It holds everything: the database and every uploaded file.

## Moving your data from the artifact

Only the code came over; your products, formulas and reports are still in the artifact's own storage.

1. In the artifact, **Import & settings → Export all to Excel**.
2. Here, **Import & settings → Import products** with that file. (The export's `Ledger` column is read as the tax column.)
3. Re-create any custom formulas on the **Formulas** page.
4. Re-upload your sales and stock reports on **Files & reports** to rebuild demand history.

## Project layout

```
server/        Express API + SQLite (app.js routes, db.js schema, reports.js report storage)
public/        Browser app, no build step
  js/formula.js  formula parser/evaluator      (pure, tested)
  js/stock.js    demand stats, safety stock    (pure, tested)
  js/reports.js  Hashiru report readers        (pure, tested)
  js/app.js      UI
scripts/       seed-demo.js
test/          node:test suites
legacy/        the original single-file artifact
```

## Security and known limits

- **Sign-in.** Passwords are hashed with scrypt; sessions are random tokens in an HttpOnly, SameSite=Strict cookie (only their hash is stored); 5 wrong passwords lock that username for 15 minutes from that address; writes need a header other websites can't send (CSRF protection). Switching a user off, changing their role or resetting their password signs them out everywhere at once.
- **Use HTTPS before opening it to a network.** Over plain HTTP, passwords and cookies cross the network unencrypted. Put it behind Caddy or nginx with a certificate and set `COOKIE_SECURE=1` and `TRUST_PROXY=1`. Localhost-only use (the default) doesn't need this.
- **SheetJS** is installed from SheetJS's own CDN (0.20.3), because the npm registry only has 0.18.5, which has known advisories. `npm install` therefore needs access to `cdn.sheetjs.com`.
- **Phone numbers** starting with 0 are assumed Indonesian (+62) for WhatsApp links; enter foreign numbers with + and the country code.
- **Order prices** are copied from the product price when a line is added and can be edited on the draft. They are not written back to the product.
- **Not yet built:** supplier invoices and payments, sales orders, multiple warehouses, a full audit log of every change (today only stock moves and orders record who did them), and a printable/PDF purchase order.
