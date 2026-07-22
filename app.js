/*
 * app.js — Sehat Ledger
 * Active Bengaluru Foundation
 *
 * Offline-first NCD screening for community volunteers.
 * All patient data stays in localStorage on this device. Nothing is
 * transmitted anywhere except the image sent to Gemini for digit recognition,
 * and only when the operator has configured a key.
 */

import { assess, fastingRisk, OUTCOME_META } from './clinical.js';
import { computeLedger, ASSUMPTIONS, formatINR, formatCompactINR } from './ledger.js';
import { readDeviceScreen, generateReferral, followUpTurn, hasKey, BARRIERS, testConnection } from './ai.js';
import * as sync from './sync.js';

/* ================================================================== *
 * Storage
 * ================================================================== */

const KEY = 'sl.records';
const SETTINGS_KEY = 'sl.settings';

const store = {
  records() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch { return []; }
  },
  save(records) { localStorage.setItem(KEY, JSON.stringify(records)); },
  upsert(rec) {
    // Stamp and mark dirty so the sync loop knows this needs pushing.
    // Local write always succeeds first; the network is never in the path.
    rec.updatedAt = new Date().toISOString();
    rec._dirty = true;
    const all = store.records();
    const i = all.findIndex(r => r.id === rec.id);
    if (i >= 0) all[i] = rec; else all.unshift(rec);
    store.save(all);
    kickSync();
    return rec;
  },
  get(id) { return store.records().find(r => r.id === id); },
  settings() {
    try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  },
  saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
};

/* ================================================================== *
 * Sync
 * ================================================================== */

const syncIO = {
  read: () => store.records(),
  save: recs => store.save(recs)
};

let kickTimer = null;
function kickSync() {
  if (!sync.isConfigured()) return;
  clearTimeout(kickTimer);
  kickTimer = setTimeout(() => sync.syncNow(syncIO), 800);
}

// A pull that changed anything should refresh whatever the user is looking at
sync.onSyncChange(st => {
  renderSyncPill(st);
  if (st.state === 'idle') RENDER[currentView]?.();
});

function renderSyncPill(st) {
  const el = $('#syncPill');
  if (!el) return;
  const map = {
    off:     ['mock', 'Local only'],
    idle:    ['live', 'Synced'],
    syncing: ['live', 'Syncing'],
    error:   ['mock', 'Sync error']
  };
  const [cls, label] = map[st.state] || map.off;
  el.className = `ai-chip ${cls}`;
  el.innerHTML = `<span class="dot"></span>${esc(label)}`;
  el.title = st.lastError || (st.lastSyncAt ? 'Last sync ' + st.lastSyncAt.toLocaleTimeString() : '');
}

const DEFAULT_SETTINGS = {
  centre: 'Masjid-e-Noor, Shivajinagar',
  volunteer: '',
  language: 'Urdu',
  assumptions: {}
};

/* ================================================================== *
 * Reference data
 * ================================================================== */

const CENTRES = [
  'Masjid-e-Noor, Shivajinagar',
  'Jamia Masjid, Chickpet',
  'Masjid-e-Bilal, Tannery Road',
  'Community Hall, Padarayanapura',
  'Masjid-e-Taqwa, RT Nagar'
];

const FACILITIES = {
  'Masjid-e-Noor, Shivajinagar': { name: 'Namma Clinic, Shivajinagar', hours: '9am to 8pm, Sunday mornings' },
  'Jamia Masjid, Chickpet': { name: 'UPHC Chickpet', hours: '9am to 4pm, Monday to Saturday' },
  'Masjid-e-Bilal, Tannery Road': { name: 'Namma Clinic, Tannery Road', hours: '9am to 8pm' },
  'Community Hall, Padarayanapura': { name: 'UPHC Padarayanapura', hours: '9am to 4pm' },
  'Masjid-e-Taqwa, RT Nagar': { name: 'Namma Clinic, RT Nagar', hours: '9am to 8pm' }
};

const SCHEME = 'Ayushman Bharat Arogya Karnataka';
const LANGUAGES = ['Urdu', 'Kannada', 'Hindi', 'Tamil', 'English'];
const RTL = ['Urdu'];

/* ================================================================== *
 * Small helpers
 * ================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const initials = n => n.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

// Lucide. Thin stroke, never filled.
const svg = (d, w = 1.8) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICON = {
  chev:   svg('<path d="M9 18l6-6-6-6"/>', 2),
  arrow:  svg('<path d="M5 12h14M12 5l7 7-7 7"/>', 2),
  camera: svg('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>', 1.6),
  spark:  svg('<path d="M12 3l1.9 5.8L20 10.7l-5.1 3.6L16 20l-4-3.2L8 20l1.1-5.7L4 10.7l6.1-1.9z"/>', 1.6),
  info:   svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  shield: svg('<path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.5 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/>', 1.6),
  empty:  svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h6"/>', 1.4),
  check:  svg('<path d="M20 6L9 17l-5-5"/>', 2.4),
  user:   svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', 1.6),
  heart:  svg('<path d="M19 14c1.5-1.5 3-3.3 3-5.5A5.5 5.5 0 0 0 12 5.4 5.5 5.5 0 0 0 2 8.5c0 2.2 1.5 4 3 5.5l7 7z"/>', 1.6),
  ruler:  svg('<path d="M21.3 8.7 8.7 21.3a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4z"/><path d="m7.5 10.5 2 2M10.5 7.5l2 2M13.5 4.5l2 2"/>', 1.6)
};

function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = esc(msg);
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}

function sheet(title, bodyHTML, onMount) {
  const root = $('#sheetRoot');
  root.innerHTML = `
    <div class="sheet-backdrop" data-close>
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheet-grip"></div>
        <div class="sheet-head">
          <h2 style="font-size:17px">${esc(title)}</h2>
          <button class="btn-ghost btn-sm" data-close>Done</button>
        </div>
        <div class="sheet-body">${bodyHTML}</div>
      </div>
    </div>`;
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', e => {
    if (e.target === b) closeSheet();
  }));
  if (onMount) onMount(root);
}
function closeSheet() { $('#sheetRoot').innerHTML = ''; }

// Header avatar shows the volunteer's initials, or a fallback glyph.
function updateAvatar() {
  const s = store.settings();
  const name = (s.volunteer || '').trim();
  const glyph = name ? esc(initials(name)) : ICON.user;

  const side = $('#profileAvatar');
  if (side) side.innerHTML = glyph;

  const mob = $('#mAvatar');
  if (mob) { mob.innerHTML = glyph; mob.title = name || 'Set volunteer name in Settings'; }

  const label = $('#profileName');
  if (label) label.textContent = name || 'Volunteer';

}

// Model status lives in Settings now, not the header. Guarded so it is safe
// to call from anywhere regardless of which view is mounted.
function updateAIChip() {
  const chip = $('#aiChip'), txt = $('#aiChipText');
  if (!chip || !txt) return;
  if (hasKey()) { chip.className = 'ai-chip live'; txt.textContent = 'Gemini live'; }
  else { chip.className = 'ai-chip mock'; txt.textContent = 'Demo mode'; }
}

/* ================================================================== *
 * Router
 * ================================================================== */

const RENDER = {};
let currentView = 'screen';

function go(view) {
  currentView = view;
  $$('.nav-item').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  window.scrollTo({ top: 0 });
  RENDER[view]?.();
}

$$('.nav-item').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));

/* ================================================================== *
 * SCREENING FLOW
 * ================================================================== */

let draft = null;
let step = 0;

function newDraft() {
  const s = store.settings();
  return {
    id: uid(),
    name: '', age: '', sex: 'M', phone: '',
    centre: s.centre, language: s.language, volunteer: s.volunteer,
    heightCm: '', weightKg: '', waistCm: '',
    systolic: '', diastolic: '', glucose: '', glucoseFasting: false,
    activity: 'mild', family: 'none',
    tobacco: false, knownDiabetic: false, knownHypertensive: false,
    onInsulin: false, onSulfonylurea: false, hypoHistory: false, ckd: false,
    consent: false, consentFollowUp: false,
    createdAt: new Date().toISOString(),
    referralIssued: false, referralStatus: null, thread: []
  };
}

