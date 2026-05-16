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
      low: Math.round(fiveKpaceSec + 30),
      high: Math.round(fiveKpaceSec + 50),
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
// Plan generation — race-date-driven
// ============================================================

// Generate a marathon training plan.
// Inputs:
//   raceDate: 'YYYY-MM-DD' (must be a Sunday for clean weekly structure)
//   startDate: 'YYYY-MM-DD' (typically today; will be aligned to Monday)
//   paces: from computePaces()
//   hr: from computeHRzones()
//   vdot: from vdotFrom5K() — used to project marathon goal time / MP
//
// Output: Array of week objects with .days[7].sessions[] structure
export function generateMarathonPlan({ raceDate, startDate, paces, hr, vdot, subTDistances = {} }) {
  // 1. Determine race-block boundaries
  // Phase 2 is the final 16 weeks ending with race day
  // Phase 1 fills in from startDate up to Phase 2 start
  // Each "week" runs Mon → Sun (race day is the final Sunday)

  const raceWeekStart = mondayOf(raceDate);  // Monday of race week
  const phase2Start = addDays(raceWeekStart, -7 * 15);  // 15 weeks before race week start = start of Phase 2
  // ^^^ Phase 2 = 16 weeks total (weeks 1-16), where week 16 = race week

  const startMonday = mondayOf(startDate);
  const phase1Start = startMonday;

  // Number of Phase 1 weeks
  const phase1Weeks = Math.max(0, Math.round(daysBetween(phase1Start, phase2Start) / 7));

  const totalWeeks = phase1Weeks + 16;
  const weeks = [];

  // Marathon pace from current fitness
  const mpSecPerMi = marathonPaceFromVdot(vdot);

  // 2. Build Phase 1 weeks (maintenance/base)
  // Default mileage progression for Phase 1, with step-back at week 5 if long enough
  for (let i = 0; i < phase1Weeks; i++) {
    const weekStart = addDays(phase1Start, i * 7);
    const isStepback = (i + 1) === Math.ceil(phase1Weeks / 2) && phase1Weeks >= 4;
    const milesTarget = phase1Mileage(i, phase1Weeks, isStepback);
    weeks.push(buildPhase1Week({
      weekIndex: i, totalWeekIndex: i, totalMiles: milesTarget,
      paces, hr, mpSecPerMi, vdot, weekStart, isStepback,
      subTDistances,
    }));
  }

  // 3. Build Phase 2 weeks (marathon block)
  for (let i = 0; i < 16; i++) {
    const weekStart = addDays(phase2Start, i * 7);
    const totalIdx = phase1Weeks + i;
    const milesTarget = phase2Mileage(i);
    const block = phase2Block(i);  // 'mb1' | 'mb2' | 'mb3' | 'taper'
    const isStepback = i === 4 || i === 9;  // step-back at week 5 (i=4) and week 10 (i=9)
    weeks.push(buildPhase2Week({
      blockWeekIndex: i, totalWeekIndex: totalIdx, totalMiles: milesTarget,
      paces, hr, mpSecPerMi, vdot, weekStart, block, isStepback, isRaceWeek: i === 15,
      subTDistances,
    }));
  }

  return weeks;
}

// ============================================================
// General mode: rolling 8-week plan, no marathon-specific structure
// ============================================================
export function generateGeneralPlan({ startDate, paces, hr, vdot, subTDistances = {}, weeks = 8 }) {
  const startMonday = mondayOf(startDate);
  const mpSecPerMi = marathonPaceFromVdot(vdot);
  const out = [];

  for (let i = 0; i < weeks; i++) {
    const weekStart = addDays(startMonday, i * 7);
    // General mode: hold steady at ~30 mi/week, no step-backs
    const miles = 30 + (i * 0.5);  // very gentle progression
    out.push(buildPhase1Week({
      weekIndex: i, totalWeekIndex: i, totalMiles: Math.round(miles * 2) / 2,
      paces, hr, mpSecPerMi, vdot, weekStart, isStepback: false,
      subTDistances,
      generalMode: true,
    }));
  }
  return out;
}

