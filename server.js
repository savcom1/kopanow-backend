'use strict';
require('dotenv').config();

const path    = require('path');
const express = require('express');
const admin   = require('firebase-admin');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Firebase Admin SDK
//    Skipped gracefully when credentials are placeholders (local dev without FCM).
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_READY = (() => {
  const projectId   = process.env.FIREBASE_PROJECT_ID   || '';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';

  // Support base64-encoded key (preferred for Render/cloud) OR raw key with escaped newlines
  let privateKey = '';
  if (process.env.FIREBASE_PRIVATE_KEY_BASE64) {
    privateKey = Buffer.from(process.env.FIREBASE_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
  } else {
    privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  }

  const isPlaceholder =
    !projectId || projectId.includes('your-') ||
    !clientEmail || clientEmail.includes('your-') ||
    !privateKey || privateKey.includes('YOUR_KEY_HERE');

  if (isPlaceholder) {
    console.warn('[firebase] Warning: Placeholder credentials - Firebase/FCM disabled.');
    return false;
  }
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
    }
    console.log('[firebase] Admin SDK initialised');
    return true;
  } catch (err) {
    console.error('[firebase] Init failed - FCM disabled:', err.message);
    return false;
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// 2. Routes
// ─────────────────────────────────────────────────────────────────────────────

const deviceRoutes    = require('./routes/device');
const paymentRoutes   = require('./routes/payment-reference');
const adminRoutes     = require('./routes/admin');
const pinRoutes       = require('./routes/pin');
const provisionRoutes = require('./routes/provision');
const loanRoutes      = require('./routes/loan');
const notifyRoutes    = require('./routes/notify');
const mpesaRoutes     = require('./routes/mpesa');
const lipaRoutes      = require('./routes/lipa-ingest');
const { startPaymentScheduler } = require('./cron/jobs');

// ─────────────────────────────────────────────────────────────────────────────
// 3. Express app
// ─────────────────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use('/api/device',    deviceRoutes);
app.use('/api/payment',   paymentRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/pin',       pinRoutes);
app.use('/api/provision', provisionRoutes);
app.use('/api/loan',      loanRoutes);
app.use('/api/notify',    notifyRoutes);
app.use('/api/mpesa',     mpesaRoutes);
app.use('/api/lipa',      lipaRoutes);

// Serve APK for QR-code provisioning downloads
// Place the signed APK at ./public/kopanow.apk  OR set APK_DOWNLOAD_URL to an external URL
app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/kopanow.apk', (_req, res) => {
  const apkPath = path.join(__dirname, 'public', 'kopanow.apk');
  if (require('fs').existsSync(apkPath)) {
    res.download(apkPath, 'kopanow.apk');
  } else {
    res.status(404).json({ error: 'APK not uploaded yet. Place kopanow.apk in /public/' });
  }
});

// Admin dashboard static files
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Root — helpful landing instead of 404
app.get('/', (_req, res) => res.json({
  service: 'kopanow-backend',
  status:  'running',
  admin:   '/admin',
  health:  '/health',
  api:     '/api/device (enrollment-check, register, …) | /api/admin | /api/payment | /api/mpesa | …',
  provision: '/admin/provision.html'
}));

// Health endpoint
app.get('/health', async (_req, res) => {
  const supabase = require('./helpers/supabase');
  let dbStatus = 'unknown';
  try {
    const { error } = await supabase.from('devices').select('id', { count: 'exact', head: true });
    if (error) {
      dbStatus = `error: ${error.message || error.code || error.details || JSON.stringify(error)}`;
    } else {
      dbStatus = 'connected';
    }
  } catch (e) {
    dbStatus = `error: ${e.message}`;
  }
  res.json({
    status:   'ok',
    service:  'kopanow-backend',
    version:  process.env.npm_package_version || '1.0.0',
    ts:       new Date().toISOString(),
    db:       dbStatus,
    firebase: FIREBASE_READY ? 'ready' : 'disabled'
  });
});

// 404 fallback
app.use((_req, res) => res.status(404).json({ success: false, error: 'Route not found' }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Supabase connectivity check → start server → start cron
// ─────────────────────────────────────────────────────────────────────────────

async function startServer() {
  const supabase = require('./helpers/supabase');

  // Quick connectivity ping (non-fatal — server starts even if Supabase is unreachable)
  const { error } = await supabase.from('devices').select('id', { count: 'exact', head: true });
  if (error) {
    console.warn('[supabase] ⚠️  Connection failed:', error.message);
    console.warn('[supabase] ⚠️  Server will start but DB-dependent endpoints may fail.');
    console.warn('[supabase] ⚠️  Check SUPABASE_URL / SUPABASE_SERVICE_KEY in .env');
  } else {
    console.log('[supabase] Connected to Supabase ✓');
  }

  app.listen(PORT, () => {
    console.log(`[server] Listening on port ${PORT}`);
    console.log(`[server] Admin UI  → http://localhost:${PORT}/admin`);
    console.log(`[server] Health    → http://localhost:${PORT}/health`);
    console.log(`[server] Device API:  /api/device/{enrollment-check,register,heartbeat,tamper,status,fcm-token}`);
    console.log(`[server] Payment API: /api/payment/{submit,status,retry-resolve,verify/:id,reject/:id,pending}`);
    console.log(`[server] Lipa SMS API: POST /api/lipa/transactions (X-Lipa-Ingest-Secret)`);
    console.log(`[server] AzamPay API:   POST /api/mpesa/stk-push`);
    console.log(`[server] Admin API:   /api/admin/{devices,…,accounting/*}`);
    console.log(`[server] PIN API:     /api/pin/{set,clear,verify}`);
    startPaymentScheduler();
  });
}

startServer().catch(err => {
  console.error('[server] Fatal startup error:', err.message);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────
process.on('SIGTERM', () => { console.log('[server] SIGTERM — shutting down'); process.exit(0); });
process.on('uncaughtException',  (err) => console.error('[server] Uncaught exception:', err.message));
process.on('unhandledRejection', (r)   => console.error('[server] Unhandled rejection:', r));