const STEP_LABELS = ['Consent', 'Risk factors', 'Measurements', 'Summary'];

RENDER.screen = () => {
  if (!draft) { draft = newDraft(); step = 0; }
  const host = $('#screenFlow');

  host.innerHTML = `
    <div class="page-title">
      <h1>New screening</h1>
      <p>${esc(draft.centre)}</p>
    </div>
    ${stepper()}
    <div id="stepBody"></div>
    <div class="actions" id="stepActions"></div>`;

  ({ 0: stepIdentity, 1: stepRisk, 2: stepVitals, 3: stepResult })[step]();
};

function stepper() {
  return `<div class="stepper" role="progressbar" aria-valuenow="${step + 1}" aria-valuemin="1" aria-valuemax="4">
    ${STEP_LABELS.map((label, i) => {
      const state = i < step ? 'done' : i === step ? 'current' : '';
      const line = i > 0 ? `<div class="stepper-line ${i <= step ? 'filled' : ''}"></div>` : '';
      return `${line}<div class="stepper-node ${state}">
        <div class="stepper-dot">${i < step ? ICON.check : i + 1}</div>
        <div class="stepper-label">${esc(label)}</div>
      </div>`;
    }).join('')}
  </div>`;
}

// A titled glass card. Purely presentational grouping — no field moves between steps.
function sectionCard(title, subtitle, inner) {
  return `<section class="card">
    <div class="card-header">
      <h2>${esc(title)}</h2>
      ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
    </div>
    ${inner}
  </section>`;
}

/* ---------- Step 0: consent and identity ---------- */

function stepIdentity() {
  $('#stepBody').innerHTML = `
    <div class="cards">
      ${sectionCard('Consent', 'Read aloud in the person’s language before any reading is taken.', `
        <div class="quote" style="margin-bottom:4px">${ICON.shield}<div>"We would like to check your blood pressure, blood sugar, height and weight. There is no charge. Your results are shared only with the health programme and the doctor we refer you to. You can stop at any time and you do not have to answer anything you do not want to."</div></div>
        <div class="toggle-row">
          <div class="toggle-row-label">Consent given for screening</div>
          <button class="switch" id="tgConsent" role="switch" aria-checked="${draft.consent}" aria-label="Consent given for screening"></button>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-row-label">Consent to follow-up messages</div>
            <div class="toggle-row-help">Optional. Declining does not affect screening.</div>
          </div>
          <button class="switch" id="tgConsentFU" role="switch" aria-checked="${draft.consentFollowUp}" aria-label="Consent to follow-up messages"></button>
        </div>`)}

      ${sectionCard('Personal details', 'Only what the referral and follow-up actually need.', `
        <div class="stack">
          <div class="form-grid">
            <div class="field"><label for="fName">Name</label>
              <input class="input" id="fName" value="${esc(draft.name)}" placeholder="Full name" autocomplete="off"></div>
            <div class="field"><label for="fPhone">Mobile</label>
              <input class="input num" id="fPhone" type="tel" inputmode="tel" value="${esc(draft.phone)}" placeholder="For follow-up only"></div>
          </div>

          <div class="form-grid">
            <div class="field"><label for="fAge">Age</label>
              <input class="input num" id="fAge" type="number" inputmode="numeric" value="${esc(draft.age)}" placeholder="Years"></div>
            <div class="field"><label>Sex</label>
              <div class="segmented" id="segSex">
                <button data-v="M" aria-pressed="${draft.sex === 'M'}">Male</button>
                <button data-v="F" aria-pressed="${draft.sex === 'F'}">Female</button>
              </div></div>
          </div>

          <div class="form-grid">
            <div class="field"><label for="fCentre">Centre</label>
              <select class="select" id="fCentre">${CENTRES.map(c => `<option ${c === draft.centre ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
            <div class="field"><label for="fLang">Language</label>
              <select class="select" id="fLang">${LANGUAGES.map(l => `<option ${l === draft.language ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          </div>
        </div>`)}
    </div>

`;
  $('#stepActions').innerHTML = `
    <button class="btn" id="next0">Continue ${ICON.arrow}</button>`;

  bindSwitch('#tgConsent', v => draft.consent = v);
  bindSwitch('#tgConsentFU', v => draft.consentFollowUp = v);
  bindSeg('#segSex', v => draft.sex = v);
  bindInputs({ '#fName': 'name', '#fAge': 'age', '#fPhone': 'phone', '#fCentre': 'centre', '#fLang': 'language' });

  $('#next0').addEventListener('click', () => {
    if (!draft.consent) return toast('Consent is required before screening');
    if (!draft.name.trim()) return toast('Name is required');
    if (!draft.age) return toast('Age is required');
    step = 1; RENDER.screen();
  });
}

/* ---------- Step 1: risk factors ---------- */

function stepRisk() {
  $('#stepBody').innerHTML = `
    <div class="cards">
      ${sectionCard('Risk factors', 'The four inputs to the Indian Diabetes Risk Score.', `
        <div class="stack">
          <div class="notice">${ICON.info}<div>These four questions are the <b>Indian Diabetes Risk Score</b> (Mohan et al., MDRF). A validated instrument, not an invented one.</div></div>

          <div class="field"><label>Physical activity</label>
            <div class="segmented seg-4" id="segAct">
              <button data-v="vigorous" aria-pressed="${draft.activity === 'vigorous'}">Heavy</button>
              <button data-v="moderate" aria-pressed="${draft.activity === 'moderate'}">Moderate</button>
              <button data-v="mild" aria-pressed="${draft.activity === 'mild'}">Mild</button>
              <button data-v="sedentary" aria-pressed="${draft.activity === 'sedentary'}">None</button>
            </div>
            <div class="field-hint">Heavy means strenuous work or vigorous exercise most days.</div></div>

          <div class="field"><label>Family history of diabetes</label>
            <div class="segmented seg-3" id="segFam">
              <button data-v="none" aria-pressed="${draft.family === 'none'}">Neither</button>
              <button data-v="one" aria-pressed="${draft.family === 'one'}">One parent</button>
              <button data-v="both" aria-pressed="${draft.family === 'both'}">Both</button>
            </div></div>

          <div class="field"><label for="fWaist">Waist circumference (cm)</label>
            <input class="input num" id="fWaist" type="number" inputmode="decimal" value="${esc(draft.waistCm)}" placeholder="Optional, if tape available">
            <div class="field-hint">Leave blank if no tape measure. A BMI-derived proxy will be substituted and the record flagged.</div></div>
        </div>`)}

      ${sectionCard('Existing conditions', 'What they are already diagnosed with or taking.', `
        <div>
          ${toggleRow('tgDia', 'Already diagnosed diabetic', draft.knownDiabetic)}
          ${toggleRow('tgHtn', 'Already diagnosed hypertensive', draft.knownHypertensive)}
          ${toggleRow('tgIns', 'Takes insulin', draft.onInsulin)}
          ${toggleRow('tgSul', 'Takes sulfonylurea tablets', draft.onSulfonylurea)}
          ${toggleRow('tgTob', 'Uses tobacco', draft.tobacco)}
        </div>`)}
    </div>

`;
  $('#stepActions').innerHTML = `
    <button class="btn btn-secondary" id="back1">Back</button>
    <button class="btn" id="next1">Continue ${ICON.arrow}</button>`;

  bindSeg('#segAct', v => draft.activity = v);
  bindSeg('#segFam', v => draft.family = v);
  bindInputs({ '#fWaist': 'waistCm' });
  bindSwitch('#tgDia', v => draft.knownDiabetic = v);
  bindSwitch('#tgHtn', v => draft.knownHypertensive = v);
  bindSwitch('#tgIns', v => draft.onInsulin = v);
  bindSwitch('#tgSul', v => draft.onSulfonylurea = v);
  bindSwitch('#tgTob', v => draft.tobacco = v);

  $('#back1').addEventListener('click', () => { step = 0; RENDER.screen(); });
  $('#next1').addEventListener('click', () => { step = 2; RENDER.screen(); });
}

/* ---------- Step 2: vitals, with camera capture ---------- */

function stepVitals() {
  $('#stepBody').innerHTML = `
    <div class="cards">
      ${sectionCard('Read the device', 'Point the camera at the glucometer or BP monitor. The reading fills itself.', `
        <div class="stack">
          <div class="capture-card" id="captureCard">
            <div class="capture-icon">${ICON.camera}</div>
            <button class="btn btn-secondary btn-sm" id="btnCamera">${ICON.camera} Open camera</button>
            <input type="file" accept="image/*" capture="environment" id="filePick" hidden>
          </div>
          <div id="captureArea"></div>
        </div>`)}

      ${sectionCard('Vitals', 'Blood pressure seated after a minute of rest. BMI uses Asian Indian thresholds.', `
        <div class="stack">
          <div class="form-grid">
            <div class="field" id="wrapSys"><label for="fSys">Systolic</label>
              <input class="input num" id="fSys" type="number" inputmode="numeric" value="${esc(draft.systolic)}" placeholder="mmHg"></div>
            <div class="field" id="wrapDia"><label for="fDia">Diastolic</label>
              <input class="input num" id="fDia" type="number" inputmode="numeric" value="${esc(draft.diastolic)}" placeholder="mmHg"></div>
          </div>
          <div class="form-grid">
            <div class="field" id="wrapGlu"><label for="fGlu">Glucose (mg/dL)</label>
              <input class="input num" id="fGlu" type="number" inputmode="numeric" value="${esc(draft.glucose)}" placeholder="mg/dL"></div>
            <div class="field"><label>Taken</label>
              <div class="segmented" id="segFast">
                <button data-v="0" aria-pressed="${!draft.glucoseFasting}">Random</button>
                <button data-v="1" aria-pressed="${draft.glucoseFasting}">Fasting</button>
              </div></div>
          </div>
          <div class="form-grid">
            <div class="field"><label for="fHt">Height (cm)</label>
              <input class="input num" id="fHt" type="number" inputmode="decimal" value="${esc(draft.heightCm)}" placeholder="cm"></div>
            <div class="field" id="wrapWt"><label for="fWt">Weight (kg)</label>
              <input class="input num" id="fWt" type="number" inputmode="decimal" value="${esc(draft.weightKg)}" placeholder="kg"></div>
          </div>
        </div>`)}
    </div>

`;
  $('#stepActions').innerHTML = `
    <button class="btn btn-secondary" id="back2">Back</button>
    <button class="btn" id="next2">See result ${ICON.arrow}</button>`;

  bindInputs({
    '#fSys': 'systolic', '#fDia': 'diastolic', '#fGlu': 'glucose',
    '#fHt': 'heightCm', '#fWt': 'weightKg'
  });
  bindSeg('#segFast', v => draft.glucoseFasting = v === '1');

  $('#btnCamera').addEventListener('click', openCamera);
  $('#filePick').addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) fileToBase64(f).then(b64 => runVision(b64, f.type));
  });

  $('#back2').addEventListener('click', () => { step = 1; RENDER.screen(); });
  $('#next2').addEventListener('click', () => {
    if (!draft.systolic && !draft.glucose) return toast('Enter at least one vital reading');
    step = 3; RENDER.screen();
  });
}