// Mileage curve for Phase 1 — slow consolidation per Sirpoc's rule.
// User already at ~25-30 mi/week (~4.5-5 hours). Hold steady, slight ramp.
// Sirpoc rule: add ~12 min easy every 2 weeks (~1.5 mi/2wk at user's pace).
function phase1Mileage(weekIdx, totalPhase1Weeks, isStepback) {
  // Start at user's current ~28 mi and ramp very gently to ~34 mi by end
  const baseStart = 28;
  const baseEnd = 34;
  const progress = totalPhase1Weeks > 1 ? weekIdx / (totalPhase1Weeks - 1) : 0;
  let miles = baseStart + (baseEnd - baseStart) * progress;
  if (isStepback) miles = miles * 0.82;
  return Math.round(miles * 2) / 2;
}

// Mileage curve for Phase 2 (16 weeks)
// Returns mileage for week index 0..15
function phase2Mileage(i) {
  // Mini-block 1 (i=0-4): foundation, build 28 → 36
  // Mini-block 2 (i=5-9): increasing load, 38 → 44
  // Mini-block 3 (i=10-13): marathon-specific, peak 42 → 48
  // Taper (i=14-15): step way down
  const curve = [
    28, 30, 32, 34, 28,   // MB1, with stepback at i=4
    37, 40, 42, 44, 36,   // MB2, with stepback at i=9
    44, 46, 48, 45,       // MB3, peak
    32, 22,               // Taper (week 15 includes race)
  ];
  return curve[i];
}

function phase2Block(i) {
  if (i <= 4) return 'mb1';
  if (i <= 9) return 'mb2';
  if (i <= 13) return 'mb3';
  return 'taper';
}

function phase2PhaseLabel(i, isStepback, isRaceWeek) {
  if (isRaceWeek) return 'Race week';
  if (i === 14) return 'Early taper';
  if (isStepback) return 'Step-back';
  if (i <= 4) return 'Foundation';
  if (i <= 9) return 'Increasing load';
  return 'Marathon-specific';
}

// ============================================================
// Week builders
// ============================================================

function emptyDays(weekStart) {
  return Array(7).fill(null).map((_, i) => ({
    sessions: [],
    date: addDays(weekStart, i),
  }));
}

// Phase 1 week:
//   Week 1: 4 runs (Sun long, Tue sub-T, Wed easy, Fri easy)
//   Week 2+: 5 runs structure - second sub-T on Friday (replacing the easy run)
// Thursday is left open (no scheduled session). Mon, Sat are rest.
function buildPhase1Week({
  weekIndex, totalWeekIndex, totalMiles, paces, hr, mpSecPerMi, vdot,
  weekStart, isStepback, subTDistances = {}, generalMode = false,
}) {
  const days = emptyDays(weekStart);

  // Long run: 30% of total weekly miles. No cap.
  const longMiles = clampLongRun(Math.round(totalMiles * 0.32 * 2) / 2, paces);
  // Sub-T workouts ~6 mi each
  const subTworkoutMiles = 6;
  const hasFridaySubT = weekIndex >= 1;  // Week 2+ gets 2nd sub-T
  const subTCount = hasFridaySubT ? 2 : 1;
  const totalSubTmiles = subTworkoutMiles * subTCount;
  // Remaining weekly mileage goes to easy run(s)
  const easyDaysCount = hasFridaySubT ? 1 : 2;
  const easyTotal = Math.max(easyDaysCount * 3, totalMiles - longMiles - totalSubTmiles);
  const easyMiles = easyDaysCount > 0 ? Math.round((easyTotal / easyDaysCount) * 2) / 2 : 0;

  const subTOpts = {
    subTShortDist: subTDistances.short,
    subTMediumDist: subTDistances.medium,
    subTLongDist: subTDistances.long,
  };

  // Sun (index 6): long run
  days[6].sessions.push(buildLongRun(longMiles, paces, hr, false, 0, mpSecPerMi));

  // Tue (index 1): sub-T (conservative for first 2 weeks of build)
  const conservative = weekIndex < 2;
  days[1].sessions.push(buildSubT(weekIndex, false, paces, hr, { conservative, ...subTOpts }));

  // Wed (index 2): easy
  days[2].sessions.push(buildEasy(easyMiles, paces, hr));

  // Fri (index 4): sub-T (if past week 1) or easy
  if (hasFridaySubT) {
    // Friday sub-T uses different rep duration than Tuesday (offset by 1 in rotation)
    days[4].sessions.push(buildSubT(weekIndex + 1, false, paces, hr, { conservative, ...subTOpts }));
  } else {
    days[4].sessions.push(buildEasy(easyMiles, paces, hr));
  }

  // Thursday (index 3): leave OPEN — user fills in cross-train/rest

  // Activation/warmup removed per user preference

  return {
    weekIndex: totalWeekIndex,
    label: `Week ${totalWeekIndex + 1}`,
    totalMiles,
    subTcount: subTCount,
    isStepback,
    phase: generalMode
      ? `Week ${totalWeekIndex + 1} · General`
      : (isStepback ? 'Phase 1 · Step-back' : 'Phase 1 · Base'),
    weekStart,
    days,
  };
}

