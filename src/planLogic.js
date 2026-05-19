// Pure plan-generation logic — no React dependencies.
//
// This module generates a 24-week marathon training plan structured as:
//   Phase 1 (Maintenance): weeks 1 through (race_week - 16)
//     - 4 runs/wk: Sun long, Tue sub-T, Wed easy, Fri easy
//     - Thu: open (user fills in cross-train or rest)
//     - Mon, Sat: rest
//   Phase 2 (Marathon Block): final 16 weeks
//     - Mini-block 1: foundation (weeks 1-5 of block) — 2 sub-T, build long
//     - Mini-block 2: increasing load (weeks 6-10) — 2 sub-T, longer reps
//     - Mini-block 3: marathon-specific (weeks 11-14) — 1 sub-T + 1 MP session
//     - Taper: weeks 15-16
//   Long run capped at 3 hours total time (per Sirpoc).
//   Step-backs at marathon-block week 5 and week 10 (and Phase 1 mid-point if long enough).

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ============================================================
// Pace and HR utilities
// ============================================================

export function paceFromSeconds(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// VDOT-style pace calculation from 5K time (sec).
// Easy = +1:55-2:25 over 5K pace
// Marathon pace = +0:55-1:05 over 5K pace (depends on VDOT, this is approximate)
// Sub-T (10K pace ish) = +0:25-0:40 over 5K pace
// Threshold (LT2) = +0:15-0:25 over 5K pace
export function computePaces(fiveKseconds) {
  const fiveKpaceSec = fiveKseconds / 3.10686;
  return {
    easy: {
      low: Math.round(fiveKpaceSec + 115),  // ~1:55 over 5K pace
      high: Math.round(fiveKpaceSec + 165),  // ~2:45 over 5K pace
    },
    marathon: {
      low: Math.round(fiveKpaceSec + 55),
      high: Math.round(fiveKpaceSec + 65),
    },
    subT: {
      // Calibrated to Sirpoc's Table 1.4 — sub-T pace varies by rep duration.
      // For 5K 21:13 (~6:50/mi pace), Sirpoc's table gives:
      //   Short reps (~3 min):  7:20-7:30/mi (≈ +30-40 sec over 5K)
      //   Medium reps (~6 min): 7:30-7:40/mi (≈ +40-50 sec)
      //   Long reps (~10 min):  7:40-7:55/mi (≈ +50-65 sec)
      // We use low = short-rep pace, high = long-rep pace.
      low: Math.round(fiveKpaceSec + 30),
      high: Math.round(fiveKpaceSec + 65),
    },
    threshold: Math.round(fiveKpaceSec + 15),
  };
}

// Karvonen-based HR zones using max HR and resting HR.
// HRR = max - resting
// Easy ceiling = resting + 0.60 * HRR  (top of Zone 1)
// Sub-T low = resting + 0.80 * HRR
// Sub-T high = resting + 0.87 * HRR
// LT2 = resting + 0.90 * HRR
export function computeHRzones(maxHR, restingHR) {
  const rest = restingHR || 50;
  const hrr = maxHR - rest;
  return {
    easyMax: Math.round(rest + 0.60 * hrr),
    subTLow: Math.round(rest + 0.80 * hrr),
    subTHigh: Math.round(rest + 0.87 * hrr),
    lt2: Math.round(rest + 0.90 * hrr),
  };
}

// Estimate VDOT from 5K time (seconds).
// Calibrated to match vdoto2.com (Jack Daniels' Running Formula tables).
// Reference 5K times (verified against vdoto2.com and Daniels' published tables):
//   VDOT 70 → 14:38 = 878
//   VDOT 65 → 15:36 = 936
//   VDOT 60 → 16:48 = 1008
//   VDOT 55 → 18:19 = 1099
//   VDOT 52 → 19:17 = 1157
//   VDOT 50 → 19:57 = 1197
//   VDOT 48 → 20:40 = 1240
//   VDOT 47 → 20:54 = 1254
//   VDOT 46 → 21:25 = 1285
//   VDOT 45 → 21:50 = 1310
//   VDOT 44 → 22:15 = 1335
//   VDOT 43 → 22:41 = 1361
//   VDOT 40 → 24:08 = 1448
//   VDOT 35 → 27:14 = 1634
//   VDOT 30 → 30:40 = 1840
// Example: 21:13 5K → interpolates to VDOT ~46.4 (matches vdoto2.com)
export function vdotFrom5K(fiveKseconds) {
  const ref = [
    [70, 878], [65, 936], [60, 1008], [55, 1099],
    [52, 1157], [50, 1197], [48, 1240], [47, 1254],
    [46, 1285], [45, 1310], [44, 1335], [43, 1361],
    [40, 1448], [35, 1634], [30, 1840],
  ];
  // Interpolate (note: lower VDOT = higher time)
  for (let i = 0; i < ref.length - 1; i++) {
    const [v1, t1] = ref[i];
    const [v2, t2] = ref[i + 1];
    if (fiveKseconds >= t1 && fiveKseconds <= t2) {
      const frac = (fiveKseconds - t1) / (t2 - t1);
      const v = v1 + frac * (v2 - v1);
      return Math.round(v * 10) / 10;
    }
  }
  // Out of range
  if (fiveKseconds < ref[0][1]) return ref[0][0];
  return ref[ref.length - 1][0];
}

// Project marathon time from VDOT (sec).
// Calibrated to Daniels' published VDOT tables (verified via vdoto2.com and T2M Coaching).
// Reference points:
//   VDOT 70 → 2:23:10 = 8590
//   VDOT 65 → 2:33:00 = 9180
//   VDOT 60 → 2:43:25 = 9805
//   VDOT 55 → 2:54:00 = 10440
//   VDOT 52 → 3:02:00 = 10920
//   VDOT 50 → 3:07:00 = 11220
//   VDOT 48 → 3:14:00 = 11640
//   VDOT 47 → 3:18:00 = 11880
//   VDOT 46 → 3:24:00 = 12240   (T2M reference)
//   VDOT 45 → 3:28:00 = 12480
//   VDOT 44 → 3:33:00 = 12780
//   VDOT 43 → 3:38:00 = 13080
//   VDOT 40 → 3:55:00 = 14100
//   VDOT 35 → 4:24:00 = 15840
//   VDOT 30 → 4:58:00 = 17880
export function projectMarathonTime(vdot) {
  const ref = [
    [70, 8590], [65, 9180], [60, 9805], [55, 10440],
    [52, 10920], [50, 11220], [48, 11640], [47, 11880],
    [46, 12240], [45, 12480], [44, 12780], [43, 13080],
    [40, 14100], [35, 15840], [30, 17880],
  ];
  for (let i = 0; i < ref.length - 1; i++) {
    const [v1, t1] = ref[i];
    const [v2, t2] = ref[i + 1];
    if (vdot <= v1 && vdot >= v2) {
      const frac = (v1 - vdot) / (v1 - v2);
      return Math.round(t1 + frac * (t2 - t1));
    }
  }
  if (vdot > 70) return ref[0][1];
  return ref[ref.length - 1][1];
}

// Marathon pace in sec/mi from VDOT
export function marathonPaceFromVdot(vdot) {
  const totalSec = projectMarathonTime(vdot);
  // pace per mile
  return Math.round(totalSec / 26.21875);
}

// Format a time in seconds as h:mm:ss
export function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ============================================================
// Date utilities (LOCAL-time safe — see warning below)
// ============================================================
//
// IMPORTANT: Parse and format dates as LOCAL dates, not UTC.
// `new Date("2026-04-20")` parses as UTC midnight, which in Eastern Time is
// April 19 8pm — and then `toISOString().slice(0,10)` converts back to UTC
// and returns "2026-04-19". That shifts every displayed date by one day.
// We avoid the bug by parsing and formatting the YYYY-MM-DD parts directly.

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Returns day-of-week index (0=Mon … 6=Sun) for an ISO date string
export function dowOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  // JS: 0=Sun, 1=Mon, …, 6=Sat → convert to Mon=0 system
  return (date.getDay() + 6) % 7;
}