let stream = null;

async function openCamera() {
  const area = $('#captureArea');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }
    });
  } catch {
    $('#filePick').click();
    return;
  }

  area.innerHTML = `
    <div class="viewfinder" id="vf">
      <video id="vid" autoplay playsinline muted></video>
      <div class="vf-frame"></div>
      <div class="vf-hint">Fill the frame with the display</div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn btn-secondary" id="btnCancelCam">Cancel</button>
      <button class="btn grow" id="btnShoot">${ICON.camera} Capture</button>
    </div>`;

  const vid = $('#vid');
  vid.srcObject = stream;

  $('#btnCancelCam').addEventListener('click', stopCamera);
  $('#btnShoot').addEventListener('click', () => {
    const c = document.createElement('canvas');
    c.width = vid.videoWidth; c.height = vid.videoHeight;
    c.getContext('2d').drawImage(vid, 0, 0);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    stopCamera();
    runVision(dataUrl.split(',')[1], 'image/jpeg', dataUrl);
  });
}

function stopCamera() {
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  const a = $('#captureArea'); if (a) a.innerHTML = '';
}

function fileToBase64(file) {
  return new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result.split(',')[1]);
    fr.readAsDataURL(file);
  });
}

async function runVision(b64, mime, preview) {
  const area = $('#captureArea');
  area.innerHTML = `
    <div class="viewfinder">
      ${preview ? `<img src="${preview}" alt="">` : '<div style="width:100%;height:100%;background:#000"></div>'}
      <div class="scanning">
        <div class="scan-line"></div>
        <div class="spinner"></div>
        <div class="small">Reading the display</div>
      </div>
    </div>`;

  const out = await readDeviceScreen(b64, mime);
  updateAIChip();

  const filled = [];
  const setVal = (sel, wrap, val) => {
    if (val == null) return;
    const el = $(sel); if (!el) return;
    el.value = val;
    el.classList.add('landed');
    $(wrap)?.classList.add('field-filled');
    filled.push(sel);
  };

  if (out.confidence === 'low' || (out.glucose == null && out.systolic == null && out.weightKg == null)) {
    area.innerHTML = `<div class="notice warn">${ICON.info}<div><b>Could not read it reliably.</b> ${esc(out.note || 'Try again with less glare, or enter the value by hand.')}</div></div>`;
    return;
  }

  setVal('#fGlu', '#wrapGlu', out.glucose);
  setVal('#fSys', '#wrapSys', out.systolic);
  setVal('#fDia', '#wrapDia', out.diastolic);
  setVal('#fWt', '#wrapWt', out.weightKg);

  if (out.glucose != null) draft.glucose = out.glucose;
  if (out.systolic != null) draft.systolic = out.systolic;
  if (out.diastolic != null) draft.diastolic = out.diastolic;
  if (out.weightKg != null) draft.weightKg = out.weightKg;

  area.innerHTML = `
    <div class="notice ${out.mocked ? '' : ''}" style="border-color:var(--ok-bd);background:var(--ok-bg);color:var(--ok)">
      ${ICON.check}
      <div><b>${out.mocked ? 'Simulated reading' : 'Read from device'}</b> &middot; ${esc(out.deviceType.replace('_', ' '))} &middot; confidence ${esc(out.confidence)}<br>
      <span style="opacity:.85">${esc(out.note || '')}</span></div>
    </div>`;

  if (out.error) toast('Model call failed, showing simulated reading');
  setTimeout(() => filled.forEach(s => $(s)?.classList.remove('landed')), 600);
}

/* ---------- Step 3: result ---------- */