// Phase 2 week: 4 runs in mini-blocks 1-2, then MP work in mini-block 3, then taper
function buildPhase2Week({
  blockWeekIndex, totalWeekIndex, totalMiles, paces, hr, mpSecPerMi, vdot,
  weekStart, block, isStepback, isRaceWeek, subTDistances = {},
}) {
  const days = emptyDays(weekStart);

  if (isRaceWeek) {
    return buildRaceWeek({
      blockWeekIndex, totalWeekIndex, totalMiles, paces, hr, mpSecPerMi,
      weekStart, days,
    });
  }

  // Long run mileage and MP segment
  const longRunMiles = computeLongRunMiles(block, blockWeekIndex, totalMiles, paces);
  const hasMPLongRun = (block === 'mb3' && [10, 11, 13].includes(blockWeekIndex));
  const mpSegmentMiles = hasMPLongRun ? (blockWeekIndex === 13 ? 4 : Math.min(6, Math.round(longRunMiles * 0.35))) : 0;

  // Sub-T or MP-focused mid-week quality
  const tuesdayWorkout = pickTuesdayWorkout(block, blockWeekIndex, paces, hr, mpSecPerMi, subTDistances);
  const fridayWorkout = pickFridayWorkout(block, blockWeekIndex, paces, hr, mpSecPerMi, subTDistances);

  // Easy miles: total - long - quality-volume
  const qualityMiles = (tuesdayWorkout.miles || 6) + (fridayWorkout.miles || 6);
  const easyTotal = Math.max(6, totalMiles - longRunMiles - qualityMiles);
  const easyMiles = Math.round((easyTotal / 1) * 2) / 2;  // single Wed easy

  // Sunday (index 6): long run (with optional MP segment)
  days[6].sessions.push(buildLongRun(longRunMiles, paces, hr, hasMPLongRun, mpSegmentMiles, mpSecPerMi));

  // Tuesday (index 1): quality session
  days[1].sessions.push(tuesdayWorkout);

  // Wednesday (index 2): easy
  days[2].sessions.push(buildEasy(easyMiles, paces, hr));

  // Friday (index 4): quality session
  days[4].sessions.push(fridayWorkout);

  // Thursday (index 3): leave OPEN

  // Activation/warmup removed per user preference

  return {
    weekIndex: totalWeekIndex,
    label: `Marathon week ${blockWeekIndex + 1}`,
    totalMiles,
    subTcount: 2,
    isStepback,
    phase: `Phase 2 · ${phase2PhaseLabel(blockWeekIndex, isStepback, isRaceWeek)}`,
    weekStart,
    days,
  };
}

