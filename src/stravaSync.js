// Strava → Singles Planner import.
//
// Pure functions (no React, no storage) so the matching can be tested on its own.
//
// What an import does, per calendar day in the plan:
//   • Runs: duplicate recordings are collapsed (same start within 2 min, distance within 5%),
//     and runs that follow each other closely (≤ 90 min gap) are combined into one workout —
//     e.g. a warm-up recorded separately from the main set. Each combined run is matched to
//     that day's planned run (closest planned duration wins), logged with Strava's moving
//     time, distance and average HR, and checked off. A run with no planned session that day
//     becomes an "extra" run.
//   • Cross-training (elliptical, bike, swim, row, …): added as a completed extra session.
//   • Strength / PT workouts: skipped unless includeStrength is on.
//   • Walks, hikes and anything outside the plan's dates: ignored.
//
// Never overwrites anything entered by hand: if a planned run already has a manual log,
// the Strava run is linked to it but the manual log is kept.
// An activity is "already imported" when any session in the plan lists its id in
// `stravaIds`, so syncing again never duplicates anything.

export const RUN_SPORTS = new Set(['Run', 'TrailRun', 'VirtualRun']);
export const CROSS_SPORTS = {
  Elliptical: 'Elliptical',
  Ride: 'Cycling',
  VirtualRide: 'Cycling',
  EBikeRide: 'Cycling',
  GravelRide: 'Cycling',
  MountainBikeRide: 'Cycling',
  Swim: 'Swimming',
  Rowing: 'Rowing',
  VirtualRow: 'Rowing',
  StairStepper: 'Stair stepper',
  NordicSki: 'Nordic skiing',
  BackcountrySki: 'Backcountry skiing',
  InlineSkate: 'Skating',
  Kayaking: 'Kayaking',
  Canoeing: 'Canoeing',
  StandUpPaddling: 'Paddling',
  Snowshoe: 'Snowshoeing',
  Pilates: 'Pilates',
  Yoga: 'Yoga',
};
export const STRENGTH_SPORTS = new Set(['WeightTraining', 'Workout', 'Crossfit', 'PhysicalTherapy', 'HighIntensityIntervalTraining']);

const PLANNED_RUN_TYPES = new Set(['easy', 'subT', 'long', 'mp', 'race']);
const MILE_M = 1609.344;

// Strava's start_date_local is local wall-clock time written with a "Z". Treat it as a
// naive local timestamp: the date part is the calendar day, and differences in ms are real.
function localMs(a) {
  return Date.parse((a.start_date_local || a.start_date || '').replace(/Z$/, '') + 'Z');
}
function localDate(a) {
  return String(a.start_date_local || a.start_date || '').slice(0, 10);
}

export function sessionKey(weekIndex, dayIdx, sessionId) {
  return `${weekIndex}-${dayIdx}-${sessionId}`;
}

/** Every Strava activity id already attached to a session in the plan. */
export function importedIds(plan) {
  const ids = new Set();
  for (const w of plan || []) for (const d of w.days) for (const s of d.sessions) {
    for (const id of s.stravaIds || []) ids.add(String(id));
  }
  return ids;
}

/** Drop second recordings of the same run (e.g. watch + phone app both recording). */
export function dedupeRuns(runs) {
  const sorted = [...runs].sort((a, b) => localMs(a) - localMs(b));
  const kept = [];
  const dupes = [];
  for (const r of sorted) {
    const twin = kept.find(k =>
      Math.abs(localMs(k) - localMs(r)) <= 2 * 60 * 1000 &&
      Math.abs((k.distance || 0) - (r.distance || 0)) <= 0.05 * Math.max(k.distance || 0, r.distance || 0, 1)
    );
    if (twin) {
      // Keep whichever recording has heart rate; otherwise the longer one.
      const better = (r.average_heartrate && !twin.average_heartrate) ||
        (!!r.average_heartrate === !!twin.average_heartrate && (r.moving_time || 0) > (twin.moving_time || 0));
      if (better) { kept[kept.indexOf(twin)] = r; dupes.push(twin); } else dupes.push(r);
    } else kept.push(r);
  }
  return { kept, dupes };
}

