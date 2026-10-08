'use strict';
/**
 * POST /api/analyze-tree   { image_path }
 * The browser has already uploaded the (resized) image to Supabase Storage under
 * "<user-id>/<file>". We verify the user, download that file with the service role,
 * send it to Gemini, validate the JSON and return it. Nothing is saved here.
 */
const { BUCKET, IMAGE_PATH_RE, admin, anonClient, fail, send, allow, readBody, requireUser, rateLimit } = require('./_lib/common');
const { analyzeImage, GeminiError } = require('./_lib/gemini');
const { validateAnalysis } = require('./_lib/validate');

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

function sniffMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

module.exports = async (req, res) => {
  if (!allow(req, res, ['POST'])) return;
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  if (!rateLimit(`analyze:${user.id}`, 20, 60 * 60 * 1000)) {
    return fail(res, 429, 'RATE_LIMITED', 'You have reached the hourly scan limit. Please try again a little later.');
  }

  const body = readBody(req);
  const imagePath = body && body.image_path;
  if (typeof imagePath !== 'string' || !IMAGE_PATH_RE.test(imagePath)) {
    return fail(res, 400, 'NO_IMAGE', 'Please choose an image to scan.');
  }
  if (!imagePath.startsWith(`${user.id}/`)) {
    return fail(res, 403, 'FORBIDDEN', 'That image does not belong to your account.');
  }

  // 1) fetch the stored image
  let buf;
  try {
    const { data, error } = await admin().storage.from(BUCKET).download(imagePath);
    if (error || !data) return fail(res, 404, 'IMAGE_NOT_FOUND', 'We could not find the uploaded image. Please upload it again.');
    buf = Buffer.from(await data.arrayBuffer());
  } catch (e) {
    console.error('[analyze] storage download failed:', e && e.message);
    return fail(res, 502, 'STORAGE_ERROR', 'We could not read the uploaded image. Please try again.');
  }
  if (buf.length === 0) return fail(res, 400, 'INVALID_FILE', 'The image file is empty.');
  if (buf.length > MAX_BYTES) return fail(res, 413, 'FILE_TOO_LARGE', 'That image is too large. Please use one under 8 MB.');
  const mime = sniffMime(buf);
  if (!mime || !ALLOWED.has(mime)) return fail(res, 415, 'INVALID_FILE', 'Please upload a JPG, PNG or WebP image.');

  // 2) ask Gemini
  let rawText;
  try {
    rawText = await analyzeImage(buf.toString('base64'), mime);
  } catch (e) {
    if (e instanceof GeminiError) {
      if (e.code === 'GEMINI_BLOCKED') return fail(res, 422, 'IMAGE_REJECTED', 'The AI could not analyse this image. Please try a different photo.');
      if (e.code === 'NOT_CONFIGURED') return fail(res, 503, 'NOT_CONFIGURED', 'The AI service is not configured yet.');
      if (e.status === 429) return fail(res, 503, 'AI_BUSY', 'The AI service is busy right now. Please try again in a minute.');
      if (e.code === 'GEMINI_TIMEOUT') return fail(res, 504, 'AI_TIMEOUT', 'The analysis took too long. Please try again.');
    }
    console.error('[analyze] gemini failed:', e && e.code, e && e.message);
    return fail(res, 502, 'AI_ERROR', 'The AI service is unavailable right now. Please try again shortly.');
  }

  // 3) validate (never trust raw model output)
  const result = validateAnalysis(rawText);
  if (!result.ok) {
    if (result.code === 'NOT_A_TREE') return fail(res, 422, 'NOT_A_TREE', result.message);
    console.error('[analyze] invalid AI JSON');
    return fail(res, 502, 'INVALID_AI_RESPONSE', 'The AI gave an answer we could not use. Please try again.');
  }
  const analysis = result.analysis;

  // 4) link to our species catalogue when the scientific name matches
  let speciesMatch = null;
  try {
    speciesMatch = await findSpecies(analysis.scientific_name);
  } catch (e) {
    console.error('[analyze] species lookup failed:', e && e.message);
  }

  send(res, 200, { ok: true, image_path: imagePath, analysis, species: speciesMatch });
};

async function findSpecies(scientificName) {
  if (!scientificName || /^unknown$/i.test(scientificName)) return null;
  const clean = scientificName.replace(/[^A-Za-z .×-]/g, '').trim();
  if (clean.length < 4) return null;
  const { data } = await anonClient()
    .from('tree_species')
    .select('id, slug, name, tamil_name, scientific_name')
    .ilike('scientific_name', clean)
    .limit(1);
  return data && data[0] ? data[0] : null;
}

module.exports.sniffMime = sniffMime;
