// Pain tracking logic — pure functions, no React

// A pain entry has shape:
// {
//   date: 'YYYY-MM-DD',            (local date string)
//   morningPain: 0..10,            (pain first thing when standing up)
//   deskPain: 0..10,               (pain after prolonged sitting / knee extension)
//   postRunPain: 0..10 | null,     (only if run that day)
//   note: string (optional, brief)
// }
//
// Storage shape: { [dateISO]: entry }

// Get the entry for a given date, or null if none
export function getEntryForDate(painLog, dateISO) {
  return painLog && painLog[dateISO] ? painLog[dateISO] : null;
}

// Has the user entered morning/desk pain for today?
export function hasDailyEntry(painLog, dateISO) {
  const e = getEntryForDate(painLog, dateISO);
  return e !== null && (e.morningPain !== undefined || e.deskPain !== undefined);
}

// Return the last N days of entries sorted by date ascending,
// filling missing days with null entries for charting.
export function getRecentEntries(painLog, days = 30, todayISO) {
  const result = [];
  const [y, m, d] = todayISO.split('-').map(Number);
  const today = new Date(y, m - 1, d);
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    result.push({
      date: key,
      entry: painLog && painLog[key] ? painLog[key] : null,
    });
  }
  return result;
}

// Compute summary stats: 7-day average morning pain, trend direction, etc.
export function computeStats(painLog, todayISO) {
  const recent14 = getRecentEntries(painLog || {}, 14, todayISO);
  const last7 = recent14.slice(-7);
  const prev7 = recent14.slice(0, 7);

  const avgOf = (arr, field) => {
    const values = arr.map(x => x.entry?.[field]).filter(v => typeof v === 'number');
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
  };

  const avgMorning7 = avgOf(last7, 'morningPain');
  const avgMorningPrev7 = avgOf(prev7, 'morningPain');
  const avgDesk7 = avgOf(last7, 'deskPain');
  const avgPostRun7 = avgOf(last7, 'postRunPain');

  let trend = null;
  if (avgMorning7 !== null && avgMorningPrev7 !== null) {
    const delta = avgMorning7 - avgMorningPrev7;
    if (Math.abs(delta) < 0.5) trend = 'flat';
    else if (delta < 0) trend = 'improving';
    else trend = 'worsening';
  }

  // Pain-free streak: consecutive days at end where morningPain <= 2
  let painFreeStreak = 0;
  for (let i = recent14.length - 1; i >= 0; i--) {
    const p = recent14[i].entry?.morningPain;
    if (typeof p === 'number' && p <= 2) painFreeStreak++;
    else if (p === undefined && recent14[i].entry) continue; // skip days with no morning entry but some data
    else if (typeof p === 'number' && p > 2) break;
    else break; // no data breaks the streak
  }

  // Days of data in last 14
  const daysLogged = recent14.filter(d => d.entry !== null).length;

  // Worst day in last 14
  let worstPain = null;
  recent14.forEach(d => {
    if (!d.entry) return;
    const maxToday = Math.max(
      d.entry.morningPain ?? -1,
      d.entry.deskPain ?? -1,
      d.entry.postRunPain ?? -1,
    );
    if (maxToday > (worstPain ?? -1)) worstPain = maxToday;
  });

  return {
    avgMorning7: avgMorning7 !== null ? Math.round(avgMorning7 * 10) / 10 : null,
    avgDesk7: avgDesk7 !== null ? Math.round(avgDesk7 * 10) / 10 : null,
    avgPostRun7: avgPostRun7 !== null ? Math.round(avgPostRun7 * 10) / 10 : null,
    trend,
    painFreeStreak,
    daysLogged,
    worstPain,
  };
}