// Returns the Monday on or before the given date (start of that week)
export function mondayOf(dateStr) {
  const dow = dowOf(dateStr);
  return addDays(dateStr, -dow);
}

// Diff between two dates (date2 - date1) in days
export function daysBetween(dateStr1, dateStr2) {
  const [y1, m1, d1] = dateStr1.split('-').map(Number);
  const [y2, m2, d2] = dateStr2.split('-').map(Number);
  const date1 = new Date(y1, m1 - 1, d1);
  const date2 = new Date(y2, m2 - 1, d2);
  return Math.round((date2 - date1) / (1000 * 60 * 60 * 24));
}
// ============================================================
// Plan generation — TIME-BASED
// ============================================================
//
// Plans are generated by weekly time target, not weekly mileage. Each session
// has a target time in minutes; distance is shown as a secondary derived value.
//
// User-configurable inputs (from Setup):
//   weeklyHours: total target time per week (3-7 hours)
//   runsPerWeek: total runs per week (3-6); long run always included
//   subTCount: sub-T workouts per week (1-3, constrained by runsPerWeek)
//   progressionEnabled: whether weekly time grows over the plan
//   subTDistances: { short, medium, long } in meters
//
// Plan modes:
//   'general' — rolling weeks with optional end date or open-ended.
//               Long run = 1.7× easy run length.
//   'marathon' — race-date-driven 24-week build. Phase 1 base + 16-week marathon block.
//                Long run follows Sirpoc's progression (scaled to user's marathon pace).

// Sirpoc's marathon block long-run progression (minutes), weeks 1-15.
// Week 10 is a 10K race, week 12 is HM race, week 15 is race week.
// Scaling factor will be applied based on user's expected marathon time.
const SIRPOC_LONG_RUN_MIN = [
  110, 115, 120, 125, 130, 130, 135, 90, 140, null, 140, null, null, null, null,
];

