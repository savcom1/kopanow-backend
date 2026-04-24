## Disbursement queue recovery (Supabase)

If rows in `cash_disbursement_queue` were accidentally deleted, parts of the system may treat borrowers as not-yet-confirmed even if funds were sent.

### What we do now (safety net)

The backend now falls back to `loans.cash_disbursement_confirmed_at` / `loans.disbursed_at` when queue rows are missing, so customers should not revert purely because `cash_disbursement_queue` is empty.

### Admin endpoints

All endpoints are under `GET/POST /api/accounting/*` and require the normal accounting auth (e.g. `x-accounting-key`).

#### 1) List confirmed loans missing queue rows

`GET /api/accounting/admin/disbursement-queue/missing?limit=500`

#### 2) Rehydrate missing completed queue rows from `loans`

`POST /api/accounting/admin/disbursement-queue/rehydrate-completed`

Body:

```json
{
  "reason": "Accidentally deleted cash_disbursement_queue; restoring",
  "actor": "ops",
  "limit": 2000
}
```

Response includes `inserted` and `missing_loan_ids`.

### Manual SQL alternative (Supabase SQL editor)

If you prefer SQL, you can insert missing queue rows for confirmed loans using:

```sql
insert into cash_disbursement_queue (loan_id, borrower_id, principal_amount, phone, status, enqueued_at, updated_at)
select
  l.loan_id,
  l.borrower_id,
  l.principal_amount,
  null as phone,
  'completed' as status,
  coalesce(l.cash_disbursement_confirmed_at, l.disbursed_at, l.updated_at, now()) as enqueued_at,
  now() as updated_at
from loans l
where l.cash_disbursement_confirmed_at is not null
  and not exists (
    select 1 from cash_disbursement_queue q
    where q.loan_id = l.loan_id
  );
```

