/*
 * clinical.js — Sehat Ledger
 *
 * Pure scoring functions. No DOM, no network, no state.
 * Every threshold here traces to a published instrument or guideline,
 * because an invented risk score is indefensible the moment a clinician asks.
 *
 * Sources:
 *   IDRS  — Mohan V et al., Madras Diabetes Research Foundation.
 *           A simplified Indian Diabetes Risk Score for screening
 *           undiagnosed diabetic subjects. J Assoc Physicians India, 2005.
 *   BMI   — WHO Asia-Pacific / ICMR cut-offs for Asian Indians (lower than
 *           the standard WHO cut-offs; using the standard ones here would
 *           under-call obesity in this population).
 *   BP    — ACC/AHA categories, as adopted in Indian practice guidance.
 *
 * Nothing in this file diagnoses. Every output is a screening signal that
 * routes a person to a clinician.
 */

/* ------------------------------------------------------------------ *
 * BMI — Asian Indian cut-offs
 * ------------------------------------------------------------------ */

export const BMI_BANDS = [
  { max: 18.5, key: 'underweight', label: 'Underweight', tone: 'warn' },
  { max: 23.0, key: 'normal', label: 'Healthy range', tone: 'ok' },
  { max: 25.0, key: 'overweight', label: 'Overweight', tone: 'warn' },
  { max: Infinity, key: 'obese', label: 'Obese', tone: 'high' }
];

export function calcBMI(heightCm, weightKg) {
  if (!heightCm || !weightKg) return null;
  const m = heightCm / 100;
  const bmi = weightKg / (m * m);
  if (!isFinite(bmi) || bmi <= 0) return null;
  return Math.round(bmi * 10) / 10;
}

export function classifyBMI(bmi) {
  if (bmi == null) return null;
  const band = BMI_BANDS.find(b => bmi < b.max) || BMI_BANDS[BMI_BANDS.length - 1];
  return {
    value: bmi,
    ...band,
    note: 'Asian Indian cut-offs (ICMR). Lower than standard WHO thresholds.'
  };
}

/* ------------------------------------------------------------------ *
 * Blood pressure
 * ------------------------------------------------------------------ */

export function classifyBP(systolic, diastolic) {
  const s = Number(systolic);
  const d = Number(diastolic);
  if (!s || !d) return null;

  let key, label, tone, action;

  if (s >= 180 || d >= 120) {
    key = 'crisis';
    label = 'Very high';
    tone = 'critical';
    action = 'Same-day medical attention. Do not send home with a routine slip.';
  } else if (s >= 140 || d >= 90) {
    key = 'stage2';
    label = 'Stage 2 range';
    tone = 'high';
    action = 'Clinician review needed.';
  } else if (s >= 130 || d >= 80) {
    key = 'stage1';
    label = 'Stage 1 range';
    tone = 'warn';
    action = 'Repeat reading and clinician review.';
  } else if (s >= 120) {
    key = 'elevated';
    label = 'Elevated';
    tone = 'warn';
    action = 'Recheck in 3 months.';
  } else {
    key = 'normal';
    label = 'Normal';
    tone = 'ok';
    action = 'Routine recheck in 12 months.';
  }

  return { systolic: s, diastolic: d, key, label, tone, action };
}

/* ------------------------------------------------------------------ *
 * Capillary glucose
 * ------------------------------------------------------------------ */

export function classifyGlucose(mgdl, fasting) {
  const g = Number(mgdl);
  if (!g) return null;

  let key, label, tone;

  if (fasting) {
    if (g >= 126) { key = 'diabetes'; label = 'Diabetes range'; tone = 'high'; }
    else if (g >= 100) { key = 'impaired'; label = 'Impaired fasting range'; tone = 'warn'; }
    else { key = 'normal'; label = 'Normal'; tone = 'ok'; }
  } else {
    if (g >= 200) { key = 'diabetes'; label = 'Diabetes range'; tone = 'high'; }
    else if (g >= 140) { key = 'impaired'; label = 'Raised'; tone = 'warn'; }
    else { key = 'normal'; label = 'Normal'; tone = 'ok'; }
  }

  return {
    value: g,
    fasting: !!fasting,
    key,
    label,
    tone,
    note: 'Capillary screening value. Venous confirmation required before any diagnosis.'
  };
}

