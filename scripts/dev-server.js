'use strict';
/**
 * Local development server (no extra dependencies).
 *   npm run dev   ->  http://localhost:3000
 * Serves /public and runs the same /api handlers that Vercel runs in production.
 * (You can also use `npx vercel dev` if you prefer.)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const API = path.join(ROOT, 'api');

// minimal .env loader (never overrides variables that are already set)
(function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  let name = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  const query = Object.fromEntries(url.searchParams.entries());
  const treeMatch = /^tree\/([^/]+)$/.exec(name);
  if (treeMatch) { name = 'tree'; query.id = decodeURIComponent(treeMatch[1]); }
  if (!/^[a-z0-9-]+$/.test(name) || !fs.existsSync(path.join(API, `${name}.js`))) {
    res.statusCode = 404; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND', error: 'Not found.' }));
  }
  req.query = query;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    try { req.body = await readBody(req); } catch { res.statusCode = 413; return res.end('{"ok":false}'); }
  }
  try {
    await require(path.join(API, `${name}.js`))(req, res);
  } catch (e) {
    console.error('[dev-server] unhandled error in /api/' + name, e);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); }
    res.end(JSON.stringify({ ok: false, code: 'SERVER_ERROR', error: 'Something went wrong on our side.' }));
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.statusCode = 403; return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(data);
  });
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return serveStatic(req, res, url);
}).listen(PORT, () => {
  console.log(`TreeAI running at http://localhost:${PORT}`);
  const missing = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
  if (missing.length) console.warn('Missing environment variables: ' + missing.join(', ') + '  (copy .env.example to .env and fill them in)');
});
