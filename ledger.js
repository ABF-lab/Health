/*
 * ledger.js — Sehat Ledger
 *
 * Converts confirmed screening outcomes into a projected community care
 * burden deferred, expressed in rupees.
 *
 * Two design rules, both non-negotiable:
 *
 *   1. Credit is written only when a referral is CONFIRMED COMPLETE by the
 *      follow-up agent. A slip handed to someone who never went is not an
 *      outcome, and counting it would make every number here fiction.
 *
 *   2. Every assumption is a named constant, surfaced in the UI, and
 *      editable. A committee that cannot inspect the working has no reason
 *      to trust the total. Conservative defaults throughout: it is far
 *      better to under-claim and be believed.
 */

export const ASSUMPTIONS = {
  annualBurden: {
    value: 158880,
    label: 'Annual support per dialysis patient',
    unit: '₹/year',
    source: 'ABF committee disbursement records, Bengaluru, 2026',
    observed: true
  },
  screeningCost: {
    value: 15,
    label: 'Consumables per screening',
    unit: '₹',
    source: 'ABF field costing, Bengaluru, 2026. Range ₹12 to ₹15; upper bound used.',
    observed: true
  },
  progressionHigh: {
    value: 0.020,
    label: 'Annual progression to high-cost complication, high risk',
    unit: 'probability/year',
    source: 'Assumption. Deliberately conservative pending pilot data.',
    observed: false
  },
  progressionModerate: {
    value: 0.008,
    label: 'Annual progression to high-cost complication, moderate risk',
    unit: 'probability/year',
    source: 'Assumption. Deliberately conservative pending pilot data.',
    observed: false
  },
  interventionEffect: {
    value: 0.50,
    label: 'Share of progression averted by early management',
    unit: 'proportion',
    source: 'Assumption, broadly consistent with diabetes prevention programme literature. Requires local validation.',
    observed: false
  }
};

export function getAssumptions(overrides = {}) {
  const out = {};
  for (const [k, v] of Object.entries(ASSUMPTIONS)) {
    out[k] = overrides[k] != null ? Number(overrides[k]) : v.value;
  }
  return out;
}

/*
 * Expected annual burden deferred for one person, confirmed in care.
 *
 *   deferred = annualBurden × P(progression per year) × effectiveness
 *
 * Note what this deliberately does NOT do: it does not multiply across a
 * multi-year horizon. Doing so would roughly quintuple every figure on the
 * dashboard and would be the first thing an actuary pulled apart.
 */
export function deferredPerCase(riskBand, a) {
  if (riskBand === 'high') return a.annualBurden * a.progressionHigh * a.interventionEffect;
  if (riskBand === 'moderate') return a.annualBurden * a.progressionModerate * a.interventionEffect;
  return 0;
}

function riskBandOf(record) {
  if (record.outcome === 'urgent' || record.outcome === 'refer') return 'high';
  if (record.outcome === 'monitor') return 'moderate';
  return 'none';
}

export function computeLedger(records, overrides = {}) {
  const a = getAssumptions(overrides);

  let screened = 0;
  let flagged = 0;
  let referralsIssued = 0;
  let referralsConfirmed = 0;
  let pendingFollowUp = 0;
  let deferred = 0;
  let deferredPending = 0;
  const byOutcome = { urgent: 0, refer: 0, monitor: 0, routine: 0 };

  for (const r of records) {
    screened++;
    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;

    const band = riskBandOf(r);
    if (band !== 'none') flagged++;

    if (r.referralIssued) {
      referralsIssued++;
      const value = deferredPerCase(band, a);
      if (r.referralStatus === 'confirmed') {
        referralsConfirmed++;
        deferred += value;
      } else if (r.referralStatus !== 'declined') {
        pendingFollowUp++;
        deferredPending += value;
      }
    }
  }

  const spend = screened * a.screeningCost;
  const completionRate = referralsIssued ? referralsConfirmed / referralsIssued : 0;

  return {
    screened,
    flagged,
    referralsIssued,
    referralsConfirmed,
    pendingFollowUp,
    completionRate,
    byOutcome,
    spend,
    deferred,
    deferredPending,
    // How far the confirmed total has gone toward releasing one patient-year
    // of dialysis support back to the fund. This is the number that makes the
    // whole thesis legible to a treasurer.
    dialysisYearsEquivalent: deferred / a.annualBurden,
    screeningsFundedByOneDialysisYear: Math.round(a.annualBurden / a.screeningCost),
    assumptions: a
  };
}

export function formatINR(n, opts = {}) {
  const v = Math.round(Number(n) || 0);
  const s = v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return opts.bare ? s : '₹' + s;
}

export function formatCompactINR(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 10000000) return '₹' + (v / 10000000).toFixed(2).replace(/\.00$/, '') + ' Cr';
  if (v >= 100000) return '₹' + (v / 100000).toFixed(2).replace(/\.00$/, '') + ' L';
  return formatINR(v);
}