/* ------------------------------------------------------------------ *
 * IDRS — Indian Diabetes Risk Score (Mohan et al.)
 *
 * Four components, 0–100 total.
 * Waist circumference is the strongest component. Where no tape measure is
 * available we substitute a BMI-derived proxy and flag the record, because
 * silently swapping inputs on a validated instrument is not acceptable.
 * ------------------------------------------------------------------ */

export const IDRS_BANDS = [
  { min: 60, key: 'high', label: 'High risk', tone: 'high' },
  { min: 30, key: 'moderate', label: 'Moderate risk', tone: 'warn' },
  { min: 0, key: 'low', label: 'Low risk', tone: 'ok' }
];

function idrsAgePoints(age) {
  if (age >= 50) return 30;
  if (age >= 35) return 20;
  return 0;
}

function idrsWaistPoints(waistCm, sex) {
  const female = sex === 'F';
  const t1 = female ? 80 : 90;
  const t2 = female ? 70 : 80;
  if (waistCm >= t1) return 20;
  if (waistCm >= t2) return 10;
  return 0;
}

// Fallback when no tape measure is in the kit. Approximates the waist bands
// from BMI using Asian Indian thresholds. Flagged wherever it is used.
function idrsWaistFromBMI(bmi) {
  if (bmi == null) return { points: 0, proxied: true };
  if (bmi >= 25) return { points: 20, proxied: true };
  if (bmi >= 23) return { points: 10, proxied: true };
  return { points: 0, proxied: true };
}

function idrsActivityPoints(activity) {
  switch (activity) {
    case 'vigorous': return 0;   // vigorous exercise or strenuous work
    case 'moderate': return 10;
    case 'mild': return 20;
    case 'sedentary': return 30;
    default: return 20;
  }
}

function idrsFamilyPoints(family) {
  switch (family) {
    case 'both': return 20;
    case 'one': return 10;
    case 'none': return 0;
    default: return 0;
  }
}

export function calcIDRS(input) {
  const { age, sex, waistCm, bmi, activity, family } = input;

  const agePts = idrsAgePoints(Number(age) || 0);
  const actPts = idrsActivityPoints(activity);
  const famPts = idrsFamilyPoints(family);

  let waistPts, proxied = false;
  if (waistCm) {
    waistPts = idrsWaistPoints(Number(waistCm), sex);
  } else {
    const proxy = idrsWaistFromBMI(bmi);
    waistPts = proxy.points;
    proxied = true;
  }

  const total = agePts + waistPts + actPts + famPts;
  const band = IDRS_BANDS.find(b => total >= b.min);

  return {
    total,
    band: band.key,
    label: band.label,
    tone: band.tone,
    proxied,
    components: [
      { name: 'Age', points: agePts, max: 30 },
      { name: proxied ? 'Waist (BMI proxy)' : 'Waist', points: waistPts, max: 20, proxied },
      { name: 'Physical activity', points: actPts, max: 30 },
      { name: 'Family history', points: famPts, max: 20 }
    ]
  };
}

/* ------------------------------------------------------------------ *
 * Overall screening outcome
 *
 * Combines the measured vitals with IDRS. Measured values always dominate:
 * a person with a very high BP reading is urgent regardless of their
 * questionnaire score.
 * ------------------------------------------------------------------ */

export const OUTCOME = {
  URGENT: 'urgent',
  REFER: 'refer',
  MONITOR: 'monitor',
  ROUTINE: 'routine'
};

