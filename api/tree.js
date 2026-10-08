'use strict';
// GET /api/tree/:id  (id = species uuid OR slug) -> species details + known diseases.
// vercel.json rewrites /api/tree/:id to /api/tree?id=:id
const { UUID_RE, anonClient, configured, fail, send, allow, query } = require('./_lib/common');

module.exports = async (req, res) => {
  if (!allow(req, res, ['GET'])) return;
  if (!configured()) return fail(res, 503, 'NOT_CONFIGURED', 'The app is not configured yet.');
  const id = String(query(req).id || '').trim();
  if (!id || id.length > 80 || !(UUID_RE.test(id) || /^[a-z0-9-]+$/.test(id))) {
    return fail(res, 400, 'BAD_REQUEST', 'Invalid tree id.');
  }
  try {
    const db = anonClient();
    const col = UUID_RE.test(id) ? 'id' : 'slug';
    const { data: tree, error } = await db.from('tree_species').select('*').eq(col, id).maybeSingle();
    if (error) throw error;
    if (!tree) return fail(res, 404, 'NOT_FOUND', 'Tree not found.');
    const { data: diseases, error: dErr } = await db
      .from('tree_diseases')
      .select('id, name, kind, severity, symptoms, causes, management, prevention')
      .eq('species_id', tree.id)
      .order('name', { ascending: true });
    if (dErr) throw dErr;
    send(res, 200, { ok: true, tree, diseases: diseases || [] });
  } catch (e) {
    console.error('[tree] failed:', e && e.message);
    fail(res, 500, 'DB_ERROR', 'We could not load this tree.');
  }
};