// Export pain log as CSV for sharing with PT
export function painLogToCSV(painLog) {
  const rows = [['date', 'morning_pain', 'desk_pain', 'post_run_pain', 'note']];
  const sortedDates = Object.keys(painLog || {}).sort();
  sortedDates.forEach(date => {
    const e = painLog[date];
    rows.push([
      date,
      e.morningPain ?? '',
      e.deskPain ?? '',
      e.postRunPain ?? '',
      (e.note ?? '').replace(/"/g, '""').replace(/\n/g, ' '),
    ]);
  });
  return rows.map(r => r.map(c => typeof c === 'string' && c.includes(',') ? `"${c}"` : c).join(',')).join('\n');
}

// ============================================================
// Rehab checklist logic
// ============================================================
//
// Rehab config shape:
//   { exercises: [{ id: string, name: string, note?: string }], createdAt: ISO }
//
// Rehab log shape:
//   { [dateISO]: { [exerciseId]: true } }  — missing exercises = not done

export const STRENGTH_CATEGORIES = [
  'Hip prep',
  'Posterior chain',
  'Single-leg power',
  'Trunk',
  'Calf / PF',
  'Mobility',
];

export const DEFAULT_REHAB_CONFIG = {
  exercises: [
    // Hip prep
    { id: 'clamshells', name: 'Clamshells with band', dose: '2×20 each', category: 'Hip prep' },
    { id: 'side-leg-raise', name: 'Side leg raise', dose: '2×20 each', category: 'Hip prep' },
    { id: 'standing-hip-flexor', name: 'Standing hip flexor raise (banded)', dose: '2×15 each', category: 'Hip prep' },
    { id: 'lateral-band-walks', name: 'Lateral band walks', dose: '3×10–15 steps', category: 'Hip prep' },
    // Posterior chain
    { id: 'sl-rdl', name: 'Single-leg RDL', dose: '3×8 each', category: 'Posterior chain' },
    { id: 'sl-glute-bridge', name: 'Single-leg glute bridge', dose: '2×10 each', category: 'Posterior chain' },
    // Single-leg power
    { id: 'bulgarian-split-squat', name: 'Bulgarian split squat', dose: '3×8 each', category: 'Single-leg power' },
    { id: 'goblet-squat', name: 'Goblet squat', dose: '3×10', category: 'Single-leg power' },
    { id: 'sl-step-up', name: 'Single-leg step-ups (w/ dumbbells)', dose: '2–3×10–12 each', category: 'Single-leg power' },
    { id: 'sl-hops', name: 'Single-leg hops / skipping drills', dose: '2–3×8–10 contacts each', category: 'Single-leg power' },
    // Trunk
    { id: 'side-plank-leg-raise', name: 'Side plank with leg raise', dose: '2×30s each', category: 'Trunk' },
    { id: 'copenhagen-plank', name: 'Copenhagen plank', dose: '3×20s each', category: 'Trunk' },
    { id: 'dead-bug', name: 'Dead bug', dose: '3×8 each side', category: 'Trunk' },
    { id: 'plank-hold', name: 'Plank hold', dose: '2–3×30–60s', category: 'Trunk' },
    // Calf / PF
    { id: 'rathleff-calf-raise', name: 'Heavy slow calf raise (Rathleff, towel under toes)', dose: '3×12 each', category: 'Calf / PF' },
    { id: 'towel-curls', name: 'Towel curls / short foot doming', dose: '3×10–20', category: 'Calf / PF' },
    { id: 'foot-inversion', name: 'Resisted foot inversion (band)', dose: '3×10–15 each', category: 'Calf / PF' },
    // Mobility
    { id: 'calf-stretch', name: 'Calf stretch (knee straight + bent)', dose: '2×30s each', category: 'Mobility' },
  ],
  createdAt: new Date().toISOString(),
};

// Count exercises completed for a given date
export function getRehabCountForDate(rehabLog, dateISO, totalExercises) {
  const entry = rehabLog?.[dateISO];
  if (!entry) return { done: 0, total: totalExercises };
  const done = Object.values(entry).filter(Boolean).length;
  return { done, total: totalExercises };
}

// Was a specific exercise done on a given date?
export function wasExerciseDone(rehabLog, dateISO, exerciseId) {
  return !!(rehabLog?.[dateISO]?.[exerciseId]);
}

// Rehab streak: consecutive days ending today where at least 1 exercise was done
export function getRehabStreak(rehabLog, todayISO) {
  const [y, m, d] = todayISO.split('-').map(Number);
  const today = new Date(y, m - 1, d);
  let streak = 0;
  for (let i = 0; i < 60; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    const entry = rehabLog?.[key];
    const didAny = entry && Object.values(entry).some(Boolean);
    if (didAny) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// Get last N days of rehab data for a consistency grid display
export function getRehabGridData(rehabLog, days = 14, todayISO) {
  const result = [];
  const [y, m, d] = todayISO.split('-').map(Number);
  const today = new Date(y, m - 1, d);
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    const entry = rehabLog?.[key];
    const count = entry ? Object.values(entry).filter(Boolean).length : 0;
    result.push({ date: key, count, dayOfWeek: date.getDay() });
  }
  return result;
}

// Compute rehab-compliance stats for last 7 and 14 days
export function computeRehabStats(rehabLog, totalExercises, todayISO) {
  const days7 = getRehabGridData(rehabLog, 7, todayISO);
  const days14 = getRehabGridData(rehabLog, 14, todayISO);
  const daysDone7 = days7.filter(d => d.count > 0).length;
  const daysDone14 = days14.filter(d => d.count > 0).length;
  const streak = getRehabStreak(rehabLog, todayISO);
  return {
    daysDone7,
    daysDone14,
    streak,
    completionRate7: Math.round((daysDone7 / 7) * 100),
  };
}