/** Combine runs on one day that follow each other closely into a single workout. */
export function groupRuns(runs, maxGapMin = 90) {
  const sorted = [...runs].sort((a, b) => localMs(a) - localMs(b));
  const groups = [];
  for (const r of sorted) {
    const g = groups[groups.length - 1];
    if (g) {
      const last = g[g.length - 1];
      const lastEnd = localMs(last) + (last.elapsed_time || last.moving_time || 0) * 1000;
      if (localMs(r) - lastEnd <= maxGapMin * 60 * 1000) { g.push(r); continue; }
    }
    groups.push([r]);
  }
  return groups.map(parts => {
    const timeSec = parts.reduce((t, p) => t + (p.moving_time || 0), 0);
    const meters = parts.reduce((t, p) => t + (p.distance || 0), 0);
    const hrParts = parts.filter(p => p.average_heartrate);
    const hrTime = hrParts.reduce((t, p) => t + (p.moving_time || 0), 0);
    const avgHR = hrTime > 0
      ? Math.round(hrParts.reduce((t, p) => t + p.average_heartrate * (p.moving_time || 0), 0) / hrTime)
      : null;
    return {
      ids: parts.map(p => String(p.id)),
      names: [...new Set(parts.map(p => p.name).filter(Boolean))],
      timeSec,
      distMi: Math.round((meters / MILE_M) * 100) / 100,
      avgHR,
      parts: parts.length,
    };
  });
}

function fmtMin(sec) { return Math.max(1, Math.round(sec / 60)); }

function runLog(bundle) {
  const label = bundle.names.join(' + ');
  return {
    distMi: bundle.distMi,
    timeSec: bundle.timeSec,
    avgHR: bundle.avgHR,
    notes: `From Strava: ${label}${bundle.parts > 1 ? ` (${bundle.parts} recordings combined)` : ''}`,
    loggedAt: new Date().toISOString(),
    source: 'strava',
    stravaIds: bundle.ids,
  };
}

/**
 * Merge Strava activities into the plan.
 * Returns new { plan, completions, skipped, logs } plus a summary. Inputs are not mutated.
 */