function buildRaceWeek({ blockWeekIndex, totalWeekIndex, totalMiles, paces, hr, mpSecPerMi, weekStart, days }) {
  // Mon (0): Easy 5 mi
  // Tue (1): Short sub-T tune-up — 3 × 1 mi at sub-T HR with 90s recovery
  // Wed (2): Easy 4 mi
  // Thu (3): Easy 3 mi
  // Fri (4): Rest
  // Sat (5): Rest (or 2 mi shakeout)
  // Sun (6): MARATHON

  days[0].sessions.push(buildEasy(5, paces, hr));
  days[1].sessions.push({
    id: `subt-race-${totalWeekIndex}`,
    type: 'subT',
    title: 'Sub-T tune-up · 3 × 1 mi',
    pace: `${paceFromSeconds(paces.subT.low)}–${paceFromSeconds(paces.subT.high)}/mi`,
    hr: `HR ${hr.subTLow}–${hr.subTHigh}`,
    miles: 6,
    detail: 'Sharpening workout. 1 mi warm-up + 3 × 1 mi @ sub-T (90s jog recovery) + 1 mi cool-down. Short and crisp.',
    structured: { reps: 3, distM: 1609, recoverySec: 90, paceLow: paces.subT.low, paceHigh: paces.subT.high },
  });
  days[2].sessions.push(buildEasy(4, paces, hr));
  days[3].sessions.push(buildEasy(3, paces, hr));
  // Fri, Sat: rest
  // Sun: race
  days[6].sessions.push({
    id: `race-${totalWeekIndex}`,
    type: 'long',
    title: 'MARINE CORPS MARATHON · 26.2 mi',
    pace: `Target ${paceFromSeconds(mpSecPerMi)}/mi (MP)`,
    hr: `HR ${Math.round(hr.subTLow * 0.98)}–${hr.subTHigh}`,
    miles: 26.2,
    detail: 'Race day. Goal: steady at MP. First half HR ~82–85% max, climbing to 86–90% by halfway. Fuel every 25–30 min. Trust the training.',
    structured: null,
  });

  // No activation or warm-up scheduling — race-week minimal

  return {
    weekIndex: totalWeekIndex,
    label: 'Race week',
    totalMiles,
    subTcount: 1,
    isStepback: false,
    phase: 'Phase 2 · Race week',
    weekStart,
    days,
  };
}

// ============================================================
// Long-run logic
// ============================================================

// Long run cap removed per user preference — long run grows with the plan.
// (Sirpoc's "3 hour" guidance remains a soft guideline but is not enforced in the app.)
function clampLongRun(miles, paces) {
  return miles;
}

// Long run progression per phase
function computeLongRunMiles(block, blockWeekIdx, totalMiles, paces) {
  let target;
  if (block === 'mb1') {
    // weeks 0-4: 12 → 15
    target = [12, 13, 14, 15, 12][blockWeekIdx];
  } else if (block === 'mb2') {
    // weeks 5-9: 16 → 18, stepback at week 9
    target = [16, 16.5, 17, 17.5, 14][blockWeekIdx - 5];
  } else if (block === 'mb3') {
    // weeks 10-13: peak. Long run peaks at week 12, eased week 13
    target = [18, 18, 18, 15][blockWeekIdx - 10];
  } else {
    // taper
    target = blockWeekIdx === 14 ? 10 : 26.2;
  }
  return clampLongRun(target, paces);
}

// ============================================================
// Quality session selection
// ============================================================

// Tuesday workout in Phase 2 — always sub-T except in mini-block 3 where
// it stays sub-T (Friday or Sunday gets the MP work)
function pickTuesdayWorkout(block, blockWeekIdx, paces, hr, mpSecPerMi, subTDistances = {}) {
  const opts = {
    subTShortDist: subTDistances.short,
    subTMediumDist: subTDistances.medium,
    subTLongDist: subTDistances.long,
  };
  return buildSubT(blockWeekIdx, false, paces, hr, opts);
}

// Friday workout — sub-T in mb1/mb2, alternates with MP work in mb3
function pickFridayWorkout(block, blockWeekIdx, paces, hr, mpSecPerMi, subTDistances = {}) {
  const opts = {
    subTShortDist: subTDistances.short,
    subTMediumDist: subTDistances.medium,
    subTLongDist: subTDistances.long,
  };
  if (block === 'mb3') {
    // Mini-block 3: alternate sub-T and MP-focused workouts
    if (blockWeekIdx === 11) {
      return buildMPSession(blockWeekIdx, 'fiveByFiveK', paces, hr, mpSecPerMi);
    }
    if (blockWeekIdx === 13) {
      return buildMPSession(blockWeekIdx, 'threeByEightK', paces, hr, mpSecPerMi);
    }
  }
  return buildSubT(blockWeekIdx, false, paces, hr, opts);
}