// Sub-T workout fixed time components
const SUBT_WARMUP_MIN = 10;  // 1 mile easy WU
const SUBT_COOLDOWN_MIN = 10;  // 1 mile easy CD

// ============================================================
// Time-per-rep estimates from user's sub-T pace
// ============================================================
//
// Sub-T pace varies by rep duration (per Sirpoc's Table 1.4).
// Short reps (target 3 min): fastest sub-T pace
// Medium reps (target 6 min): middle sub-T pace
// Long reps (target 10 min): slowest sub-T pace
//
// We use the user's paces.subT range to estimate time per rep at each distance.

export function estimateRepTime(distM, repCategory, paces) {
  // Use category-specific paces from Sirpoc's table
  // Short = faster end of subT range, Long = slower end
  let paceSecPerMi;
  if (repCategory === 'short') {
    paceSecPerMi = paces.subT.low;  // fastest sub-T
  } else if (repCategory === 'long') {
    paceSecPerMi = paces.subT.high;  // slowest sub-T
  } else {
    paceSecPerMi = (paces.subT.low + paces.subT.high) / 2;  // medium
  }
  // Convert distance to miles, multiply by pace
  const miles = distM / 1609.34;
  return Math.round(miles * paceSecPerMi);
}

// Sirpoc's tolerance windows (seconds)
export const REP_TOLERANCES = {
  short: { target: 180, min: 150, max: 210 },  // 3 min ±30 sec
  medium: { target: 360, min: 300, max: 420 },  // 6 min ±1 min
  long: { target: 600, min: 540, max: 660 },  // 10 min ±1 min
};

// Check if a given distance produces a rep time within Sirpoc's tolerance
export function checkRepTolerance(distM, repCategory, paces) {
  const repSec = estimateRepTime(distM, repCategory, paces);
  const tol = REP_TOLERANCES[repCategory];
  if (!tol) return { ok: true, repSec };
  return {
    ok: repSec >= tol.min && repSec <= tol.max,
    repSec,
    targetMin: tol.min,
    targetMax: tol.max,
    targetSec: tol.target,
  };
}

// ============================================================
// Day assignment for weekly run structure
// ============================================================
//
// Returns an array of length 7, where each element is one of:
//   'long', 'subT', 'easy', or null (rest/open).
// Days are Mon=0 ... Sun=6.
//
// Sub-T sessions are spaced. Sirpoc's pattern: Tue/Thu/Sat with rest Mon/Fri/Sun-long.
// We adapt to user's runsPerWeek and subTCount.

export function assignWeekDays(runsPerWeek, subTCount) {
  const days = [null, null, null, null, null, null, null];  // Mon-Sun
  // Sunday is always long run
  days[6] = 'long';

  // Assign sub-T sessions with spacing
  if (subTCount === 1) {
    days[1] = 'subT';  // Tuesday
  } else if (subTCount === 2) {
    days[1] = 'subT';  // Tuesday
    days[4] = 'subT';  // Friday
  } else if (subTCount === 3) {
    days[1] = 'subT';  // Tuesday
    days[3] = 'subT';  // Thursday
    days[5] = 'subT';  // Saturday (compresses; harder week)
  }

  // Remaining runs are easy. We have runsPerWeek - 1 (long) - subTCount easy slots.
  const easyCount = runsPerWeek - 1 - subTCount;
  // Best easy days (in priority order): Wed, Fri, Thu, Mon, Sat
  const preferredEasyDays = [2, 4, 3, 0, 5];
  let placed = 0;
  for (const dow of preferredEasyDays) {
    if (placed >= easyCount) break;
    if (days[dow] === null) {
      days[dow] = 'easy';
      placed++;
    }
  }

  return days;
}

// ============================================================
// Compute session times to fit weekly time budget
// ============================================================
//
// For General mode: long = 1.7 × easy. Sub-T workouts are ~50 min each.
// Solve: long + (easyCount × easy) + (subTCount × 50) = weeklyMin
// With long = 1.7 × easy: 1.7E + easyCount × E + subTCount × 50 = weeklyMin
// → E = (weeklyMin - subTCount × 50) / (1.7 + easyCount)

function computeGeneralWeekTimes(weeklyMin, runsPerWeek, subTCount, longMultiplier = 1.7) {
  const subTMin = 50;
  const easyCount = runsPerWeek - 1 - subTCount;
  const subTTotal = subTCount * subTMin;

  let easyMin, longMin;
  if (easyCount === 0) {
    // No easy runs — long takes everything remaining
    longMin = Math.max(45, weeklyMin - subTTotal);
    easyMin = 0;
  } else {
    easyMin = Math.round((weeklyMin - subTTotal) / (longMultiplier + easyCount));
    easyMin = Math.max(20, Math.min(60, easyMin));  // bound easy: 20-60 min per Sirpoc
    longMin = Math.round(longMultiplier * easyMin);
    longMin = Math.max(45, Math.min(180, longMin));  // soft cap at 3h
  }

  return { easyMin, longMin, subTMin };
}

