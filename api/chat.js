'use strict';
// POST /api/chat  { messages:[{role:'user'|'bot', text}], context?:{...last scan summary} }
const { fail, send, allow, readBody, requireUser, rateLimit } = require('./_lib/common');
const { chat, GeminiError } = require('./_lib/gemini');

const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

module.exports = async (req, res) => {
  if (!allow(req, res, ['POST'])) return;
  const auth = await requireUser(req, res);
  if (!auth) return;
  if (!rateLimit(`chat:${auth.user.id}`, 60, 60 * 60 * 1000)) {
    return fail(res, 429, 'RATE_LIMITED', 'You are asking quite quickly. Please wait a little and try again.');
  }
  const body = readBody(req);
  if (!body || !Array.isArray(body.messages)) return fail(res, 400, 'BAD_REQUEST', 'Please type a question.');

  const messages = body.messages
    .slice(-10)
    .map((m) => ({ role: m && m.role === 'user' ? 'user' : 'model', text: clip(m && m.text, 1200) }))
    .filter((m) => m.text);
  // Gemini needs the conversation to start with, and end on, a user turn
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return fail(res, 400, 'BAD_REQUEST', 'Please type a question.');
  }

  let ctx = '';
  const c = body.context;
  if (c && typeof c === 'object') {
    ctx = [
      `Tree: ${clip(c.tree_name, 80)} (${clip(c.scientific_name, 100)})`,
      `Health: ${clip(c.health_status, 40)}; disease: ${clip(c.disease, 100)}; severity: ${clip(c.severity, 20)}`,
      c.symptoms && Array.isArray(c.symptoms) ? `Symptoms: ${c.symptoms.slice(0, 5).map((s) => clip(s, 160)).join('; ')}` : '',
    ].filter(Boolean).join('\n');
  }

  try {
    const reply = await chat(messages, ctx);
    if (!reply) return fail(res, 502, 'AI_ERROR', 'TreeAI could not answer that. Please try rephrasing.');
    send(res, 200, { ok: true, reply: reply.slice(0, 2000) });
  } catch (e) {
    console.error('[chat] failed:', e && e.code, e && e.message);
    if (e instanceof GeminiError && e.status === 429) return fail(res, 503, 'AI_BUSY', 'TreeAI is busy right now. Please try again in a minute.');
    fail(res, 502, 'AI_ERROR', 'TreeAI is unavailable right now. Please try again shortly.');
  }
};
