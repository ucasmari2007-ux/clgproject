'use strict';
/**
 * Validation / normalisation of the AI's JSON. We never trust raw model output:
 * every field is type-checked, trimmed, length-limited and cross-checked.
 */

const HEALTH = ['Healthy', 'Minor concerns', 'Needs attention', 'Unhealthy', 'Unknown'];
const SEVERITY = ['None', 'Low', 'Moderate', 'High', 'Unknown'];
const PARTS = ['Whole tree', 'Leaf', 'Bark', 'Fruit', 'Flower', 'Seed', 'Branch', 'Other', 'Unknown'];
const QUALITY = ['Good', 'Fair', 'Poor'];

const DISCLAIMER =
  'This is an AI assessment based only on the visible image, not a laboratory diagnosis. ' +
  'For important decisions, confirm with a qualified agricultural or forestry expert ' +
  '(for example your local Krishi Vigyan Kendra or a TNAU extension officer).';

function str(v, max, fallback = 'Unknown') {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return fallback;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function list(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = str(item, maxLen, '');
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function pct(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  const scaled = n > 0 && n <= 1 ? n * 100 : n; // tolerate 0–1 scale
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

function oneOf(v, allowed, fallback) {
  if (typeof v !== 'string') return fallback;
  const hit = allowed.find((a) => a.toLowerCase() === v.trim().toLowerCase());
  return hit || fallback;
}

const isUnknown = (s) => !s || /^(unknown|n\/a|none|not applicable|not visible)$/i.test(s.trim());
const NO_DISEASE = /^(none|no disease|none visible|no visible disease|no visible symptoms|not applicable|n\/a|healthy)/i;

/**
 * @returns {{ ok: true, analysis: object } | { ok: false, code: string, message: string }}
 */
function validateAnalysis(raw) {
  let data = raw;
  if (typeof data === 'string') {
    const cleaned = data.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { data = JSON.parse(cleaned); } catch {
      return { ok: false, code: 'INVALID_AI_RESPONSE', message: 'The AI returned an unreadable answer.' };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'INVALID_AI_RESPONSE', message: 'The AI returned an unexpected answer.' };
  }

  const isTree = data.is_valid_tree_image === true || data.is_valid_tree_image === 'true';
  if (!isTree) {
    return {
      ok: false,
      code: 'NOT_A_TREE',
      message: str(
        data.rejection_reason,
        240,
        'This does not look like a tree or plant photo. Please upload a clear picture of a tree, leaf, bark or fruit.'
      ),
    };
  }

  const a = {
    tree_name: str(data.tree_name, 80),
    tamil_name: str(data.tamil_name, 80),
    scientific_name: str(data.scientific_name, 120),
    family: str(data.family, 80),
    plant_part: oneOf(data.plant_part, PARTS, 'Unknown'),
    image_quality: oneOf(data.image_quality, QUALITY, 'Fair'),
    confidence: pct(data.confidence),
    health_status: oneOf(data.health_status, HEALTH, 'Unknown'),
    disease: str(data.disease, 120),
    disease_confidence: pct(data.disease_confidence),
    severity: oneOf(data.severity, SEVERITY, 'Unknown'),
    summary: str(data.summary, 900, ''),
    symptoms: list(data.symptoms, 8, 220),
    causes: list(data.causes, 8, 220),
    treatment: list(data.treatment, 8, 260),
    prevention: list(data.prevention, 8, 240),
    observations: list(data.observations, 8, 240),
  };

  // ---- cross-field consistency rules ----
  if (isUnknown(a.tree_name)) {
    a.tree_name = 'Unknown';
    a.tamil_name = 'Unknown';
    a.scientific_name = 'Unknown';
    a.family = 'Unknown';
    a.confidence = Math.min(a.confidence, 30);
  }
  if (a.confidence < 40 && a.tree_name !== 'Unknown') {
    a.observations.unshift('Identification confidence is low — try a clearer, closer photo of the leaves, bark or fruit.');
  }

  if (NO_DISEASE.test(a.disease)) {
    a.disease = 'None visible';
    a.disease_confidence = 0;
    if (a.severity === 'Unknown' || a.severity === 'Low' || a.severity === 'Moderate' || a.severity === 'High') {
      a.severity = a.health_status === 'Healthy' ? 'None' : a.severity;
    }
  } else if (isUnknown(a.disease)) {
    a.disease = 'Unknown';
    a.disease_confidence = Math.min(a.disease_confidence, 30);
  }
  if (a.health_status === 'Healthy' && a.disease === 'None visible') {
    a.severity = 'None';
    a.symptoms = [];
    a.causes = [];
  }
  if (a.health_status === 'Unknown' && a.disease === 'Unknown') {
    a.severity = 'Unknown';
  }
  if (!a.summary) {
    a.summary = a.tree_name === 'Unknown'
      ? 'The tree could not be identified with confidence from this image.'
      : `${a.tree_name} identified from the uploaded image.`;
  }

  a.disclaimer = DISCLAIMER;
  return { ok: true, analysis: a };
}

/** Re-validates an analysis coming back from the browser before it is saved. */
function validateForSave(input) {
  if (!input || typeof input !== 'object') return { ok: false, code: 'BAD_REQUEST', message: 'Missing analysis.' };
  return validateAnalysis({ ...input, is_valid_tree_image: true });
}

module.exports = { validateAnalysis, validateForSave, DISCLAIMER, HEALTH, SEVERITY, PARTS, QUALITY };
