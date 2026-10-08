'use strict';
/**
 * Shared helpers for every /api function.
 * Files whose names start with "_" are NOT exposed as routes by Vercel.
 */

const BUCKET = 'tree-images';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// image_path must look like: <user-uuid>/<file-name>
const IMAGE_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._-]{1,120}$/i;

let _admin = null;

function env(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

function configured() {
  return Boolean(env('SUPABASE_URL') && env('SUPABASE_ANON_KEY') && env('SUPABASE_SERVICE_ROLE_KEY'));
}

/** Service-role client (bypasses RLS). SERVER ONLY. */
function admin() {
  if (_admin) return _admin;
  const { createClient } = require('@supabase/supabase-js');
  _admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}

/** Client that acts as the signed-in user, so Row Level Security applies. */
function userClient(token) {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** Anonymous client for public reads (species catalogue). */
function anonClient() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message) {
  send(res, status, { ok: false, code, error: message });
}

function allow(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader('Allow', methods.join(', '));
  fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  return false;
}

function readBody(req) {
  let b = req.body;
  if (b == null) return {};
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { return null; }
  }
  return b && typeof b === 'object' ? b : null;
}

function query(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try {
    return Object.fromEntries(new URL(req.url, 'http://x').searchParams.entries());
  } catch {
    return {};
  }
}

/**
 * Verifies the Bearer token sent by the browser and returns { user, token }.
 * Sends the error response and returns null when the caller is not signed in.
 */
async function requireUser(req, res) {
  if (!configured()) {
    fail(res, 503, 'NOT_CONFIGURED', 'The server is not configured yet. Please try again later.');
    return null;
  }
  const header = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) {
    fail(res, 401, 'UNAUTHENTICATED', 'Please sign in to continue.');
    return null;
  }
  try {
    const { data, error } = await admin().auth.getUser(m[1]);
    if (error || !data || !data.user) {
      fail(res, 401, 'UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
      return null;
    }
    return { user: data.user, token: m[1] };
  } catch (e) {
    console.error('[auth] verification failed:', e && e.message);
    fail(res, 500, 'AUTH_ERROR', 'We could not verify your session. Please try again.');
    return null;
  }
}

/**
 * Best-effort in-memory rate limiter. On serverless each instance has its own
 * memory, so this is a safety net against accidental loops, not a hard quota.
 */
const _hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (_hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { _hits.set(key, arr); return false; }
  arr.push(now);
  _hits.set(key, arr);
  if (_hits.size > 5000) {
    for (const [k, v] of _hits) if (!v.some((t) => now - t < windowMs)) _hits.delete(k);
  }
  return true;
}

module.exports = {
  BUCKET, UUID_RE, IMAGE_PATH_RE,
  env, configured, admin, userClient, anonClient,
  send, fail, allow, readBody, query, requireUser, rateLimit,
};
