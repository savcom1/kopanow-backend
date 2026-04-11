'use strict';
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[supabase] SUPABASE_URL or SUPABASE_SERVICE_KEY is missing from .env');
  process.exit(1);
}

/**
 * Single Supabase client for the entire backend.
 * Uses the service_role key so ALL operations bypass Row Level Security.
 * Never expose this key to the frontend or Android app — use the anon key there.
 */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

module.exports = supabase;
