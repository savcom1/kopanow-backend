'use strict';

const API = '/api/accounting';
const KEY_STORAGE = 'kopanow_accounting_key';

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function getKey() {
  return sessionStorage.getItem(KEY_STORAGE) || '';
}

function setKey(k) {
  if (k) sessionStorage.setItem(KEY_STORAGE, k);
  else sessionStorage.removeItem(KEY_STORAGE);
}

function headers(json = true) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  const k = getKey();
  if (k) h['x-accounting-key'] = k;
  return h;
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, { ...opts, headers: { ...headers(), ...opts.headers } });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(data.error || data.message || res.statusText || 'Request failed');
  }
  return data;
}

function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 4200);
}

function setView(name) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  $$('.nav-item').forEach((n) => n.classList.remove('active'));
  $(`#view-${name}`)?.classList.add('active');
  $(`[data-view="${name}"]`)?.classList.add('active');
  const titles = {
    home: 'Home',
    customers: 'Customers',
    loans: 'Loans & invoices',
    'cash-disburse': 'Cash disbursement',
    cash: 'Cash receipts (Lipa)',
    reports: 'Reports',
    queues: 'Queues',
    audit: 'Audit log',
  };
  $('#page-title').textContent = titles[name] || name;
}

let selectedBorrowerId = null;
let selectedLoanId = null;
let pendingDisburseLoanId = null;
let pendingDisburseStage = 'ready';
let currentLoanDetail = null;

