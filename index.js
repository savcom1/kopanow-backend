require('dotenv').config();

const express   = require('express');
const mongoose  = require('mongoose');

const deviceRoutes  = require('./routes/device');
const paymentRoutes = require('./routes/payments');
const { registerCronJobs } = require('./cron/jobs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(express.json());

// ── Routes ─────────────────────────────────────────────────────────────────

app.use('/api/device', deviceRoutes);
app.use('/api/mpesa',  paymentRoutes);

// Health-check — Render pings this to verify the service is up
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  ts:     new Date().toISOString()
}));

// ── MongoDB + startup ──────────────────────────────────────────────────────

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('[mongo] connected to MongoDB Atlas');
    app.listen(PORT, () => {
      console.log(`[server] listening on port ${PORT}`);
      // Start cron jobs only after DB is ready
      registerCronJobs();
    });
  })
  .catch(err => {
    console.error('[mongo] connection failed:', err.message);
    process.exit(1);
  });