// For Marathon mode: long run follows Sirpoc's scaled progression.
// Easy runs fill the remainder, with soft cap on each easy run (Sirpoc says 60 min).
// In race/taper weeks where long run is short, allow easy runs to slightly exceed cap to honor weekly target.
function computeMarathonWeekTimes(weeklyMin, runsPerWeek, subTCount, longMin) {
  const subTMin = 50;
  const easyCount = runsPerWeek - 1 - subTCount;
  const subTTotal = subTCount * subTMin;
  const remainingForEasy = weeklyMin - longMin - subTTotal;
  let easyMin;
  if (easyCount === 0) {
    easyMin = 0;
  } else {
    easyMin = Math.round(remainingForEasy / easyCount);
    easyMin = Math.max(20, easyMin);
    // Soft cap at 60 min per Sirpoc, but allow up to 75 in weeks where long run is short
    const cap = longMin < 100 ? 75 : 60;
    easyMin = Math.min(cap, easyMin);
  }
  return { easyMin, longMin, subTMin };
}

// ============================================================
// Session builders (time-based)
// ============================================================

function buildEasySession(targetMin, paces, hr) {
  // Estimate distance from time at user's easy pace (midpoint)
  const easyPaceSec = (paces.easy.low + paces.easy.high) / 2;
  const miles = (targetMin * 60) / easyPaceSec;
  return {
    id: `easy-${Math.random().toString(36).slice(2, 10)}`,
    type: 'easy',
    title: `Easy ${targetMin} min`,
    targetMin,
    pace: `${paceFromSeconds(paces.easy.low)}–${paceFromSeconds(paces.easy.high)}/mi`,
    hr: `HR < ${hr.easyMax}`,
    miles: Math.round(miles * 10) / 10,
    detail: `${targetMin} minutes easy. Fully conversational. If HR creeps above ${hr.easyMax}, slow down — don't speed up to hit pace. Estimated distance: ~${miles.toFixed(1)} mi.`,
    structured: null,
  };
}

function buildLongSession(targetMin, paces, hr, withMPSegment = false, mpSegmentMin = 0, mpSecPerMi = null) {
  const easyPaceSec = (paces.easy.low + paces.easy.high) / 2;
  const miles = (targetMin * 60) / easyPaceSec;

  let title = `Long ${targetMin} min`;
  let detail = `${targetMin} minutes at easy pace. Estimated distance: ~${miles.toFixed(1)} mi.`;
  if (withMPSegment && mpSecPerMi) {
    const mpMiles = (mpSegmentMin * 60) / mpSecPerMi;
    title = `Long ${targetMin} min w/ ${mpSegmentMin} min @ MP`;
    detail = `${targetMin} min total. Final ${mpSegmentMin} min at marathon pace (${paceFromSeconds(mpSecPerMi)}/mi, ~${mpMiles.toFixed(1)} mi MP). Rest at easy pace.`;
  }

  return {
    id: `long-${Math.random().toString(36).slice(2, 10)}`,
    type: 'long',
    title,
    targetMin,
    pace: `${paceFromSeconds(paces.easy.low)}–${paceFromSeconds(paces.easy.high)}/mi`,
    hr: `HR < ${hr.easyMax}` + (withMPSegment ? ` (MP segment up to ${hr.subTLow})` : ''),
    miles: Math.round(miles * 10) / 10,
    detail,
    structured: withMPSegment ? { mpSegmentMin, mpSecPerMi } : null,
  };
}

