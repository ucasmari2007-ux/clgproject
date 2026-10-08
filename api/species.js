'use strict';
// GET /api/species[?category=Fruit]  -> public catalogue of Tamil Nadu tree species.
const { anonClient, configured, fail, send, allow, query } = require('./_lib/common');

module.exports = async (req, res) => {
  if (!allow(req, res, ['GET'])) return;
  if (!configured()) return fail(res, 503, 'NOT_CONFIGURED', 'The app is not configured yet.');
  try {
    const q = query(req);
    let qb = anonClient()
      .from('tree_species')
      .select('id, slug, name, tamil_name, scientific_name, family, category, color_from, color_to')
      .order('name', { ascending: true });
    if (typeof q.category === 'string' && q.category && q.category !== 'All') qb = qb.eq('category', q.category.slice(0, 40));
    const { data, error } = await qb;
    if (error) throw error;
    send(res, 200, { ok: true, species: data || [] });
  } catch (e) {
    console.error('[species] failed:', e && e.message);
    fail(res, 500, 'DB_ERROR', 'We could not load the tree catalogue.');
  }
};
