'use strict';

const API     = '/api/admin';
const REFRESH = 30_000;

let currentView       = 'dashboard';
let deviceFilter      = 'all';
let tamperSevFilter   = 'all';
let tamperRevFilter   = null;
let selectedDeviceId  = null;
let refreshTimer      = null;

const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function setView(name) {
  currentView = name;
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $(`#view-${name}`)?.classList.add('active');
  $(`[data-view="${name}"]`)?.classList.add('active');
  $('#page-title').textContent = {
    dashboard: 'Dashboard',
    devices:   'Devices',
    tamper:    'Tamper Log',
    loans:     'Loans',
    payments:  'Payment References'
  }[name] || name;
  refresh();
}

async function apiFetch(path, opts = {}) {
  try {
    const res  = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    console.error('API Error:', err.message);
    toast(err.message, 'error');
    return { success: false, error: err.message };
  }
}

async function sendCommand(deviceId, command, extra = {}) {
  return apiFetch(`${API}/command`, {
    method: 'POST',
    body:   JSON.stringify({ device_id: deviceId, command, ...extra })
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  if (m < 1440)return `${Math.floor(m/60)}h ago`;
  return `${Math.floor(m/1440)}d ago`;
}

function isOnline(lastSeen) {
  if (!lastSeen) return false;
  // Device heartbeats every 24h — consider online if seen within 25h (24h + 1h buffer)
  return Date.now() - new Date(lastSeen).getTime() < 25 * 60 * 60 * 1000;
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-TZ', { day:'numeric', month:'short', year:'numeric' });
}

function esc(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders invoice_summary from API (pending / paid / overdue counts). */
function formatInvoiceSummaryHtml(s) {
  if (!s || !s.total) return '<span class="text-muted">—</span>';
  const bits = [];
  if (s.paid) bits.push(`<span style="color:var(--green)">${s.paid} paid</span>`);
  if (s.pending) bits.push(`<span style="color:var(--amber)">${s.pending} pend</span>`);
  if (s.overdue) bits.push(`<span style="color:var(--red)">${s.overdue} late</span>`);
  return bits.length ? bits.join(' <span class="text-muted">·</span> ') : '<span class="text-muted">—</span>';
}

function mdmBoolHtml(v) {
  if (v === true) return '<span style="color:var(--green)">Yes</span>';
  if (v === false) return '<span style="color:var(--red)">No</span>';
  return '<span class="text-muted">—</span>';
}

/** Table cell: summary from devices.mdm_compliance (heartbeat snapshot). */
function mdmComplianceCell(m) {
  if (!m || typeof m !== 'object') return '<span class="text-muted" title="No snapshot yet">—</span>';
  const ok = m.all_required_ok === true;
  const oc = m.ok_count;
  const rc = m.required_count;
  if (typeof oc === 'number' && typeof rc === 'number') {
    const title = ok ? 'All required permissions OK' : 'Some permissions missing — open Details';
    return ok
      ? `<span style="color:var(--green)" title="${esc(title)}">✓ ${oc}/${rc}</span>`
      : `<span style="color:var(--amber)" title="${esc(title)}">⚠ ${oc}/${rc}</span>`;
  }
  return ok ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--amber)">⚠</span>';
}

/** Device modal: per-flag breakdown from heartbeat mdm_compliance JSON. */
function formatMdmComplianceModalHtml(m) {
  if (!m || typeof m !== 'object') {
    return '<div class="text-muted" style="font-size:12px">No compliance snapshot yet — device will send one on the next heartbeat.</div>';
  }
  const rows = [
    ['Device admin', m.device_admin],
    ['Accessibility (Kopanow)', m.accessibility_service],
    ['Display over other apps', m.display_over_other_apps],
    ['Notifications channel OK', m.notifications_ok],
    ['POST notifications permission', m.post_notifications_permission],
    ['Battery: not restricted', m.battery_optimization_ignored],
    ['Usage access (stats)', m.usage_stats_granted],
    ['Schedule exact alarms', m.can_schedule_exact_alarms],
    ['Full-screen intent', m.full_screen_intent_allowed],
    ['FCM token on device', m.fcm_token_present],
  ];
  let inner = rows.map(([label, v]) => `
    <div class="detail-row">
      <span class="detail-label">${esc(label)}</span>
      <span class="detail-value">${mdmBoolHtml(v)}</span>
    </div>`).join('');
  if (m.sdk_int != null) {
    inner += `
    <div class="detail-row">
      <span class="detail-label">SDK / API level</span>
      <span class="detail-value">${esc(String(m.sdk_int))}</span>
    </div>`;
  }
  const oc = m.ok_count;
  const rc = m.required_count;
  const summary = (typeof oc === 'number' && typeof rc === 'number')
    ? `<div style="margin:0 0 10px;font-size:12px">
        ${m.all_required_ok
          ? '<span style="color:var(--green);font-weight:600">Required checks: all OK</span>'
          : `<span style="color:var(--amber);font-weight:600">Required checks: ${oc} / ${rc}</span>`}
       </div>`
    : '';
  const cap = m.captured_at_ms
    ? `<div class="text-muted" style="font-size:11px;margin-top:8px">Captured: ${new Date(m.captured_at_ms).toLocaleString()}</div>`
    : '';
  return summary + inner + cap;
}

function invoiceStatusBadge(status) {
  const map = {
    pending: '<span class="status-badge s-registered">Pending</span>',
    paid:    '<span class="status-badge s-active">Paid</span>',
    overdue: '<span class="status-badge s-locked">Overdue</span>'
  };
  return map[status] || esc(status);
}

function daysOverdueClient(nextDueDate) {
  if (!nextDueDate) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(nextDueDate).getTime()) / 86400000));
}

