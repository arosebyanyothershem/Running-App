// Pure plan-generation logic — no React dependencies

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function paceFromSeconds(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function computePaces(fiveKseconds) {
  const fiveKpaceSec = fiveKseconds / 3.10686;
  return {
    easy: {
      low: Math.round(fiveKpaceSec + 135),
      high: Math.round(fiveKpaceSec + 180),
    },
    subT: {
      low: Math.round(fiveKpaceSec + 55),
      high: Math.round(fiveKpaceSec + 75),
    },
    threshold: Math.round(fiveKpaceSec + 30),
  };
}

export function computeHRzones(maxHR) {
  return {
    easyMax: Math.round(maxHR * 0.70),
    subTLow: Math.round(maxHR * 0.84),
    subTHigh: Math.round(maxHR * 0.88),
    lt2: Math.round(maxHR * 0.90),
  };
}

export function generatePlan({
  weeks,
  daysPerWeek,
  startingMiles,
  recovering,
  paces,
  hr,
  preferredLongDay,
  preferredQualityDays,
  startDate,
}) {
  const out = [];
  let currentMiles = startingMiles;

  for (let w = 0; w < weeks; w++) {
    let subTcount;
    if (recovering) {
      if (w < 2) subTcount = 0;
      else if (w < 4) subTcount = 1;
      else subTcount = 2;
    } else {
      if (w < 1) subTcount = 1;
      else subTcount = 2;
    }
    if (w >= 6 && daysPerWeek >= 6 && !recovering) subTcount = Math.min(3, subTcount + 1);
    subTcount = Math.min(subTcount, daysPerWeek - 2);

    if (w > 0) {
      if ((w + 1) % 4 === 0) {
        currentMiles = Math.round((currentMiles * 0.85) * 10) / 10;
      } else {
        currentMiles = Math.round((currentMiles * 1.10) * 10) / 10;
      }
    }

    const weekStart = addDays(startDate, w * 7);
    const weekPlan = buildWeek({
      weekIndex: w,
      totalMiles: currentMiles,
      daysPerWeek,
      subTcount,
      recovering,
      paces,
      hr,
      preferredLongDay,
      preferredQualityDays,
      isStepback: (w + 1) % 4 === 0 && w > 0,
      weekStart,
    });
    out.push(weekPlan);
  }
  return out;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateForDay(weekStart, dayIndex) {
  return addDays(weekStart, dayIndex);
}

function buildWeek({
  weekIndex, totalMiles, daysPerWeek, subTcount, recovering,
  paces, hr, preferredLongDay, preferredQualityDays, isStepback, weekStart,
}) {
  const longMiles = Math.max(3, Math.round(totalMiles * 0.30 * 2) / 2);
  const subTmiles = subTcount > 0 ? Math.max(3, Math.round(totalMiles * 0.20 * 2) / 2) : 0;
  const easyCount = daysPerWeek - 1 - subTcount;
  const remaining = Math.max(easyCount * 2, totalMiles - longMiles - subTmiles * subTcount);
  const easyMiles = easyCount > 0 ? Math.round((remaining / easyCount) * 2) / 2 : 0;

  const days = Array(7).fill(null).map((_, i) => ({
    sessions: [],
    date: dateForDay(weekStart, i),
  }));

  days[preferredLongDay].sessions.push(buildLongRun(longMiles, paces, hr));

  const availableQuality = preferredQualityDays.filter(d => d !== preferredLongDay);
  for (let i = 0; i < subTcount; i++) {
    const d = availableQuality[i % availableQuality.length];
    if (days[d].sessions.length === 0) {
      days[d].sessions.push(buildSubT(subTmiles, weekIndex, recovering, paces, hr));
    }
  }

  const runDaysSoFar = days.filter(d => d.sessions.length > 0).length;
  const easyNeeded = daysPerWeek - runDaysSoFar;
  let placedEasy = 0;
  const order = [0, 2, 4, 1, 3, 5, 6];
  for (const d of order) {
    if (placedEasy >= easyNeeded) break;
    if (days[d].sessions.length === 0) {
      days[d].sessions.push(buildEasy(easyMiles, paces, hr));
      placedEasy++;
    }
  }

  // Activation every day
  days.forEach((d, i) => {
    d.sessions.unshift({
      id: `act-${weekIndex}-${i}`,
      type: 'activation',
      title: 'AM Activation (5 min)',
      detail: 'Do first thing in the morning. Side-lying leg raises 30/side • Clamshells 30/side • Single-leg glute bridges 10/side × 2.',
    });
  });

  // Pre-run warm-up on run days
  days.forEach((d, i) => {
    const hasRun = d.sessions.some(s => ['easy', 'subT', 'long'].includes(s.type));
    if (hasRun) {
      d.sessions.splice(1, 0, {
        id: `warm-${weekIndex}-${i}`,
        type: 'warmup',
        title: 'Pre-run warm-up (5 min)',
        detail: "Immediately before running. Monster walks 20 fwd + 20 back • World's greatest stretch 5/side • Leg swings 15× each direction.",
      });
    }
  });

  // Strength on easy/rest days only
  const easyDayIndices = days.map((d, i) => {
    const hasEasy = d.sessions.some(s => s.type === 'easy');
    const hasSubT = d.sessions.some(s => s.type === 'subT');
    const hasLong = d.sessions.some(s => s.type === 'long');
    return (hasEasy && !hasSubT && !hasLong) ? i : -1;
  }).filter(i => i >= 0);

  const restDayIndices = days.map((d, i) => {
    const hasRun = d.sessions.some(s => ['easy', 'subT', 'long'].includes(s.type));
    return !hasRun ? i : -1;
  }).filter(i => i >= 0);

  const strengthCandidates = [...easyDayIndices, ...restDayIndices];
  const picks = pickNonConsecutive(strengthCandidates, 3);
  picks.forEach(i => {
    days[i].sessions.push({
      id: `str-${weekIndex}-${i}`,
      type: 'strength',
      title: 'Strength (15–20 min)',
      detail: 'Later in the day or after your easy run. Bulgarian split squats 8/side × 3 • Single-leg RDL 8/side × 3 • Side plank + leg lift 8/side × 3 • Banded wall sit 3 × 30s.',
    });
  });

  return {
    weekIndex,
    label: `Week ${weekIndex + 1}`,
    totalMiles,
    subTcount,
    isStepback,
    phase: phaseFor(weekIndex, recovering),
    weekStart,
    days,
  };
}

function pickNonConsecutive(arr, n) {
  const out = [];
  const sorted = [...arr].sort((a, b) => a - b);
  for (const x of sorted) {
    if (out.length >= n) break;
    if (out.length === 0 || x - out[out.length - 1] >= 2) out.push(x);
  }
  if (out.length < n) {
    for (const x of sorted) {
      if (out.length >= n) break;
      if (!out.includes(x)) out.push(x);
    }
  }
  return out;
}

function phaseFor(w, recovering) {
  if (recovering) {
    if (w < 2) return 'Rebuild easy';
    if (w < 4) return 'Intro sub-T';
    return 'Full Singles';
  }
  return w < 1 ? 'Intro sub-T' : 'Full Singles';
}

function buildEasy(miles, paces, hr) {
  return {
    id: `easy-${Math.random().toString(36).slice(2, 10)}`,
    type: 'easy',
    title: `Easy ${miles.toFixed(1)} mi`,
    pace: `${paceFromSeconds(paces.easy.low)}–${paceFromSeconds(paces.easy.high)}/mi`,
    hr: `HR < ${hr.easyMax}`,
    miles,
    detail: "Fully conversational. If HR creeps above target, slow down — don't speed up to hit pace.",
    structured: null,
  };
}

function buildSubT(miles, weekIndex, recovering, paces, hr) {
  let structure;
  let structured;
  if (recovering && weekIndex < 4) {
    structure = '4 × 1 km @ sub-T pace w/ 90 sec jog recovery';
    structured = { reps: 4, distM: 1000, recoverySec: 90 };
  } else if (weekIndex % 2 === 0) {
    structure = '5 × 1 km @ sub-T pace w/ 1 min jog recovery';
    structured = { reps: 5, distM: 1000, recoverySec: 60 };
  } else {
    structure = '4 × 1 mi @ sub-T pace w/ 90 sec jog recovery';
    structured = { reps: 4, distM: 1609, recoverySec: 90 };
  }
  return {
    id: `subt-${Math.random().toString(36).slice(2, 10)}`,
    type: 'subT',
    title: `Sub-T intervals ${miles.toFixed(1)} mi`,
    pace: `${paceFromSeconds(paces.subT.low)}–${paceFromSeconds(paces.subT.high)}/mi`,
    hr: `HR ${hr.subTLow}–${hr.subTHigh}`,
    miles,
    detail: `${structure}. Warm-up 1 mi + cool-down 1 mi easy. Should feel firm but controlled — not gasping.`,
    structured: { ...structured, paceLow: paces.subT.low, paceHigh: paces.subT.high },
  };
}

function buildLongRun(miles, paces, hr) {
  return {
    id: `long-${Math.random().toString(36).slice(2, 10)}`,
    type: 'long',
    title: `Long run ${miles.toFixed(1)} mi`,
    pace: `${paceFromSeconds(paces.easy.low)}–${paceFromSeconds(paces.easy.high)}/mi`,
    hr: `HR < ${hr.easyMax + 5}`,
    miles,
    detail: 'Keep it fully easy start to finish. Resist the urge to finish fast.',
    structured: null,
  };
}
