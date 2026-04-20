'use strict';

/**
 * Local / single-node entry: mounts Admin (ops) and Accounting APIs + static UIs.
 * Deployments that only register route modules should also:
 *   app.use('/api/admin', require('./routes/admin'));
 *   app.use('/api/accounting', require('./routes/accounting'));
 */
require('dotenv').config();

const path = require('path');
const express = require('express');

const adminRouter = require('./routes/admin');
const accountingRouter = require('./routes/accounting');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use('/api/admin', adminRouter);
app.use('/api/accounting', accountingRouter);

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
  <p>API: <code>/api/admin/*</code>, <code>/api/accounting/*</code></p>
</body></html>`);
});

const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, () => {
  console.log(`[kopanow-backend] listening on http://localhost:${port}`);
});