function stepResult() {
  const a = assess(draft);
  const fast = fastingRisk(draft, a);
  const toneClass = 't-' + a.tone;

  $('#stepBody').innerHTML = `
    <div class="cards">
      <div class="result-hero ${toneClass}">
        <div class="eyebrow" style="color:currentColor;opacity:.72">Screening outcome</div>
        <div class="result-title">${esc(a.title)}</div>
        <div class="result-summary">${esc(a.summary)}</div>
      </div>

      ${sectionCard('Measurements', 'Against Asian Indian and ACC/AHA thresholds.', `
        <div class="stack">
          <div class="vital-grid">
            ${vitalTile('BP', a.bp ? `${a.bp.systolic}/${a.bp.diastolic}` : '—', a.bp?.label, a.bp?.tone)}
            ${vitalTile('Glucose', a.glucose ? a.glucose.value : '—', a.glucose?.label, a.glucose?.tone)}
            ${vitalTile('BMI', a.bmi ? a.bmi.value : '—', a.bmi?.label, a.bmi?.tone)}
          </div>
          ${a.reasons.length ? `<div class="reasons">${a.reasons.map(r => `<div class="reason"><div class="reason-dot"></div><div>${esc(r)}</div></div>`).join('')}</div>` : ''}
        </div>`)}

      <section class="card card-flush">
        <div class="card-head"><h3>Indian Diabetes Risk Score</h3>
          <span class="badge t-${a.idrs.tone}"><span class="dot"></span>${a.idrs.total} &middot; ${esc(a.idrs.label)}</span></div>
        <div style="padding:20px">
          ${a.idrs.components.map(c => `
            <div class="idrs-row">
              <div class="idrs-name">${esc(c.name)}</div>
              <div class="idrs-bar"><div class="idrs-fill" style="width:${(c.points / c.max) * 100}%"></div></div>
              <div class="idrs-pts num">${c.points}/${c.max}</div>
            </div>`).join('')}
          ${a.idrs.proxied ? `<div class="tiny dim" style="margin-top:10px">Waist estimated from BMI, no tape measure recorded. Flagged on this record.</div>` : ''}
        </div>
      </section>

      ${fast ? `
      <section class="card card-flush">
        <div class="card-head"><h3>Ramadan fasting risk</h3>
          <span class="badge t-${fast.tone}"><span class="dot"></span>${esc(fast.label)}</span></div>
        <div style="padding:20px" class="stack-sm">
          <p class="small">${esc(fast.guidance)}</p>
          ${fast.factors.length ? `<div class="reasons">${fast.factors.map(f => `<div class="reason"><div class="reason-dot"></div><div>${esc(f)}</div></div>`).join('')}</div>` : ''}
          <div class="disclaimer">${esc(fast.disclaimer)}</div>
        </div>
      </section>` : ''}

      <div id="referralArea"></div>

      <div class="disclaimer">This is a screening result, not a diagnosis. No condition has been named to this person and no medication advice has been given. Confirmation rests with a clinician.</div>
    </div>

`;
  $('#stepActions').innerHTML = `
    <button class="btn btn-secondary" id="back3">Back</button>
    <button class="btn" id="saveRec">${a.referral ? 'Generate referral' : 'Save record'} ${ICON.arrow}</button>`;

  $('#back3').addEventListener('click', () => { step = 2; RENDER.screen(); });
  $('#saveRec').addEventListener('click', () => finishScreening(a));
}

function vitalTile(label, value, tag, tone) {
  return `<div class="vital">
    <div class="vital-label">${esc(label)}</div>
    <div class="vital-value num">${esc(value)}</div>
    <div class="vital-tag" style="color:var(--${tone || 'text-3'})">${esc(tag || '')}</div>
  </div>`;
}

async function finishScreening(a) {
  const btn = $('#saveRec');
  btn.disabled = true;

  draft.outcome = a.outcome;
  draft.idrsTotal = a.idrs.total;
  draft.idrsProxied = a.idrs.proxied;

  if (!a.referral) {
    store.upsert(draft);
    toast('Record saved');
    draft = null; step = 0;
    go('records');
    return;
  }

  btn.innerHTML = '<span class="spinner dark"></span> Writing referral';
  const facility = FACILITIES[draft.centre] || { name: 'Nearest Namma Clinic', hours: '' };

  const ref = await generateReferral({
    record: draft, assessment: a, language: draft.language,
    facility: `${facility.name} (${facility.hours})`, scheme: SCHEME
  });
  updateAIChip();

  draft.referral = ref;
  draft.referralIssued = true;
  draft.referralStatus = 'pending';
  draft.facility = facility.name;

  if (draft.consentFollowUp && draft.phone) {
    draft.thread = [];
    draft.followUpDue = true;
  }

  store.upsert(draft);
  renderSlip(ref, facility);
  btn.disabled = false;
  btn.textContent = 'Done';
  btn.onclick = () => { draft = null; step = 0; go('records'); };
}

function renderSlip(ref, facility) {
  const rtl = RTL.includes(draft.language);
  $('#referralArea').innerHTML = `
    <div class="section-title">Referral slip</div>
    <div class="slip">
      <div class="slip-head">
        <img src="assets/abf-logo.png" alt="ABF">
        <div style="font-size:12px;font-weight:600">${esc(draft.language)} &middot; ${esc(facility.name)}</div>
      </div>
      <div class="slip-body">
        <div class="slip-lang" ${rtl ? 'dir="rtl"' : ''}><b>${esc(ref.headline)}</b>

${esc(ref.body)}</div>
        <div class="slip-quote" ${rtl ? 'dir="rtl"' : ''}>${esc(ref.whatToSay)}</div>
        ${ref.dietNote ? `<div class="slip-quote" ${rtl ? 'dir="rtl"' : ''} style="border-left-color:var(--ok)">${esc(ref.dietNote)}</div>` : ''}
      </div>
      <div class="slip-foot">
        <b>English record:</b> ${esc(ref.englishGloss)}<br>
        Screening result only. Not a diagnosis. ${ref.mocked ? '<br><b>Simulated output</b>, no API key configured.' : ''}
      </div>
    </div>
    ${draft.consentFollowUp && draft.phone
      ? `<div class="notice" style="margin-top:12px">${ICON.spark}<div><b>Follow-up scheduled.</b> The assistant will message on day 3, and again on day 10 if there is no reply.</div></div>`
      : `<div class="notice" style="margin-top:12px">${ICON.info}<div>No follow-up scheduled. ${draft.phone ? 'Follow-up consent was declined.' : 'No mobile number recorded.'}</div></div>`}`;
}

/* ---------- shared form binders ---------- */

function bindInputs(map) {
  for (const [sel, key] of Object.entries(map)) {
    const el = $(sel); if (!el) continue;
    el.addEventListener('input', () => draft[key] = el.value);
    el.addEventListener('change', () => draft[key] = el.value);
  }
}
function bindSeg(sel, cb) {
  const root = $(sel); if (!root) return;
  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    [...root.children].forEach(c => c.setAttribute('aria-pressed', String(c === b)));
    cb(b.dataset.v);
  });
}
function bindSwitch(sel, cb) {
  const el = $(sel); if (!el) return;
  el.addEventListener('click', () => {
    const v = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', String(v));
    cb(v);
  });
}
function toggleRow(id, label, val) {
  return `<div class="toggle-row"><div class="toggle-row-label">${esc(label)}</div>
    <button class="switch" id="${id}" role="switch" aria-checked="${val}"></button></div>`;
}

/* ================================================================== *
 * RECORDS
 * ================================================================== */

let recordFilter = 'all';

