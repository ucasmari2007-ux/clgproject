'use strict';
/**
 * POST /api/save-scan   { image_path, analysis, species_id? }
 * Saves a scan for the signed-in user. Uses the USER's token for database writes,
 * so Row Level Security guarantees a user can only write their own rows.
 */
const { BUCKET, IMAGE_PATH_RE, UUID_RE, admin, anonClient, userClient, fail, send, allow, readBody, requireUser, rateLimit } = require('./_lib/common');
const { validateForSave } = require('./_lib/validate');

module.exports = async (req, res) => {
  if (!allow(req, res, ['POST'])) return;
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, token } = auth;

  if (!rateLimit(`save:${user.id}`, 60, 60 * 60 * 1000)) {
    return fail(res, 429, 'RATE_LIMITED', 'Too many saves. Please try again a little later.');
  }

  const body = readBody(req);
  if (!body) return fail(res, 400, 'BAD_REQUEST', 'Invalid request.');
  const { image_path: imagePath } = body;
  if (typeof imagePath !== 'string' || !IMAGE_PATH_RE.test(imagePath) || !imagePath.startsWith(`${user.id}/`)) {
    return fail(res, 400, 'BAD_REQUEST', 'Invalid image reference.');
  }
  const checked = validateForSave(body.analysis);
  if (!checked.ok) return fail(res, 400, 'BAD_REQUEST', 'The scan result is not valid and could not be saved.');
  const a = checked.analysis;

  // the image must really exist in storage
  const signed = await admin().storage.from(BUCKET).createSignedUrl(imagePath, 3600);
  if (signed.error || !signed.data) {
    return fail(res, 404, 'IMAGE_NOT_FOUND', 'The scanned image is no longer available. Please scan again.');
  }

  // optional species link: trust the DB, not the browser
  let speciesId = null;
  if (typeof body.species_id === 'string' && UUID_RE.test(body.species_id)) {
    const { data } = await anonClient().from('tree_species').select('id').eq('id', body.species_id).limit(1);
    if (data && data[0]) speciesId = data[0].id;
  }

  const db = userClient(token);
  const row = {
    user_id: user.id,
    species_id: speciesId,
    image_path: imagePath,
    tree_name: a.tree_name,
    tamil_name: a.tamil_name,
    scientific_name: a.scientific_name,
    family: a.family,
    plant_part: a.plant_part,
    confidence: a.confidence,
    health_status: a.health_status,
    disease: a.disease,
    disease_confidence: a.disease_confidence,
    severity: a.severity,
    summary: a.summary,
    symptoms: a.symptoms,
    causes: a.causes,
    treatment: a.treatment,
    prevention: a.prevention,
    observations: a.observations,
    ai_model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  };

  const { data, error } = await db.from('scan_results').insert(row).select('id, created_at').single();
  if (error) {
    if (error.code === '23505') return fail(res, 409, 'ALREADY_SAVED', 'This scan is already saved.');
    console.error('[save-scan] insert failed:', error.code, error.message);
    return fail(res, 500, 'DB_ERROR', 'We could not save your scan. Please try again.');
  }

  if (a.symptoms.length) {
    const symptomRows = a.symptoms.map((s, i) => ({ scan_id: data.id, user_id: user.id, symptom: s, position: i }));
    const { error: sErr } = await db.from('scan_symptoms').insert(symptomRows);
    if (sErr) console.error('[save-scan] symptoms insert failed:', sErr.code, sErr.message); // non-fatal
  }

  send(res, 201, { ok: true, id: data.id, created_at: data.created_at, image_url: signed.data.signedUrl });
};
