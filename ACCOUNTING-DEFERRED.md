# Deferred reporting scope (by design)

The following require **schema and policy** not present in the current loan-centric model. They are **not** implemented in the accounting lite module:

- **Officer / branch performance** — needs `loan_officer_id`, `branch_id` (or equivalent) on loans or devices.
- **Full NPL / write-off / loan-loss reserve** — needs accounting policy, often `loan_status` including `written_off`, and optionally a general ledger for provisions.
- **Interest accrual vs cash, yield** — needs accrual rules and split of each payment into principal/interest (or GL).
- **Regulatory / AML / credit bureau** — needs export formats and often additional KYC fields.
- **Full financial statements (P&amp;L, balance sheet, cash flow)** — needs chart of accounts and journals, or export to an external accounting system.

Revisit when those dimensions exist in [`db/schema.sql`](db/schema.sql) and business rules are fixed.