function statusBadge(status) {
  const labels = {
    active: 'Active', locked: 'Locked', registered: 'Registered',
    admin_removed: 'Removed', suspended: 'Suspended', unregistered: 'Unregistered'
  };
  return `<span class="status-badge s-${status}">${labels[status] || status}</span>`;
}

function connectivityBadge(online) {
  return online
    ? `<span class="conn-badge online">Online</span>`
    : `<span class="conn-badge offline">Offline</span>`;
}

function sevBadge(sev) {
  return `<span class="sev-badge sev-${sev}">${sev}</span>`;
}

const TAMPER_ICONS = {
  DEVICE_MISMATCH:     '🎭',
  ADMIN_REVOKED:       '🔐',
  ADMIN_SILENT_REMOVE: '👻',
  SAFE_MODE_DETECTED:  '⚠️',
  HEARTBEAT_MISSING:   '💤',
  LOCK_SENT:           '🔒',
  UNLOCK_SENT:         '🔓',
  PAYMENT_RECEIVED:    '💳',
  ADMIN_REMOVAL_SENT:  '🗑️',
  MANUAL_FLAG:         '🚩',
  HEARTBEAT_FAILED:    '❌',
  LOCK_BYPASS_ATTEMPT: '🚨',
  PASSCODE_SET:        '🔑',   // admin issued a PIN to this device
  PASSCODE_CLEARED:    '🗝️'   // admin cleared the PIN from this device
};

async function loadDashboard() {
  const search = $('#search-input')?.value?.trim() || '';
  const data   = await apiFetch(`${API}/devices?limit=50&search=${encodeURIComponent(search)}`);
  if (!data.success) return;

  const s = data.summary || {};
  $('#kpi-total').textContent        = s.total        ?? 0;
  $('#kpi-active').textContent       = s.active       ?? 0;
  $('#kpi-locked').textContent       = s.locked       ?? 0;
  $('#kpi-unregistered').textContent = s.registered   ?? 0;
  $('#kpi-removed').textContent      = s.admin_removed ?? 0;
  $('#badge-locked').textContent     = s.locked       ?? 0;

  const tbody = $('#dash-tbody');
  // Sort client-side: put devices with last_seen first (most recent), then newly
  // enrolled devices with null last_seen (sorted by updated_at desc)
  const sorted = [...(data.devices || [])].sort((a, b) => {
    const ta = new Date(a.last_seen || a.updated_at || 0).getTime();
    const tb = new Date(b.last_seen || b.updated_at || 0).getTime();
    return tb - ta;
  }).slice(0, 10);

  tbody.innerHTML = sorted.map(d => `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="dot ${isOnline(d.last_seen) ? 'online' : 'offline'}"></span>
          <strong>${d.borrower_id}</strong>
        </div>
      </td>
      <td class="mono">${d.loan_id}</td>
      <td class="mono text-muted" style="font-size:12px">${d.device_id ? d.device_id.slice(0, 12) + '…' : '—'}</td>
      <td>${d.device_model || '—'}</td>
      <td>${statusBadge(d.status)}</td>
      <td class="text-muted">${d.last_seen ? timeAgo(d.last_seen) : '<span style="color:var(--amber)">New — no heartbeat yet</span>'}</td>
      <td>${d.loan ? `TSh ${Number(d.loan.outstanding_amount).toLocaleString()}` : '—'}</td>
      <td style="font-size:11px;max-width:120px">${d.loan ? formatInvoiceSummaryHtml(d.loan.invoice_summary) : '—'}</td>
      <td>
        <div class="action-group">
          ${d.status !== 'locked'
            ? `<button class="btn btn-xs btn-danger"  onclick="quickCommand('${d.id}','LOCK_DEVICE')">Lock</button>`
            : `<button class="btn btn-xs btn-green"   onclick="quickCommand('${d.id}','UNLOCK_DEVICE')">Unlock</button>`}
          <button class="btn btn-xs btn-ghost" onclick="openModal('${d.id}')">Details</button>
        </div>
      </td>
    </tr>`).join('');
}