RENDER.records = () => {
  const q = ($('#recordSearch')?.value || '').toLowerCase();
  let list = store.records();

  if (recordFilter === 'flagged') list = list.filter(r => r.outcome === 'refer' || r.outcome === 'urgent');
  if (recordFilter === 'pending') list = list.filter(r => r.referralIssued && r.referralStatus === 'pending');
  if (recordFilter === 'confirmed') list = list.filter(r => r.referralStatus === 'confirmed');
  if (q) list = list.filter(r => r.name.toLowerCase().includes(q) || (r.centre || '').toLowerCase().includes(q));

  const host = $('#recordList');
  if (!list.length) {
    host.innerHTML = `<div class="card"><div class="empty">${ICON.empty}
      <div class="empty-title">No records</div><p>Screen someone, or load sample data from Settings.</p></div></div>`;
    return;
  }

  const all = store.records();
  const counts = {
    total: all.length,
    flagged: all.filter(r => r.outcome === 'refer' || r.outcome === 'urgent').length,
    pending: all.filter(r => r.referralStatus === 'pending').length,
    confirmed: all.filter(r => r.referralStatus === 'confirmed').length,
    urgent: all.filter(r => r.outcome === 'urgent').length
  };

  host.innerHTML = `
    <div class="strip">
      ${stripCell(counts.total, 'Screened')}
      ${stripCell(counts.flagged, 'Flagged', 'var(--warn)')}
      ${stripCell(counts.pending, 'Pending', 'var(--warn)')}
      ${stripCell(counts.confirmed, 'In care', 'var(--ok)')}
      ${stripCell(counts.urgent, 'Urgent', 'var(--high)')}
    </div>
    <div class="list">${list.map(r => {
    const meta = OUTCOME_META[r.outcome] || OUTCOME_META.routine;
    const status = r.referralStatus === 'confirmed' ? '<span class="badge t-ok"><span class="dot"></span>In care</span>'
      : r.referralStatus === 'pending' ? '<span class="badge t-warn"><span class="dot"></span>Pending</span>' : '';
    const idrs = r.idrsTotal ?? 0;
    // Bar tracks risk, so it fills as risk rises. Colour tracks the band.
    const barTone = idrs >= 60 ? 'var(--high)' : idrs >= 30 ? 'var(--warn)' : 'var(--ok)';
    return `<button class="list-item" data-id="${r.id}">
      <div class="avatar t-${meta.tone}">${esc(initials(r.name))}</div>
      <div class="grow">
        <div class="li-title">${esc(r.name)}</div>
        <div class="li-sub">${r.age}y &middot; ${esc(meta.title)}</div>
        <div style="margin-top:6px">${status}</div>
      </div>
      <div class="score">
        <div class="score-value num" style="color:${barTone}">${idrs}<span>/100</span></div>
        <div class="score-label">IDRS</div>
        <div class="score-bar"><div class="score-fill" style="width:${idrs}%;background:${barTone}"></div></div>
      </div>
      <div class="li-chev">${ICON.chev}</div>
    </button>`;
  }).join('')}</div>`;

  $$('#recordList .list-item').forEach(b => b.addEventListener('click', () => openRecord(b.dataset.id)));
};

$('#recordSearch').addEventListener('input', () => RENDER.records());
$('#recordFilter').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#recordFilter button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  recordFilter = b.dataset.filter;
  RENDER.records();
});

function openRecord(id) {
  const r = store.get(id); if (!r) return;
  const a = assess(r);
  const meta = OUTCOME_META[r.outcome] || OUTCOME_META.routine;

  sheet(r.name, `
    <div class="stack">
      <div class="row wrap">
        <span class="badge t-${meta.tone}"><span class="dot"></span>${esc(meta.title)}</span>
        <span class="badge t-${a.idrs.tone}">IDRS ${a.idrs.total}</span>
        ${r.referralStatus ? `<span class="badge t-${r.referralStatus === 'confirmed' ? 'ok' : 'warn'}">${r.referralStatus === 'confirmed' ? 'Confirmed in care' : 'Referral pending'}</span>` : ''}
      </div>
      <div class="vital-grid">
        ${vitalTile('BP', a.bp ? `${a.bp.systolic}/${a.bp.diastolic}` : '—', a.bp?.label, a.bp?.tone)}
        ${vitalTile('Glucose', a.glucose ? a.glucose.value : '—', a.glucose?.label, a.glucose?.tone)}
        ${vitalTile('BMI', a.bmi ? a.bmi.value : '—', a.bmi?.label, a.bmi?.tone)}
      </div>
      <div class="card small stack-sm">
        <div class="row-between"><span class="muted">Age, sex</span><span>${r.age}, ${r.sex === 'F' ? 'Female' : 'Male'}</span></div>
        <div class="row-between"><span class="muted">Centre</span><span>${esc(r.centre)}</span></div>
        <div class="row-between"><span class="muted">Language</span><span>${esc(r.language)}</span></div>
        <div class="row-between"><span class="muted">Screened</span><span>${new Date(r.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
        ${r.facility ? `<div class="row-between"><span class="muted">Referred to</span><span>${esc(r.facility)}</span></div>` : ''}
      </div>
      ${r.referral ? `<div class="slip"><div class="slip-body">
        <div class="slip-lang" ${RTL.includes(r.language) ? 'dir="rtl"' : ''}><b>${esc(r.referral.headline)}</b>

${esc(r.referral.body)}</div></div></div>` : ''}
      ${r.referralIssued ? `<button class="btn btn-block" id="goThread">Open follow-up</button>` : ''}
    </div>`, root => {
    root.querySelector('#goThread')?.addEventListener('click', () => { closeSheet(); go('followups'); setTimeout(() => openThread(r.id), 60); });
  });
}

/* ================================================================== *
 * FOLLOW-UPS
 * ================================================================== */

RENDER.followups = () => {
  const list = store.records().filter(r => r.referralIssued);
  const host = $('#followupList');

  const pending = list.filter(r => r.referralStatus === 'pending').length;
  const badge = $('#fuBadge');
  badge.hidden = !pending; badge.textContent = pending;

  if (!list.length) {
    host.innerHTML = `<div class="card"><div class="empty">${ICON.empty}
      <div class="empty-title">Nothing to follow up</div><p>Referrals appear here once issued.</p></div></div>`;
    return;
  }

  host.innerHTML = `<div class="list">${list.map(r => {
    const turns = r.thread?.length || 0;
    const last = r.thread?.[turns - 1];
    const barrier = r.barrier ? BARRIERS[r.barrier] : null;
    const status = r.referralStatus === 'confirmed'
      ? '<span class="badge t-ok"><span class="dot"></span>In care</span>'
      : r.referralStatus === 'declined'
        ? '<span class="badge t-neutral">Stopped</span>'
        : `<span class="badge t-${barrier?.tone || 'warn'}"><span class="dot"></span>${esc(barrier?.label || 'Not started')}</span>`;
    return `<button class="list-item" data-id="${r.id}">
      <div class="avatar t-${r.referralStatus === 'confirmed' ? 'ok' : 'warn'}">${esc(initials(r.name))}</div>
      <div class="grow">
        <div class="li-title">${esc(r.name)}</div>
        <div class="li-sub">${turns ? esc(last.text?.slice(0, 46) || '…') : 'No contact yet'}</div>
      </div>
      ${status}
      <div class="li-chev">${ICON.chev}</div>
    </button>`;
  }).join('')}</div>`;

  $$('#followupList .list-item').forEach(b => b.addEventListener('click', () => openThread(b.dataset.id)));
};

const QUICK_REPLIES = [
  'I could not go, the clinic closes before I finish work',
  'Where is it exactly?',
  'I do not have money for this',
  'I feel fine, it is not serious',
  'Yes, I went and saw the doctor',
  'Please do not message me again'
];

function openThread(id) {
  const r = store.get(id); if (!r) return;
  renderThread(r);
}

