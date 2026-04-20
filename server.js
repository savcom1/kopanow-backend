'use strict';

/**
 * Kopanow API entry: Android app + admin/accounting UIs.
 */
require('dotenv').config();

const path = require('path');
const express = require('express');

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

const adminStatic = path.join(__dirname, 'admin');
const accountingStatic = path.join(__dirname, 'accounting');

app.use('/admin', express.static(adminStatic));
app.use('/accounting', express.static(accountingStatic));

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>Kopanow backend</title></head>
<body style="font-family:system-ui;padding:2rem;">
  <h1>Kopanow</h1>
  <ul>
    <li><a href="/admin/">Admin (operations)</a> — devices, tamper, lipa ops</li>
    <li><a href="/accounting/">Accounting</a> — borrowers, loans, Lipa cash-in, reports</li>
  </ul>
  <p>API: <code>/api/admin/*</code>, <code>/api/accounting/*</code>, <code>/api/loan/*</code>, <code>/api/device/*</code>, …</p>
</body></html>`);
});

const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, () => {
  console.log(`[kopanow-backend] listening on http://localhost:${port}`);
});