// Sub-T workout: warm-up + reps (with recovery jogs between) + cool-down
export function buildSubTSession(weekIndex, paces, hr, opts = {}) {
  const shortDist = opts.subTShortDist || 800;
  const mediumDist = opts.subTMediumDist || 1200;
  const longDist = opts.subTLongDist || 1609;
  const conservative = opts.conservative;
  const forcedRotation = opts.rotation;  // 0 = long, 1 = medium, 2 = short

  const fmtDist = (m) => {
    if (m === 1609) return '1 mi';
    if (m === 3218) return '2 mi';
    if (m >= 1000) return `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)}km`;
    return `${m}m`;
  };

  let reps, distM, recoverySec, category;
  if (conservative) {
    reps = 3; distM = longDist; recoverySec = 90; category = 'long';
  } else {
    const rotation = forcedRotation !== undefined ? forcedRotation : (weekIndex % 3);
    if (rotation === 0) {
      reps = 3; distM = longDist; recoverySec = 90; category = 'long';
    } else if (rotation === 1) {
      reps = 5; distM = mediumDist; recoverySec = 75; category = 'medium';
    } else {
      reps = 8; distM = shortDist; recoverySec = 60; category = 'short';
    }
  }

  // Estimate total time: WU + reps × repTime + (reps-1) × recoveryTime + CD
  const repSec = estimateRepTime(distM, category, paces);
  const workMin = (reps * repSec + (reps - 1) * recoverySec) / 60;
  const totalMin = Math.round(SUBT_WARMUP_MIN + workMin + SUBT_COOLDOWN_MIN);

  // Total distance estimate
  const easyPaceSec = (paces.easy.low + paces.easy.high) / 2;
  const wuCdMiles = ((SUBT_WARMUP_MIN + SUBT_COOLDOWN_MIN) * 60) / easyPaceSec;
  const repMiles = (reps * distM) / 1609.34;
  const recoveryMiles = ((reps - 1) * recoverySec * 0.85) / easyPaceSec;  // ~85% effort during recovery jogs
  const totalMiles = wuCdMiles + repMiles + recoveryMiles;

  const structure = `${reps} × ${fmtDist(distM)} @ sub-T HR w/ ${recoverySec >= 60 ? `${recoverySec / 60} min` : `${recoverySec} sec`} jog recovery`;

  return {
    id: `subt-${Math.random().toString(36).slice(2, 10)}`,
    type: 'subT',
    title: `Sub-T · ${structure.split(' @')[0]}`,
    targetMin: totalMin,
    pace: `${paceFromSeconds(paces.subT.low)}–${paceFromSeconds(paces.subT.high)}/mi`,
    hr: `HR ${hr.subTLow}–${hr.subTHigh}`,
    miles: Math.round(totalMiles * 10) / 10,
    detail: `${structure}. Warm-up ${SUBT_WARMUP_MIN} min + cool-down ${SUBT_COOLDOWN_MIN} min easy. Total ~${totalMin} min, ~${totalMiles.toFixed(1)} mi. HR is the gate — if HR exceeds ${hr.subTHigh}, slow down.`,
    structured: {
      reps, distM, recoverySec,
      paceLow: paces.subT.low, paceHigh: paces.subT.high,
      category,
    },
  };
}

// MP session: 10km at MP, 3×8km progressive at MP, etc.
function buildMPSession(weekIndex, sessionType, paces, hr, mpSecPerMi) {
  let title, detail, totalMin;
  const mpPace = paceFromSeconds(mpSecPerMi);
  if (sessionType === 'fiveByFiveK') {
    // 5 × 5km at MP — Sirpoc's signature MP workout
    const kmAtMP = 25;  // 5 × 5km = 25 km
    const milesAtMP = kmAtMP / 1.609;
    const mpMin = (milesAtMP * mpSecPerMi) / 60;
    totalMin = Math.round(SUBT_WARMUP_MIN + mpMin + 4 * 2 + SUBT_COOLDOWN_MIN);  // 4 × 2 min recovery
    title = `5 × 5km @ MP`;
    detail = `5 × 5km at marathon pace (${mpPace}/mi) with 2 min jog recovery between. Total ~${totalMin} min including warmup/cooldown.`;
  } else if (sessionType === 'threeByEightK') {
    // 3 × 8km progressive — Sirpoc's late-block MP staple
    const kmAtMP = 24;
    const milesAtMP = kmAtMP / 1.609;
    const mpMin = (milesAtMP * mpSecPerMi) / 60;
    totalMin = Math.round(SUBT_WARMUP_MIN + mpMin + 2 * 3 + SUBT_COOLDOWN_MIN);
    title = `3 × 8km progressive @ MP`;
    detail = `3 × 8km progressive (92% → 100% MP). Approximate paces: rep 1 +5%/mi over MP, rep 2 +0%/mi, rep 3 at or slightly below MP. 3 min recovery. Total ~${totalMin} min.`;
  } else {
    // Default: 10km at MP
    totalMin = Math.round(SUBT_WARMUP_MIN + (10 / 1.609 * mpSecPerMi) / 60 + SUBT_COOLDOWN_MIN);
    title = `10km @ MP`;
    detail = `10km at marathon pace (${mpPace}/mi). Total ~${totalMin} min including warmup/cooldown.`;
  }
  return {
    id: `mp-${Math.random().toString(36).slice(2, 10)}`,
    type: 'mp',
    title,
    targetMin: totalMin,
    pace: `${mpPace}/mi`,
    hr: `HR ${hr.subTLow - 5}–${hr.subTLow + 5}`,
    miles: Math.round((totalMin * 60 / mpSecPerMi) * 10) / 10,
    detail,
    structured: null,
  };
}

// ============================================================
// Week builders
// ============================================================

function emptyDays(weekStartISO) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    days.push({ date: addDays(weekStartISO, i), sessions: [] });
  }
  return days;
}