async function loadDevices() {
  const search = $('#search-input')?.value?.trim() || '';
  const data   = await apiFetch(
    `${API}/devices?status=${deviceFilter}&search=${encodeURIComponent(search)}&limit=200`
  );
  if (!data.success) return;

  const tbody = $('#devices-tbody');
  if (!data.devices?.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="text-muted" style="text-align:center;padding:32px">No devices found.</td></tr>';
    return;
  }

  // Sort: devices with real last_seen first, then by updated_at for new enrollments
  const sorted = [...data.devices].sort((a, b) => {
    const ta = new Date(a.last_seen || a.updated_at || 0).getTime();
    const tb = new Date(b.last_seen || b.updated_at || 0).getTime();
    return tb - ta;
  });

  tbody.innerHTML = sorted.map(d => `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="dot ${isOnline(d.last_seen) ? 'online' : 'offline'}"></span>
          <strong>${d.borrower_id}</strong>
        </div>
      </td>
      <td class="mono">${d.loan_id}</td>
      <td class="mono text-muted">${d.device_id ? d.device_id.slice(0,12) + '…' : '—'}</td>
      <td>${d.device_model || '—'}</td>
      <td>${statusBadge(d.status)}</td>
      <td>${d.dpc_active ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--red)">✗</span>'}</td>
      <td style="font-size:12px;white-space:nowrap">${mdmComplianceCell(d.mdm_compliance)}</td>
      <td class="text-muted">${d.last_seen ? timeAgo(d.last_seen) : '<span style="color:var(--amber)">New</span>'}</td>
      <td>${d.loan?.days_overdue > 0 ? `<span style="color:var(--red)">${d.loan.days_overdue}d</span>` : '—'}</td>
      <td>${d.loan ? `TSh ${Number(d.loan.outstanding_amount).toLocaleString()}` : '—'}</td>
      <td style="font-size:12px;max-width:140px">${d.loan ? formatInvoiceSummaryHtml(d.loan.invoice_summary) : '—'}</td>
      <td>
        <div class="action-group">
          ${d.status !== 'locked'
            ? `<button class="btn btn-xs btn-danger" onclick="quickCommand('${d.id}','LOCK_DEVICE')">Lock</button>`
            : `<button class="btn btn-xs btn-green"  onclick="quickCommand('${d.id}','UNLOCK_DEVICE')">Unlock</button>`}
          <button class="btn btn-xs btn-ghost" onclick="openModal('${d.id}')">⋯</button>
        </div>
      </td>
    </tr>`).join('');
}

async function loadTamperLog() {
  const sev      = tamperSevFilter !== 'all' ? `&severity=${tamperSevFilter}` : '';
  const reviewed = tamperRevFilter !== null  ? `&reviewed=${tamperRevFilter}` : '';
  const data     = await apiFetch(`${API}/tamper-logs?limit=100${sev}${reviewed}`);
  if (!data.success) return;

  const logs = data.logs || [];
  $('#badge-tamper').textContent = logs.filter(l => !l.reviewed && ['CRITICAL','HIGH'].includes(l.severity)).length;

  const list = $('#tamper-list');
  if (!logs.length) {
    list.innerHTML = '<div class="text-muted" style="padding:24px;text-align:center">No tamper events found.</div>';
    return;
  }
  list.innerHTML = logs.map(log => `
    <div class="tamper-item ${log.reviewed ? 'reviewed' : ''}">
      <div class="tamper-icon">${TAMPER_ICONS[log.event_type] || '⚡'}</div>
      <div class="tamper-main">
        <div class="tamper-header">
          <span class="tamper-type">${log.event_type}</span>
          ${sevBadge(log.severity)}
          ${log.reviewed ? '<span class="text-muted" style="font-size:11px">✓ reviewed</span>' : ''}
        </div>
        <div class="tamper-meta">
          ${log.borrower_id} / ${log.loan_id} &nbsp;·&nbsp; ${timeAgo(log.created_at)}
        </div>
        ${log.detail ? `<div class="tamper-detail">${log.detail}</div>` : ''}
      </div>
      <div class="tamper-actions">
        ${!log.reviewed
          ? `<button class="btn btn-xs btn-secondary" onclick="reviewTamper('${log.id}', this)">Mark reviewed</button>`
          : ''}
      </div>
    </div>`).join('');
}

