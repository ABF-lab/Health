<div align="center">

<img src="assets/abf-logo.jpg" alt="Active Bengaluru Foundation" width="300">

# Sehat Ledger

### Zakat is no longer arriving as charity. It is arriving as a bill.

**[Open the app →](https://abf-lab.github.io/Health/)**

Built at Algorism № 001 · Bengaluru · 26 July 2026 · Ummah track

</div>

---

## The problem

Ask any mosque committee in Bengaluru where the medical relief fund goes. The answer is almost never preventive care. It goes to dialysis, cardiac procedures, diabetic amputations, and hospital bills for a breadwinner who collapsed without warning.

These are the terminal stages of two conditions, diabetes and hypertension, that are silent for years and detectable in ninety seconds with a ₹5,000 kit.

Charity is meant to be given at a moment of choice. This is not that. The amount is fixed by a hospital, the schedule is fixed by a dialysis machine, and it repeats every month whether the fund can carry it or not.

```
One dialysis patient, one year          ₹1,58,880
Consumables per screening                     ₹15
─────────────────────────────────────────────────
The same amount screens              10,592 people
```

**The support for one dialysis patient for one year would screen every person across all 100 centres in the ABF network.**

## What this is

An offline-first screening tool that turns a mosque volunteer with a low-end Android phone into a preventive health worker, and measures every screening as zakat capital preserved.

Installs to the Android home screen. Runs with no connectivity. No app store, no accounts, no backend.

## Where the AI does the work

Four places, all load-bearing. Remove the models and this is a paper clipboard nobody in the room can read.

| | |
|---|---|
| **Vision capture** | Point the camera at a glucometer or BP monitor. The digits fill themselves. Removes the typing and literacy barrier that causes most data loss in community screening. |
| **Multilingual referral** | Referral slip and counselling script in Urdu, Kannada, Hindi or Tamil, pitched at the reader's literacy level, naming the facility and the scheme they qualify for. |
| **Follow-up agent** | Messages the patient on day 3 and day 10. Does not repeat reminders. Identifies why someone has not gone and removes that specific obstacle, or escalates to the volunteer. |
| **Risk-to-burden model** | Converts confirmed outcomes into a rupee figure a committee treasurer can act on. |

## What makes the ledger honest

**Credit is written only when the follow-up agent confirms the person reached a doctor.**

Every community screening programme in India reports impressive screening numbers while health outcomes stay flat, because a referral nobody acts on is a piece of paper. Counting issued slips would make every figure here fiction. The number this app shows is smaller than the alternative and it is the only defensible one.

Every assumption behind it is a named constant, surfaced in the UI, and editable. Two are observed from ABF field records. Three are labelled as assumptions, deliberately conservative, on a single-year horizon rather than a multi-year one.

## Clinical basis

Nothing here is invented scoring.

- **Risk stratification** — Indian Diabetes Risk Score (Mohan et al., Madras Diabetes Research Foundation, 2005)
- **BMI thresholds** — ICMR Asian Indian cut-offs, which are lower than standard WHO thresholds. Using the standard ones would under-call obesity in this population.
- **Blood pressure** — ACC/AHA categories as adopted in Indian practice
- **Ramadan fasting guidance** — IDF-DAR risk categories

**This is screening, not diagnosis.** No condition is ever named to a patient. No medication advice is generated anywhere in the application. The output is always "see a doctor about this."

## Privacy

- Records live in `localStorage` on the device. There is no backend and no account.
- Consent is captured before any reading is taken. Follow-up contact is a separate opt-in, and declining it does not affect screening.
- The follow-up agent identifies itself as automated in its first message and stops permanently on request.
- The only outbound request is the image sent for digit recognition, and only when a key is configured.

## Running it

Static files. No build step, no npm, no bundler.

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`. Deploys to GitHub Pages by pushing to the default branch.

**To enable the models:** Settings → paste a [Google AI Studio](https://aistudio.google.com/apikey) key. Without one the app runs in demo mode, returning realistic simulated output that is clearly labelled as simulated. Nothing silently pretends to be live.

The key is stored in the browser only and is never committed. On a public deployment it is a client-side key: restrict it by referrer in AI Studio and rotate it after the event.

**To see it populated:** Settings → Load sample data.

## Files

```
index.html      app shell
styles.css      design system
app.js          routing, screening flow, camera, threads, ledger UI
clinical.js     IDRS, BMI, BP, glucose, outcome escalation (pure functions)
ledger.js       zakat preservation model
ai.js           Gemini vision, referral generation, follow-up agent
sw.js           offline service worker
```

## Built today, and not

**Built:** vision capture, offline screening with on-device scoring, multilingual referral generation, follow-up agent with barrier classification and escalation, zakat ledger gated on confirmed completion.

**On the follow-up agent specifically:** the agent logic, conversation handling, barrier classification and escalation are live. WhatsApp Business API approval takes longer than a build day, so the demo runs the real agent against a simulated thread. Production substitutes the channel, not the system.

**Not built:** offline voice input in four languages, learned risk classifier (needs screening volume), geospatial hotspot mapping, live facility availability, automated scheme eligibility checks.

---

<div align="center">

**Active Bengaluru Foundation**

</div>