function buildGeneralWeek({
  weekIndex, weeklyMin, runsPerWeek, subTCount, paces, hr, mpSecPerMi, vdot,
  weekStart, subTDistances = {}, conservativeSubT = false,
  recentLongRunMin = null, progressionEnabled = false,
}) {
  const days = emptyDays(weekStart);
  const dayAssignments = assignWeekDays(runsPerWeek, subTCount);
  const computed = computeGeneralWeekTimes(weeklyMin, runsPerWeek, subTCount);
  let { easyMin, longMin, subTMin } = computed;

  // If user provided a recent long run, use it as the starting long run.
  // With progression: long run grows ~5 min/week. Without: stays at recentLongRunMin.
  if (recentLongRunMin && recentLongRunMin > 0) {
    if (progressionEnabled) {
      longMin = Math.round(recentLongRunMin + 5 * weekIndex);
    } else {
      longMin = recentLongRunMin;
    }
    longMin = Math.min(180, longMin);  // Soft cap at 3 hours
    // Recompute easy time to fit weekly budget around the user-set long run
    const subTTotal = subTCount * subTMin;
    const easyCount = runsPerWeek - 1 - subTCount;
    if (easyCount > 0) {
      const remaining = weeklyMin - longMin - subTTotal;
      easyMin = Math.max(20, Math.min(60, Math.round(remaining / easyCount)));
    } else {
      easyMin = 0;
    }
  }

  let subTIdx = 0;
  dayAssignments.forEach((kind, dow) => {
    if (kind === 'long') {
      days[dow].sessions.push(buildLongSession(longMin, paces, hr));
    } else if (kind === 'subT') {
      const rotation = (weekIndex + subTIdx) % 3;
      const subTOpts = {
        subTShortDist: subTDistances.short,
        subTMediumDist: subTDistances.medium,
        subTLongDist: subTDistances.long,
        rotation,
        conservative: conservativeSubT,
      };
      days[dow].sessions.push(buildSubTSession(weekIndex, paces, hr, subTOpts));
      subTIdx++;
    } else if (kind === 'easy') {
      days[dow].sessions.push(buildEasySession(easyMin, paces, hr));
    }
  });

  const totalMin = days.reduce((sum, d) => sum + d.sessions.reduce((s, sess) => s + (sess.targetMin || 0), 0), 0);
  const totalMiles = days.reduce((sum, d) => sum + d.sessions.reduce((s, sess) => s + (sess.miles || 0), 0), 0);

  return {
    weekIndex,
    label: `Week ${weekIndex + 1}`,
    totalMin,
    totalMiles: Math.round(totalMiles * 10) / 10,
    subTcount: subTCount,
    isStepback: false,
    phase: 'General',
    weekStart,
    days,
  };
}

function buildMarathonWeek({
  weekIndex, blockWeekIndex, isPhase1, weeklyMin, runsPerWeek, subTCount, paces, hr, mpSecPerMi, vdot,
  weekStart, subTDistances = {}, longMin, isStepback, isRaceWeek, conservativeSubT = false,
}) {
  if (isRaceWeek) {
    return buildRaceWeek({ weekIndex, paces, hr, mpSecPerMi, weekStart });
  }

  const days = emptyDays(weekStart);
  const dayAssignments = assignWeekDays(runsPerWeek, subTCount);
  const { easyMin } = computeMarathonWeekTimes(weeklyMin, runsPerWeek, subTCount, longMin);

  // Determine MP segment for late marathon block long runs
  const hasMPLongRun = !isPhase1 && blockWeekIndex !== null && [9, 10, 12].includes(blockWeekIndex);
  const mpSegmentMin = hasMPLongRun ? (blockWeekIndex === 12 ? 30 : 40) : 0;

  let subTIdx = 0;
  dayAssignments.forEach((kind, dow) => {
    if (kind === 'long') {
      days[dow].sessions.push(buildLongSession(longMin, paces, hr, hasMPLongRun, mpSegmentMin, mpSecPerMi));
    } else if (kind === 'subT') {
      // In mb3 of marathon block, replace one sub-T with MP session
      if (!isPhase1 && blockWeekIndex !== null) {
        if (subTIdx === 0 && blockWeekIndex === 10) {
          // Week 11 of marathon block: 5×5km @ MP
          days[dow].sessions.push(buildMPSession(weekIndex, 'fiveByFiveK', paces, hr, mpSecPerMi));
          subTIdx++;
          return;
        }
        if (subTIdx === 0 && blockWeekIndex === 12) {
          // Week 13 of marathon block: 3×8km progressive
          days[dow].sessions.push(buildMPSession(weekIndex, 'threeByEightK', paces, hr, mpSecPerMi));
          subTIdx++;
          return;
        }
      }

      const rotation = (weekIndex + subTIdx) % 3;
      const subTOpts = {
        subTShortDist: subTDistances.short,
        subTMediumDist: subTDistances.medium,
        subTLongDist: subTDistances.long,
        rotation,
        conservative: conservativeSubT,
      };
      days[dow].sessions.push(buildSubTSession(weekIndex, paces, hr, subTOpts));
      subTIdx++;
    } else if (kind === 'easy') {
      days[dow].sessions.push(buildEasySession(easyMin, paces, hr));
    }
  });

  const totalMin = days.reduce((sum, d) => sum + d.sessions.reduce((s, sess) => s + (sess.targetMin || 0), 0), 0);
  const totalMiles = days.reduce((sum, d) => sum + d.sessions.reduce((s, sess) => s + (sess.miles || 0), 0), 0);

  let phaseLabel;
  if (isPhase1) {
    phaseLabel = isStepback ? 'Phase 1 · Step-back' : 'Phase 1 · Base';
  } else {
    if (blockWeekIndex <= 4) phaseLabel = 'Phase 2 · Foundation';
    else if (blockWeekIndex <= 7) phaseLabel = 'Phase 2 · Increasing load';
    else if (blockWeekIndex <= 13) phaseLabel = 'Phase 2 · Marathon-specific';
    else phaseLabel = 'Phase 2 · Taper';
    if (isStepback) phaseLabel = 'Phase 2 · Step-back';
  }

  return {
    weekIndex,
    label: isPhase1 ? `Phase 1 · Week ${weekIndex + 1}` : `MB Week ${blockWeekIndex + 1}`,
    totalMin,
    totalMiles: Math.round(totalMiles * 10) / 10,
    subTcount: subTCount,
    isStepback,
    phase: phaseLabel,
    weekStart,
    days,
  };
}