async function loadLoans() {
  const data = await apiFetch(`${API}/loans?limit=100`);
  if (!data.success) return;
  const tbody = $('#loans-tbody');
  tbody.innerHTML = data.loans.map(l => {
    const totalR = l.total_repayment_amount != null ? Number(l.total_repayment_amount) : null;
    const weekly = l.weekly_installment_amount != null ? Number(l.weekly_installment_amount) : null;
    const wk = l.installment_weeks || '—';
    const tw = totalR != null && weekly != null
      ? `TZS ${totalR.toLocaleString()} <span class="text-muted">/</span> ${wk}× TZS ${weekly.toLocaleString()}`
      : '—';
    return `
    <tr>
      <td class="mono">${esc(l.loan_id)}</td>
      <td>${esc(l.borrower_id)}</td>
      <td>TZS ${Number(l.principal_amount || 0).toLocaleString()}</td>
      <td style="font-size:12px">${tw}</td>
      <td><strong>TZS ${Number(l.outstanding_amount || 0).toLocaleString()}</strong></td>
      <td>${fmtDate(l.next_due_date)}</td>
      <td>${l.days_overdue > 0 ? `<span style="color:var(--red)">${l.days_overdue}d</span>` : '<span style="color:var(--green)">OK</span>'}</td>
      <td style="font-size:12px">${formatInvoiceSummaryHtml(l.invoice_summary)}</td>
      <td>${statusBadge(l.device_status)}</td>
    </tr>`;
  }).join('');
}

