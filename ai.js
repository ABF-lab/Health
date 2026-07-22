/*
 * ai.js — Sehat Ledger
 *
 * Three model-backed capabilities, all Gemini:
 *
 *   1. readDeviceScreen  — vision: read digits off a glucometer or BP monitor
 *   2. generateReferral  — multilingual referral slip + counselling script
 *   3. followUpTurn      — the agent that chases the referral to completion
 *
 * Every call degrades to a deterministic mock if there is no key or the
 * network is unavailable. A demo that dies because the venue wifi died is
 * not a demo. Mocked responses are labelled as such in the UI, never
 * passed off as live model output.
 *
 * KEY HANDLING: the key is entered by the operator at runtime and kept in
 * localStorage on the device. It is never committed to the repository and
 * never sent anywhere except Google's endpoint. On a public deployment this
 * is a client-side key and should be restricted by referrer in Google AI
 * Studio, and rotated after the event.
 */

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER = 'https://openrouter.ai/api/v1';

export const AI_STATUS = { LIVE: 'live', MOCK: 'mock', ERROR: 'error' };

let lastStatus = AI_STATUS.MOCK;
let lastProvider = '';
export function getLastStatus() { return lastStatus; }
export function getLastProvider() { return lastProvider; }

/* ------------------------------------------------------------------ *
 * Providers
 *
 * Gemini free tier caps both per-minute and per-day. Hitting either mid-demo
 * would otherwise drop the app to labelled mock output at the worst possible
 * moment, so a second provider is tried before giving up.
 *
 * OpenRouter is the fallback because it is OpenAI-compatible, carries free
 * vision-capable models, and one key reaches many models — which also means
 * the model list is discovered at runtime rather than hardcoded and going
 * stale.
 * ------------------------------------------------------------------ */

export function cfg() {
  return {
    order: (localStorage.getItem('sl.order') || 'gemini,openrouter').split(','),
    gemini: {
      key: localStorage.getItem('sl.apiKey') || '',
      model: localStorage.getItem('sl.model') || 'gemini-flash-latest'
    },
    openrouter: {
      key: localStorage.getItem('sl.orKey') || '',
      model: localStorage.getItem('sl.orModel') || 'meta-llama/llama-4-scout:free'
    }
  };
}

export function hasKey() {
  const c = cfg();
  return !!(c.gemini.key || c.openrouter.key);
}

export function configuredProviders() {
  const c = cfg();
  return c.order.filter(p => c[p] && c[p].key);
}

/* A rate limit or quota exhaustion should move to the next provider.
   A bad request should not — that would just fail twice. */
function isRetryable(err) {
  const m = String(err && err.message || '');
  return /\b(429|503|500)\b/.test(m) || /quota|rate.?limit|exhausted|overloaded|capacity/i.test(m);
}

/* ---------------- Gemini ---------------- */

async function callGeminiProvider({ parts, schema, system, temperature }) {
  const { key, model } = cfg().gemini;
  if (!key) throw new Error('NO_KEY');

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, responseMimeType: 'application/json' }
  };
  if (schema) body.generationConfig.responseSchema = schema;
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await fetch(`${GEMINI}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 240)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text) throw new Error('Gemini returned an empty response');
  return text;
}

/* ---------------- OpenRouter (OpenAI-compatible) ---------------- */

/* Gemini part shape -> OpenAI content blocks */
function toOpenAIContent(parts) {
  return parts.map(p => {
    if (p.text) return { type: 'text', text: p.text };
    if (p.inline_data) {
      return {
        type: 'image_url',
        image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` }
      };
    }
    return null;
  }).filter(Boolean);
}

async function callOpenRouterProvider({ parts, schema, system, temperature }) {
  const { key, model } = cfg().openrouter;
  if (!key) throw new Error('NO_KEY');

  // json_schema support varies by model on OpenRouter; json_object plus an
  // explicit shape in the system prompt works everywhere.
  const shape = schema
    ? `\n\nReturn a single JSON object with exactly this shape, no prose:\n${JSON.stringify(schema)}`
    : '\n\nReturn a single JSON object, no prose.';

  const messages = [];
  if (system) messages.push({ role: 'system', content: system + shape });
  else messages.push({ role: 'system', content: shape });
  messages.push({ role: 'user', content: toOpenAIContent(parts) });

  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': location.origin,
      'X-Title': 'Sehat Ledger'
    },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: 'json_object' },
      messages
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${detail.slice(0, 240)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('OpenRouter returned an empty response');
  return text;
}

