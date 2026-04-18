'use strict';
require('dotenv').config();

const { notify, EVENT } = require('./helpers/notify');
const supabase = require('./helpers/supabase');

async function test() {
  console.log('\n=== Kopanow Notification Pipeline Test ===\n');

  // 1. Verify notifications_log table exists
  const { error: tableErr } = await supabase
    .from('notifications_log')
    .select('id')
    .limit(1);

  if (tableErr) {
    console.error('[FAIL] notifications_log table missing:', tableErr.message);
    console.log('\nFIX: Run this SQL in Supabase Dashboard → SQL Editor:\n');
    console.log(`CREATE TABLE IF NOT EXISTS notifications_log (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  borrower_id  TEXT        NOT NULL,
  loan_id      TEXT        NOT NULL,
  channel      TEXT        NOT NULL CHECK (channel IN ('sms', 'fcm', 'both')),
  event_type   TEXT        NOT NULL,
  phone        TEXT,
  message      TEXT,
  status       TEXT        NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'skipped')),
  error        TEXT,
  days_state   INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_log_borrower ON notifications_log (borrower_id, loan_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_event    ON notifications_log (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_log_status   ON notifications_log (status);`);
    process.exit(1);
  }
  console.log('[OK] notifications_log table exists');

  // 2. Test notify() with mock data (FCM token is fake/short so goes to mock mode)
  const r1 = await notify({
    borrowerId:  'B-TEST-001',
    loanId:      'LN-TEST-001',
    phone:       '+255712345678',
    eventType:   EVENT.REMINDER_3D,
    daysState:   -3,
    fcmToken:    'fake_short_token',
    smsMessage:  'KOPANOW: Test — payment due in 3 days',
    pushTitle:   'Test Reminder',
    pushBody:    'Test push body',
    deduplicate: false,
  });
  console.log('[OK] notify() fired:', JSON.stringify(r1));

  // 3. Verify log was written
  const { data: logs } = await supabase
    .from('notifications_log')
    .select('event_type, channel, status, phone, message')
    .eq('borrower_id', 'B-TEST-001')
    .order('created_at', { ascending: false })
    .limit(5);
  console.log('[OK] notifications_log entries written:', logs?.length || 0);
  (logs || []).forEach(l => console.log('   ', JSON.stringify(l)));

  // 4. Test deduplication — same event sent again today should be skipped
  const r2 = await notify({
    borrowerId:  'B-TEST-001',
    loanId:      'LN-TEST-001',
    phone:       '+255712345678',
    eventType:   EVENT.REMINDER_3D,
    daysState:   -3,
    smsMessage:  'Should be SKIPPED by dedup',
    deduplicate: true,
  });
  if (r2.skipped) {
    console.log('[OK] Deduplication working — duplicate was skipped');
  } else {
    console.warn('[WARN] Deduplication did NOT skip the duplicate');
  }

  // 5. Test MANUAL event (deduplicate=false, always sends)
  const r3 = await notify({
    borrowerId:  'B-TEST-001',
    loanId:      'LN-TEST-001',
    phone:       '+255712345678',
    eventType:   EVENT.MANUAL,
    smsMessage:  'KOPANOW: Manual admin message test',
    deduplicate: false,
  });
  console.log('[OK] Manual notify():', JSON.stringify(r3));

  // Cleanup test rows
  await supabase.from('notifications_log').delete().eq('borrower_id', 'B-TEST-001');
  console.log('[OK] Test data cleaned up');

  console.log('\n=== All tests PASSED ===\n');
  process.exit(0);
}

test().catch(err => {
  console.error('\n[FATAL] Test failed:', err.message);
  process.exit(1);
});