async function openModal(mongoId) {
  selectedDeviceId = mongoId;
  $('#modal-overlay').classList.add('open');
  $('#modal-body').innerHTML = '<div class="text-muted">Loading…</div>';
  $('#cmd-result').textContent = '';

  const data = await apiFetch(`${API}/devices/${mongoId}`);
  if (!data.success) {
    $('#modal-body').innerHTML = `<div class="text-muted">Error: ${data.error}</div>`;
    return;
  }

  const d = data.device;
  const l = data.loan;
  const reg = data.registration;
  const invoices = data.invoices || [];
  const invSum = data.invoice_summary;

  $('#modal-title').textContent = `${esc(d.borrower_id)} — ${esc(d.loan_id)}`;

  let html = '';

  if (reg) {
    html += `<div style="margin:0 0 10px;font-weight:600;font-size:13px;color:var(--text-secondary)">Customer (registration)</div>`;
    html += [
      ['Full name', esc(reg.full_name)],
      ['Phone', esc(reg.phone)],
      ['National ID', esc(reg.national_id)],
      ['Region', esc(reg.region)],
      ['Address', esc(reg.address)],
    ].map(([a, b]) => `
      <div class="detail-row">
        <span class="detail-label">${a}</span>
        <span class="detail-value">${b || '—'}</span>
      </div>`).join('');
    html += '<div style="height:14px"></div>';
  }

  if (l) {
    html += `<div style="margin:0 0 10px;font-weight:600;font-size:13px;color:var(--text-secondary)">Loan & repayment schedule</div>`;
    const loanRows = [
      ['Principal', `TZS ${Number(l.principal_amount || 0).toLocaleString()}`],
      ['Interest (defined)', l.interest_amount != null ? `TZS ${Number(l.interest_amount).toLocaleString()} <span class="text-muted" style="font-size:11px">(total − principal; total = 120%/140%/160% of principal)</span>` : '—'],
      ['Total repayment (fixed)', l.total_repayment_amount != null ? `TZS ${Number(l.total_repayment_amount).toLocaleString()}` : '—'],
      ['Weekly installment', l.weekly_installment_amount != null ? `TZS ${Number(l.weekly_installment_amount).toLocaleString()}` : '—'],
      ['Installment weeks', l.installment_weeks != null ? String(l.installment_weeks) : '—'],
      ['Schedule rule', 'Total = principal × (120% / 140% / 160%) for 1–3 mo; weekly = total ÷ (4 × months)'],
      ['Schedule start', l.loan_schedule_start ? fmtDate(l.loan_schedule_start) : '—'],
      ['Outstanding', `<strong>TZS ${Number(l.outstanding_amount || 0).toLocaleString()}</strong>`],
      ['Next due date', fmtDate(l.next_due_date)],
      ['Calendar days overdue', l.next_due_date ? (daysOverdueClient(l.next_due_date) ? `<span style="color:var(--red)">${daysOverdueClient(l.next_due_date)} days</span>` : '<span style="color:var(--green)">0</span>') : '—'],
    ];
    if (invSum && invSum.total) {
      loanRows.push(['Installment status', formatInvoiceSummaryHtml(invSum)]);
    }
    html += loanRows.map(([a, b]) => `
      <div class="detail-row">
        <span class="detail-label">${a}</span>
        <span class="detail-value">${b}</span>
      </div>`).join('');
    html += '<div style="height:14px"></div>';
  }

  if (invoices.length) {
    html += `<div style="margin:0 0 8px;font-weight:600;font-size:13px;color:var(--text-secondary)">Invoices (${invoices.length})</div>`;
    html += `<div style="overflow:auto;max-height:260px;border:1px solid var(--border);border-radius:8px;margin-bottom:14px">
      <table class="data-table" style="font-size:12px;margin:0;width:100%">
        <thead><tr>
          <th>#</th><th>Invoice #</th><th>Amount</th><th>Due</th><th>Status</th><th>Paid at</th>
        </tr></thead><tbody>`;
    html += invoices.map((row) => `
        <tr>
          <td>${row.installment_index}</td>
          <td class="mono">${esc(row.invoice_number)}</td>
          <td>TZS ${Number(row.amount_due).toLocaleString()}</td>
          <td>${fmtDate(row.due_date)}</td>
          <td>${invoiceStatusBadge(row.status)}</td>
          <td class="text-muted">${row.paid_at ? fmtDate(row.paid_at) : '—'}</td>
        </tr>`).join('');
    html += '</tbody></table></div>';
  }

  html += `<div style="margin:0 0 10px;font-weight:600;font-size:13px;color:var(--text-secondary)">Device & lock state</div>`;

  const fields = [
    ['Borrower ID', esc(d.borrower_id)],
    ['Loan ID', esc(d.loan_id)],
    ['Device ID', esc(d.device_id) || '—'],
    ['Model', esc(d.device_model) || '—'],
  ];

  const di = d.device_info;
  if (di && typeof di === 'object') {
    if (di.manufacturer) fields.push(['Manufacturer', esc(di.manufacturer)]);
    if (di.brand) fields.push(['Brand', esc(di.brand)]);
    if (di.android_version) fields.push(['Android', esc(di.android_version)]);
    if (di.sdk_version != null) fields.push(['API level', String(di.sdk_version)]);
    if (di.screen_width_dp != null && di.screen_height_dp != null) {
      fields.push(['Screen (dp)', `${di.screen_width_dp} × ${di.screen_height_dp}`]);
    }
    if (di.screen_density) fields.push(['Density (dpi)', String(di.screen_density)]);
    if (di.battery_pct != null) fields.push(['Battery (%)', String(di.battery_pct)]);
    if (di.build_product) fields.push(['Build product', esc(di.build_product)]);
    if (di.build_device) fields.push(['Build device', esc(di.build_device)]);
    if (di.is_rooted === true) fields.push(['Rooted', '<span style="color:var(--red)">Yes</span>']);
    if (di.source === 'loan_registration') fields.push(['Profile source', 'Loan application']);
    if (di.registered_at) fields.push(['Registered at', fmtDate(di.registered_at)]);
    if (di.mdm_enrolled_at) fields.push(['MDM enrolled', fmtDate(di.mdm_enrolled_at)]);
  }

  fields.push(
    ['Connectivity', connectivityBadge(isOnline(d.last_seen))],
    ['Status', statusBadge(d.status)],
    ['Locked', d.is_locked ? '🔒 Yes' : '🔓 No'],
    ['Passcode Active', d.passcode_active
      ? '<span style="color:#f0a500;font-weight:600">🔑 Yes</span>'
      : '<span style="color:#888">No</span>'],
    ['Lock Reason', esc(d.lock_reason) || '—'],
    ['Amount Due', esc(d.amount_due) || '—'],
    ['Last Seen', timeAgo(d.last_seen)],
  );

  html += fields.map(([label, val]) => `
    <div class="detail-row">
      <span class="detail-label">${label}</span>
      <span class="detail-value">${val}</span>
    </div>`).join('');

  html += `<div style="margin:16px 0 10px;font-weight:600;font-size:13px;color:var(--text-secondary)">Permissions &amp; access (MDM)</div>`;
  html += formatMdmComplianceModalHtml(d.mdm_compliance);

  $('#modal-body').innerHTML = html;
  $('#cmd-lock-reason').value = d.lock_reason || '';
}

