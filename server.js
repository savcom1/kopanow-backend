'use strict';

/**
 * Kopanow API entry: Android app + admin/accounting UIs.
 */
require('dotenv').config();

const path = require('path');
const express = require('express');
const firebaseAdmin = require('firebase-admin');

/**
 * FCM / device commands require Firebase Admin. Set one of:
 * - FIREBASE_SERVICE_ACCOUNT_JSON — full JSON object as a string (recommended on Render)
 * - GOOGLE_APPLICATION_CREDENTIALS — path to the service account .json file (local dev)
 */
function initFirebaseAdmin() {
  if (firebaseAdmin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && String(raw).trim()) {
    try {
      const cred = JSON.parse(raw);
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(cred),
      });
      console.log('[firebase] Firebase Admin initialised (FIREBASE_SERVICE_ACCOUNT_JSON)');
      return;
    } catch (e) {
      console.error('[firebase] FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON:', e.message);
    }
  }
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac && String(gac).trim()) {
    try {
      firebaseAdmin.initializeApp();
      console.log('[firebase] Firebase Admin initialised (GOOGLE_APPLICATION_CREDENTIALS)');
      return;
    } catch (e) {
      console.error('[firebase] GOOGLE_APPLICATION_CREDENTIALS init failed:', e.message);
    }
  }
  console.warn(
    '[firebase] Not configured — lock/unlock and other FCM device commands will fail. ' +
      'Set FIREBASE_SERVICE_ACCOUNT_JSON in Render (paste service account JSON) or GOOGLE_APPLICATION_CREDENTIALS locally.',
  );
}

initFirebaseAdmin();

const adminRouter = require('./routes/admin');
const accountingRouter = require('./routes/accounting');
const loanRouter = require('./routes/loan');
const deviceRouter = require('./routes/device');
const paymentRefRouter = require('./routes/payment-reference');
const mpesaRouter = require('./routes/mpesa');
const pinRouter = require('./routes/pin');
const lipaIngestRouter = require('./routes/lipa-ingest');
const notifyRouter = require('./routes/notify');
const provisionRouter = require('./routes/provision');
const loanOverviewRouter = require('./routes/loanoverview');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use('/api/admin', adminRouter);
app.use('/api/accounting', accountingRouter);
app.use('/api/loan', loanRouter);
app.use('/api/device', deviceRouter);
app.use('/api/payment', paymentRefRouter);
app.use('/api/mpesa', mpesaRouter);
app.use('/api/pin', pinRouter);
app.use('/api/lipa', lipaIngestRouter);
app.use('/api/notify', notifyRouter);
app.use('/api/provision', provisionRouter);
app.use('/api/admin/loanoverview', loanOverviewRouter);

const adminStatic = path.join(__dirname, 'admin');
const accountingStatic = path.join(__dirname, 'accounting');
const loanOverviewStatic = path.join(__dirname, 'loanoverview');

app.use('/admin', express.static(adminStatic));
app.use('/accounting', express.static(accountingStatic));
app.use('/loanoverview', express.static(loanOverviewStatic));

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>Kopanow backend</title></head>
<body style="font-family:system-ui;padding:2rem;">
  <h1>Kopanow</h1>
  <ul>
    <li><a href="/admin/">Admin (operations)</a> — devices, tamper, lipa ops</li>
    <li><a href="/accounting/">Accounting</a> — borrowers, loans, Lipa cash-in, reports</li>
    <li><a href="/loanoverview/">LoanOverview</a> — real-time KPIs (polling)</li>
  </ul>
  <p>API: <code>/api/admin/*</code>, <code>/api/accounting/*</code>, <code>/api/loan/*</code>, <code>/api/device/*</code>, …</p>
</body></html>`);
});

const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, () => {
  console.log(`[kopanow-backend] listening on http://localhost:${port}`);
});