function buildRaceWeek({ weekIndex, paces, hr, mpSecPerMi, weekStart }) {
  const days = emptyDays(weekStart);
  // Mon: easy 40 min
  days[0].sessions.push(buildEasySession(40, paces, hr));
  // Tue: short sub-T tune-up
  days[1].sessions.push({
    id: `subt-race-${weekIndex}`,
    type: 'subT',
    title: `Sub-T tune-up · 3 × 1 mi`,
    targetMin: 35,
    pace: `${paceFromSeconds(paces.subT.low)}–${paceFromSeconds(paces.subT.high)}/mi`,
    hr: `HR ${hr.subTLow}–${hr.subTHigh}`,
    miles: 5,
    detail: '3 × 1 mile at sub-T pace with 90 sec jog recovery. Warm-up 10 min + cool-down 10 min easy. Tune-up only — don\'t push.',
    structured: { reps: 3, distM: 1609, recoverySec: 90 },
  });
  // Wed: easy 30 min
  days[2].sessions.push(buildEasySession(30, paces, hr));
  // Thu: easy 20 min shakeout
  days[3].sessions.push(buildEasySession(20, paces, hr));
  // Fri: rest
  // Sat: rest (or 15 min jog)
  // Sun: MARATHON
  days[6].sessions.push({
    id: `race-${weekIndex}`,
    type: 'race',
    title: '🏁 MARATHON',
    targetMin: null,
    pace: `MP: ${paceFromSeconds(mpSecPerMi)}/mi`,
    hr: `82-85% MHR first half, 86-90% by mid`,
    miles: 26.2,
    detail: 'Race day. First half slightly conservative (HR 82-85% max), let the effort rise naturally in the second half.',
    structured: null,
  });

  const totalMin = days.reduce((sum, d) => sum + d.sessions.reduce((s, sess) => s + (sess.targetMin || 0), 0), 0);
  return {
    weekIndex,
    label: 'Race week',
    totalMin,
    totalMiles: 40,
    subTcount: 1,
    isStepback: false,
    phase: 'Phase 2 · Race week',
    weekStart,
    days,
  };
}

// ============================================================
// Plan generators (public API)
// ============================================================

// Apply Sirpoc 6-min-per-week progression to a base weekly time
function applyProgression(baseMin, weekIndex, enabled) {
  if (!enabled) return baseMin;
  // Sirpoc rule: add 12 min easy every 2 weeks, so ~6 min/week
  return Math.round(baseMin + 6 * weekIndex);
}

// Compute scaling factor for long runs based on user's expected marathon time vs Sirpoc's.
// Sirpoc trains for ~2:30 marathon (5:42/mi pace). A user with slower marathon pace
// needs more time on feet to cover the same distance proportionally.
//
// We scale Sirpoc's long-run minutes by ratio of user's marathon time to Sirpoc's,
// capped at 1.5× to avoid making long runs unreasonably long.
function longRunScaleFactor(vdot) {
  // Sirpoc's reference: VDOT ~62, marathon ~2:45 = 165 min
  const sirpocRefMarathonMin = 165;
  const userMarathonMin = marathonPaceFromVdot(vdot) * 26.2 / 60;
  const ratio = userMarathonMin / sirpocRefMarathonMin;
  return Math.min(1.5, Math.max(1.0, ratio));
}