function closeModal() {
  $('#modal-overlay').classList.remove('open');
  selectedDeviceId = null;
}

// ─── PIN / Passcode commands ─────────────────────────────────────────────────

let pinCountdownInterval = null;
let pinPollInterval      = null;

/**
 * Trigger the device to generate its own real system PIN.
 * The command (SET_SYSTEM_PIN) is sent via FCM with no PIN payload.
 * The device generates a cryptographically random PIN, sets it on the
 * actual Android lockscreen via DevicePolicyManager.resetPasswordWithToken(),
 * then reports the PIN back to /api/pin/report.
 * We poll /api/pin/reveal/:id every 3 s until the PIN arrives.
 */
async function setPinForDevice() {
  if (!selectedDeviceId) return;

  const btn = $('#cmd-set-pin');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  const result = await apiFetch('/api/pin/set', {
    method: 'POST',
    body:   JSON.stringify({ device_id: selectedDeviceId })
  });

  btn.disabled = false;
  btn.textContent = '🔑 Set System PIN';

  const el = $('#cmd-result');
  if (!result.success) {
    el.textContent = `✗ ${result.error || 'Failed to send PIN command'}`;
    el.className   = 'cmd-result error';
    toast(result.error || 'PIN command failed', 'error');
    return;
  }

  el.textContent = '✓ SET_SYSTEM_PIN command delivered — waiting for device to respond…';
  el.className   = 'cmd-result';
  toast('Command sent! Waiting for device to generate & report PIN…', 'success');

  // Show reveal box in waiting state
  const box       = $('#pin-reveal-box');
  const valEl     = $('#pin-reveal-value');
  const countdown = $('#pin-countdown');
  valEl.textContent = '···';
  countdown.textContent = '45';
  box.style.display = 'block';

  // Poll /api/pin/reveal/:id — device will POST to /api/pin/report
  // and we pick it up here
  clearInterval(pinPollInterval);
  clearInterval(pinCountdownInterval);

  let pollSecs = 45;
  countdown.textContent = pollSecs;

  pinCountdownInterval = setInterval(() => {
    pollSecs--;
    countdown.textContent = pollSecs;
    if (pollSecs <= 0) {
      clearInterval(pinCountdownInterval);
      clearInterval(pinPollInterval);
      if (valEl.textContent === '···') {
        valEl.textContent = '?';
        el.textContent = '✗ Device did not report PIN within 45 s — check FCM / Device Admin status';
        el.className   = 'cmd-result error';
      }
    }
  }, 1000);

  pinPollInterval = setInterval(async () => {
    if (pollSecs <= 0) { clearInterval(pinPollInterval); return; }
    const reveal = await apiFetch(`/api/pin/reveal/${selectedDeviceId}`);
    if (reveal.success && reveal.pin) {
      // PIN arrived!
      clearInterval(pinPollInterval);
      clearInterval(pinCountdownInterval);
      valEl.textContent = reveal.pin;
      countdown.textContent = '60';
      el.textContent = '✓ System PIN set on device — read this PIN to the borrower';
      el.className   = 'cmd-result';
      toast(`Device PIN ready: ${reveal.pin} — read it to the borrower`, 'success');

      // Auto-hide after 60 s
      let hideSecs = 60;
      countdown.textContent = hideSecs;
      pinCountdownInterval = setInterval(() => {
        hideSecs--;
        countdown.textContent = hideSecs;
        if (hideSecs <= 0) {
          clearInterval(pinCountdownInterval);
          box.style.display = 'none';
          valEl.textContent = '——';
        }
      }, 1000);

      openModal(selectedDeviceId);
    }
  }, 3000);
}

