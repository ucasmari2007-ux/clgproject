'use strict';
/**
 * GET    /api/scan-history             -> latest scans (+ total)
 * GET    /api/scan-history?id=<uuid>   -> one scan
 * DELETE /api/scan-history?id=<uuid>   -> delete a scan and its image
 * All reads/writes use the user's token, so RLS limits them to the user's own rows.
 */
const { BUCKET, UUID_RE, admin, userClient, fail, send, allow, query, requireUser } = require('./_lib/common');

const COLUMNS =
  'id, species_id, image_path, tree_name, tamil_name, scientific_name, family, plant_part, confidence, health_status, ' +
  'disease, disease_confidence, severity, summary, symptoms, causes, treatment, prevention, observations, created_at';

async function withImageUrls(rows) {
  const paths = rows.map((r) => r.image_path).filter(Boolean);
  const urlMap = {};
  if (paths.length) {
    const { data } = await admin().storage.from(BUCKET).createSignedUrls(paths, 3600);
    (data || []).forEach((d) => { if (d && d.path && d.signedUrl) urlMap[d.path] = d.signedUrl; });
  }
  return rows.map((r) => ({ ...r, image_url: urlMap[r.image_path] || null }));
}

module.exports = async (req, res) => {
  if (!allow(req, res, ['GET', 'DELETE'])) return;
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, token } = auth;
  const db = userClient(token);
  const q = query(req);
  const id = typeof q.id === 'string' ? q.id : '';

  if (id && !UUID_RE.test(id)) return fail(res, 400, 'BAD_REQUEST', 'Invalid scan id.');

  try {
    if (req.method === 'DELETE') {
      if (!id) return fail(res, 400, 'BAD_REQUEST', 'Missing scan id.');
      const { data: row, error } = await db.from('scan_results').select('id, image_path').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!row) return fail(res, 404, 'NOT_FOUND', 'Scan not found.');
      const { error: delErr } = await db.from('scan_results').delete().eq('id', id);
      if (delErr) throw delErr;
      if (row.image_path && row.image_path.startsWith(`${user.id}/`)) {
        const { error: rmErr } = await admin().storage.from(BUCKET).remove([row.image_path]);
        if (rmErr) console.error('[scan-history] image removal failed:', rmErr.message);
      }
      return send(res, 200, { ok: true });
    }

    if (id) {
      const { data: row, error } = await db.from('scan_results').select(COLUMNS).eq('id', id).maybeSingle();
      if (error) throw error;
      if (!row) return fail(res, 404, 'NOT_FOUND', 'Scan not found.');
      const [withUrl] = await withImageUrls([row]);
      return send(res, 200, { ok: true, scan: withUrl });
    }

    const limit = Math.max(1, Math.min(100, parseInt(q.limit, 10) || 60));
    let qb = db.from('scan_results').select(COLUMNS, { count: 'exact' }).order('created_at', { ascending: false }).limit(limit);
    if (typeof q.before === 'string' && !Number.isNaN(Date.parse(q.before))) qb = qb.lt('created_at', q.before);
    const { data, error, count } = await qb;
    if (error) throw error;
    send(res, 200, { ok: true, total: count || 0, scans: await withImageUrls(data || []) });
  } catch (e) {
    console.error('[scan-history] failed:', e && (e.code || ''), e && e.message);
    fail(res, 500, 'DB_ERROR', 'We could not load your scans. Please try again.');
  }
};