// ============================================================
// Session builders
// ============================================================

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

// Sub-T workout — rotates Sirpoc's three rep durations.
// Distances are user-configurable from Setup; defaults match Sirpoc's recommendations.
// HR (160-170) is the hard gate; pace is a guide that may need to adjust to terrain/weather.
function buildSubT(weekIndex, recovering, paces, hr, opts = {}) {
  let structure;
  let structured;
  let totalMiles;

  // Sub-T distances (user-configurable)
  const shortDist = opts.subTShortDist || 800;
  const mediumDist = opts.subTMediumDist || 1200;
  const longDist = opts.subTLongDist || 1609;

  const fmtDist = (m) => {
    if (m === 1609) return '1 mi';
    if (m >= 1000) return `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)}km`;
    return `${m}m`;
  };

  // Phase 1 first two weeks: ease in with conservative 3 × long-rep reentry
  if (opts.conservative) {
    structure = `3 × ${fmtDist(longDist)} @ sub-T HR w/ 90 sec jog recovery`;
    structured = { reps: 3, distM: longDist, recoverySec: 90 };
    totalMiles = 6;
  } else {
    // Rotate the three Sirpoc rep durations
    const rotation = weekIndex % 3;
    if (rotation === 0) {
      // Long reps
      structure = `3 × ${fmtDist(longDist)} @ sub-T HR w/ 90 sec jog recovery`;
      structured = { reps: 3, distM: longDist, recoverySec: 90 };
      totalMiles = 6;
    } else if (rotation === 1) {
      // Medium reps
      structure = `5 × ${fmtDist(mediumDist)} @ sub-T HR w/ 75 sec jog recovery`;
      structured = { reps: 5, distM: mediumDist, recoverySec: 75 };
      totalMiles = 6;
    } else {
      // Short reps
      structure = `8 × ${fmtDist(shortDist)} @ sub-T HR w/ 60 sec jog recovery`;
      structured = { reps: 8, distM: shortDist, recoverySec: 60 };
      totalMiles = 7;
    }
  }

  return {
    id: `subt-${Math.random().toString(36).slice(2, 10)}`,
    type: 'subT',
    title: `Sub-T · ${structure.split(' @')[0]}`,
    pace: `${paceFromSeconds(paces.subT.low)}–${paceFromSeconds(paces.subT.high)}/mi`,
    hr: `HR ${hr.subTLow}–${hr.subTHigh}`,
    miles: totalMiles,
    detail: `${structure}. Warm-up 1 mi + cool-down 1 mi easy. HR is the gate, not pace — if HR exceeds ${hr.subTHigh}, slow down. Pace will vary with terrain.`,
    structured: { ...structured, paceLow: paces.subT.low, paceHigh: paces.subT.high },
  };
}

// Marathon-pace focused session (used in mini-block 3)
function buildMPSession(weekIndex, sessionType, paces, hr, mpSecPerMi) {
  const mpPace = paceFromSeconds(mpSecPerMi);
  if (sessionType === 'fiveByFiveK') {
    // 5 × 5 km at MP (Sirpoc's signature marathon-specific workout)
    return {
      id: `mp-${weekIndex}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'subT',
      title: `MP work · 5 × 5 km`,
      pace: `${mpPace}/mi (MP)`,
      hr: `HR ${Math.round(hr.subTLow * 1.0)}–${hr.subTHigh}`,
      miles: 19,  // ~15 mi at MP + 4 mi WU/CD
      detail: `5 × 3.1 mi @ MP (~${mpPace}/mi) w/ 3 min jog recovery. Warm-up 1.5 mi + cool-down 1.5 mi easy. This is the marathon-specific signature workout — practices race pace at high volume.`,
      structured: { reps: 5, distM: 5000, recoverySec: 180, paceLow: mpSecPerMi - 5, paceHigh: mpSecPerMi + 5 },
    };
  }
  if (sessionType === 'threeByEightK') {
    // 3 × 8 km progressive at 92-93-100% MP (Sirpoc's late-block workout)
    return {
      id: `mp-${weekIndex}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'subT',
      title: 'MP work · 3 × 8 km progressive',
      pace: `${mpPace}/mi (MP)`,
      hr: `HR ${hr.subTLow}–${hr.subTHigh}`,
      miles: 19,  // ~15 mi at MP + 4 mi WU/CD
      detail: `3 × 5 mi progressive at 92% → 93% → 100% MP. No rest between (continuous). Warm-up 1 mi + cool-down 1 mi easy. Last segment at goal MP — practice the closing of a marathon.`,
      structured: { reps: 3, distM: 8000, recoverySec: 0, paceLow: mpSecPerMi - 10, paceHigh: mpSecPerMi },
    };
  }
  return buildSubT(weekIndex, false, paces, hr);
}

