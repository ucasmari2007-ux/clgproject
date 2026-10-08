'use strict';
// Public runtime config for the browser. Only values that are SAFE to expose:
// the Supabase project URL and the anon (public) key. Row Level Security protects the data.
const { env, send, fail, allow } = require('./_lib/common');

module.exports = async (req, res) => {
  if (!allow(req, res, ['GET'])) return;
  const supabaseUrl = env('SUPABASE_URL');
  const supabaseAnonKey = env('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    return fail(res, 503, 'NOT_CONFIGURED', 'The app is not configured yet.');
  }
  send(res, 200, { ok: true, supabaseUrl, supabaseAnonKey, maxUploadMB: 10 });
};