export function mergeStravaActivities({ plan, completions, skipped, logs, activities, includeStrength = false, dismissedIds = [] }) {
  const summary = { matched: 0, extrasAdded: 0, crossAdded: 0, strengthAdded: 0, duplicates: 0, keptManual: 0, ignored: 0, details: [] };
  if (!plan || !plan.length) return { plan, completions, skipped, logs, summary };

  const already = importedIds(plan);
  const dismissed = new Set((dismissedIds || []).map(String));
  const fresh = (activities || []).filter(a => !already.has(String(a.id)) && !dismissed.has(String(a.id)));

  // Locate each plan day by date.
  const dayIndex = new Map();
  plan.forEach((w, wi) => w.days.forEach((d, di) => dayIndex.set(d.date, { wi, di })));

  const newPlan = plan.map(w => ({ ...w, days: w.days.map(d => ({ ...d, sessions: d.sessions.map(s => ({ ...s })) })) }));
  const newCompletions = { ...completions };
  const newSkipped = { ...skipped };
  const newLogs = { ...logs };

  const byDate = new Map();
  for (const a of fresh) {
    const date = localDate(a);
    if (!dayIndex.has(date)) { summary.ignored++; continue; }
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(a);
  }

  const markDone = (week, di, session) => {
    const key = sessionKey(week.weekIndex, di, session.id);
    newCompletions[key] = true;
    delete newSkipped[key];
    return key;
  };
  let seq = 0;
  const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

  for (const [date, acts] of [...byDate.entries()].sort()) {
    const { wi, di } = dayIndex.get(date);
    const week = newPlan[wi];
    const day = week.days[di];

    const runs = acts.filter(a => RUN_SPORTS.has(a.sport_type));
    const cross = acts.filter(a => CROSS_SPORTS[a.sport_type]);
    const strength = acts.filter(a => STRENGTH_SPORTS.has(a.sport_type));
    summary.ignored += acts.length - runs.length - cross.length - strength.length;

    // ── Runs ───────────────────────────────────────────────
    const { kept, dupes } = dedupeRuns(runs);
    summary.duplicates += dupes.length;
    const bundles = groupRuns(kept).sort((a, b) => b.timeSec - a.timeSec);
    const dupeIds = dupes.map(d => String(d.id));

    // Candidates: planned runs not yet done/skipped/linked, then hand-added extra runs.
    const used = new Set();
    for (const [bi, bundle] of bundles.entries()) {
      const ids = bi === 0 ? [...bundle.ids, ...dupeIds] : bundle.ids; // remember duplicates on the main run
      const candidates = day.sessions.filter(s =>
        PLANNED_RUN_TYPES.has(s.type) && !used.has(s.id) && !(s.stravaIds && s.stravaIds.length)
      ).filter(s => {
        const key = sessionKey(week.weekIndex, di, s.id);
        return !newSkipped[key];
      });
      // Prefer sessions not yet completed; among those, closest planned duration.
      const minutes = bundle.timeSec / 60;
      const plannedMin = s => s.targetMin || s.durationMin || (s.miles ? s.miles * 9.5 : 45);
      candidates.sort((a, b) => {
        const ka = sessionKey(week.weekIndex, di, a.id), kb = sessionKey(week.weekIndex, di, b.id);
        const doneA = !!(newCompletions[ka] || newLogs[ka]), doneB = !!(newCompletions[kb] || newLogs[kb]);
        if (doneA !== doneB) return doneA ? 1 : -1;
        if (!!a.unscheduled !== !!b.unscheduled) return a.unscheduled ? 1 : -1;
        return Math.abs(plannedMin(a) - minutes) - Math.abs(plannedMin(b) - minutes);
      });
      const target = candidates[0];

      if (target) {
        used.add(target.id);
        target.stravaIds = ids;
        const key = markDone(week, di, target);
        if (newLogs[key] && newLogs[key].source !== 'strava') {
          summary.keptManual++;
          summary.details.push(`${date}: linked to your hand-logged ${target.title || target.label}`);
        } else {
          newLogs[key] = runLog(bundle);
          summary.matched++;
          summary.details.push(`${date}: ${target.title || target.label} ← ${fmtMin(bundle.timeSec)} min, ${bundle.distMi} mi`);
        }
      } else {
        const min = fmtMin(bundle.timeSec);
        const session = {
          id: newId('strava'),
          unscheduled: true,
          type: 'easy',
          label: `${bundle.names[0] || 'Run'} · ${min} min · ${bundle.distMi.toFixed(1)} mi`,
          durationMin: min,
          miles: bundle.distMi,
          notes: 'Imported from Strava',
          source: 'strava',
          stravaIds: ids,
        };
        day.sessions.push(session);
        const key = markDone(week, di, session);
        newLogs[key] = runLog(bundle);
        summary.extrasAdded++;
        summary.details.push(`${date}: extra run ${min} min, ${bundle.distMi} mi`);
      }
    }

    // ── Cross-training ─────────────────────────────────────
    for (const a of cross) {
      const pretty = CROSS_SPORTS[a.sport_type];
      const min = fmtMin(a.moving_time || a.elapsed_time || 0);
      // Link to a hand-added cross session of the same kind if there is one.
      const manual = day.sessions.find(s => s.type === 'cross' && !(s.stravaIds && s.stravaIds.length) && !used.has(s.id) &&
        String(s.crossType || s.label || '').toLowerCase().includes(pretty.toLowerCase().split(' ')[0]));
      if (manual) {
        used.add(manual.id);
        manual.stravaIds = [String(a.id)];
        markDone(week, di, manual);
        summary.keptManual++;
        continue;
      }
      const session = {
        id: newId('strava'),
        unscheduled: true,
        type: 'cross',
        crossType: pretty,
        durationMin: min,
        label: `${pretty} · ${min} min`,
        notes: `From Strava: ${a.name || pretty}`,
        source: 'strava',
        stravaIds: [String(a.id)],
      };
      day.sessions.push(session);
      markDone(week, di, session);
      summary.crossAdded++;
      summary.details.push(`${date}: ${pretty} ${min} min`);
    }

    // ── Strength / PT (optional) ───────────────────────────
    if (includeStrength) {
      for (const a of strength) {
        const min = fmtMin(a.moving_time || a.elapsed_time || 0);
        const kind = a.sport_type === 'PhysicalTherapy' ? 'PT' : 'Strength';
        const session = {
          id: newId('strava'),
          unscheduled: true,
          type: 'strength',
          durationMin: min,
          label: `${kind} · ${min} min`,
          notes: `From Strava: ${a.name || kind}`,
          source: 'strava',
          stravaIds: [String(a.id)],
        };
        day.sessions.push(session);
        markDone(week, di, session);
        summary.strengthAdded++;
      }
    } else {
      summary.ignored += strength.length;
    }
  }

  return { plan: newPlan, completions: newCompletions, skipped: newSkipped, logs: newLogs, summary };
}