const PROVIDERS = { gemini: callGeminiProvider, openrouter: callOpenRouterProvider };

function parseJSON(text) {
  try { return JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Model did not return valid JSON');
  }
}

/* Try each configured provider in order, moving on only for rate limits
   and transient server errors. */
async function callModel({ parts, schema, system, temperature = 0.2 }) {
  const order = configuredProviders();
  if (!order.length) throw new Error('NO_KEY');

  let lastErr;
  for (const name of order) {
    try {
      const text = await PROVIDERS[name]({ parts, schema, system, temperature });
      lastProvider = name;
      return parseJSON(text);
    } catch (err) {
      lastErr = err;
      if (err.message === 'NO_KEY') continue;
      if (!isRetryable(err)) throw err;
      // rate limited: fall through to the next provider
    }
  }
  throw lastErr || new Error('NO_KEY');
}

/* ------------------------------------------------------------------ *
 * OpenRouter model discovery
 *
 * Model names churn. Ask the API which free models can accept an image
 * rather than baking in a list that expires.
 * ------------------------------------------------------------------ */

export async function listOpenRouterModels() {
  const { key } = cfg().openrouter;
  const res = await fetch(`${OPENROUTER}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {}
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const { data } = await res.json();

  return (data || [])
    .filter(m => {
      const p = m.pricing || {};
      const free = Number(p.prompt || 0) === 0 && Number(p.completion || 0) === 0;
      const mods = m.architecture?.input_modalities || [];
      return free && mods.includes('image');
    })
    .map(m => ({ id: m.id, label: m.name || m.id, ctx: m.context_length }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ *
 * Connection test
 *
 * Model aliases move. Rather than hardcoding a name that may 404 on the
 * morning of the event, ask the key what it can actually reach and let the
 * operator pick. Run this once at the venue, before the doors open.
 * ------------------------------------------------------------------ */

export async function listModels() {
  const { key } = cfg().gemini;
  if (!key) throw new Error('NO_KEY');

  const res = await fetch(`${GEMINI}?key=${encodeURIComponent(key)}&pageSize=100`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();

  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({
      id: m.name.replace(/^models\//, ''),
      label: m.displayName || m.name,
      inputTokens: m.inputTokenLimit
    }))
    // Prefer flash tiers: fast, cheap, and vision-capable, which is what a
    // volunteer on a cheap phone in a basement actually needs.
    .sort((a, b) => {
      const rank = s => (/flash/i.test(s) ? 0 : /pro/i.test(s) ? 1 : 2);
      return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id);
    });
}

export async function testConnection() {
  const { model } = cfg().gemini;
  const started = performance.now();

  let models;
  try {
    models = await listModels();
  } catch (err) {
    if (err.message === 'NO_KEY') return { ok: false, stage: 'key', message: 'No API key saved.' };
    return { ok: false, stage: 'auth', message: err.message, models: [] };
  }

  const available = models.some(m => m.id === model);

  try {
    const out = await callModel({
      temperature: 0,
      parts: [{ text: 'Reply with exactly {"ok":true} and nothing else.' }],
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
    });
    return {
      ok: true,
      stage: 'done',
      model,
      available,
      models,
      ms: Math.round(performance.now() - started),
      echoed: out?.ok === true
    };
  } catch (err) {
    return {
      ok: false, stage: 'generate', model, available, models,
      message: err.message
    };
  }
}

/* ------------------------------------------------------------------ *
 * 1. Vision — read the device screen
 * ------------------------------------------------------------------ */

const READING_SCHEMA = {
  type: 'object',
  properties: {
    deviceType: { type: 'string', enum: ['glucometer', 'bp_monitor', 'weighing_scale', 'unknown'] },
    glucose: { type: 'number', nullable: true },
    systolic: { type: 'number', nullable: true },
    diastolic: { type: 'number', nullable: true },
    pulse: { type: 'number', nullable: true },
    weightKg: { type: 'number', nullable: true },
    unit: { type: 'string', nullable: true },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: 'string' }
  },
  required: ['deviceType', 'confidence', 'note']
};

const VISION_SYSTEM = `You read numeric displays on low-cost medical devices used in community health screening in India.

Devices you will see: digital blood pressure monitors (show systolic over diastolic, plus pulse), glucometers (a single number, mg/dL in India), and digital weighing scales.

Rules:
- Report ONLY digits that are actually visible on the display. Never infer, never complete a partially visible number, never guess a plausible clinical value.
- If the image is blurred, glare-obscured, angled, or the display is off, set confidence to "low" and leave the numeric fields null. A refusal is far safer than a wrong vital sign.
- Indian glucometers report mg/dL. A glucose reading between 4 and 30 is almost certainly mmol/L; convert to mg/dL by multiplying by 18 and say so in the note.
- On a BP monitor the larger upper number is systolic, the lower is diastolic. Pulse is usually smaller and separately labelled, often with a heart icon.
- Keep the note under 15 words, describing what you could see.`;

export async function readDeviceScreen(base64, mimeType = 'image/jpeg') {
  try {
    const out = await callModel({
      system: VISION_SYSTEM,
      schema: READING_SCHEMA,
      temperature: 0,
      parts: [
        { text: 'Read the values from this device display.' },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    });
    lastStatus = AI_STATUS.LIVE;
    return { ...out, live: true };
  } catch (err) {
    if (err.message === 'NO_KEY') {
      lastStatus = AI_STATUS.MOCK;
      return mockReading();
    }
    lastStatus = AI_STATUS.ERROR;
    return { ...mockReading(), error: err.message };
  }
}

function mockReading() {
  const pick = Math.random();
  if (pick < 0.5) {
    return {
      deviceType: 'glucometer', glucose: 214, unit: 'mg/dL',
      confidence: 'high', note: 'Simulated reading, no API key configured.',
      live: false, mocked: true
    };
  }
  return {
    deviceType: 'bp_monitor', systolic: 156, diastolic: 94, pulse: 82,
    confidence: 'high', note: 'Simulated reading, no API key configured.',
    live: false, mocked: true
  };
}

/* ------------------------------------------------------------------ *
 * 2. Referral slip and counselling script
 * ------------------------------------------------------------------ */

const REFERRAL_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    body: { type: 'string' },
    whatToSay: { type: 'string' },
    dietNote: { type: 'string' },
    urgencyNote: { type: 'string' },
    englishGloss: { type: 'string' }
  },
  required: ['headline', 'body', 'whatToSay', 'dietNote', 'englishGloss']
};

const REFERRAL_SYSTEM = `You write referral slips handed to people screened at community health camps run out of mosques in Bengaluru.

The reader may have limited literacy. Many are daily-wage earners. Write for someone who will read this once, at home, possibly with a family member reading it aloud.

Hard rules:
- NEVER name a diagnosis. Do not write "you have diabetes" or "you are hypertensive". Write about the reading and what to do next.
- NEVER mention or adjust medication.
- Short sentences. Everyday words. No medical vocabulary without a plain-language gloss.
- Be direct about urgency without frightening. No alarm language.
- Dietary advice must be specific to how people here actually eat: rice, chapati, sweet tea, biryani at weddings, dates and sherbet at iftar. "Reduce carbohydrate intake" is useless advice and you must not write it.
- whatToSay is the exact words to say at the clinic reception, in the target language, so someone nervous is not lost for words.
- englishGloss is a faithful English translation of the body, for the volunteer's records.

Write in the requested language, in its own script.`;

export async function generateReferral({ record, assessment, language, facility, scheme }) {
  const summary = [
    `Age ${record.age}, ${record.sex === 'F' ? 'female' : 'male'}.`,
    assessment.bp ? `Blood pressure ${assessment.bp.systolic}/${assessment.bp.diastolic} (${assessment.bp.label}).` : '',
    assessment.glucose ? `Blood glucose ${assessment.glucose.value} mg/dL ${assessment.glucose.fasting ? 'fasting' : 'random'} (${assessment.glucose.label}).` : '',
    assessment.bmi ? `BMI ${assessment.bmi.value} (${assessment.bmi.label}).` : '',
    `IDRS ${assessment.idrs.total}, ${assessment.idrs.label}.`,
    `Screening outcome: ${assessment.title}.`
  ].filter(Boolean).join(' ');

  try {
    const out = await callModel({
      system: REFERRAL_SYSTEM,
      schema: REFERRAL_SCHEMA,
      temperature: 0.4,
      parts: [{
        text: `Language: ${language}
Screening findings: ${summary}
Refer to: ${facility}
Government scheme they may be entitled to: ${scheme}
Urgency: ${assessment.outcome}

Write the referral slip.`
      }]
    });
    lastStatus = AI_STATUS.LIVE;
    return { ...out, live: true };
  } catch (err) {
    if (err.message === 'NO_KEY') { lastStatus = AI_STATUS.MOCK; return mockReferral(facility, scheme, language); }
    lastStatus = AI_STATUS.ERROR;
    return { ...mockReferral(facility, scheme, language), error: err.message };
  }
}

function mockReferral(facility, scheme, language) {
  return {
    headline: 'Please see a doctor this week',
    body: `Your readings today were higher than they should be. This is not an emergency, but it does need a doctor to look at it properly.\n\nGo to ${facility}. Take this paper with you.\n\nThe visit is covered under ${scheme}, so you should not be asked to pay.`,
    whatToSay: '"I was screened at the community health camp. They asked me to show this paper to a doctor."',
    dietNote: 'Sweet tea is the easiest thing to change. Two cups a day with two spoons of sugar each adds up more than most people expect. Try one spoon this week, none the next.',
    urgencyNote: 'Within one week.',
    englishGloss: 'Simulated referral, no API key configured.',
    live: false, mocked: true,
    language
  };
}

/* ------------------------------------------------------------------ *
 * 3. Follow-up agent
 *
 * The agent that decides what to say next, classifies why someone has not
 * gone, and decides whether to escalate to the volunteer who screened them.
 * ------------------------------------------------------------------ */

export const BARRIERS = {
  went: { label: 'Attended', tone: 'ok' },
  location_unknown: { label: 'Does not know where', tone: 'warn' },
  timing_conflict: { label: 'Clinic hours clash with work', tone: 'warn' },
  cost_concern: { label: 'Worried about paying', tone: 'warn' },
  transport: { label: 'Cannot get there', tone: 'warn' },
  low_severity: { label: 'Does not think it is serious', tone: 'warn' },
  fear: { label: 'Afraid of the result', tone: 'warn' },
  no_response: { label: 'No reply', tone: 'high' },
  declined: { label: 'Asked to stop', tone: 'neutral' },
  unclear: { label: 'Unclear', tone: 'neutral' }
};

const AGENT_SCHEMA = {
  type: 'object',
  properties: {
    barrier: {
      type: 'string',
      enum: Object.keys(BARRIERS)
    },
    reply: { type: 'string' },
    englishGloss: { type: 'string' },
    action: { type: 'string', enum: ['await_reply', 'resolve_barrier', 'escalate_to_volunteer', 'mark_confirmed', 'stop'] },
    actionDetail: { type: 'string' },
    referralStatus: { type: 'string', enum: ['pending', 'confirmed', 'declined'] }
  },
  required: ['barrier', 'reply', 'englishGloss', 'action', 'referralStatus']
};

const AGENT_SYSTEM = `You are the follow-up assistant for a community health screening programme run by Active Bengaluru Foundation out of mosques in Bengaluru. You message people a few days after they were screened and given a referral.

Your only job is to find out whether they reached a doctor, and if not, to remove whatever is actually stopping them.

Hard rules:
- You are NOT a clinician. Never diagnose, never interpret a reading beyond what the slip already said, never discuss medication.
- Never repeat a reminder. If someone has not gone, find out WHY and address that specific obstacle. Repeating "please visit the clinic" is worse than saying nothing.
- People here are not indifferent. They are working. Assume a practical obstacle before assuming apathy.
- Warm, brief, respectful. Two or three short sentences. This is WhatsApp, not a letter.
- Use the person's language. Match their register.
- If they ask you to stop, stop immediately and set referralStatus to declined.
- After two messages with no reply, escalate to the volunteer rather than sending a third.
- Never discuss someone's health with anyone other than the person themselves.

Set action to:
  resolve_barrier        — you have identified the obstacle and your reply addresses it
  await_reply            — you have asked something and are waiting
  escalate_to_volunteer  — a human from the community needs to step in
  mark_confirmed         — they confirm they saw a doctor
  stop                   — they asked you to stop

englishGloss is a faithful English translation of your reply, for the volunteer's records.`;

export async function followUpTurn({ record, assessment, thread, language, facility, scheme, dayIndex }) {
  const transcript = thread.map(m => `${m.from === 'agent' ? 'Assistant' : 'Patient'}: ${m.text}`).join('\n');

  try {
    const out = await callModel({
      system: AGENT_SYSTEM,
      schema: AGENT_SCHEMA,
      temperature: 0.5,
      parts: [{
        text: `Person: ${record.name}, age ${record.age}, ${record.sex === 'F' ? 'female' : 'male'}
Language: ${language}
Screened: day 0. Today is day ${dayIndex}.
Referred to: ${facility}
Scheme they qualify for: ${scheme}
Urgency given on the slip: ${assessment.outcome}

Conversation so far:
${transcript || '(no messages yet, this is your first contact)'}

Write your next message.`
      }]
    });
    lastStatus = AI_STATUS.LIVE;
    return { ...out, live: true };
  } catch (err) {
    if (err.message === 'NO_KEY') { lastStatus = AI_STATUS.MOCK; return mockAgentTurn(thread, dayIndex); }
    lastStatus = AI_STATUS.ERROR;
    return { ...mockAgentTurn(thread, dayIndex), error: err.message };
  }
}

function mockAgentTurn(thread, dayIndex) {
  const last = thread.filter(m => m.from === 'patient').slice(-1)[0]?.text?.toLowerCase() || '';

  if (!thread.length) {
    return {
      barrier: 'unclear',
      reply: 'Assalamu alaikum. This is the health assistant from the Active Bengaluru Foundation camp. You were given a slip to show a doctor. Have you been able to go yet?',
      englishGloss: 'First contact, asking whether they attended.',
      action: 'await_reply', referralStatus: 'pending',
      actionDetail: 'Awaiting first reply.',
      live: false, mocked: true
    };
  }

  if (/went|yes|saw|doctor|gaya|gone/.test(last)) {
    return {
      barrier: 'went', reply: 'That is very good to hear. Did they give you any medicine to collect?',
      englishGloss: 'Confirming attendance and medication collection.',
      action: 'mark_confirmed', referralStatus: 'confirmed',
      actionDetail: 'Referral confirmed complete. Ledger credit written.',
      live: false, mocked: true
    };
  }

  if (/work|time|closed|shift|job|late/.test(last)) {
    return {
      barrier: 'timing_conflict',
      reply: 'That makes sense, most clinics close before people finish work. The Namma Clinic at Shivajinagar is open until 8pm and also on Sunday mornings. Would Sunday be easier?',
      englishGloss: 'Timing conflict identified. Offered an evening and Sunday alternative.',
      action: 'resolve_barrier', referralStatus: 'pending',
      actionDetail: 'Barrier: clinic hours. Alternative facility with evening hours offered.',
      live: false, mocked: true
    };
  }

  if (/money|pay|cost|afford|paisa|kharcha/.test(last)) {
    return {
      barrier: 'cost_concern',
      reply: 'You will not be asked to pay. This is covered under Ayushman Bharat, and the slip you have shows that. Show it at the reception desk.',
      englishGloss: 'Payment concern addressed by confirming scheme coverage.',
      action: 'resolve_barrier', referralStatus: 'pending',
      actionDetail: 'Barrier: perceived charge. Scheme entitlement confirmed.',
      live: false, mocked: true
    };
  }

  if (/where|address|which|kahan/.test(last)) {
    return {
      barrier: 'location_unknown',
      reply: 'It is the Namma Clinic on Shivajinagar main road, next to the bus stand. Open 9am to 8pm. Take the slip and show it at the front desk.',
      englishGloss: 'Location shared with landmark and opening hours.',
      action: 'resolve_barrier', referralStatus: 'pending',
      actionDetail: 'Barrier: location. Directions and hours sent.',
      live: false, mocked: true
    };
  }

  if (/fine|ok|nothing|not serious|theek/.test(last)) {
    return {
      barrier: 'low_severity',
      reply: 'Most people feel completely fine at this stage, that is exactly what makes it worth checking. It is one short visit and it is free. Shall I send the timings?',
      englishGloss: 'Addressed low perceived severity without alarming.',
      action: 'resolve_barrier', referralStatus: 'pending',
      actionDetail: 'Barrier: low perceived severity.',
      live: false, mocked: true
    };
  }

  if (dayIndex >= 10) {
    return {
      barrier: 'no_response',
      reply: '',
      englishGloss: 'No reply after two attempts. Handing to the volunteer.',
      action: 'escalate_to_volunteer', referralStatus: 'pending',
      actionDetail: 'Two attempts, no reply. Escalated to the volunteer who screened them.',
      live: false, mocked: true
    };
  }

  return {
    barrier: 'unclear',
    reply: 'Thank you for replying. Just so I can help properly, have you been able to see a doctor since the camp?',
    englishGloss: 'Clarifying attendance status.',
    action: 'await_reply', referralStatus: 'pending',
    actionDetail: 'Clarifying.',
    live: false, mocked: true
  };
}