function renderThread(r) {
  const thread = r.thread || [];
  const confirmed = r.referralStatus === 'confirmed';
  const stopped = r.referralStatus === 'declined';

  const bubbles = thread.map(m => {
    if (m.from === 'annotation') {
      return `<div class="agent-annotation">${ICON.spark}<div><b>${esc(m.barrierLabel)}</b> &middot; ${esc(m.text)}</div></div>`;
    }
    if (m.from === 'daymark') return `<div class="day-marker">Day ${m.day}</div>`;
    return `<div class="bubble ${m.from}">${esc(m.text)}
      ${m.gloss && m.from === 'agent' ? `<div class="bubble-meta">${esc(m.gloss)}</div>` : ''}</div>`;
  }).join('');

  sheet(`Follow-up · ${r.name}`, `
    <div class="card" style="overflow:hidden">
      <div class="card-head">
        <div class="row"><span class="badge t-neutral">${esc(r.language)}</span>
        <span class="small muted">${esc(r.facility || '')}</span></div>
        ${confirmed ? '<span class="badge t-ok"><span class="dot"></span>Confirmed</span>' : ''}
      </div>
      <div class="thread" id="threadBody">
        ${thread.length ? bubbles : '<div class="empty" style="padding:26px"><p class="small">No contact yet. Start the day 3 message.</p></div>'}
      </div>
      ${!confirmed && !stopped ? `<div class="quick-replies" id="quickReplies">
        ${thread.length
          ? QUICK_REPLIES.map(q => `<button class="quick-reply" data-q="${esc(q)}">${esc(q)}</button>`).join('')
          : `<button class="btn btn-sm" id="startFU">${ICON.spark} Send day 3 message</button>`}
      </div>` : ''}
    </div>
    ${confirmed ? `<div class="notice" style="margin-top:12px;border-color:var(--ok-bd);background:var(--ok-bg);color:var(--ok)">
      ${ICON.check}<div><b>Referral confirmed complete.</b> Ledger credit written. This is the only point at which the ledger moves.</div></div>` : ''}
  `, root => {
    root.querySelector('#startFU')?.addEventListener('click', () => agentTurn(r.id, 3));
    root.querySelectorAll('.quick-reply').forEach(b =>
      b.addEventListener('click', () => patientReply(r.id, b.dataset.q)));
    const tb = root.querySelector('#threadBody');
    if (tb) tb.scrollTop = tb.scrollHeight;
  });
}

async function patientReply(id, text) {
  const r = store.get(id);
  const day = (r.thread.filter(m => m.from === 'agent').length >= 2) ? 10 : 3;
  r.thread.push({ from: 'patient', text, day });
  store.upsert(r);
  renderThread(r);
  await agentTurn(id, day);
}

async function agentTurn(id, dayIndex) {
  const r = store.get(id);
  const a = assess(r);

  if (!r.thread.length) r.thread.push({ from: 'daymark', day: dayIndex });

  // typing indicator
  const body = $('#threadBody');
  if (body) {
    const t = document.createElement('div');
    t.className = 'bubble agent typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(t);
    body.scrollTop = body.scrollHeight;
  }

  const out = await followUpTurn({
    record: r, assessment: a, thread: r.thread.filter(m => m.from === 'agent' || m.from === 'patient'),
    language: r.language, facility: r.facility || 'the clinic', scheme: SCHEME, dayIndex
  });
  updateAIChip();

  if (out.reply) {
    r.thread.push({ from: 'agent', text: out.reply, gloss: out.englishGloss, day: dayIndex });
  }
  if (out.actionDetail) {
    r.thread.push({
      from: 'annotation',
      barrierLabel: BARRIERS[out.barrier]?.label || 'Noted',
      text: out.actionDetail
    });
  }

  r.barrier = out.barrier;
  r.referralStatus = out.referralStatus || r.referralStatus;

  store.upsert(r);
  renderThread(r);
  RENDER.followups();

  if (out.referralStatus === 'confirmed') toast('Referral confirmed. Ledger updated.');
  if (out.action === 'escalate_to_volunteer') toast('Escalated to the volunteer');
}

/* ================================================================== *
 * LEDGER
 * ================================================================== */

RENDER.ledger = () => {
  const s = store.settings();
  const L = computeLedger(store.records(), s.assumptions);

  $('#ledgerBody').innerHTML = `
    <div class="stack-lg">
      <div class="hero-ledger">
        <div class="hero-label">Community care burden deferred</div>
        <div class="hero-value num">${formatCompactINR(L.deferred)}</div>
        <div class="hero-note">Counted only for the ${L.referralsConfirmed} ${L.referralsConfirmed === 1 ? 'person' : 'people'} confirmed to have reached a doctor. A slip handed over is not an outcome.</div>
        <div class="hero-divider"></div>
        <div class="hero-foot">
          <div>
            <div class="hero-foot-value num">${(L.dialysisYearsEquivalent * 100).toFixed(0)}%</div>
            <div class="hero-foot-label">of one dialysis year</div>
          </div>
          <div>
            <div class="hero-foot-value num">${formatINR(L.spend)}</div>
            <div class="hero-foot-label">spent on consumables</div>
          </div>
          <div>
            <div class="hero-foot-value num">${(L.completionRate * 100).toFixed(0)}%</div>
            <div class="hero-foot-label">referrals completed</div>
          </div>
        </div>
      </div>

      <div class="strip">
        ${stripCell(L.screened, 'Screened')}
        ${stripCell(L.flagged, 'Flagged', 'var(--warn)')}
        ${stripCell(L.referralsIssued, 'Referred')}
        ${stripCell(L.referralsConfirmed, 'In care', 'var(--ok)')}
        ${stripCell(L.pendingFollowUp, 'Chasing', 'var(--high)')}
      </div>

      ${L.pendingFollowUp ? `<div class="notice warn">${ICON.info}<div>
        <b>${L.pendingFollowUp} referrals still unconfirmed</b>, worth ${formatINR(L.deferredPending)} if they reach care. Not counted above.</div></div>` : ''}

      <div class="card">
        <div class="card-head"><h3>The arithmetic</h3>
          <button class="btn-ghost btn-sm" id="editAssump">Assumptions</button></div>
        <div style="padding:20px" class="stack-sm">
          <div class="formula">deferred = annual burden × P(progression/yr) × effectiveness

one dialysis patient-year   ${formatINR(L.assumptions.annualBurden)}
consumables per screening   ${formatINR(L.assumptions.screeningCost)}
────────────────────────────────────────
that same amount screens    ${L.screeningsFundedByOneDialysisYear.toLocaleString('en-IN')} people</div>
          <p class="tiny dim">The support for one dialysis patient for one year would screen every person across all 100 centres in the ABF network. Progression and effectiveness figures are conservative assumptions pending pilot data, not observed values. Open Assumptions to inspect or change them.</p>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Outcomes</h3></div>
        <div style="padding:20px" class="stack-sm">
          ${Object.entries(L.byOutcome).filter(([, v]) => v).map(([k, v]) => {
            const m = OUTCOME_META[k];
            const share = L.screened ? (v / L.screened) * 100 : 0;
            return `<div class="idrs-row">
              <div class="idrs-name">${esc(m.title)}</div>
              <div class="idrs-bar"><div class="idrs-fill" style="width:${share}%;background:var(--${m.tone})"></div></div>
              <div class="idrs-pts num">${v}</div></div>`;
          }).join('')}
        </div>
      </div>

      <div class="disclaimer">Burden deferred is a projection, not money observed returning to the fund. It is deliberately modelled on a single-year horizon rather than a multi-year one, which would roughly quintuple every figure here and would not survive scrutiny.</div>
    </div>`;

  $('#editAssump').addEventListener('click', openAssumptions);
};

function stripCell(value, label, color) {
  return `<div class="strip-cell">
    <div class="strip-value num" ${color ? `style="color:${color}"` : ''}>${value}</div>
    <div class="strip-label">${esc(label)}</div>
  </div>`;
}

function stat(label, value, sub) {
  return `<div class="stat"><div class="stat-label">${esc(label)}</div>
    <div class="stat-value num">${typeof value === 'number' ? value.toLocaleString('en-IN') : esc(value)}</div>
    <div class="stat-sub">${esc(sub)}</div></div>`;
}

