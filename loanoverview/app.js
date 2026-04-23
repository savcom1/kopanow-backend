'use strict';

const API = '/api/admin/loanoverview';
const KEY_STORAGE = 'loanoverview_admin_key';

function $(sel) { return document.querySelector(sel); }

function setKey(k) {
  try { localStorage.setItem(KEY_STORAGE, k); } catch (_) {}
}
function getKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (_) { return ''; }
}

function headers() {
  const h = { 'content-type': 'application/json' };
  const k = $('#admin-key').value.trim();
  if (k) h['x-admin-key'] = k;
  return h;
}

async function apiFetch(path) {
  const res = await fetch(`${API}${path}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
  return data;
}

function tzs(n) {
  const x = Number(n) || 0;
  return `TZS ${x.toLocaleString()}`;
}

function fmtIso(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function toIsoFromDatetimeLocal(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function render(summary) {
  $('#last-updated').textContent = fmtIso(summary.generated_at);

  $('#kpi-applicants').textContent = (summary.counts?.applicants_in_window ?? '—').toLocaleString?.() ?? String(summary.counts?.applicants_in_window ?? '—');
  $('#kpi-customers').textContent = (summary.counts?.customers_in_window ?? '—').toLocaleString?.() ?? String(summary.counts?.customers_in_window ?? '—');

  $('#kpi-registrations').textContent =
    `Registrations(window): ${Number(summary.counts?.registrations_in_window || 0).toLocaleString()} · Total regs: ${summary.counts?.registrations_total ?? '—'}`;
  $('#kpi-customers-total').textContent =
    `Customers(total): ${Number(summary.counts?.customers_total || 0).toLocaleString()}`;

  $('#kpi-disbursed').textContent = tzs(summary.disbursed?.principal_sum_in_window);
  $('#kpi-disbursed-count').textContent =
    `Completed loans(window): ${Number(summary.disbursed?.completed_loan_count_in_window || 0).toLocaleString()}`;

  $('#kpi-gross').textContent = tzs(summary.portfolio?.gross_outstanding);
  const p30 = summary.portfolio?.par?.par30;
  $('#kpi-par30').textContent = p30 ? `PAR30: ${p30.pct}% (${tzs(p30.balance)})` : 'PAR30: —';

  $('#kpi-lipa-total').textContent = tzs(summary.payments?.lipa?.total_amount);
  $('#kpi-lipa-claimed').textContent = tzs(summary.payments?.lipa?.claimed_amount);
  $('#kpi-lipa-unclaimed').textContent = tzs(summary.payments?.lipa?.unclaimed_amount);
  $('#kpi-lipa-rows').textContent = `Rows: ${Number(summary.payments?.lipa?.row_count || 0).toLocaleString()}`;

  $('#kpi-verified').textContent = tzs(summary.payments?.verified?.total_amount);
  $('#kpi-verified-rows').textContent = `Rows: ${Number(summary.payments?.verified?.row_count || 0).toLocaleString()}`;

  const prc = summary.payments?.payment_references?.counts;
  $('#kpi-payment-refs').textContent = prc
    ? `Payment refs(window): total=${prc.total}, pending=${prc.pending}, verified=${prc.verified}, rejected=${prc.rejected}`
    : 'Payment refs(window): —';

  $('#kpi-prot-ok').textContent =
    Number(summary.operations?.protections_completed_in_window || 0).toLocaleString();
  $('#kpi-q-pending').textContent =
    Number(summary.operations?.queue_pending_enqueued_in_window || 0).toLocaleString();
  $('#kpi-q-completed').textContent =
    Number(summary.operations?.queue_completed_updated_in_window || 0).toLocaleString();

  $('#aging-out').textContent = JSON.stringify(
    { total_receivable: summary.aging?.total_receivable, buckets: summary.aging?.buckets },
    null,
    2
  );
  $('#raw-out').textContent = JSON.stringify(summary, null, 2);
}

let timer = null;
let inFlight = false;

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  try {
    const w = $('#window').value || 'day';
    const fromIso = toIsoFromDatetimeLocal($('#from').value);
    const toIso = toIsoFromDatetimeLocal($('#to').value);
    const qs = new URLSearchParams({ window: w });
    if (fromIso && toIso) {
      qs.set('from', fromIso);
      qs.set('to', toIso);
    }
    const data = await apiFetch(`/summary?${qs.toString()}`);
    render(data);
  } catch (err) {
    $('#raw-out').textContent = JSON.stringify({ error: err.message }, null, 2);
  } finally {
    inFlight = false;
  }
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (document.hidden) return;
    refresh().catch(() => {});
  }, 30000);
}

$('#admin-key').value = getKey();
$('#admin-key').addEventListener('input', () => setKey($('#admin-key').value.trim()));
$('#btn-refresh').addEventListener('click', () => refresh().catch(() => {}));
$('#window').addEventListener('change', () => refresh().catch(() => {}));

startPolling();
refresh().catch(() => {});