/**
 * Clear the active system PIN from the selected device.
 */
async function clearPinForDevice() {
  if (!selectedDeviceId) return;

  const btn = $('#cmd-clear-pin');
  btn.disabled = true;
  btn.textContent = 'Clearing…';

  const result = await apiFetch('/api/pin/clear', {
    method: 'POST',
    body:   JSON.stringify({ device_id: selectedDeviceId })
  });

  btn.disabled = false;
  btn.textContent = '✕ Clear System PIN';

  clearInterval(pinPollInterval);
  clearInterval(pinCountdownInterval);

  const el = $('#cmd-result');
  if (result.success) {
    el.textContent = '✓ CLEAR_SYSTEM_PIN sent — device real lockscreen PIN removed';
    el.className   = 'cmd-result';
    $('#pin-reveal-box').style.display = 'none';
    $('#pin-reveal-value').textContent = '——';
    toast(result.message || 'System PIN cleared', 'success');
    openModal(selectedDeviceId);
  } else {
    el.textContent = `✗ ${result.error || 'Failed'}`;
    el.className   = 'cmd-result error';
    toast(result.error || 'Clear PIN failed', 'error');
  }
}

async function quickCommand(deviceId, command) {
  const result = await sendCommand(deviceId, command);
  if (result.success) {
    toast(`${command} sent successfully`, 'success');
    refresh();
  } else {
    toast(result.error || 'Command failed', 'error');
  }
}

async function modalCommand(command) {
  if (!selectedDeviceId) return;
  const reason = $('#cmd-lock-reason').value.trim();
  const result = await sendCommand(
    selectedDeviceId, command,
    reason ? { lock_reason: reason } : {}
  );
  const el = $('#cmd-result');
  if (result.success) {
    el.textContent = `✓ ${command} sent`;
    el.className   = 'cmd-result';
    toast(`${command} sent`, 'success');
    openModal(selectedDeviceId);
    refresh();
  } else {
    el.textContent = `✗ ${result.error || 'Failed'}`;
    el.className   = 'cmd-result error';
    toast(result.error || 'Command failed', 'error');
  }
}

// ─── Payments ──────────────────────────────────────────────────

let payStatusFilter = 'pending';

function payStatusBadge(status) {
  const map = {
    pending:  '<span class="status-badge s-registered">⏳ Pending</span>',
    verified: '<span class="status-badge s-active">✓ Verified</span>',
    rejected: '<span class="status-badge s-locked">✗ Rejected</span>'
  };
  return map[status] || status;
}

async function loadPayments() {
  const data = await apiFetch(`/api/payment/pending?status=${payStatusFilter}&limit=100`);
  if (!data.success) return;

  // Update sidebar badge (pending count)
  if (payStatusFilter === 'pending' || payStatusFilter === 'all') {
    const pending = (data.references || []).filter(r => r.status === 'pending').length;
    $('#badge-payments').textContent = pending;
  }

  const tbody = $('#payments-tbody');
  if (!data.references?.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-muted" style="text-align:center;padding:32px">No ${payStatusFilter} references</td></tr>`;
    return;
  }

  tbody.innerHTML = data.references.map(r => `
    <tr>
      <td><strong>${r.borrower_id}</strong></td>
      <td class="mono">${r.loan_id}</td>
      <td class="mono" style="font-size:14px;letter-spacing:.05em">${r.mpesa_ref}</td>
      <td>TSh ${r.amount_claimed ? Number(r.amount_claimed).toLocaleString() : '—'}</td>
      <td class="text-muted">${timeAgo(r.submitted_at)}</td>
      <td>${payStatusBadge(r.status)}</td>
      <td>
        ${r.status === 'pending' ? `
          <div class="action-group">
            <input id="amt-${r.id}" type="number" placeholder="TSh iliyolipwa"
              style="width:90px;background:var(--surface2);border:1px solid var(--border);
                     border-radius:6px;padding:4px 8px;color:var(--text-primary);font-size:12px"
              value="${r.amount_claimed || ''}" />
            <button class="btn btn-xs btn-green" onclick="verifyPayment('${r.id}', '${r.borrower_id}')">Verify &amp; Unlock</button>
            <button class="btn btn-xs btn-danger" onclick="rejectPayment('${r.id}')">Reject</button>
          </div>` : `<span class="text-muted">${r.reviewer_note || '—'}</span>`}
      </td>
    </tr>`).join('');
}