function buildLongRun(miles, paces, hr, withMPSegment, mpSegmentMiles, mpSecPerMi) {
  const easyPace = `${paceFromSeconds(paces.easy.low)}–${paceFromSeconds(paces.easy.high)}/mi`;
  if (withMPSegment && mpSegmentMiles > 0) {
    const easyMiles = miles - mpSegmentMiles;
    const mpPace = paceFromSeconds(mpSecPerMi);
    return {
      id: `long-${Math.random().toString(36).slice(2, 10)}`,
      type: 'long',
      title: `Long run ${miles.toFixed(1)} mi w/ ${mpSegmentMiles} mi at MP`,
      pace: `Easy ${easyPace}; last ${mpSegmentMiles} mi at MP ${mpPace}/mi`,
      hr: `HR < ${hr.easyMax + 5} easy; ${hr.subTLow}–${hr.subTHigh} at MP`,
      miles,
      detail: `Easy ${easyMiles.toFixed(1)} mi at conversational pace, then last ${mpSegmentMiles} mi at marathon pace (~${mpPace}/mi). This is where you learn what MP feels like on tired legs.`,
      structured: null,
    };
  }
  return {
    id: `long-${Math.random().toString(36).slice(2, 10)}`,
    type: 'long',
    title: `Long run ${miles.toFixed(1)} mi`,
    pace: easyPace,
    hr: `HR < ${hr.easyMax + 5}`,
    miles,
    detail: 'Keep it fully easy start to finish. Resist the urge to finish fast.',
    structured: null,
  };
}

// ============================================================
// Activation + warmup helpers
// ============================================================

function addActivationAndWarmup(days, totalWeekIndex) {
  // Activation and warm-up entries are no longer auto-added to the plan.
  // Strength/activation work lives in the Strength tab instead.
  return;
}

// ============================================================
// Legacy export — the old generatePlan signature, still exported for backward compat
// ============================================================
//
// This wrapper allows existing callers (older Setup form) to keep working until
// the App is updated to use generateMarathonPlan directly.
export function generatePlan({
  weeks, daysPerWeek, startingMiles, recovering, paces, hr,
  preferredLongDay, preferredQualityDays, startDate,
}) {
  // For backward compatibility: if no race date provided, return a generic
  // 8-week build using the new sub-T workouts but the old simple structure.
  const out = [];
  let currentMiles = startingMiles;
  const mpSecPerMi = Math.round((paces.easy.low + paces.subT.low) / 2);  // rough estimate
  for (let w = 0; w < weeks; w++) {
    if (w > 0) {
      if ((w + 1) % 4 === 0) {
        currentMiles = Math.round(currentMiles * 0.85 * 10) / 10;
      } else {
        currentMiles = Math.round(currentMiles * 1.10 * 10) / 10;
      }
    }
    const weekStart = addDays(startDate, w * 7);
    out.push(buildPhase1Week({
      weekIndex: w, totalWeekIndex: w, totalMiles: currentMiles,
      paces, hr, mpSecPerMi, vdot: 50, weekStart,
      isStepback: (w + 1) % 4 === 0 && w > 0,
    }));
  }
  return out;
}