export function generateGeneralPlan({
  startDate, endDate, paces, hr, vdot,
  weeklyHours = 5, runsPerWeek = 4, subTCount = 2,
  subTDistances = {}, progressionEnabled = false,
  recentLongRunMin = null,
  openEnded = false, weeks: weekCountOverride,
}) {
  const startMonday = mondayOf(startDate);
  const mpSecPerMi = marathonPaceFromVdot(vdot);
  const baseMin = weeklyHours * 60;

  // Constrain subTCount to runsPerWeek
  subTCount = Math.min(subTCount, Math.max(1, runsPerWeek - 1));
  if (runsPerWeek < 6) subTCount = Math.min(subTCount, 2);
  subTCount = Math.min(3, subTCount);

  let weeks;
  if (weekCountOverride) {
    weeks = weekCountOverride;
  } else if (endDate) {
    weeks = Math.max(1, Math.ceil(daysBetween(startMonday, endDate) / 7));
  } else if (openEnded) {
    weeks = 12;
  } else {
    weeks = 8;
  }

  const out = [];
  for (let i = 0; i < weeks; i++) {
    const weekStart = addDays(startMonday, i * 7);
    const weeklyMin = applyProgression(baseMin, i, progressionEnabled);
    const conservativeSubT = i < 2;
    out.push(buildGeneralWeek({
      weekIndex: i, weeklyMin, runsPerWeek, subTCount, paces, hr, mpSecPerMi, vdot,
      weekStart, subTDistances, conservativeSubT,
      recentLongRunMin: recentLongRunMin,
      progressionEnabled,
    }));
  }
  return out;
}

export function generateMarathonPlan({
  raceDate, startDate, paces, hr, vdot,
  weeklyHours = 5, runsPerWeek = 4, subTCount = 2,
  subTDistances = {}, progressionEnabled = true,
  recentLongRunMin = null,
}) {
  const raceWeekStart = mondayOf(raceDate);
  const phase2Start = addDays(raceWeekStart, -7 * 14);  // 14 weeks before race week (race week is week 15)
  const startMonday = mondayOf(startDate);
  const phase1Weeks = Math.max(0, Math.round(daysBetween(startMonday, phase2Start) / 7));

  const mpSecPerMi = marathonPaceFromVdot(vdot);
  const baseMin = weeklyHours * 60;
  const longScale = longRunScaleFactor(vdot);

  // Constrain subTCount
  subTCount = Math.min(subTCount, Math.max(1, runsPerWeek - 1));
  if (runsPerWeek < 6) subTCount = Math.min(subTCount, 2);
  subTCount = Math.min(3, subTCount);

  const weeks = [];

  // Phase 1 (base): build toward Sirpoc's week-1 long run.
  // If user provided recentLongRunMin, use that as Phase 1 starting point.
  // Otherwise default to 90 min.
  for (let i = 0; i < phase1Weeks; i++) {
    const weekStart = addDays(startMonday, i * 7);
    const weeklyMin = applyProgression(baseMin, i, progressionEnabled);
    const conservativeSubT = i < 2;

    // Long run progression in Phase 1
    const longStart = recentLongRunMin || 90;
    const longEnd = Math.round(SIRPOC_LONG_RUN_MIN[0] * longScale);  // week 1 of marathon block (scaled)
    // If recentLongRunMin already exceeds longEnd, just hold at recentLongRunMin
    const effectiveEnd = Math.max(longStart, longEnd);
    const progress = phase1Weeks > 1 ? i / (phase1Weeks - 1) : 0;
    let longMin = Math.round(longStart + (effectiveEnd - longStart) * progress);
    const isStepback = i >= 3 && (i + 1) === Math.ceil(phase1Weeks / 2);
    if (isStepback) longMin = Math.round(longMin * 0.82);

    weeks.push(buildMarathonWeek({
      weekIndex: i, blockWeekIndex: null, isPhase1: true,
      weeklyMin, runsPerWeek, subTCount, paces, hr, mpSecPerMi, vdot,
      weekStart, subTDistances, longMin, isStepback, isRaceWeek: false, conservativeSubT,
    }));
  }

  // Phase 2 (marathon block): 15 weeks per Sirpoc, last is race week
  for (let i = 0; i < 15; i++) {
    const weekStart = addDays(phase2Start, i * 7);
    const totalIdx = phase1Weeks + i;
    const isRaceWeek = i === 14;
    const isStepback = false;  // Sirpoc's step-backs are encoded in his long-run table (week 8 = 90 min)
    const weeklyMin = applyProgression(baseMin, totalIdx, progressionEnabled);

    let longMin;
    if (i === 9) {
      // 10k race week — short long run
      longMin = 75;
    } else if (i === 11) {
      // HM race week — short long run
      longMin = 60;
    } else if (i < 14 && SIRPOC_LONG_RUN_MIN[i] !== null) {
      longMin = Math.round(SIRPOC_LONG_RUN_MIN[i] * longScale);
      // Soft cap at 180 min (3 hours)
      longMin = Math.min(180, longMin);
    } else {
      longMin = 60;
    }

    weeks.push(buildMarathonWeek({
      weekIndex: totalIdx, blockWeekIndex: i, isPhase1: false,
      weeklyMin, runsPerWeek, subTCount, paces, hr, mpSecPerMi, vdot,
      weekStart, subTDistances, longMin, isStepback, isRaceWeek, conservativeSubT: false,
    }));
  }

  return weeks;
}

// Legacy export for backward compat
export function generatePlan(opts) {
  return generateMarathonPlan(opts);
}
