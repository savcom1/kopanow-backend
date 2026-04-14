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
  // Online if seen in the last 5 minutes
  return Date.now() - new Date(lastSeen).getTime() < 5 * 60 * 1000;
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-TZ', { day:'numeric', month:'short', year:'numeric' });
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
      <td>${d.device_model || '—'}</td>
      <td>${statusBadge(d.status)}</td>
      <td class="text-muted">${d.last_seen ? timeAgo(d.last_seen) : '<span style="color:var(--amber)">New — no heartbeat yet</span>'}</td>
      <td>${d.loan ? `TSh ${Number(d.loan.outstanding_amount).toLocaleString()}` : '—'}</td>
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
    tbody.innerHTML = '<tr><td colspan="10" class="text-muted" style="text-align:center;padding:32px">No devices found.</td></tr>';
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
      <td class="text-muted">${d.last_seen ? timeAgo(d.last_seen) : '<span style="color:var(--amber)">New</span>'}</td>
      <td>${d.loan?.days_overdue > 0 ? `<span style="color:var(--red)">${d.loan.days_overdue}d</span>` : '—'}</td>
      <td>${d.loan ? `TSh ${Number(d.loan.outstanding_amount).toLocaleString()}` : '—'}</td>
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
  tbody.innerHTML = data.loans.map(l => `
    <tr>
      <td class="mono">${l.loan_id}</td>
      <td>${l.borrower_id}</td>
      <td>TZS ${Number(l.principal_amount).toLocaleString()}</td>
      <td><strong>TZS ${Number(l.outstanding_amount).toLocaleString()}</strong></td>
      <td>${fmtDate(l.next_due_date)}</td>
      <td>${l.days_overdue > 0 ? `<span style="color:var(--red)">${l.days_overdue} days</span>` : '<span style="color:var(--green)">Current</span>'}</td>
      <td>${statusBadge(l.device_status)}</td>
    </tr>`).join('');
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
  $('#modal-title').textContent = `${d.borrower_id} — ${d.loan_id}`;

  const fields = [
    ['Borrower ID',    d.borrower_id],
    ['Loan ID',        d.loan_id],
    ['Device ID',      d.device_id || '—'],
    ['Model',          d.device_model || '—'],
    ['Connectivity',   connectivityBadge(isOnline(d.last_seen))],
    ['Status',         statusBadge(d.status)],
    ['Locked',         d.is_locked ? '🔒 Yes' : '🔓 No'],
    ['Passcode Active',d.passcode_active
                         ? '<span style="color:#f0a500;font-weight:600">🔑 Yes</span>'
                         : '<span style="color:#888">No</span>'],
    ['Lock Reason',    d.lock_reason || '—'],
    ['Amount Due',     d.amount_due || '—'],
    ['Last Seen',      timeAgo(d.last_seen)],
    ['Outstanding',    l ? `TZS ${Number(l.outstanding_amount).toLocaleString()}` : '—'],
    ['Next Due',       l ? fmtDate(l.next_due_date) : '—'],
  ];

  $('#modal-body').innerHTML = fields.map(([label, val]) => `
    <div class="detail-row">
      <span class="detail-label">${label}</span>
      <span class="detail-value">${val}</span>
    </div>`).join('');

  $('#cmd-lock-reason').value = d.lock_reason || '';
}

function closeModal() {
  $('#modal-overlay').classList.remove('open');
  selectedDeviceId = null;
}

// ─── PIN / Passcode commands ─────────────────────────────────────────────────

let pinCountdownInterval = null;

/**
 * Generate a PIN for the selected device, push it via FCM, and show it
 * once in the reveal box for 60 seconds before auto-hiding.
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
  btn.textContent = '🔑 Set PIN';

  const el = $('#cmd-result');
  if (result.success) {
    el.textContent = '✓ PIN sent to device via FCM';
    el.className   = 'cmd-result';
    toast(`PIN sent! Show the code below to the borrower's support call.`, 'success');

    // Show reveal box
    const box       = $('#pin-reveal-box');
    const valEl     = $('#pin-reveal-value');
    const countdown = $('#pin-countdown');
    valEl.textContent = result.pin;   // raw PIN returned once from backend
    box.style.display = 'block';

    // Start 60-second countdown then hide
    let secs = 60;
    countdown.textContent = secs;
    clearInterval(pinCountdownInterval);
    pinCountdownInterval = setInterval(() => {
      secs--;
      countdown.textContent = secs;
      if (secs <= 0) {
        clearInterval(pinCountdownInterval);
        box.style.display = 'none';
        valEl.textContent = '——';   // clear from DOM
      }
    }, 1000);

    openModal(selectedDeviceId);  // refresh passcode_active field
  } else {
    el.textContent = `✗ ${result.error || 'Failed to set PIN'}`;
    el.className   = 'cmd-result error';
    toast(result.error || 'PIN delivery failed', 'error');
  }
}

/**
 * Clear the active PIN from the selected device.
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
  btn.textContent = '✕ Clear PIN';

  const el = $('#cmd-result');
  if (result.success) {
    el.textContent = '✓ PIN cleared';
    el.className   = 'cmd-result';
    // Also hide reveal box if still visible
    clearInterval(pinCountdownInterval);
    $('#pin-reveal-box').style.display = 'none';
    $('#pin-reveal-value').textContent = '——';
    toast('PIN cleared — device will receive CLEAR_PASSCODE command', 'success');
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