export function assess(record) {
  const bmi = calcBMI(record.heightCm, record.weightKg);
  const bmiC = classifyBMI(bmi);
  const bpC = classifyBP(record.systolic, record.diastolic);
  const gluC = classifyGlucose(record.glucose, record.glucoseFasting);
  const idrs = calcIDRS({
    age: record.age,
    sex: record.sex,
    waistCm: record.waistCm,
    bmi,
    activity: record.activity,
    family: record.family
  });

  const reasons = [];
  let outcome = OUTCOME.ROUTINE;

  const escalate = (level, reason) => {
    const rank = { routine: 0, monitor: 1, refer: 2, urgent: 3 };
    if (rank[level] > rank[outcome]) outcome = level;
    if (reason) reasons.push(reason);
  };

  if (bpC) {
    if (bpC.key === 'crisis') escalate(OUTCOME.URGENT, `Blood pressure ${bpC.systolic}/${bpC.diastolic}, very high`);
    else if (bpC.key === 'stage2') escalate(OUTCOME.REFER, `Blood pressure ${bpC.systolic}/${bpC.diastolic}, stage 2 range`);
    else if (bpC.key === 'stage1') escalate(OUTCOME.MONITOR, `Blood pressure ${bpC.systolic}/${bpC.diastolic}, stage 1 range`);
  }

  if (gluC) {
    if (gluC.key === 'diabetes') escalate(OUTCOME.REFER, `Blood glucose ${gluC.value} mg/dL, diabetes range`);
    else if (gluC.key === 'impaired') escalate(OUTCOME.MONITOR, `Blood glucose ${gluC.value} mg/dL, raised`);
  }

  if (idrs.band === 'high') escalate(OUTCOME.REFER, `IDRS ${idrs.total}, high risk`);
  else if (idrs.band === 'moderate') escalate(OUTCOME.MONITOR, `IDRS ${idrs.total}, moderate risk`);

  if (bmiC && bmiC.key === 'obese') escalate(OUTCOME.MONITOR, `BMI ${bmiC.value}, obese range for Asian Indians`);

  if (record.knownDiabetic || record.knownHypertensive) {
    escalate(OUTCOME.MONITOR, 'Already diagnosed, continuity of care check');
  }

  return {
    bmi: bmiC,
    bp: bpC,
    glucose: gluC,
    idrs,
    outcome,
    reasons,
    ...OUTCOME_META[outcome]
  };
}

export const OUTCOME_META = {
  urgent: {
    title: 'Needs care today',
    tone: 'critical',
    summary: 'A reading in this range should not wait. Accompany them or arrange transport now.',
    followUp: true,
    referral: true
  },
  refer: {
    title: 'Refer to clinician',
    tone: 'high',
    summary: 'Findings need confirmation and management by a doctor.',
    followUp: true,
    referral: true
  },
  monitor: {
    title: 'Monitor',
    tone: 'warn',
    summary: 'Not urgent, but this should be rechecked rather than forgotten.',
    followUp: false,
    referral: false
  },
  routine: {
    title: 'Routine recheck',
    tone: 'ok',
    summary: 'Nothing raised today. Recheck at the next camp.',
    followUp: false,
    referral: false
  }
};

/* ------------------------------------------------------------------ *
 * Ramadan fasting risk — IDF-DAR categories
 *
 * Included because most of this population will fast regardless of advice,
 * and a screening programme that ignores that is not being useful.
 * Guidance only. Never an instruction to fast or not to fast.
 * ------------------------------------------------------------------ */

export function fastingRisk(record, assessment) {
  if (!record.knownDiabetic && assessment.glucose?.key !== 'diabetes') return null;

  let level = 'moderate';
  const factors = [];

  if (record.onInsulin) { level = 'veryhigh'; factors.push('On insulin'); }
  if (assessment.glucose?.value >= 300) { level = 'veryhigh'; factors.push('Glucose above 300 mg/dL'); }
  if (record.hypoHistory) { level = 'veryhigh'; factors.push('History of hypoglycaemia'); }
  if (record.ckd) { level = 'veryhigh'; factors.push('Kidney disease'); }

  if (level !== 'veryhigh') {
    if (record.onSulfonylurea) { level = 'high'; factors.push('On sulfonylurea, hypoglycaemia risk'); }
    if (Number(record.age) >= 70) { level = 'high'; factors.push('Age 70 or above'); }
  }

  const meta = {
    veryhigh: {
      label: 'Very high risk',
      tone: 'critical',
      guidance: 'Scholarly opinion generally permits exemption at this level of medical risk. Must be discussed with a doctor before Ramadan.'
    },
    high: {
      label: 'High risk',
      tone: 'high',
      guidance: 'Medication timing needs adjusting before Ramadan. Doctor review required.'
    },
    moderate: {
      label: 'Moderate risk',
      tone: 'warn',
      guidance: 'Fasting is generally possible with monitoring and a suhoor plan. Review with a doctor.'
    }
  }[level];

  return {
    level,
    factors,
    ...meta,
    disclaimer: 'Clinical guidance only, grounded in IDF-DAR categories. Religious rulings on exemption rest with a qualified scholar, not with this app.'
  };
}