function openAssumptions() {
  const s = store.settings();
  sheet('Model assumptions', `
    <p class="small muted" style="margin-bottom:14px">Every figure the ledger produces comes from these five numbers. Two are observed from ABF field records. Three are assumptions and are labelled as such.</p>
    <div class="card">
      ${Object.entries(ASSUMPTIONS).map(([k, v]) => `
        <div class="assumption">
          <div class="assumption-head">
            <div class="grow">
              <div class="assumption-label">${esc(v.label)}</div>
              <span class="badge ${v.observed ? 't-ok' : 't-neutral'}" style="margin-top:4px">${v.observed ? 'Observed' : 'Assumption'}</span>
            </div>
            <input class="input num" type="number" step="any" data-k="${k}" value="${s.assumptions[k] ?? v.value}">
          </div>
          <div class="assumption-src">${esc(v.source)}</div>
        </div>`).join('')}
    </div>
    <div class="row" style="margin-top:14px">
      <button class="btn btn-secondary grow" id="resetAssump">Reset</button>
      <button class="btn grow" id="saveAssump">Apply</button>
    </div>`, root => {
    root.querySelector('#saveAssump').addEventListener('click', () => {
      const s2 = store.settings();
      s2.assumptions = {};
      root.querySelectorAll('input[data-k]').forEach(i => s2.assumptions[i.dataset.k] = Number(i.value));
      store.saveSettings(s2);
      closeSheet(); RENDER.ledger(); toast('Assumptions updated');
    });
    root.querySelector('#resetAssump').addEventListener('click', () => {
      const s2 = store.settings(); s2.assumptions = {}; store.saveSettings(s2);
      closeSheet(); RENDER.ledger(); toast('Reset to defaults');
    });
  });
}

/* ================================================================== *
 * SETTINGS
 * ================================================================== */