async function loadCustomers() {
  const q = $('#customer-search').value.trim();
  const qs = new URLSearchParams({ page: 1, limit: 100 });
  if (q) qs.set('search', q);
  const data = await apiFetch(`/borrowers?${qs}`);
  const tb = $('#table-customers tbody');
  tb.innerHTML = '';
  for (const b of data.borrowers || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(b.borrower_id)}</td><td>${escapeHtml(b.full_name)}</td><td>${escapeHtml(b.phone)}</td><td>${escapeHtml(b.region)}</td>`;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => openCustomer(b.borrower_id));
    tb.appendChild(tr);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function openCustomer(borrowerId) {
  selectedBorrowerId = borrowerId;
  const data = await apiFetch(`/borrowers/${encodeURIComponent(borrowerId)}`);
  const r = data.registration;
  $('#customer-detail').hidden = false;
  $('#customer-detail-title').textContent = r.full_name || borrowerId;
  const f = $('#form-edit-customer');
  f.full_name.value = r.full_name || '';
  f.phone.value = r.phone || '';
  f.national_id.value = r.national_id || '';
  f.region.value = r.region || '';
  f.address.value = r.address || '';
  f.reason.value = '';
  f.actor.value = '';
}

$('#form-edit-customer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedBorrowerId) return;
  const f = e.target;
  const body = {
    full_name: f.full_name.value.trim(),
    phone: f.phone.value.trim(),
    national_id: f.national_id.value.trim(),
    region: f.region.value.trim(),
    address: f.address.value.trim(),
    reason: f.reason.value.trim(),
    actor: f.actor.value.trim() || 'accounting',
  };
  try {
    await apiFetch(`/borrowers/${encodeURIComponent(selectedBorrowerId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    toast('Customer updated');
    loadCustomers();
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadLoans() {
  const q = $('#loan-search').value.trim();
  const qs = new URLSearchParams({ page: 1, limit: 100 });
  if (q) qs.set('search', q);
  const data = await apiFetch(`/loans?${qs}`);
  const tb = $('#table-loans tbody');
  tb.innerHTML = '';
  for (const l of data.loans || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(l.loan_id)}</td><td>${escapeHtml(l.borrower_full_name || l.borrower_id)}</td><td>${escapeHtml(String(l.outstanding_amount))}</td><td>${fmtDate(l.next_due_date)}</td><td><button type="button" class="link">Open</button></td>`;
    tr.querySelector('button').addEventListener('click', () => openLoan(l.loan_id));
    tb.appendChild(tr);
  }
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function openLoan(loanId) {
  selectedLoanId = loanId;
  const data = await apiFetch(`/loans/${encodeURIComponent(loanId)}`);
  currentLoanDetail = data;
  $('#loan-detail').hidden = false;
  $('#loan-detail-title').textContent = loanId;
  $('#loan-detail-meta').textContent =
    `Borrower: ${data.registration?.full_name || data.loan.borrower_id}` +
    ` · Principal: ${data.loan.principal_amount ?? '—'}` +
    ` · Outstanding: ${data.loan.outstanding_amount ?? '—'}`;
  const fo = $('#form-outstanding');
  fo.outstanding_amount.value = data.loan.outstanding_amount ?? '';
  fo.reason.value = '';
  fo.actor.value = '';
  const fp = $('#form-principal');
  fp.principal_amount.value = data.loan.principal_amount ?? '';
  fp.reason.value = '';
  fp.actor.value = '';

  const tb = $('#table-invoices tbody');
  tb.innerHTML = '';
  for (const inv of data.invoices || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${inv.installment_index}</td><td>${fmtDate(inv.due_date)}</td><td>${inv.amount_due}</td><td>${escapeHtml(inv.status)}</td><td></td>`;
    const td = tr.lastElementChild;
    const sel = document.createElement('select');
    ['pending', 'paid', 'overdue'].forEach((st) => {
      const o = document.createElement('option');
      o.value = st;
      o.textContent = st;
      if (st === inv.status) o.selected = true;
      sel.appendChild(o);
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary';
    btn.textContent = 'Apply';
    btn.addEventListener('click', async () => {
      const reason = window.prompt('Reason for invoice status change (required):');
      if (!reason || !reason.trim()) {
        toast('Reason required', true);
        return;
      }
      const actor = window.prompt('Actor (optional):', '') || 'accounting';
      try {
        await apiFetch(`/loans/${encodeURIComponent(loanId)}/invoices/${inv.id}/adjust`, {
          method: 'POST',
          body: JSON.stringify({ status: sel.value, reason: reason.trim(), actor }),
        });
        toast('Invoice updated');
        openLoan(loanId);
      } catch (err) {
        toast(err.message, true);
      }
    });
    td.appendChild(sel);
    td.appendChild(btn);

    // Extra invoice field edits (amount_due + due_date)
    const amtInput = document.createElement('input');
    amtInput.type = 'number';
    amtInput.step = '0.01';
    amtInput.min = '0';
    amtInput.value = inv.amount_due ?? '';
    amtInput.style.width = '110px';
    amtInput.style.marginLeft = '10px';

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = inv.due_date ? new Date(inv.due_date).toISOString().slice(0, 10) : '';
    dateInput.style.width = '150px';
    dateInput.style.marginLeft = '10px';

    const btnFields = document.createElement('button');
    btnFields.type = 'button';
    btnFields.className = 'btn btn-secondary';
    btnFields.textContent = 'Apply fields';
    btnFields.style.marginLeft = '10px';
    btnFields.addEventListener('click', async () => {
      const reason = window.prompt('Reason for invoice field change (required):');
      if (!reason || !reason.trim()) {
        toast('Reason required', true);
        return;
      }
      const actor = window.prompt('Actor (optional):', '') || 'accounting';
      const body = { reason: reason.trim(), actor };
      const amt = amtInput.value;
      const due = dateInput.value;
      if (amt !== '' && amt != null) body.amount_due = Number(amt);
      if (due) body.due_date = due;
      if (body.amount_due === undefined && body.due_date === undefined) {
        toast('Change amount or due date first', true);
        return;
      }
      try {
        await apiFetch(`/loans/${encodeURIComponent(loanId)}/invoices/${inv.id}/adjust-fields`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        toast('Invoice fields updated');
        openLoan(loanId);
      } catch (err) {
        toast(err.message, true);
      }
    });

    td.appendChild(amtInput);
    td.appendChild(dateInput);
    td.appendChild(btnFields);

    // Delete invoice
    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'btn btn-danger';
    btnDelete.textContent = 'Delete';
    btnDelete.style.marginLeft = '10px';
    btnDelete.addEventListener('click', async () => {
      const ok = window.confirm(
        `Delete invoice #${inv.installment_index} (amount ${inv.amount_due})?\n\nThis cannot be undone.`,
      );
      if (!ok) return;
      const reason = window.prompt('Reason for deleting this invoice (required):');
      if (!reason || !reason.trim()) {
        toast('Reason required', true);
        return;
      }
      const actor = window.prompt('Actor (optional):', '') || 'accounting';
      try {
        await apiFetch(`/loans/${encodeURIComponent(loanId)}/invoices/${inv.id}/delete`, {
          method: 'POST',
          body: JSON.stringify({ reason: reason.trim(), actor }),
        });
        toast('Invoice deleted');
        openLoan(loanId);
      } catch (err) {
        toast(err.message, true);
      }
    });
    td.appendChild(btnDelete);
    tb.appendChild(tr);
  }
}

$('#form-outstanding').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedLoanId) return;
  const f = e.target;
  try {
    await apiFetch(`/loans/${encodeURIComponent(selectedLoanId)}/adjust-outstanding`, {
      method: 'POST',
      body: JSON.stringify({
        outstanding_amount: Number(f.outstanding_amount.value),
        reason: f.reason.value.trim(),
        actor: f.actor.value.trim() || 'accounting',
      }),
    });
    toast('Outstanding updated');
    openLoan(selectedLoanId);
  } catch (err) {
    toast(err.message, true);
  }
});

$('#form-principal').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedLoanId) return;
  const f = e.target;
  try {
    await apiFetch(`/loans/${encodeURIComponent(selectedLoanId)}/adjust-principal`, {
      method: 'POST',
      body: JSON.stringify({
        principal_amount: Number(f.principal_amount.value),
        reason: f.reason.value.trim(),
        actor: f.actor.value.trim() || 'accounting',
      }),
    });
    toast('Principal updated');
    openLoan(selectedLoanId);
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btn-sync-outstanding').addEventListener('click', async () => {
  if (!selectedLoanId) return;
  const data = currentLoanDetail;
  if (!data?.invoices?.length) {
    toast('No invoices loaded for this loan', true);
    return;
  }
  const unpaid = (data.invoices || []).filter((i) => i.status === 'pending' || i.status === 'overdue');
  const sum = unpaid.reduce((acc, i) => acc + (Number(i.amount_due) || 0), 0);
  const reason = window.prompt('Reason for outstanding sync (required):', 'Sync outstanding to sum(unpaid invoices)') || '';
  if (!reason.trim()) {
    toast('Reason required', true);
    return;
  }
  const actor = window.prompt('Actor (optional):', '') || 'accounting';
  try {
    await apiFetch(`/loans/${encodeURIComponent(selectedLoanId)}/adjust-outstanding`, {
      method: 'POST',
      body: JSON.stringify({
        outstanding_amount: sum,
        reason: reason.trim(),
        actor,
      }),
    });
    toast('Outstanding synced to unpaid invoices');
    openLoan(selectedLoanId);
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadPendingDisbursement() {
  const qs = new URLSearchParams();
  qs.set('stage', pendingDisburseStage || 'all');
  const data = await apiFetch(`/loans/pending-disbursement?${qs.toString()}`);
  const tb = $('#table-pending-disburse tbody');
  tb.innerHTML = '';
  for (const l of data.loans || []) {
    const tr = document.createElement('tr');
    const principal =
      l.principal_amount != null ? Number(l.principal_amount).toLocaleString() : '—';
    const who = l.borrower_full_name || l.borrower_id || '—';
    const isCustomer = l.is_customer === true;
    const badge = isCustomer
      ? `<span class="badge ok">Customer</span>`
      : `<span class="badge bad">Applicant</span>`;
    tr.innerHTML = `<td>${escapeHtml(l.loan_id)}</td><td>${escapeHtml(who)}</td><td>${badge}</td><td>${escapeHtml(principal)}</td><td>${fmtDate(l.created_at)}</td><td><button type="button" class="btn btn-primary" data-confirm-disburse="1">Confirm</button></td>`;
    tr.dataset.loanId = l.loan_id;
    tb.appendChild(tr);
  }
}

function openCashDisburseModal(loanId, labelLine) {
  pendingDisburseLoanId = loanId;
  const modal = $('#modal-cash-disburse');
  const f = $('#form-cash-disburse');
  f.actor.value = '';
  f.notes.value = '';
  $('#modal-cash-loan-line').textContent = labelLine || loanId;
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  f.actor.focus();
}

function closeCashDisburseModal() {
  pendingDisburseLoanId = null;
  const modal = $('#modal-cash-disburse');
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

async function loadLipa() {
  const claim = $('#lipa-claim').value;
  const search = $('#lipa-search').value.trim();
  const qs = new URLSearchParams({ page: 1, limit: 80, claim });
  if (search) qs.set('search', search);
  const data = await apiFetch(`/cash-receipts/lipa?${qs}`);
  const tb = $('#table-lipa tbody');
  tb.innerHTML = '';
  for (const t of data.transactions || []) {
    const tr = document.createElement('tr');
    const when = t.transaction_occurred_at || t.ingested_at;
    tr.innerHTML = `<td>${fmtDate(when)}</td><td>${t.amount}</td><td>${escapeHtml(t.transaction_ref)}</td><td>${escapeHtml(t.payer_phone)}</td><td>${escapeHtml(t.claimed_loan_id || '—')}</td>`;
    tb.appendChild(tr);
  }
}

async function runCollectionsJson() {
  const from = $('#rep-from').value;
  const to = $('#rep-to').value;
  if (!from || !to) {
    toast('Pick from and to dates', true);
    return;
  }
  const start = new Date(from + 'T00:00:00.000Z').toISOString();
  const end = new Date(to + 'T23:59:59.999Z').toISOString();
  const data = await apiFetch(`/reports/collections?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}&format=json`);
  $('#collections-out').textContent = JSON.stringify(data, null, 2);
}

function csvDownloadName(path) {
  if (path.includes('expected-vs-actual')) return 'expected-vs-actual.csv';
  if (path.includes('disbursements')) return 'disbursements.csv';
  if (path.includes('maturity')) return 'maturity-upcoming.csv';
  if (path.includes('aging')) return 'ar-aging.csv';
  return 'collections-lipa.csv';
}

async function downloadCsv(path) {
  const h = headers(false);
  const res = await fetch(`${API}${path}`, { headers: h });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || err.message || res.statusText);
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = csvDownloadName(path);
  a.click();
  URL.revokeObjectURL(a.href);
}

async function runAgingJson() {
  const data = await apiFetch('/reports/aging?format=json');
  $('#aging-out').textContent = JSON.stringify(data, null, 2);
}

async function loadParKpis() {
  const data = await apiFetch('/reports/par');
  const p = data.par;
  $('#kpi-par1').textContent = `${p.par1.pct}%`;
  $('#kpi-par1-bal').textContent = `TZS ${p.par1.balance.toLocaleString()}`;
  $('#kpi-par30').textContent = `${p.par30.pct}%`;
  $('#kpi-par30-bal').textContent = `TZS ${p.par30.balance.toLocaleString()}`;
  $('#kpi-par90').textContent = `${p.par90.pct}%`;
  $('#kpi-par90-bal').textContent = `TZS ${p.par90.balance.toLocaleString()}`;
  $('#kpi-portfolio').textContent = `TZS ${data.portfolio_gross_outstanding.toLocaleString()}`;
  $('#kpi-par30-count').textContent = `${data.loan_count_in_par30} loans in PAR30`;
  $('#par-as-of').textContent = `As of ${new Date(data.as_of).toLocaleString()}`;
}

async function runParDetail() {
  const data = await apiFetch('/reports/par');
  $('#par-out').textContent = JSON.stringify(data, null, 2);
}

async function runEvaJson() {
  const from = $('#eva-from').value;
  const to = $('#eva-to').value;
  if (!from || !to) {
    toast('Pick from and to (Expected vs actual)', true);
    return;
  }
  const start = new Date(from + 'T00:00:00.000Z').toISOString();
  const end = new Date(to + 'T23:59:59.999Z').toISOString();
  const data = await apiFetch(
    `/reports/expected-vs-actual?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}&format=json`,
  );
  $('#eva-out').textContent = JSON.stringify(data, null, 2);
}

async function runDisJson() {
  const from = $('#dis-from').value;
  const to = $('#dis-to').value;
  if (!from || !to) {
    toast('Pick disbursement date range', true);
    return;
  }
  const start = new Date(from + 'T00:00:00.000Z').toISOString();
  const end = new Date(to + 'T23:59:59.999Z').toISOString();
  const data = await apiFetch(
    `/reports/disbursements?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}&format=json`,
  );
  $('#dis-out').textContent = JSON.stringify(data, null, 2);
}

async function runMatJson() {
  const days = Math.min(365, Math.max(1, parseInt($('#mat-days').value, 10) || 30));
  const data = await apiFetch(`/reports/maturity?withinDays=${days}&format=json`);
  $('#mat-out').textContent = JSON.stringify(data, null, 2);
}

async function loadQueueLipa() {
  const data = await apiFetch('/queues/unmatched-lipa?page=1&limit=80');
  const tb = $('#table-queue-lipa tbody');
  tb.innerHTML = '';
  for (const t of data.transactions || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(t.ingested_at)}</td><td>${t.amount}</td><td>${escapeHtml(t.transaction_ref)}</td><td>${escapeHtml(t.payer_phone)}</td>`;
    tb.appendChild(tr);
  }
}

async function loadQueueRefs() {
  const data = await apiFetch('/queues/pending-refs?page=1&limit=80');
  const tb = $('#table-queue-refs tbody');
  tb.innerHTML = '';
  for (const r of data.references || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(r.submitted_at)}</td><td>${escapeHtml(r.mpesa_ref)}</td><td>${escapeHtml(r.loan_id)}</td><td>${escapeHtml(r.borrower_id)}</td>`;
    tb.appendChild(tr);
  }
}

async function loadAudit() {
  const data = await apiFetch('/audit-log?page=1&limit=100');
  const tb = $('#table-audit tbody');
  tb.innerHTML = '';
  for (const e of data.entries || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(e.created_at)}</td><td>${escapeHtml(e.actor)}</td><td>${escapeHtml(e.entity_type)} ${escapeHtml(e.entity_id)}</td><td>${escapeHtml(e.action)}</td><td>${escapeHtml(e.reason || '—')}</td>`;
    tb.appendChild(tr);
  }
}

function wireNav() {
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.getAttribute('data-view');
      setView(v);
      if (v === 'customers') loadCustomers().catch((e) => toast(e.message, true));
      if (v === 'loans') loadLoans().catch((e) => toast(e.message, true));
      if (v === 'cash') loadLipa().catch((e) => toast(e.message, true));
      if (v === 'cash-disburse') loadPendingDisbursement().catch((e) => toast(e.message, true));
      if (v === 'queues') {
        loadQueueLipa().catch((e) => toast(e.message, true));
        loadQueueRefs().catch((e) => toast(e.message, true));
      }
      if (v === 'audit') loadAudit().catch((e) => toast(e.message, true));
      if (v === 'home') loadParKpis().catch((e) => toast(e.message, true));
    });
  });
}

function wirePendingDisbursementStageChips() {
  const chips = $$('[data-disburse-stage]');
  if (!chips.length) return;

  const setActive = (stage) => {
    pendingDisburseStage = stage || 'all';
    chips.forEach((c) => {
      const active = (c.dataset.disburseStage || '') === pendingDisburseStage;
      c.classList.toggle('active', active);
      c.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  };

  chips.forEach((btn) => {
    btn.addEventListener('click', () => {
      setActive(btn.dataset.disburseStage || 'all');
      loadPendingDisbursement().catch((e) => toast(e.message, true));
    });
  });

  setActive(pendingDisburseStage);
}

$('#table-pending-disburse').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-confirm-disburse]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const loanId = tr?.dataset?.loanId;
  if (!loanId) return;
  const cells = tr.querySelectorAll('td');
  const label =
    cells.length >= 2
      ? `${loanId} · ${cells[1].textContent.trim()}`
      : loanId;
  openCashDisburseModal(loanId, label);
});

$('#btn-pending-disburse-refresh').addEventListener('click', () => {
  loadPendingDisbursement().catch((e) => toast(e.message, true));
});

$('#btn-cash-disburse-cancel').addEventListener('click', () => closeCashDisburseModal());

$('#modal-cash-disburse').addEventListener('click', (e) => {
  if (e.target.id === 'modal-cash-disburse') closeCashDisburseModal();
});

$('#form-cash-disburse').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pendingDisburseLoanId) return;
  const f = e.target;
  const actor = f.actor.value.trim();
  if (!actor) {
    toast('Actor is required', true);
    return;
  }
  try {
    await apiFetch(`/loans/${encodeURIComponent(pendingDisburseLoanId)}/confirm-cash-disbursement`, {
      method: 'POST',
      body: JSON.stringify({
        actor,
        notes: f.notes.value.trim() || undefined,
      }),
    });
    toast('Cash disbursement confirmed');
    closeCashDisburseModal();
    await loadPendingDisbursement();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btn-save-key').addEventListener('click', () => {
  setKey($('#api-key').value.trim());
  toast('Key saved for this session');
});

$('#api-key').value = getKey();

$('#btn-search-customers').addEventListener('click', () => loadCustomers().catch((e) => toast(e.message, true)));
$('#btn-search-loans').addEventListener('click', () => loadLoans().catch((e) => toast(e.message, true)));
$('#btn-lipa-refresh').addEventListener('click', () => loadLipa().catch((e) => toast(e.message, true)));

$('#btn-collections-run').addEventListener('click', () => runCollectionsJson().catch((e) => toast(e.message, true)));
$('#btn-collections-csv').addEventListener('click', () => {
  const from = $('#rep-from').value;
  const to = $('#rep-to').value;
  if (!from || !to) {
    toast('Pick from and to dates', true);
    return;
  }
  const start = new Date(from + 'T00:00:00.000Z').toISOString();
  const end = new Date(to + 'T23:59:59.999Z').toISOString();
  const path = `/reports/collections?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}&format=csv`;
  downloadCsv(path).catch((e) => toast(e.message, true));
});

$('#btn-aging-run').addEventListener('click', () => runAgingJson().catch((e) => toast(e.message, true)));
$('#btn-aging-csv').addEventListener('click', () => downloadCsv('/reports/aging?format=csv').catch((e) => toast(e.message, true)));

$('#btn-refresh-par').addEventListener('click', () => loadParKpis().catch((e) => toast(e.message, true)));
$('#btn-par-run').addEventListener('click', () => runParDetail().catch((e) => toast(e.message, true)));

$('#btn-eva-run').addEventListener('click', () => runEvaJson().catch((e) => toast(e.message, true)));
$('#btn-eva-csv').addEventListener('click', () => {
  const from = $('#eva-from').value;
  const to = $('#eva-to').value;
  if (!from || !to) {
    toast('Pick from and to', true);
    return;
  }
  const start = new Date(from + 'T00:00:00.000Z').toISOString();
  const end = new Date(to + 'T23:59:59.999Z').toISOString();
  downloadCsv(
    `/reports/expected-vs-actual?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}&format=csv`,
  ).catch((e) => toast(e.message, true));
});

$('#btn-dis-run').addEventListener('click', () => runDisJson().catch((e) => toast(e.message, true)));
$('#btn-dis-csv').addEventListener('click', () => {
  const from = $('#dis-from').value;
  const to = $('#dis-to').value;
  if (!from || !to) {
    toast('Pick from and to', true);
    return;
  }
  const start = new Date(from + 'T00:00:00.000Z').toISOString();
  const end = new Date(to + 'T23:59:59.999Z').toISOString();
  downloadCsv(
    `/reports/disbursements?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}&format=csv`,
  ).catch((e) => toast(e.message, true));
});

$('#btn-mat-run').addEventListener('click', () => runMatJson().catch((e) => toast(e.message, true)));
$('#btn-mat-csv').addEventListener('click', () => {
  const days = Math.min(365, Math.max(1, parseInt($('#mat-days').value, 10) || 30));
  downloadCsv(`/reports/maturity?withinDays=${days}&format=csv`).catch((e) => toast(e.message, true));
});

$('#btn-queue-lipa').addEventListener('click', () => loadQueueLipa().catch((e) => toast(e.message, true)));
$('#btn-queue-refs').addEventListener('click', () => loadQueueRefs().catch((e) => toast(e.message, true)));
$('#btn-audit-refresh').addEventListener('click', () => loadAudit().catch((e) => toast(e.message, true)));

wireNav();
wirePendingDisbursementStageChips();

// Default date range: last 30 days
(function initDates() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  const fs = from.toISOString().slice(0, 10);
  const ts = to.toISOString().slice(0, 10);
  $('#rep-to').value = ts;
  $('#rep-from').value = fs;
  $('#eva-from').value = fs;
  $('#eva-to').value = ts;
  $('#dis-from').value = fs;
  $('#dis-to').value = ts;
})();

loadParKpis().catch((e) => toast(e.message, true));
