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

function setText(sel, value) {
  const el = $(sel);
  if (!el) return;
  el.textContent = value;
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
  setText('#last-updated', fmtIso(summary.generated_at));
  setText('#chip-window', `${summary.window || 'day'} · ${fmtIso(summary.from)} → ${fmtIso(summary.to)}`);

  setText(
    '#kpi-applicants',
    (summary.counts?.applicants_in_window ?? '—').toLocaleString?.() ??
      String(summary.counts?.applicants_in_window ?? '—')
  );
  setText(
    '#kpi-customers',
    (summary.counts?.customers_in_window ?? '—').toLocaleString?.() ??
      String(summary.counts?.customers_in_window ?? '—')
  );

  setText(
    '#kpi-registrations',
    `Registrations(window): ${Number(summary.counts?.registrations_in_window || 0).toLocaleString()} · Total regs: ${summary.counts?.registrations_total ?? '—'}`
  );
  setText(
    '#kpi-customers-total',
    `Customers(total): ${Number(summary.counts?.customers_total || 0).toLocaleString()}`
  );

  setText('#kpi-disbursed', tzs(summary.disbursed?.principal_sum_in_window));
  setText(
    '#kpi-disbursed-count',
    `Completed loans(window): ${Number(summary.disbursed?.completed_loan_count_in_window || 0).toLocaleString()}`
  );

  setText('#kpi-gross', tzs(summary.portfolio?.gross_outstanding));
  const p30 = summary.portfolio?.par?.par30;
  setText('#kpi-par30', p30 ? `PAR30: ${p30.pct}% (${tzs(p30.balance)})` : 'PAR30: —');

  setText('#kpi-lipa-total', tzs(summary.payments?.lipa?.total_amount));
  setText('#kpi-lipa-claimed', tzs(summary.payments?.lipa?.claimed_amount));
  setText('#kpi-lipa-unclaimed', tzs(summary.payments?.lipa?.unclaimed_amount));
  setText('#kpi-lipa-rows', `Rows: ${Number(summary.payments?.lipa?.row_count || 0).toLocaleString()}`);

  setText('#kpi-verified', tzs(summary.payments?.verified?.total_amount));
  setText('#kpi-verified-rows', `Rows: ${Number(summary.payments?.verified?.row_count || 0).toLocaleString()}`);

  const prc = summary.payments?.payment_references?.counts;
  setText(
    '#kpi-payment-refs',
    prc
      ? `Payment refs(window): total=${prc.total}, pending=${prc.pending}, verified=${prc.verified}, rejected=${prc.rejected}`
      : 'Payment refs(window): —'
  );

  setText('#kpi-prot-ok', Number(summary.operations?.protections_completed_in_window || 0).toLocaleString());
  setText('#kpi-q-pending', Number(summary.operations?.queue_pending_enqueued_in_window || 0).toLocaleString());
  setText('#kpi-q-completed', Number(summary.operations?.queue_completed_updated_in_window || 0).toLocaleString());

  // Aging
  setText('#aging-total', tzs(summary.aging?.total_receivable));
  const table = $('#aging-table');
  if (table) {
    table.innerHTML = '';
    const buckets = summary.aging?.buckets || {};
    for (const key of Object.keys(buckets)) {
      const b = buckets[key];
      const row = document.createElement('div');
      row.className = 'lo-aging-row';
      row.innerHTML =
        `<div class="lo-aging-label">${b?.label || key}</div>` +
        `<div class="lo-aging-count">${Number(b?.count || 0).toLocaleString()} loans</div>` +
        `<div class="lo-aging-amount">${tzs(b?.amount || 0)}</div>`;
      table.appendChild(row);
    }
  }

  // Raw JSON (collapsible)
  const raw = $('#raw-out');
  if (raw) raw.textContent = JSON.stringify(summary, null, 2);
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

$('#btn-toggle-raw')?.addEventListener('click', () => {
  const raw = $('#raw-out');
  if (!raw) return;
  raw.hidden = !raw.hidden;
});

$('#btn-toggle-aging')?.addEventListener('click', () => {
  const wrap = $('#aging-wrap');
  if (!wrap) return;
  wrap.hidden = !wrap.hidden;
});

startPolling();
refresh().catch(() => {});

