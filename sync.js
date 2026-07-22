/*
 * sync.js — Sehat Ledger
 *
 * Local-first sync to Supabase. Records are always written to localStorage
 * first, so a volunteer with no signal keeps working exactly as before.
 * Anything unsynced is queued and pushed when connectivity returns.
 *
 * No client library. Supabase exposes PostgREST over plain HTTP, so this is
 * fetch() and nothing else — which keeps the no-build-step architecture.
 *
 * ---------------------------------------------------------------------------
 * DEMO CONFIGURATION — READ THIS
 *
 * The table is currently readable and writable by anyone holding the anon
 * key, and that key ships in the client on a public page. That is acceptable
 * for a hackathon demo running on seeded data. It is NOT acceptable for a
 * real screening camp: it would put identifiable patient health records on
 * an open endpoint.
 *
 * Before any field use, either
 *   (a) sync pseudonymous data only, keeping name and phone on device, or
 *   (b) put per-volunteer auth in front of it with row-level security.
 * Both are written up in the roadmap.
 * ---------------------------------------------------------------------------
 */

const TABLE = 'screenings';
const POLL_MS = 12000;

export const SYNC = { OFF: 'off', IDLE: 'idle', SYNCING: 'syncing', ERROR: 'error' };

let state = SYNC.OFF;
let lastError = '';
let lastSyncAt = null;
let timer = null;
const listeners = new Set();

export function onSyncChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach(fn => fn(status())); }

export function status() {
  return { state, lastError, lastSyncAt, configured: isConfigured() };
}

function cfg() {
  return {
    url: (localStorage.getItem('sl.sbUrl') || '').replace(/\/+$/, ''),
    key: localStorage.getItem('sl.sbKey') || ''
  };
}

export function isConfigured() {
  const { url, key } = cfg();
  return !!(url && key);
}

export function setConfig(url, key) {
  localStorage.setItem('sl.sbUrl', (url || '').trim().replace(/\/+$/, ''));
  localStorage.setItem('sl.sbKey', (key || '').trim());
  state = isConfigured() ? SYNC.IDLE : SYNC.OFF;
  emit();
}

function headers(extra = {}) {
  const { key } = cfg();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

/* ------------------------------------------------------------------ *
 * Connection test
 * ------------------------------------------------------------------ */

export async function testConnection() {
  const { url, key } = cfg();
  if (!url || !key) return { ok: false, message: 'Project URL and anon key are both required.' };

  try {
    const res = await fetch(`${url}/rest/v1/${TABLE}?select=id&limit=1`, { headers: headers() });
    if (res.ok) {
      const rows = await res.json();
      return { ok: true, message: `Connected. Table "${TABLE}" is reachable.`, rows: rows.length };
    }
    const body = await res.text().catch(() => '');
    if (res.status === 404) {
      return { ok: false, message: `Table "${TABLE}" not found. Run the setup SQL in the Supabase SQL editor.` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Key rejected, or row-level security is blocking access. Check the anon key and the policy.' };
    }
    return { ok: false, message: `${res.status}: ${body.slice(0, 160)}` };
  } catch (err) {
    return { ok: false, message: `Network error: ${err.message}` };
  }
}

/* ------------------------------------------------------------------ *
 * Push — send anything marked dirty
 * ------------------------------------------------------------------ */

async function push(records, save) {
  const dirty = records.filter(r => r._dirty);
  if (!dirty.length) return 0;

  const { url } = cfg();
  const payload = dirty.map(r => ({
    id: r.id,
    updated_at: r.updatedAt || new Date().toISOString(),
    data: stripLocalFlags(r)
  }));

  const res = await fetch(`${url}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`push ${res.status}: ${body.slice(0, 160)}`);
  }

  // Clear the dirty flag only once the server has accepted it
  const ids = new Set(dirty.map(r => r.id));
  const next = records.map(r => (ids.has(r.id) ? { ...r, _dirty: false } : r));
  save(next);
  return dirty.length;
}

function stripLocalFlags(r) {
  const { _dirty, ...clean } = r;
  return clean;
}

/* ------------------------------------------------------------------ *
 * Pull — merge remote in, last write wins
 * ------------------------------------------------------------------ */

async function pull(records, save) {
  const { url } = cfg();
  const res = await fetch(`${url}/rest/v1/${TABLE}?select=id,updated_at,data&order=updated_at.desc`, {
    headers: headers()
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`pull ${res.status}: ${body.slice(0, 160)}`);
  }

  const remote = await res.json();
  const byId = new Map(records.map(r => [r.id, r]));
  let changed = 0;

  for (const row of remote) {
    const local = byId.get(row.id);
    const remoteAt = new Date(row.updated_at || 0).getTime();
    const localAt = local ? new Date(local.updatedAt || 0).getTime() : -1;

    // A locally dirty record has edits the server has not seen; keep it.
    if (local && local._dirty) continue;

    if (!local || remoteAt > localAt) {
      byId.set(row.id, { ...row.data, id: row.id, updatedAt: row.updated_at, _dirty: false });
      changed++;
    }
  }

  if (changed) {
    const merged = [...byId.values()].sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
    save(merged);
  }
  return changed;
}

/* ------------------------------------------------------------------ *
 * Cycle
 * ------------------------------------------------------------------ */

export async function syncNow({ read, save }) {
  if (!isConfigured()) { state = SYNC.OFF; emit(); return { pushed: 0, pulled: 0 }; }
  if (state === SYNC.SYNCING) return { pushed: 0, pulled: 0 };
  if (!navigator.onLine) { state = SYNC.IDLE; emit(); return { pushed: 0, pulled: 0 }; }

  state = SYNC.SYNCING; lastError = ''; emit();
  try {
    const pushed = await push(read(), save);
    const pulled = await pull(read(), save);
    lastSyncAt = new Date();
    state = SYNC.IDLE;
    emit();
    return { pushed, pulled };
  } catch (err) {
    lastError = err.message;
    state = SYNC.ERROR;
    emit();
    return { pushed: 0, pulled: 0, error: err.message };
  }
}

export function startSync(io) {
  stopSync();
  if (!isConfigured()) { state = SYNC.OFF; emit(); return; }
  state = SYNC.IDLE; emit();

  syncNow(io);
  timer = setInterval(() => syncNow(io), POLL_MS);

  // Sync the moment the tab is looked at again, and when signal returns
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow(io);
  });
  window.addEventListener('online', () => syncNow(io));
}

export function stopSync() {
  if (timer) { clearInterval(timer); timer = null; }
}

/* ------------------------------------------------------------------ *
 * Setup SQL, surfaced in the UI so nobody has to hunt for it
 * ------------------------------------------------------------------ */

export const SETUP_SQL = `-- Sehat Ledger: run once in the Supabase SQL editor

create table if not exists screenings (
  id          text primary key,
  updated_at  timestamptz not null default now(),
  data        jsonb       not null
);

create index if not exists screenings_updated_at_idx
  on screenings (updated_at desc);

alter table screenings enable row level security;

-- DEMO POLICY: open to anyone holding the anon key.
-- Replace before any real screening camp. See sync.js header.
drop policy if exists "demo open access" on screenings;
create policy "demo open access" on screenings
  for all using (true) with check (true);`;
