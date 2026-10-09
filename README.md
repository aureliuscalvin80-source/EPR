# Sparepart Stock Ledger

Inventory ledger for spare parts, kept as two ledgers (PPN and Non-PPN). Originally built and published as a Claude artifact; this repository holds its source.

## Features

- **Inventory** – products by SKU, ledger (PPN / Non-PPN), unit (PCS / SET), quantity, price and minimum stock, with search, filters, sorting and paging.
- **Stock moves** – record IN / OUT / ADJ movements; the last 30 days feed `out_30` and `avg_daily_out`.
- **Alerts** – live alert list driven by user-defined formulas, with a stock gauge per item (safety stock, reorder point, suggested order).
- **Formulas** – a small expression language (no `eval`) for alert rules and computed columns.
- **Files** – upload Hashiru sales (Laporan Penjualan Detail) and stock (Persediaan Barang) reports, or yearly workbooks with one tab per month; they are reconciled to report totals and feed the demand history.
- **Safety stock** – `Z × σ(monthly sales) × √((lead time + review period) ÷ 30.4)`, with reorder point and order-up-to levels; stock-out months are excluded.
- **Import / export** – import products from Excel or CSV; export the ledger or the alerts to Excel.

## Running it

`index.html` is a single self-contained page (fonts from Google Fonts, SheetJS from cdnjs).

Storage, file uploads, downloads and user permissions come from the Claude artifact runtime (`window.claude.use("db" | "assets" | "downloads" | "user")`). Opened outside claude.ai, the page loads in **offline preview** mode: the UI renders, but nothing is saved and uploads/downloads are disabled.

To run it standalone, replace the `window.claude` calls in the boot section at the bottom of the script with your own backend (e.g. Firebase/Firestore — the `db` API used here follows the same `collection` / `doc` / `onSnapshot` shape).

## Data

Only the code is in this repository. The ledger data (products, moves, formulas, settings, uploaded reports) lives in the artifact's own storage and is not included.