RENDER.settings = () => {
  const s = store.settings();
  const key = localStorage.getItem('sl.apiKey') || '';
  const model = localStorage.getItem('sl.model') || 'gemini-flash-latest';

  $('#settingsBody').innerHTML = `
    <div class="stack-lg">
      <div>
        <div class="section-title">This device</div>
        <div class="stack">
          <div class="field"><label for="sCentre">Default centre</label>
            <select class="select" id="sCentre">${CENTRES.map(c => `<option ${c === s.centre ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
          <div class="field"><label for="sVol">Volunteer name</label>
            <input class="input" id="sVol" value="${esc(s.volunteer)}" placeholder="Who is screening"></div>
          <div class="field"><label for="sLang">Default language</label>
            <select class="select" id="sLang">${LANGUAGES.map(l => `<option ${l === s.language ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        </div>
      </div>

      <div>
        <div class="section-title">Gemini</div>
        <div class="stack">
          <div class="row-between">
            <span class="small muted">Model status</span>
            <span id="aiChip" class="ai-chip mock"><span class="dot"></span><span id="aiChipText">Demo mode</span></span>
          </div>
          <div class="field"><label for="sKey">API key</label>
            <input class="input" id="sKey" type="password" value="${esc(key)}" placeholder="Paste from Google AI Studio" autocomplete="off">
            <div class="field-hint">Stored only in this browser. Never committed to the repository. Restrict it by referrer in AI Studio and rotate it after the event.</div></div>
          <div class="field"><label for="sModel">Model</label>
            <input class="input" id="sModel" value="${esc(model)}" placeholder="gemini-flash-latest" list="modelList">
            <datalist id="modelList"></datalist>
            <div class="field-hint">Model aliases change. Run the connection test to see what this key can actually reach.</div></div>
          <div class="row">
            <button class="btn btn-secondary grow" id="saveKey">Save</button>
            <button class="btn grow" id="testKey">Test connection</button>
          </div>
          <div id="testResult"></div>
          <div class="notice">${ICON.info}<div>Without a key the app runs in <b>demo mode</b>: vision, referrals and the follow-up assistant return realistic simulated output, clearly labelled. Nothing silently pretends to be live.</div></div>
        </div>
      </div>

      <div>
        <div class="section-title">Shared sync</div>
        <div class="stack">
          <div class="row-between">
            <span class="small muted">Status</span>
            <span id="syncPill" class="ai-chip mock"><span class="dot"></span>Local only</span>
          </div>
          <div class="notice warn">${ICON.info}<div><b>Demo configuration.</b> Anyone with the app link can read every synced record. Use seeded data only. Do not enter real patient details while sync is open.</div></div>
          <div class="field"><label for="sbUrl">Supabase project URL</label>
            <input class="input" id="sbUrl" value="${esc(localStorage.getItem('sl.sbUrl') || '')}" placeholder="https://xxxx.supabase.co" autocomplete="off"></div>
          <div class="field"><label for="sbKey">Anon public key</label>
            <input class="input" id="sbKey" type="password" value="${esc(localStorage.getItem('sl.sbKey') || '')}" placeholder="eyJhbGci..." autocomplete="off"></div>
          <div class="row">
            <button class="btn btn-secondary grow" id="sbSave">Save</button>
            <button class="btn grow" id="sbTest">Test</button>
          </div>
          <div id="sbResult"></div>
          <button class="btn-ghost" id="sbSql">Show setup SQL</button>
        </div>
      </div>

      <div>
        <div class="section-title">Data</div>
        <div class="stack">
          <div class="notice">${ICON.shield}<div><b>${store.records().length} records</b> on this device.</div></div>
          <button class="btn btn-secondary" id="seedBtn">Load sample data</button>
          <button class="btn btn-secondary" id="exportBtn">Export as JSON</button>
          <button class="btn btn-danger" id="wipeBtn">Erase all records</button>
        </div>
      </div>

      <div>
        <div class="section-title">About</div>
        <div class="card small stack-sm">
          <p><b>Sehat Ledger</b> — Active Bengaluru Foundation</p>
          <p class="muted">Built at Algorism № 001, Bengaluru, 26 July 2026. Ummah track.</p>
          <p class="muted">Screening instrument: Indian Diabetes Risk Score (Mohan et al., MDRF). BMI thresholds: ICMR Asian Indian cut-offs. Fasting guidance: IDF-DAR categories.</p>
          <p class="muted">Screening only. Never a diagnosis. No medication advice is generated anywhere in this application.</p>
        </div>
      </div>
    </div>`;

  updateAIChip();

  const persist = () => {
    store.saveSettings({
      ...s,
      centre: $('#sCentre').value,
      volunteer: $('#sVol').value,
      language: $('#sLang').value
    });
  };
  ['#sCentre', '#sVol', '#sLang'].forEach(sel =>
    $(sel).addEventListener('change', () => { persist(); updateAvatar(); }));

  $('#saveKey').addEventListener('click', () => {
    localStorage.setItem('sl.apiKey', $('#sKey').value.trim());
    localStorage.setItem('sl.model', $('#sModel').value.trim() || 'gemini-flash-latest');
    updateAIChip();
    toast($('#sKey').value.trim() ? 'Gemini connected' : 'Key cleared, demo mode');
  });

  $('#testKey').addEventListener('click', async () => {
    // Save whatever is typed first, so the test checks what they intend to use
    localStorage.setItem('sl.apiKey', $('#sKey').value.trim());
    localStorage.setItem('sl.model', $('#sModel').value.trim() || 'gemini-flash-latest');
    updateAIChip();

    const box = $('#testResult');
    const btn = $('#testKey');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner dark"></span> Testing';
    box.innerHTML = '';

    const r = await testConnection();
    btn.disabled = false;
    btn.textContent = 'Test connection';

    if (r.models?.length) {
      $('#modelList').innerHTML = r.models.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    }

    if (r.ok) {
      box.innerHTML = `
        <div class="notice" style="border-color:var(--ok-bd);background:var(--ok-bg);color:var(--ok)">
          ${ICON.check}<div><b>Connected.</b> ${esc(r.model)} responded in ${r.ms} ms.
          ${r.models.length} models reachable with this key.</div></div>`;
      toast('Gemini connected');
    } else if (r.stage === 'key') {
      box.innerHTML = `<div class="notice warn">${ICON.info}<div><b>No key saved.</b> Paste one above, then test.</div></div>`;
    } else if (r.stage === 'auth') {
      box.innerHTML = `<div class="notice high">${ICON.info}<div><b>Key rejected.</b> ${esc(r.message)}<br>
        Check it was copied whole, and that Generative Language API is enabled for the project.</div></div>`;
    } else {
      const suggest = r.models?.slice(0, 6) || [];
      box.innerHTML = `
        <div class="notice high">${ICON.info}<div>
          <b>Key works, model failed.</b> ${esc(r.message)}<br>
          ${r.available ? '' : `<b>"${esc(r.model)}" is not in this key's model list.</b>`}
        </div></div>
        ${suggest.length ? `<div class="card" style="margin-top:10px">
          <div class="eyebrow" style="margin-bottom:8px">Reachable models, tap to use</div>
          <div class="row wrap">${suggest.map(m => `<button class="quick-reply" data-m="${esc(m.id)}">${esc(m.id)}</button>`).join('')}</div>
        </div>` : ''}`;
      box.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
        $('#sModel').value = b.dataset.m;
        localStorage.setItem('sl.model', b.dataset.m);
        toast('Model set to ' + b.dataset.m);
        $('#testKey').click();
      }));
    }
  });

  renderSyncPill(sync.status());

  $('#sbSave').addEventListener('click', () => {
    sync.setConfig($('#sbUrl').value, $('#sbKey').value);
    if (sync.isConfigured()) { sync.startSync(syncIO); toast('Sync enabled'); }
    else { sync.stopSync(); toast('Sync disabled, local only'); }
  });

  $('#sbTest').addEventListener('click', async () => {
    sync.setConfig($('#sbUrl').value, $('#sbKey').value);
    const btn = $('#sbTest'), box = $('#sbResult');
    btn.disabled = true; btn.innerHTML = '<span class="spinner dark"></span> Testing';
    const r = await sync.testConnection();
    btn.disabled = false; btn.textContent = 'Test';
    box.innerHTML = r.ok
      ? `<div class="notice ok">${ICON.check}<div><b>Connected.</b> ${esc(r.message)}</div></div>`
      : `<div class="notice high">${ICON.info}<div><b>Not connected.</b> ${esc(r.message)}</div></div>`;
    if (r.ok) { sync.startSync(syncIO); toast('Sync enabled'); }
  });

  $('#sbSql').addEventListener('click', () => {
    sheet('Supabase setup', `
      <p class="small muted" style="margin-bottom:14px">Create a project at supabase.com, open the SQL editor, and run this once. Then paste the project URL and anon key above.</p>
      <div class="formula" style="white-space:pre-wrap">${esc(sync.SETUP_SQL)}</div>
      <button class="btn btn-block" id="copySql" style="margin-top:14px">Copy SQL</button>`, root => {
      root.querySelector('#copySql').addEventListener('click', () => {
        navigator.clipboard?.writeText(sync.SETUP_SQL);
        toast('SQL copied');
      });
    });
  });

  $('#seedBtn').addEventListener('click', () => { seed(); toast('Sample data loaded'); RENDER.settings(); });
  $('#exportBtn').addEventListener('click', exportJSON);
  $('#wipeBtn').addEventListener('click', () => {
    if (!confirm('Erase all records on this device? This cannot be undone.')) return;
    store.save([]); toast('All records erased'); RENDER.settings();
  });
};

function exportJSON() {
  const blob = new Blob([JSON.stringify(store.records(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sehat-ledger-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ================================================================== *
 * Sample data
 * ================================================================== */

const NAMES_M = ['Abdul Rahman', 'Mohammed Iqbal', 'Syed Rizwan', 'Imran Pasha', 'Faisal Ahmed', 'Nizamuddin S', 'Yusuf Khan', 'Tabrez Alam', 'Shoaib Akhtar', 'Zameer Ahmed', 'Rafiq Baig', 'Sameer Hussain', 'Anwar Sharief', 'Junaid Basha', 'Mustafa Ali'];
const NAMES_F = ['Ayesha Begum', 'Fatima Bi', 'Ruksana Banu', 'Nasreen Taj', 'Shabana Kausar', 'Zainab Sultana', 'Hafsa Parveen', 'Salma Khatoon', 'Rehana Begum', 'Yasmin Fatima', 'Nargis Bano', 'Saira Banu'];

function seed() {
  const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const out = [];

  for (let i = 0; i < 52; i++) {
    const sex = Math.random() < 0.52 ? 'F' : 'M';
    const name = pick(sex === 'F' ? NAMES_F : NAMES_M);
    const age = rnd(26, 71);
    const heightCm = sex === 'F' ? rnd(146, 164) : rnd(157, 176);
    const weightKg = rnd(48, 92);

    // Skew toward the population this programme actually screens
    const hot = Math.random();
    const systolic = hot < 0.16 ? rnd(142, 178) : hot < 0.34 ? rnd(130, 141) : rnd(106, 129);
    const diastolic = systolic > 140 ? rnd(88, 104) : rnd(68, 86);
    const glucose = hot < 0.13 ? rnd(202, 288) : hot < 0.3 ? rnd(142, 199) : rnd(88, 138);

    const rec = {
      id: uid(), name, age, sex,
      phone: '9' + rnd(100000000, 999999999),
      centre: pick(CENTRES), language: pick(['Urdu', 'Kannada', 'Hindi', 'Tamil']),
      heightCm, weightKg, waistCm: Math.random() < 0.45 ? rnd(72, 104) : '',
      systolic, diastolic, glucose, glucoseFasting: Math.random() < 0.3,
      activity: pick(['sedentary', 'mild', 'mild', 'moderate', 'vigorous']),
      family: pick(['none', 'none', 'one', 'one', 'both']),
      tobacco: Math.random() < 0.24,
      knownDiabetic: Math.random() < 0.12, knownHypertensive: Math.random() < 0.14,
      onInsulin: false, onSulfonylurea: Math.random() < 0.08,
      hypoHistory: false, ckd: false,
      consent: true, consentFollowUp: Math.random() < 0.86,
      createdAt: new Date(Date.now() - rnd(0, 26) * 864e5).toISOString(),
      thread: []
    };

    const a = assess(rec);
    rec.outcome = a.outcome;
    rec.idrsTotal = a.idrs.total;

    if (a.referral) {
      rec.referralIssued = true;
      rec.facility = (FACILITIES[rec.centre] || {}).name || 'Namma Clinic';
      const roll = Math.random();
      // Deliberately imperfect completion. A dashboard showing 100% completion
      // would be the least believable thing in the entire demo.
      if (roll < 0.44) { rec.referralStatus = 'confirmed'; rec.barrier = 'went'; }
      else if (roll < 0.52) { rec.referralStatus = 'declined'; rec.barrier = 'declined'; }
      else {
        rec.referralStatus = 'pending';
        rec.barrier = pick(['timing_conflict', 'cost_concern', 'location_unknown', 'low_severity', 'no_response', 'transport']);
      }
    } else {
      rec.referralIssued = false; rec.referralStatus = null;
    }

    out.push(rec);
  }

  const now = new Date().toISOString();
  out.forEach(r => { r.updatedAt = now; r._dirty = true; });
  out.sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
  store.save(out);
  kickSync();
}

/* ================================================================== *
 * Boot
 * ================================================================== */

updateAIChip();
updateAvatar();
if (sync.isConfigured()) sync.startSync(syncIO);
$('#profileBtn').addEventListener('click', () => go('settings'));
$('#mAvatar')?.addEventListener('click', () => go('settings'));
RENDER.screen();
RENDER.followups();

/* Service worker.
 *
 * A cache-first worker will happily serve yesterday's JavaScript forever,
 * which during a build day looks exactly like "my changes did nothing".
 * So: check for an update on every load, activate it immediately, and
 * reload once when the new worker takes control.
 */
if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      reg.update();
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) sw.postMessage('skipWaiting');
        });
      });
    } catch { /* offline or unsupported; the app still runs */ }
  });
}
