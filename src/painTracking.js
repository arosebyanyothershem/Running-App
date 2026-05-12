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

export const DEFAULT_REHAB_CONFIG = {
  exercises: [],
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