/** One-line description of what a sync did, for the toast. */
export function describeSummary(s) {
  const parts = [];
  if (s.matched) parts.push(`${s.matched} planned run${s.matched === 1 ? '' : 's'} logged`);
  if (s.extrasAdded) parts.push(`${s.extrasAdded} extra run${s.extrasAdded === 1 ? '' : 's'}`);
  if (s.crossAdded) parts.push(`${s.crossAdded} cross-training`);
  if (s.strengthAdded) parts.push(`${s.strengthAdded} strength`);
  if (s.keptManual) parts.push(`${s.keptManual} already logged by hand`);
  return parts.length ? `Strava: ${parts.join(', ')}` : 'Strava: you’re up to date';
}

// ── Connection (tokens live in this browser) ───────────────────────────────

export function decodeConnectionCode(code) {
  const clean = String(code || '').trim().replace(/\s+/g, '');
  if (!clean) throw new Error('Paste the code first.');
  let json;
  try {
    const b64 = clean.replace(/-/g, '+').replace(/_/g, '/');
    json = JSON.parse(decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4)))));
  } catch {
    throw new Error('That doesn’t look like a Strava connection code.');
  }
  if (!json || !json.refreshToken) throw new Error('That code is missing its Strava login.');
  return json;
}

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `Request failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  return data;
}

export async function fetchStravaStatus() {
  return api('/api/strava?action=status');
}

/** Returns a valid auth object, refreshing the access token if it is about to expire. */
export async function ensureFreshAuth(auth) {
  if (!auth || !auth.refreshToken) throw new Error('Not connected to Strava');
  const now = Math.floor(Date.now() / 1000);
  if (auth.accessToken && auth.expiresAt && auth.expiresAt - now > 120) return { auth, changed: false };
  const d = await api('/api/strava?action=refresh', { method: 'POST', body: JSON.stringify({ refresh_token: auth.refreshToken }) });
  return { auth: { ...auth, ...d }, changed: true };
}

/** All activities since `afterEpoch` (seconds), oldest first. */
export async function fetchActivitiesSince(accessToken, afterEpoch) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/api/strava?action=activities&after=${afterEpoch}&page=${page}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export async function deauthorizeStrava(accessToken) {
  return api('/api/strava?action=deauthorize', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => ({}));
}