async function verifyPayment(refId, borrowerId) {
  const amtInput = $(`#amt-${refId}`);
  const amount   = amtInput?.value ? Number(amtInput.value) : null;

  const result = await apiFetch(`/api/payment/verify/${refId}`, {
    method: 'POST',
    body:   JSON.stringify({ verified_by: 'admin', amount_paid: amount })
  });
  if (result.success) {
    toast(`✓ Verified! ${result.action === 'REMOVE_ADMIN' ? 'Device fully released.' : 'Device unlocked.'}`, 'success');
    loadPayments();
  } else {
    toast(result.error || 'Verify failed', 'error');
  }
}

async function rejectPayment(refId) {
  const note = prompt('Rejection reason (shown to borrower):') || 'Reference could not be verified';
  const result = await apiFetch(`/api/payment/reject/${refId}`, {
    method: 'POST',
    body:   JSON.stringify({ verified_by: 'admin', reviewer_note: note })
  });
  if (result.success) {
    toast('Reference rejected', 'success');
    loadPayments();
  } else {
    toast(result.error || 'Reject failed', 'error');
  }
}

async function reviewTamper(logId, btn) {
  btn.disabled = true;
  const result = await apiFetch(`${API}/tamper-logs/${logId}/review`, { method: 'POST' });
  if (result.success) {
    btn.closest('.tamper-item').classList.add('reviewed');
    btn.remove();
    toast('Marked as reviewed', 'success');
  } else {
    btn.disabled = false;
    toast('Failed to mark reviewed', 'error');
  }
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function refresh() {
  clearTimeout(refreshTimer);
  const loaders = {
    dashboard: loadDashboard,
    devices:   loadDevices,
    tamper:    loadTamperLog,
    loans:     loadLoans,
    payments:  loadPayments
  };
  loaders[currentView]?.().catch(console.error);
  $('#last-refresh').textContent = 'Updated ' + new Date().toLocaleTimeString('en-TZ', { hour:'2-digit', minute:'2-digit' });
  refreshTimer = setTimeout(refresh, REFRESH);
}

document.addEventListener('DOMContentLoaded', () => {
  $$('.nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));

  $$('#view-devices .chip[data-status]').forEach(chip => {
    chip.addEventListener('click', () => {
      deviceFilter = chip.dataset.status;
      $$('#view-devices .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      loadDevices();
    });
  });

  $$('#view-tamper .chip[data-sev]').forEach(chip => {
    chip.addEventListener('click', () => {
      tamperSevFilter = chip.dataset.sev;
      $$('#view-tamper .chip[data-sev]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      loadTamperLog();
    });
  });

  // Unreviewed toggle chip — fixes broken filter that had no listener
  $$('#view-tamper .chip[data-reviewed]').forEach(chip => {
    chip.addEventListener('click', () => {
      const isActive = chip.classList.contains('active');
      if (isActive) {
        // toggle off → show all
        tamperRevFilter = null;
        chip.classList.remove('active');
      } else {
        tamperRevFilter = chip.dataset.reviewed; // 'false' → only unreviewed
        chip.classList.add('active');
      }
      loadTamperLog();
    });
  });

  $$('#view-payments .chip[data-pay-status]').forEach(chip => {
    chip.addEventListener('click', () => {
      payStatusFilter = chip.dataset.payStatus;
      $$('#view-payments .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      loadPayments();
    });
  });

  $('#btn-refresh').addEventListener('click', refresh);

  let searchTimer;
  $('#search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refresh, 350);
  });

  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

  $('#cmd-lock').addEventListener('click',      () => modalCommand('LOCK_DEVICE'));
  $('#cmd-unlock').addEventListener('click',    () => modalCommand('UNLOCK_DEVICE'));
  $('#cmd-remove').addEventListener('click',    () => modalCommand('REMOVE_ADMIN'));
  $('#cmd-heartbeat').addEventListener('click', () => modalCommand('HEARTBEAT_REQUEST'));
  $('#cmd-set-pin').addEventListener('click',   () => setPinForDevice());
  $('#cmd-clear-pin').addEventListener('click', () => clearPinForDevice());

  refresh();
});

window.openModal        = openModal;
window.quickCommand     = quickCommand;
window.reviewTamper     = reviewTamper;
window.setPinForDevice  = setPinForDevice;
window.clearPinForDevice = clearPinForDevice;
window.verifyPayment    = verifyPayment;
window.rejectPayment    = rejectPayment;

