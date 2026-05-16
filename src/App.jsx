import React, { useState, useEffect, useCallback } from 'react';
import {
  Calendar, Settings, CheckCircle2, Circle, ChevronLeft, ChevronRight,
  Activity, Dumbbell, Footprints, TrendingUp, RotateCcw, AlertCircle,
  GripVertical, Sunrise, Zap, Download, Watch, Share2, Info, Copy,
  Cloud, MapPin, Wind, Droplets, Shirt, ThermometerSun, ThermometerSnowflake,
  Heart, X, TrendingDown, Minus, Plus, Trash2,
} from 'lucide-react';

import { storage } from './storage.js';
import {
  DAYS, paceFromSeconds, computePaces, computeHRzones,
  generatePlan, generateMarathonPlan, generateGeneralPlan,
  vdotFrom5K, projectMarathonTime, marathonPaceFromVdot, formatTime,
} from './planLogic.js';
import { downloadICS } from './icsExport.js';
import { downloadTCX } from './tcxExport.js';
import { geocodeZip, fetchForecast, pickHour, describeWeather, compassFromDeg, recommendOutfit, applyFeedback, getBandForTemp, EMPTY_BIASES } from './weather.js';
import { getEntryForDate, hasDailyEntry, getRecentEntries, computeStats, painLogToCSV, DEFAULT_REHAB_CONFIG, STRENGTH_CATEGORIES, getRehabCountForDate, wasExerciseDone, getRehabStreak, getRehabGridData, computeRehabStats } from './painTracking.js';

const SESSION_COLORS = {
  activation: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-900', icon: Sunrise },
  warmup: { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-900', icon: Zap },
  easy: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-900', icon: Footprints },
  subT: { bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-900', icon: TrendingUp },
  long: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-900', icon: Activity },
  strength: { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-900', icon: Dumbbell },
  cross: { bg: 'bg-cyan-50', border: 'border-cyan-200', text: 'text-cyan-900', icon: Activity },
};

// Format a Date object as YYYY-MM-DD in LOCAL time (not UTC).
// Critical: `toISOString()` converts to UTC first, which shifts dates by 1 day
// for users after ~8pm ET.
function formatLocalISO(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function todayISO() {
  return formatLocalISO(new Date());
}

function nextMondayISO() {
  const d = new Date();
  const js = d.getDay();
  const daysUntilMon = js === 0 ? 1 : (js === 1 ? 0 : 8 - js);
  d.setDate(d.getDate() + daysUntilMon);
  return formatLocalISO(d);
}

function isToday(dateStr) {
  return dateStr === todayISO();
}

export default function App() {
  const [setup, setSetup] = useState({
    fiveKminutes: 21,
    fiveKseconds: 15,
    maxHR: 188,
    restingHR: 50,
    raceDate: '2026-10-25',
    startDate: nextMondayISO(),
    planMode: 'marathon',  // 'general' (rolling) or 'marathon' (race-driven 24-week build)
    strengthDays: [0, 3, 5],  // Day indices: 0=Mon, 3=Thu, 5=Sat
    subTShortDist: 800,   // meters
    subTMediumDist: 1200, // meters
    subTLongDist: 1609,   // meters (1 mile)
  });
  const [plan, setPlan] = useState(null);
  const [currentWeekIdx, setCurrentWeekIdx] = useState(0);
  const [completions, setCompletions] = useState({});
  const [logs, setLogs] = useState({}); // key -> { distMi, timeSec, avgHR, notes }
  const [view, setView] = useState('setup');
  const [loading, setLoading] = useState(true);
  const [selectedSession, setSelectedSession] = useState(null);
  // Weather state
  const [weatherLocation, setWeatherLocation] = useState(null); // { zip, lat, lon, city, state }
  const [outfitBiases, setOutfitBiases] = useState(EMPTY_BIASES);
  // Pain tracking state: { [dateISO]: { morningPain, deskPain, postRunPain, note } }
  const [painLog, setPainLog] = useState({});
  const [painModal, setPainModal] = useState(null); // null | { date, mode: 'daily' | 'postRun' }
  // Rehab tracking
  const [rehabConfig, setRehabConfig] = useState(DEFAULT_REHAB_CONFIG); // { exercises: [...] }
  const [rehabLog, setRehabLog] = useState({}); // { [dateISO]: { [exerciseId]: true } }
  const [showMethodModal, setShowMethodModal] = useState(false);
  // When adding an unscheduled session: { weekIdx, dayIdx } — null means closed
  const [addSessionTarget, setAddSessionTarget] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const s = await storage.get('setup');
        if (s) setSetup(prev => ({ ...prev, ...JSON.parse(s.value) }));
      } catch {}
      try {
        const p = await storage.get('plan');
        if (p) {
          setPlan(JSON.parse(p.value));
          setView('week');
          const parsed = JSON.parse(p.value);
          const today = todayISO();
          const currentIdx = parsed.findIndex(w =>
            w.days.some(d => d.date === today) ||
            (w.days[0] && w.days[6] && w.days[0].date <= today && w.days[6].date >= today)
          );
          if (currentIdx >= 0) setCurrentWeekIdx(currentIdx);
        }
      } catch {}
      try {
        const c = await storage.get('completions');
        if (c) setCompletions(JSON.parse(c.value));
      } catch {}
      try {
        const l = await storage.get('logs');
        if (l) setLogs(JSON.parse(l.value));
      } catch {}
      try {
        const wl = await storage.get('weatherLocation');
        if (wl) setWeatherLocation(JSON.parse(wl.value));
      } catch {}
      try {
        const ob = await storage.get('outfitBiases');
        if (ob) setOutfitBiases({ ...EMPTY_BIASES, ...JSON.parse(ob.value) });
      } catch {}
      try {
        const pl = await storage.get('painLog');
        if (pl) setPainLog(JSON.parse(pl.value));
      } catch {}
      try {
        const rc = await storage.get('rehabConfig');
        if (rc) setRehabConfig(JSON.parse(rc.value));
      } catch {}
      try {
        const rl = await storage.get('rehabLog');
        if (rl) setRehabLog(JSON.parse(rl.value));
      } catch {}
      setLoading(false);
    };
    load();
  }, []);

  const savePlan = useCallback(async (p) => { await storage.set('plan', JSON.stringify(p)); }, []);
  const saveSetup = useCallback(async (s) => { await storage.set('setup', JSON.stringify(s)); }, []);
  const saveCompletions = useCallback(async (c) => { await storage.set('completions', JSON.stringify(c)); }, []);
  const saveLogs = useCallback(async (l) => { await storage.set('logs', JSON.stringify(l)); }, []);
  const saveWeatherLocation = useCallback(async (wl) => { await storage.set('weatherLocation', JSON.stringify(wl)); }, []);
  const saveOutfitBiases = useCallback(async (ob) => { await storage.set('outfitBiases', JSON.stringify(ob)); }, []);
  const savePainLog = useCallback(async (pl) => { await storage.set('painLog', JSON.stringify(pl)); }, []);
  const saveRehabConfig = useCallback(async (rc) => { await storage.set('rehabConfig', JSON.stringify(rc)); }, []);
  const saveRehabLog = useCallback(async (rl) => { await storage.set('rehabLog', JSON.stringify(rl)); }, []);

  const toggleRehabExercise = useCallback((dateISO, exerciseId) => {
    setRehabLog(prev => {
      const existing = prev[dateISO] || {};
      const next = {
        ...prev,
        [dateISO]: { ...existing, [exerciseId]: !existing[exerciseId] },
      };
      // Clean up: if all flags are false, remove the date entry to keep the log tidy
      const allFalse = Object.values(next[dateISO]).every(v => !v);
      if (allFalse) delete next[dateISO];
      saveRehabLog(next);
      return next;
    });
  }, [saveRehabLog]);

  const updateRehabConfig = useCallback((updater) => {
    setRehabConfig(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveRehabConfig(next);
      return next;
    });
  }, [saveRehabConfig]);

  // Update pain log entry for a given date. `updates` is a partial entry to merge.
  const updatePainEntry = useCallback((dateISO, updates) => {
    setPainLog(prev => {
      const existing = prev[dateISO] || {};
      // Merge; allow null to clear a field, but drop undefined keys
      const merged = { ...existing };
      Object.keys(updates).forEach(k => {
        if (updates[k] !== undefined) merged[k] = updates[k];
      });
      const next = { ...prev, [dateISO]: merged };
      savePainLog(next);
      return next;
    });
  }, [savePainLog]);

  const updateWeatherLocation = (loc) => {
    setWeatherLocation(loc);
    saveWeatherLocation(loc);
  };

  const handleOutfitFeedback = (band, feedback, context) => {
    const updated = applyFeedback(outfitBiases, band, feedback, context);
    setOutfitBiases(updated);
    saveOutfitBiases(updated);
  };

  const resetOutfitBiases = () => {
    setOutfitBiases(EMPTY_BIASES);
    saveOutfitBiases(EMPTY_BIASES);
  };

  const handleGenerate = () => {
    const fiveKseconds = setup.fiveKminutes * 60 + setup.fiveKseconds;
    const paces = computePaces(fiveKseconds);
    const hr = computeHRzones(setup.maxHR, setup.restingHR);
    const vdot = vdotFrom5K(fiveKseconds);
    const subTDistances = {
      short: setup.subTShortDist || 800,
      medium: setup.subTMediumDist || 1200,
      long: setup.subTLongDist || 1609,
    };

    const buildPlan = (startDate) => {
      if (setup.planMode === 'general') {
        return generateGeneralPlan({
          startDate, paces, hr, vdot, subTDistances, weeks: 8,
        });
      }
      return generateMarathonPlan({
        raceDate: setup.raceDate, startDate, paces, hr, vdot, subTDistances,
      });
    };

    // If there's no existing plan, just generate fresh
    if (!plan) {
      const newPlan = buildPlan(setup.startDate);
      setPlan(newPlan);
      setCurrentWeekIdx(0);
      setCompletions({});
      setLogs({});
      savePlan(newPlan);
      saveSetup(setup);
      saveCompletions({});
      saveLogs({});
      setView('week');
      return;
    }

    // Smart regeneration: preserve past weeks (those that have ended), regenerate future weeks
    const today = todayISO();

    // A "past week" = a week whose last day (Sunday) is strictly before today
    const pastWeeks = plan.filter(w => w.days[6] && w.days[6].date < today);
    const pastWeekCount = pastWeeks.length;

    if (pastWeekCount === 0) {
      // No weeks have passed yet — confirm full regeneration
      if (!confirm('Regenerate the entire plan? Your current completion history and run logs will be cleared.')) return;
      const newPlan = buildPlan(setup.startDate);
      setPlan(newPlan);
      setCurrentWeekIdx(0);
      setCompletions({});
      setLogs({});
      savePlan(newPlan);
      saveSetup(setup);
      saveCompletions({});
      saveLogs({});
      setView('week');
      return;
    }

    // Past weeks exist — confirm partial regeneration
    const message = `Regenerate plan?\n\n• Weeks 1–${pastWeekCount} have already happened — they'll be kept along with your completion checkmarks.\n• Weeks ${pastWeekCount + 1}+ will be rebuilt with your new settings.\n\nContinue?`;
    if (!confirm(message)) return;

    // Find the start date for the future portion: the day after the last past week ends
    const lastPastWeek = pastWeeks[pastWeeks.length - 1];
    const [ly, lm, ld] = lastPastWeek.days[6].date.split('-').map(Number);
    const lastPastEnd = new Date(ly, lm - 1, ld);
    lastPastEnd.setDate(lastPastEnd.getDate() + 1);
    const futureStartDate = formatLocalISO(lastPastEnd);

    // Regenerate from the future start date
    const futureWeeksRaw = buildPlan(futureStartDate);

    // Renumber the future weeks so weekIndex stays globally unique
    const futureWeeks = futureWeeksRaw.map((w, i) => ({
      ...w,
      weekIndex: pastWeekCount + i,
    }));

    const mergedPlan = [...pastWeeks, ...futureWeeks];

    // Filter completions/logs to only keep those tied to past weeks
    const validKeys = new Set();
    pastWeeks.forEach((w) => {
      w.days.forEach((d, di) => {
        d.sessions.forEach(s => {
          validKeys.add(`${w.weekIndex}-${di}-${s.id}`);
        });
      });
    });
    const filteredCompletions = {};
    Object.keys(completions).forEach(k => {
      if (validKeys.has(k)) filteredCompletions[k] = completions[k];
    });
    const filteredLogs = {};
    Object.keys(logs).forEach(k => {
      if (validKeys.has(k)) filteredLogs[k] = logs[k];
    });

    setPlan(mergedPlan);
    setCompletions(filteredCompletions);
    setLogs(filteredLogs);
    savePlan(mergedPlan);
    saveSetup(setup);
    saveCompletions(filteredCompletions);
    saveLogs(filteredLogs);
    setCurrentWeekIdx(pastWeekCount);
    setView('week');
  };

  const handleReset = async () => {
    if (!confirm('Reset plan and clear all completion history?')) return;
    setPlan(null);
    setCompletions({});
    setLogs({});
    await storage.delete('plan');
    await storage.delete('completions');
    await storage.delete('logs');
    setView('setup');
  };

  const toggleCompletion = (key) => {
    const updated = { ...completions, [key]: !completions[key] };
    setCompletions(updated);
    saveCompletions(updated);
  };

  const updateLog = (key, log) => {
    const updated = { ...logs };
    const isNewLog = !logs[key] && log !== null && log !== undefined;
    if (log === null || log === undefined) {
      delete updated[key];
    } else {
      updated[key] = log;
    }
    setLogs(updated);
    saveLogs(updated);
    // After logging a NEW run, prompt for post-run pain if not already captured today
    if (isNewLog) {
      const today = todayISO();
      const todayEntry = painLog[today];
      if (!todayEntry || todayEntry.postRunPain === undefined) {
        // Defer so session modal closes first
        setTimeout(() => setPainModal({ date: today, mode: 'postRun' }), 200);
      }
    }
  };

  const moveSession = (weekIdx, fromDay, toDay, sessionId) => {
    const newPlan = plan.map((week, i) => {
      if (i !== weekIdx) return week;
      const newDays = week.days.map(d => ({ ...d, sessions: [...d.sessions] }));
      const sessionIdx = newDays[fromDay].sessions.findIndex(s => s.id === sessionId);
      if (sessionIdx === -1) return week;
      const [moved] = newDays[fromDay].sessions.splice(sessionIdx, 1);
      newDays[toDay].sessions.push(moved);
      return { ...week, days: newDays };
    });
    setPlan(newPlan);
    savePlan(newPlan);
  };

  // Add an unscheduled session to a specific day.
  // sessionData: { type, label, miles?, crossType?, durationMin? }
  // Cross-train sessions track activity subtype (e.g. "Cycling") + duration;
  // they do not contribute to weekly running mileage counts.
  const addUnscheduledSession = (weekIdx, dayIdx, sessionData) => {
    const id = `unscheduled-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newSession = { id, unscheduled: true, ...sessionData };
    const newPlan = plan.map((week, i) => {
      if (i !== weekIdx) return week;
      const newDays = week.days.map((d, di) => {
        if (di !== dayIdx) return d;
        return { ...d, sessions: [...d.sessions, newSession] };
      });
      return { ...week, days: newDays };
    });
    setPlan(newPlan);
    savePlan(newPlan);
  };

  const handleBackup = () => {
    const backup = {
      version: 5,
      exportedAt: new Date().toISOString(),
      setup,
      plan,
      completions,
      logs,
      weatherLocation,
      outfitBiases,
      painLog,
      rehabConfig,
      rehabLog,
    };
    const content = JSON.stringify(backup, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const today = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `singles-plan-backup-${today}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  const handleRestore = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.plan || !data.setup) {
          alert('That file does not look like a Singles Planner backup.');
          return;
        }
        if (plan && !confirm('Restore from backup? This will REPLACE your current plan, completion history, run logs, weather settings, and pain log.')) {
          return;
        }
        setSetup(data.setup);
        setPlan(data.plan);
        setCompletions(data.completions || {});
        setLogs(data.logs || {});
        if (data.weatherLocation) {
          setWeatherLocation(data.weatherLocation);
          saveWeatherLocation(data.weatherLocation);
        }
        if (data.outfitBiases) {
          setOutfitBiases({ ...EMPTY_BIASES, ...data.outfitBiases });
          saveOutfitBiases(data.outfitBiases);
        }
        if (data.painLog) {
          setPainLog(data.painLog);
          savePainLog(data.painLog);
        }
        if (data.rehabConfig) {
          setRehabConfig(data.rehabConfig);
          saveRehabConfig(data.rehabConfig);
        }
        if (data.rehabLog) {
          setRehabLog(data.rehabLog);
          saveRehabLog(data.rehabLog);
        }
        saveSetup(data.setup);
        savePlan(data.plan);
        saveCompletions(data.completions || {});
        saveLogs(data.logs || {});
        setCurrentWeekIdx(0);
        setView('week');
        alert('Backup restored.');
      } catch (err) {
        alert('Could not read the backup file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-slate-500">Loading...</div>;
  }

  const fiveKsec = setup.fiveKminutes * 60 + setup.fiveKseconds;
  const paces = computePaces(fiveKsec);
  const hrZones = computeHRzones(setup.maxHR, setup.restingHR);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 pb-20">
      {/* Top header */}
      <header className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3">
        <div className="flex items-center justify-between max-w-5xl mx-auto">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-rose-500" />
            <h1 className="font-semibold text-sm md:text-base">Singles Planner</h1>
          </div>
          {plan && view !== 'setup' && (
            <button
              onClick={() => downloadICS(plan)}
              className="text-xs px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-md flex items-center gap-1 transition"
              title="Export to Calendar"
            >
              <Share2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Export to Calendar</span>
              <span className="sm:hidden">.ics</span>
            </button>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-4">
        {view === 'setup' && (
          <SetupForm
            setup={setup}
            onChange={setSetup}
            onGenerate={handleGenerate}
            onReset={plan ? handleReset : null}
            onBackup={handleBackup}
            onRestore={handleRestore}
            hasPlan={!!plan}
            onShowMethod={() => setShowMethodModal(true)}
          />
        )}
        {view === 'week' && plan && (
          <WeekView
            plan={plan}
            currentWeekIdx={currentWeekIdx}
            setCurrentWeekIdx={setCurrentWeekIdx}
            completions={completions}
            logs={logs}
            onToggleCompletion={toggleCompletion}
            onMoveSession={moveSession}
            onSessionClick={setSelectedSession}
            onAddSessionRequest={(dayIdx) => setAddSessionTarget({ weekIdx: currentWeekIdx, dayIdx })}
            goalMarathonTime={projectMarathonTime(vdotFrom5K(fiveKsec))}
            goalDistance="26.2 mi"
            goalMP={paceFromSeconds(marathonPaceFromVdot(vdotFrom5K(fiveKsec)))}
          />
        )}
        {view === 'arc' && plan && (
          <ArcView
            plan={plan}
            completions={completions}
            logs={logs}
            paces={paces}
            onJumpToWeek={(i) => { setCurrentWeekIdx(i); setView('week'); }}
          />
        )}
        {view === 'strength' && (
          <StrengthView
            rehabConfig={rehabConfig}
            rehabLog={rehabLog}
            onToggleRehab={(exerciseId, dateISO) => toggleRehabExercise(dateISO || todayISO(), exerciseId)}
            onUpdateRehabConfig={updateRehabConfig}
            strengthDays={setup.strengthDays || [0, 3, 5]}
            onUpdateStrengthDays={(days) => {
              const next = { ...setup, strengthDays: days };
              setSetup(next);
              saveSetup(next);
            }}
          />
        )}
        {view === 'weather' && (
          <WeatherView
            location={weatherLocation}
            onLocationChange={updateWeatherLocation}
            biases={outfitBiases}
            onFeedback={handleOutfitFeedback}
            onResetBiases={resetOutfitBiases}
          />
        )}

        {plan && (view === 'week' || view === 'arc') && (
          <div className="mt-6 pt-4 border-t border-slate-200">
            <ZonesLegend paces={paces} hr={hrZones} />
          </div>
        )}
      </main>

      {/* Bottom nav */}
      {(plan || view === 'weather' || view === 'strength') && (
        <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex items-center justify-around py-2 z-10">
          {plan && <NavButton icon={Calendar} label="Run" active={view === 'week'} onClick={() => setView('week')} />}
          <NavButton icon={Dumbbell} label="Strength" active={view === 'strength'} onClick={() => setView('strength')} />
          {plan && <NavButton icon={TrendingUp} label="Arc" active={view === 'arc'} onClick={() => setView('arc')} />}
          <NavButton icon={Cloud} label="Weather" active={view === 'weather'} onClick={() => setView('weather')} />
          <NavButton icon={Settings} label="Setup" active={view === 'setup'} onClick={() => setView('setup')} />
        </nav>
      )}

      {/* Session detail modal */}
      {selectedSession && (
        <SessionModal
          session={selectedSession.session}
          onMoveStart={selectedSession.onMoveStart}
          sessionKey={selectedSession.sessionKey}
          log={logs[selectedSession.sessionKey]}
          onSaveLog={(log) => updateLog(selectedSession.sessionKey, log)}
          paces={paces}
          hr={hrZones}
          onClose={() => setSelectedSession(null)}
        />
      )}

      {/* Pain tracking modal */}
      {painModal && (
        <PainModal
          date={painModal.date}
          mode={painModal.mode}
          painLog={painLog}
          onSave={(dateISO, updates, opts) => {
            updatePainEntry(dateISO, updates);
            if (!opts || !opts.keepOpen) setPainModal(null);
          }}
          onClose={() => setPainModal(null)}
        />
      )}

      {/* Norwegian Singles method primer */}
      {showMethodModal && (
        <MethodModal onClose={() => setShowMethodModal(false)} />
      )}

      {/* Add unscheduled session modal */}
      {addSessionTarget && plan && (
        <AddSessionModal
          plan={plan}
          weekIdx={addSessionTarget.weekIdx}
          dayIdx={addSessionTarget.dayIdx}
          onAdd={(sessionData) => {
            addUnscheduledSession(addSessionTarget.weekIdx, addSessionTarget.dayIdx, sessionData);
            setAddSessionTarget(null);
          }}
          onClose={() => setAddSessionTarget(null)}
        />
      )}
    </div>
  );
}

function NavButton({ icon: Icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 px-6 py-1 rounded-md transition ${active ? 'text-slate-900' : 'text-slate-400'}`}
    >
      <Icon className="h-5 w-5" />
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

// Modal for logging an unscheduled run or cross-training session on a given day.
function AddSessionModal({ plan, weekIdx, dayIdx, onAdd, onClose }) {
  const [type, setType] = useState(null); // 'easy' | 'subT' | 'long' | 'strength' | 'cross'
  const [miles, setMiles] = useState('');
  const [crossType, setCrossType] = useState('');
  const [durationMin, setDurationMin] = useState('');
  const [notes, setNotes] = useState('');

  const day = plan[weekIdx]?.days[dayIdx];
  const [y, m, d] = (day?.date || '').split('-').map(Number);
  const dayName = day?.date ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(y, m - 1, d).getDay()] : '';
  const displayDate = day?.date ? `${dayName} ${m}/${d}` : '';

  const typeOptions = [
    { id: 'easy', label: 'Easy run', icon: Footprints, color: 'emerald' },
    { id: 'subT', label: 'Sub-T run', icon: TrendingUp, color: 'rose' },
    { id: 'long', label: 'Long run', icon: Activity, color: 'blue' },
    { id: 'strength', label: 'Strength', icon: Dumbbell, color: 'purple' },
    { id: 'cross', label: 'Cross-train', icon: Activity, color: 'cyan' },
  ];

  const isRun = type === 'easy' || type === 'subT' || type === 'long';
  const isCross = type === 'cross';
  const isStrength = type === 'strength';

  const canSave = type !== null && (
    (isRun && miles.trim() !== '') ||
    (isCross && crossType.trim() !== '' && durationMin.trim() !== '') ||
    isStrength
  );

  const handleSave = () => {
    if (!canSave) return;
    const data = { type };
    const chosen = typeOptions.find(t => t.id === type);
    if (isRun) {
      const m = parseFloat(miles);
      if (!Number.isFinite(m) || m <= 0) return;
      data.miles = m;
      data.label = `${chosen.label} · ${m.toFixed(1)} mi`;
    } else if (isCross) {
      const dur = parseFloat(durationMin);
      if (!Number.isFinite(dur) || dur <= 0) return;
      data.crossType = crossType.trim();
      data.durationMin = dur;
      data.label = `${crossType.trim()} · ${dur} min`;
    } else if (isStrength) {
      data.label = 'Strength session';
      if (durationMin.trim()) {
        const dur = parseFloat(durationMin);
        if (Number.isFinite(dur) && dur > 0) {
          data.durationMin = dur;
          data.label = `Strength · ${dur} min`;
        }
      }
    }
    if (notes.trim()) data.notes = notes.trim();
    onAdd(data);
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}>
      <div
        className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Add session</h3>
            {displayDate && <p className="text-xs text-slate-500 mt-0.5">{displayDate}</p>}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Session type picker */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-2 uppercase tracking-wide">Type</label>
          <div className="grid grid-cols-2 gap-2">
            {typeOptions.map(opt => {
              const Icon = opt.icon;
              const selected = type === opt.id;
              const style = SESSION_COLORS[opt.id];
              return (
                <button
                  key={opt.id}
                  onClick={() => setType(opt.id)}
                  className={`flex items-center gap-2 p-2.5 rounded-md text-sm font-medium border transition ${
                    selected
                      ? `${style.bg} ${style.border} ${style.text} ring-2 ring-offset-1 ring-slate-900`
                      : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}>
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Type-specific fields */}
        {isRun && (
          <div className="mt-4">
            <label className="block text-xs font-semibold text-slate-700 mb-1 uppercase tracking-wide">Distance (miles)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={miles}
              onChange={e => setMiles(e.target.value)}
              placeholder="e.g. 5.2"
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-transparent"
              autoFocus
            />
          </div>
        )}

        {isCross && (
          <>
            <div className="mt-4">
              <label className="block text-xs font-semibold text-slate-700 mb-1 uppercase tracking-wide">Activity</label>
              <input
                type="text"
                value={crossType}
                onChange={e => setCrossType(e.target.value)}
                placeholder="e.g. Cycling, Swimming, Yoga"
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                autoFocus
              />
            </div>
            <div className="mt-3">
              <label className="block text-xs font-semibold text-slate-700 mb-1 uppercase tracking-wide">Duration (minutes)</label>
              <input
                type="number"
                step="1"
                min="0"
                inputMode="numeric"
                value={durationMin}
                onChange={e => setDurationMin(e.target.value)}
                placeholder="e.g. 45"
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
              />
            </div>
            <p className="text-[10px] text-slate-500 mt-2 italic">Cross-training won't count toward weekly running mileage, but will appear on your plan.</p>
          </>
        )}

        {isStrength && (
          <div className="mt-4">
            <label className="block text-xs font-semibold text-slate-700 mb-1 uppercase tracking-wide">Duration (minutes, optional)</label>
            <input
              type="number"
              step="1"
              min="0"
              inputMode="numeric"
              value={durationMin}
              onChange={e => setDurationMin(e.target.value)}
              placeholder="e.g. 30"
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              autoFocus
            />
          </div>
        )}

        {/* Notes */}
        {type && (
          <div className="mt-4">
            <label className="block text-xs font-semibold text-slate-700 mb-1 uppercase tracking-wide">
              Notes <span className="font-normal text-slate-400 normal-case">(optional)</span>
            </label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              maxLength={200}
              placeholder="How it went, HR, pace, etc."
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-transparent"
            />
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 border border-slate-300 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="flex-1 py-2.5 bg-slate-900 text-white rounded-md text-sm font-medium hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed">
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// Norwegian Singles method primer — written out as a shareable read.
function MethodModal({ onClose }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}>
      <div
        className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-200 flex-shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">The Norwegian Singles Method</h3>
            <p className="text-xs text-slate-500 mt-0.5">A primer</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content — scrollable */}
        <div className="overflow-y-auto px-5 py-4 flex-1">
          <div className="prose prose-sm max-w-none text-slate-700 space-y-4 text-sm leading-relaxed">

            <section>
              <h4 className="font-semibold text-slate-900 text-base mb-2">What it is</h4>
              <p>
                The Norwegian Singles method is a running training approach centered on a simple idea: run easy almost all the time, but layer in frequent, moderately-hard workouts called "sub-threshold" sessions. It's called "Singles" because workouts are done once per day — no doubles (two sessions/day) like the elite Norwegian method it's derived from.
              </p>
              <p>
                It was designed by Marius Bakken, a former Norwegian 5K national record holder, and popularized in the running community by a user named Sirpoc on the LetsRun forums, who documented dramatic improvements running 40–60 miles per week on this method.
              </p>
            </section>

            <section>
              <h4 className="font-semibold text-slate-900 text-base mb-2">The core weekly structure</h4>
              <p>A typical Singles week looks like:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><strong>2–3 sub-threshold (sub-T) workouts</strong> — intervals run just below lactate threshold, e.g. 5×1 mile at ~10K pace with short recovery</li>
                <li><strong>1 long run</strong> — at easy pace</li>
                <li><strong>3–4 easy runs</strong> — strictly below ~70% of max heart rate</li>
                <li><strong>1 rest day</strong></li>
              </ul>
              <p>
                That's it. No tempo runs. No VO2 max intervals. No race-pace sessions. Just sub-T and easy, repeated week after week.
              </p>
            </section>

            <section>
              <h4 className="font-semibold text-slate-900 text-base mb-2">What makes it different</h4>
              <p>
                Most training philosophies (Daniels, Pfitzinger, Hanson's Marathon Method) include a variety of workout types across multiple intensities: tempo, threshold, VO2, marathon-pace, race-pace, strides, etc. The theory is that each stimulus develops a different physiological system.
              </p>
              <p>
                Singles is radically simpler. It uses <em>one</em> workout intensity — sub-T — and <em>frequently</em>, counting on volume and repetition to drive adaptation rather than variety. This does a few things:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li><strong>Reduces injury risk</strong> — fewer high-intensity sessions means less cumulative mechanical stress</li>
                <li><strong>Improves recovery</strong> — sub-T is easier to recover from than threshold or race-pace, so you can do it 2–3x weekly without digging a fatigue hole</li>
                <li><strong>Keeps easy runs genuinely easy</strong> — because your hard days aren't wrecking you, you don't need to recovery-jog between them</li>
                <li><strong>Builds aerobic capacity aggressively</strong> — total volume + moderately hard work accumulates a lot of stimulus without crossing the fatigue line</li>
              </ul>
            </section>

            <section>
              <h4 className="font-semibold text-slate-900 text-base mb-2">Why "sub-T"?</h4>
              <p>
                Lactate threshold (LT2) is the pace/effort at which your body starts accumulating lactate faster than it can clear it. Running at or above LT2 forces a relatively quick end to the effort and requires significant recovery.
              </p>
              <p>
                Sub-T is just below that line — close enough to stimulate adaptation in the lactate-clearing system, but below the tipping point. This means you can do meaningful work, repeat it frequently, and the next day's session isn't compromised.
              </p>
              <p>
                Practically: sub-T is often 10–20 seconds per mile slower than 10K race pace, at a heart rate roughly 84–88% of max. It should feel "comfortably hard" — breathing hard but in rhythm, conversation in short phrases only.
              </p>
            </section>

            <section>
              <h4 className="font-semibold text-slate-900 text-base mb-2">Why strict easy pace matters</h4>
              <p>
                The method only works if easy runs are truly easy. "Easy" in Singles typically means below 70% of max heart rate — slower than most runners naturally drift toward. Running easy at 75–80% of max, even if it feels fine, accumulates enough stress that your sub-T sessions will suffer.
              </p>
              <p>
                This is the hardest part of the method for most runners. You'll feel like you're wasting your run. You're not — you're preserving the ability to execute the hard days at the right quality.
              </p>
            </section>

            <section>
              <h4 className="font-semibold text-slate-900 text-base mb-2">Who it works well for</h4>
              <ul className="list-disc pl-5 space-y-1">
                <li>Runners prone to injury from higher-intensity plans</li>
                <li>Runners who find traditional training too chaotic (different workout type every day)</li>
                <li>Runners building base fitness from a plateau</li>
                <li>Runners with limited time — Singles requires less recovery complexity</li>
              </ul>
              <p>It's less well-suited for short-distance specialists (1500m and below) who need more speed work.</p>
            </section>

            <section>
              <h4 className="font-semibold text-slate-900 text-base mb-2">Further reading</h4>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <a href="https://www.mariusbakken.com/the-norwegian-model.html" target="_blank" rel="noopener noreferrer"
                     className="text-blue-600 hover:text-blue-800 underline">
                    Marius Bakken — the Norwegian Model
                  </a> (the original architect's own writeup)
                </li>
                <li>
                  <a href="https://www.letsrun.com/forum/flat_read.php?thread=11459409" target="_blank" rel="noopener noreferrer"
                     className="text-blue-600 hover:text-blue-800 underline">
                    Sirpoc's LetsRun thread
                  </a> (the training log that popularized Singles)
                </li>
                <li>
                  <a href="https://scientifictriathlon.com/" target="_blank" rel="noopener noreferrer"
                     className="text-blue-600 hover:text-blue-800 underline">
                    Scientific Triathlon — Norwegian Method podcasts
                  </a> (Mikael Eriksson's interviews with the Ingebrigtsens' coaches)
                </li>
              </ul>
            </section>

            <p className="text-xs text-slate-500 italic pt-2 border-t border-slate-100">
              This primer is a simplification. The actual method has more nuance — periodization, how to progress sub-T pace over time, how to recover from workouts that don't go well, etc. The resources above go deeper.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 flex-shrink-0 bg-slate-50">
          <button onClick={onClose}
            className="w-full py-2 bg-slate-900 text-white rounded-md text-sm font-medium hover:bg-slate-800">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SetupForm({ setup, onChange, onGenerate, onReset, onBackup, onRestore, hasPlan, onShowMethod }) {
  const update = (patch) => onChange({ ...setup, ...patch });

  const handleRestoreClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) onRestore(file);
    };
    input.click();
  };

  // Derived values for live preview
  const fiveKsec = setup.fiveKminutes * 60 + setup.fiveKseconds;
  const paces = fiveKsec > 0 ? computePaces(fiveKsec) : null;
  const hr = computeHRzones(setup.maxHR, setup.restingHR);
  const vdot = fiveKsec > 0 ? vdotFrom5K(fiveKsec) : null;
  const projectedMarathonSec = vdot ? projectMarathonTime(vdot) : null;
  const mpSec = vdot ? marathonPaceFromVdot(vdot) : null;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">Set up your plan</h2>
      <p className="text-sm text-slate-500 mb-5">
        {setup.planMode === 'general'
          ? 'General training: rolling weeks, no race-specific structure.'
          : 'Race-driven marathon plan: Phase 1 base + 16-week marathon block ending on race day.'}
      </p>

      <div className="space-y-5">
        {/* Plan mode toggle */}
        <div>
          <label className="block text-sm font-medium mb-2">Training mode</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => update({ planMode: 'general' })}
              className={`px-3 py-2 rounded-md border text-sm font-medium transition ${
                setup.planMode === 'general'
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
              }`}>
              General training
            </button>
            <button
              type="button"
              onClick={() => update({ planMode: 'marathon' })}
              className={`px-3 py-2 rounded-md border text-sm font-medium transition ${
                setup.planMode === 'marathon' || !setup.planMode
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
              }`}>
              Marathon-specific
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {setup.planMode === 'general'
              ? 'Sirpoc-style general training: rolling weeks, sub-T rotation, no marathon-specific work.'
              : 'Race-driven plan: 16-week marathon block ending on race day, with MP work in late blocks.'}
          </p>
        </div>

        {/* Race date — only shown in marathon mode */}
        {setup.planMode !== 'general' && (
          <div>
            <label className="block text-sm font-medium mb-1.5">Race date (target marathon)</label>
            <input type="date" value={setup.raceDate}
              onChange={(e) => update({ raceDate: e.target.value })}
              className="px-3 py-2 border border-slate-200 rounded-md text-sm" />
            <p className="text-xs text-slate-400 mt-1">The plan works backward 16 weeks from race day. Phase 1 fills the gap from your start date.</p>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1.5">Plan start date</label>
          <input type="date" value={setup.startDate}
            onChange={(e) => update({ startDate: e.target.value })}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm" />
          <p className="text-xs text-slate-400 mt-1">Week 1 begins on the Monday of this date.</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">Recent 5K time</label>
          <div className="flex items-center gap-2">
            <input type="number" value={setup.fiveKminutes}
              onChange={(e) => update({ fiveKminutes: parseInt(e.target.value) || 0 })}
              className="w-20 px-3 py-2 border border-slate-200 rounded-md text-sm" min="10" max="60" />
            <span className="text-sm text-slate-500">min</span>
            <input type="number" value={setup.fiveKseconds}
              onChange={(e) => update({ fiveKseconds: parseInt(e.target.value) || 0 })}
              className="w-20 px-3 py-2 border border-slate-200 rounded-md text-sm" min="0" max="59" />
            <span className="text-sm text-slate-500">sec</span>
          </div>
          <p className="text-xs text-slate-400 mt-1">If your last 5K was hilly, enter the flat-equivalent (GAP-corrected) time.</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1.5">Max HR (bpm)</label>
            <input type="number" value={setup.maxHR}
              onChange={(e) => update({ maxHR: parseInt(e.target.value) || 0 })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" min="140" max="220" />
            <p className="text-xs text-slate-400 mt-1">Observed max from racing.</p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Resting HR (bpm)</label>
            <input type="number" value={setup.restingHR}
              onChange={(e) => update({ restingHR: parseInt(e.target.value) || 0 })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" min="30" max="80" />
            <p className="text-xs text-slate-400 mt-1">Morning resting HR.</p>
          </div>
        </div>

        {/* Derived values preview */}
        {vdot && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-2">
            <h3 className="text-sm font-semibold text-slate-900">Calculated from your inputs</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <div className="text-slate-500">VDOT</div>
              <div className="font-medium text-slate-900">{vdot.toFixed(1)}</div>

              <div className="text-slate-500">Easy pace</div>
              <div className="font-medium text-slate-900">{paceFromSeconds(paces.easy.low)}–{paceFromSeconds(paces.easy.high)}/mi</div>

              <div className="text-slate-500">Sub-T pace</div>
              <div className="font-medium text-slate-900">{paceFromSeconds(paces.subT.low)}–{paceFromSeconds(paces.subT.high)}/mi</div>

              <div className="text-slate-500">Marathon pace</div>
              <div className="font-medium text-slate-900">{paceFromSeconds(mpSec)}/mi</div>

              <div className="text-slate-500">Projected marathon</div>
              <div className="font-medium text-slate-900">{formatTime(projectedMarathonSec)}</div>

              <div className="text-slate-500">Easy HR ceiling</div>
              <div className="font-medium text-slate-900">&lt; {hr.easyMax}</div>

              <div className="text-slate-500">Sub-T HR target</div>
              <div className="font-medium text-slate-900">{hr.subTLow}–{hr.subTHigh}</div>

              <div className="text-slate-500">Threshold (LT2)</div>
              <div className="font-medium text-slate-900">~{hr.lt2}</div>
            </div>
            <p className="text-xs text-slate-500 italic pt-1">
              Marathon pace and goal time are derived from current fitness, not aspiration. They'll update as you log faster races/time trials.
            </p>
          </div>
        )}

        {/* Sub-T rep distance configuration */}
        <div>
          <label className="block text-sm font-medium mb-2">Sub-T rep distances</label>
          <p className="text-xs text-slate-400 mb-3">
            Pick rep distances per Sirpoc's three sub-T staples. Distances are checked against the rep-duration target (3 / 6 / 10 min).
          </p>

          <div className="space-y-3">
            {/* Short reps (~3 min) */}
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-1.5">Short reps (~3 min target)</p>
              <div className="flex flex-wrap gap-1.5">
                {[600, 700, 800, 1000].map(dist => (
                  <button
                    key={dist}
                    type="button"
                    onClick={() => update({ subTShortDist: dist })}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium border transition ${
                      (setup.subTShortDist || 800) === dist
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                    }`}>
                    {dist}m{dist === 800 ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            </div>

            {/* Medium reps (~6 min) */}
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-1.5">Medium reps (~6 min target)</p>
              <div className="flex flex-wrap gap-1.5">
                {[1000, 1200, 1609, 2000].map(dist => (
                  <button
                    key={dist}
                    type="button"
                    onClick={() => update({ subTMediumDist: dist })}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium border transition ${
                      (setup.subTMediumDist || 1200) === dist
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                    }`}>
                    {dist === 1609 ? '1 mi' : `${dist}m`}{dist === 1200 ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            </div>

            {/* Long reps (~10 min) */}
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-1.5">Long reps (~10 min target)</p>
              <div className="flex flex-wrap gap-1.5">
                {[1609, 2000, 2414, 3000].map(dist => (
                  <button
                    key={dist}
                    type="button"
                    onClick={() => update({ subTLongDist: dist })}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium border transition ${
                      (setup.subTLongDist || 1609) === dist
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                    }`}>
                    {dist === 1609 ? '1 mi' : dist === 2414 ? '1.5 mi' : `${dist}m`}{dist === 1609 ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-2 italic">✓ = Sirpoc's recommended default</p>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <p className="text-xs text-amber-900 leading-relaxed">
            <span className="font-semibold">Weekly structure:</span> 4 runs (Sun long · Tue sub-T · Wed easy · Fri sub-T from week 2 onward).
            Thursday is open for cross-training or rest. Mon and Sat are rest days.
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mt-6">
        <button onClick={onGenerate}
          className="px-5 py-2.5 bg-slate-900 text-white rounded-md font-medium text-sm hover:bg-slate-800 transition">
          {hasPlan ? 'Regenerate plan' : 'Generate plan'}
        </button>
        {onReset && (
          <button onClick={onReset}
            className="px-5 py-2.5 bg-white text-slate-700 border border-slate-200 rounded-md font-medium text-sm hover:bg-slate-50 transition flex items-center justify-center gap-1.5">
            <RotateCcw className="h-3.5 w-3.5" /> Reset plan
          </button>
        )}
      </div>

      {/* About the method */}
      <div className="mt-8 pt-5 border-t border-slate-200">
        <h3 className="text-sm font-semibold text-slate-900 mb-1">About the Norwegian Singles method</h3>
        <p className="text-xs text-slate-500 mb-3 leading-relaxed">
          A primer on how this training approach works and how it differs from more common plans like Daniels or Pfitzinger. Shareable with friends who are curious.
        </p>
        <button onClick={onShowMethod}
          className="w-full sm:w-auto px-4 py-2 bg-slate-100 text-slate-800 border border-slate-200 rounded-md font-medium text-sm hover:bg-slate-200 transition flex items-center justify-center gap-1.5">
          <Info className="h-3.5 w-3.5" />
          Read the primer
        </button>
      </div>

      {/* Backup & restore section */}
      <div className="mt-8 pt-5 border-t border-slate-200">
        <h3 className="text-sm font-semibold text-slate-900 mb-1">Backup & restore</h3>
        <p className="text-xs text-slate-500 mb-3 leading-relaxed">
          Your plan and completion history live in this browser only. Download a backup periodically — store it in iCloud, Google Drive, or email it to yourself. Restore it on another device or after clearing your browser.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <button onClick={onBackup} disabled={!hasPlan}
            className="flex-1 px-4 py-2 bg-emerald-50 text-emerald-900 border border-emerald-200 rounded-md font-medium text-sm hover:bg-emerald-100 transition flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
            <Download className="h-3.5 w-3.5" />
            Download backup
          </button>
          <button onClick={handleRestoreClick}
            className="flex-1 px-4 py-2 bg-blue-50 text-blue-900 border border-blue-200 rounded-md font-medium text-sm hover:bg-blue-100 transition flex items-center justify-center gap-1.5">
            <Share2 className="h-3.5 w-3.5" />
            Restore from backup
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionCard({ session, completed, onToggle, hasLog, isMoveMode, isSelected, isMovableInMode, onSelectAsMoveTarget, onClick }) {
  const style = SESSION_COLORS[session.type] || SESSION_COLORS.easy;
  const Icon = style.icon;
  // Unscheduled sessions use `label` (user-entered), planned ones use `title`
  const displayTitle = session.title || session.label || 'Session';

  const handleCardClick = (e) => {
    // In move mode, tapping does nothing on the card itself (the whole day handles the tap)
    if (isMoveMode) return;
    onClick && onClick();
  };

  return (
    <div
      onClick={handleCardClick}
      className={`group rounded-lg border ${style.border} ${style.bg} p-2 transition cursor-pointer ${
        completed ? 'opacity-60' : ''
      } ${isSelected ? 'ring-2 ring-slate-900 shadow-lg' : ''} ${
        isMoveMode && !isSelected ? 'opacity-50' : ''
      } ${session.unscheduled ? 'border-dashed' : ''}`}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className="mt-0.5 flex-shrink-0"
          aria-label="Mark complete"
        >
          {completed
            ? <CheckCircle2 className={`h-4 w-4 ${style.text}`} />
            : <Circle className="h-4 w-4 text-slate-400 hover:text-slate-600" />
          }
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <Icon className={`h-3.5 w-3.5 ${style.text} flex-shrink-0`} />
            <p className={`text-xs font-semibold ${style.text} leading-tight truncate ${completed ? 'line-through' : ''}`}>
              {displayTitle}
            </p>
            {hasLog && (
              <span className="ml-auto text-[9px] font-bold text-emerald-700 bg-emerald-100 rounded px-1 py-0.5 flex-shrink-0">LOGGED</span>
            )}
            {session.unscheduled && !hasLog && (
              <span className="ml-auto text-[8px] font-semibold text-slate-500 bg-slate-100 rounded px-1 py-0.5 flex-shrink-0">EXTRA</span>
            )}
          </div>
          {session.pace && (
            <p className="text-[10px] text-slate-600 leading-tight">{session.pace} · {session.hr}</p>
          )}
          {session.unscheduled && session.notes && (
            <p className="text-[10px] text-slate-500 leading-tight italic truncate">{session.notes}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Pain tracking UI
// ============================================================

// Full-page Health view — pain tracking + rehab checklist
function HealthView({ painLog, onOpenPainModal }) {
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
          <Heart className="h-4 w-4 text-rose-500" />
          Health
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">Pain tracking</p>
      </div>
      <PainSection painLog={painLog} onOpenPainModal={onOpenPainModal} />
    </div>
  );
}

function StrengthView({ rehabConfig, rehabLog, onToggleRehab, onUpdateRehabConfig, strengthDays, onUpdateStrengthDays }) {
  const today = todayISO();
  const todayDow = getDayOfWeekIndex(today);  // 0=Mon, 6=Sun

  // Selected day for viewing/checking off exercises (defaults to today if today is a strength day, else first strength day this week)
  const [selectedDow, setSelectedDow] = useState(
    strengthDays.includes(todayDow) ? todayDow : (strengthDays[0] ?? 0)
  );
  // Move mode: when set, tapping another day moves the strength day there
  const [moveFromDow, setMoveFromDow] = useState(null);

  // Compute the week start (Monday) for the current week and build per-day dates
  const weekStartISO = startOfWeekISO(today);
  const weekDates = [];
  {
    const [y, m, d] = weekStartISO.split('-').map(Number);
    for (let i = 0; i < 7; i++) {
      const dt = new Date(y, m - 1, d + i);
      const yy = dt.getFullYear();
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      weekDates.push(`${yy}-${mm}-${dd}`);
    }
  }

  const selectedDateISO = weekDates[selectedDow];

  const handleDayClick = (dow) => {
    const isStrengthDay = strengthDays.includes(dow);

    if (moveFromDow !== null) {
      // We're in move mode — move strength day from moveFromDow to dow
      if (dow === moveFromDow) {
        // Tapped the same day — cancel
        setMoveFromDow(null);
      } else if (strengthDays.includes(dow)) {
        // Target is also a strength day — just swap selection
        setSelectedDow(dow);
        setMoveFromDow(null);
      } else {
        // Move: remove moveFromDow, add dow
        const next = strengthDays.filter(d => d !== moveFromDow).concat(dow).sort();
        onUpdateStrengthDays(next);
        setSelectedDow(dow);
        setMoveFromDow(null);
      }
      return;
    }

    if (isStrengthDay) {
      setSelectedDow(dow);
    }
  };

  const handleDayLongPress = (dow) => {
    if (strengthDays.includes(dow)) {
      setMoveFromDow(dow);
    }
  };

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
          <Dumbbell className="h-4 w-4 text-purple-600" />
          Strength
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          {moveFromDow !== null
            ? 'Tap a day to move the strength day there'
            : 'Tap a purple day to view exercises. Long-press a strength day to move it.'}
        </p>
      </div>

      {/* Week calendar */}
      <div className="bg-white border border-slate-200 rounded-lg p-3 mb-4">
        <div className="grid grid-cols-7 gap-1.5">
          {weekDates.map((dateISO, dow) => {
            const isStrengthDay = strengthDays.includes(dow);
            const isSelected = dow === selectedDow && isStrengthDay;
            const isToday = dateISO === today;
            const isMoveOrigin = moveFromDow === dow;
            const exerciseCount = isStrengthDay
              ? Object.values(rehabLog?.[dateISO] || {}).filter(Boolean).length
              : 0;
            const [, , ddStr] = dateISO.split('-');

            let bgClass, textClass;
            if (isMoveOrigin) {
              bgClass = 'bg-purple-300 ring-2 ring-purple-600';
              textClass = 'text-purple-900';
            } else if (isSelected) {
              bgClass = 'bg-purple-600';
              textClass = 'text-white';
            } else if (isStrengthDay) {
              bgClass = 'bg-purple-100 hover:bg-purple-200';
              textClass = 'text-purple-900';
            } else {
              bgClass = 'bg-slate-50 hover:bg-slate-100';
              textClass = 'text-slate-400';
            }

            return (
              <button
                key={dateISO}
                onClick={() => handleDayClick(dow)}
                onContextMenu={(e) => { e.preventDefault(); handleDayLongPress(dow); }}
                onTouchStart={(e) => {
                  // Set up a long-press handler
                  const timer = setTimeout(() => handleDayLongPress(dow), 500);
                  e.target.dataset.longPressTimer = timer;
                }}
                onTouchEnd={(e) => {
                  if (e.target.dataset.longPressTimer) {
                    clearTimeout(parseInt(e.target.dataset.longPressTimer));
                  }
                }}
                className={`relative flex flex-col items-center justify-center py-2 rounded-md transition ${bgClass} ${textClass}`}>
                <span className="text-[10px] font-medium">{DAYS[dow]}</span>
                <span className={`text-base font-bold ${isToday ? 'underline' : ''}`}>{Number(ddStr)}</span>
                {isStrengthDay && exerciseCount > 0 && (
                  <span className="absolute top-0.5 right-0.5 bg-emerald-500 text-white text-[8px] font-bold rounded-full h-3 w-3 flex items-center justify-center">
                    {exerciseCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {moveFromDow !== null && (
          <button
            onClick={() => setMoveFromDow(null)}
            className="w-full mt-2 py-1 text-[11px] text-slate-600 hover:text-slate-900 underline">
            Cancel move
          </button>
        )}
      </div>

      {/* Selected day exercises */}
      {strengthDays.includes(selectedDow) ? (
        <StrengthDaySection
          dateISO={selectedDateISO}
          dayName={DAYS[selectedDow]}
          rehabConfig={rehabConfig}
          rehabLog={rehabLog}
          onToggleRehab={(exId) => onToggleRehab(exId, selectedDateISO)}
          onUpdateRehabConfig={onUpdateRehabConfig}
        />
      ) : (
        <div className="bg-slate-50 border border-dashed border-slate-300 rounded-lg p-4 text-center">
          <p className="text-xs text-slate-500">Tap a strength day on the calendar above.</p>
        </div>
      )}
    </div>
  );
}

// Get day of week index from ISO date string (0 = Monday, 6 = Sunday)
function getDayOfWeekIndex(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const jsDay = dt.getDay();  // 0 = Sunday
  return (jsDay + 6) % 7;  // 0 = Monday
}

// Get Monday of the week containing this date
function startOfWeekISO(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = getDayOfWeekIndex(isoDate);
  dt.setDate(dt.getDate() - dow);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Renders one strength day: all 18 exercises grouped by category, with per-day checkboxes
function StrengthDaySection({ dateISO, dayName, rehabConfig, rehabLog, onToggleRehab, onUpdateRehabConfig }) {
  const [editing, setEditing] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [addingCategory, setAddingCategory] = useState(null);
  const [newName, setNewName] = useState('');
  const [newDose, setNewDose] = useState('');

  const exercises = rehabConfig.exercises || [];
  const byCategory = {};
  STRENGTH_CATEGORIES.forEach(c => { byCategory[c] = []; });
  exercises.forEach(ex => {
    const cat = ex.category && STRENGTH_CATEGORIES.includes(ex.category) ? ex.category : 'Mobility';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(ex);
  });

  const handleAdd = (category) => {
    const name = newName.trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
    onUpdateRehabConfig(prev => ({
      ...prev,
      exercises: [
        ...(prev.exercises || []),
        { id, name, dose: newDose.trim() || undefined, category },
      ],
    }));
    setNewName('');
    setNewDose('');
    setAddingCategory(null);
  };

  const handleSaveEdit = (id, updated) => {
    onUpdateRehabConfig(prev => ({
      ...prev,
      exercises: (prev.exercises || []).map(e => e.id === id ? { ...e, ...updated } : e),
    }));
    setEditingId(null);
  };

  const handleRemove = (id) => {
    if (!confirm('Remove this exercise? (Past completion records are kept.)')) return;
    onUpdateRehabConfig(prev => ({
      ...prev,
      exercises: (prev.exercises || []).filter(e => e.id !== id),
    }));
    setEditingId(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
          {dayName} · {dateISO}
        </h3>
        <button
          onClick={() => { setEditing(!editing); setEditingId(null); setAddingCategory(null); }}
          className="text-[11px] text-slate-600 hover:text-slate-900 underline underline-offset-2">
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      <div className="space-y-3">
        {STRENGTH_CATEGORIES.map(category => {
          const items = byCategory[category] || [];
          if (items.length === 0 && !editing) return null;
          return (
            <div key={category} className="bg-white border border-slate-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[11px] font-semibold text-slate-800 uppercase tracking-wide">{category}</h4>
                {editing && (
                  <button
                    onClick={() => { setAddingCategory(category); setNewName(''); setNewDose(''); }}
                    className="text-[10px] text-purple-600 hover:text-purple-700 font-medium inline-flex items-center gap-1">
                    <Plus className="h-3 w-3" />
                    Add
                  </button>
                )}
              </div>

              {items.length === 0 && !editing && (
                <p className="text-[11px] text-slate-400 italic">No exercises</p>
              )}

              <div className="space-y-1.5">
                {items.map(ex => {
                  const isDone = wasExerciseDone(rehabLog, dateISO, ex.id);
                  const isEditingThis = editingId === ex.id;

                  if (isEditingThis) {
                    return <ExerciseEditor key={ex.id}
                      exercise={ex}
                      onSave={(updates) => handleSaveEdit(ex.id, updates)}
                      onRemove={() => handleRemove(ex.id)}
                      onCancel={() => setEditingId(null)}
                    />;
                  }

                  return (
                    <div key={ex.id} className="flex items-center gap-2">
                      <button
                        onClick={() => !editing && onToggleRehab(ex.id)}
                        disabled={editing}
                        className={`flex items-center gap-2 flex-1 text-left p-2 rounded-md border transition ${
                          isDone
                            ? 'bg-purple-50 border-purple-200 text-purple-900'
                            : 'bg-white border-slate-200 hover:border-slate-300'
                        } ${editing ? 'opacity-60 cursor-not-allowed' : ''}`}>
                        {isDone
                          ? <CheckCircle2 className="h-4 w-4 text-purple-600 flex-shrink-0" />
                          : <Circle className="h-4 w-4 text-slate-400 flex-shrink-0" />
                        }
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm font-medium truncate ${isDone ? 'line-through text-purple-900/70' : 'text-slate-900'}`}>
                            {ex.name}
                          </p>
                          {(ex.dose || ex.note) && (
                            <p className="text-[10px] text-slate-500 truncate">{ex.dose || ex.note}</p>
                          )}
                        </div>
                      </button>
                      {editing && (
                        <button
                          onClick={() => setEditingId(ex.id)}
                          className="p-2 text-slate-400 hover:text-slate-700 flex-shrink-0"
                          title="Edit">
                          <Settings className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}

                {addingCategory === category && (
                  <div className="bg-slate-50 border border-slate-200 rounded-md p-2 space-y-2">
                    <input
                      type="text"
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                      placeholder="Exercise name"
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                      autoFocus
                    />
                    <input
                      type="text"
                      value={newDose}
                      onChange={e => setNewDose(e.target.value)}
                      placeholder="Dose (e.g. 3×10 each)"
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => setAddingCategory(null)}
                        className="flex-1 py-1.5 border border-slate-300 rounded text-xs text-slate-700 hover:bg-slate-100">
                        Cancel
                      </button>
                      <button
                        onClick={() => handleAdd(category)}
                        disabled={!newName.trim()}
                        className="flex-1 py-1.5 bg-purple-600 text-white rounded text-xs font-medium hover:bg-purple-700 disabled:bg-slate-300">
                        Add
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Pain tracking section for the Health tab — full layout, always shows chart.
function PainSection({ painLog, onOpenPainModal }) {
  const today = todayISO();
  const todayEntry = getEntryForDate(painLog, today);
  const hasTodayEntry = todayEntry !== null && (todayEntry.morningPain !== undefined || todayEntry.deskPain !== undefined);
  const stats = computeStats(painLog, today);
  const daysLogged = stats.daysLogged || 0;

  const trendIcon = stats.trend === 'improving' ? TrendingDown
    : stats.trend === 'worsening' ? TrendingUp
    : Minus;
  const trendColor = stats.trend === 'improving' ? 'text-emerald-600'
    : stats.trend === 'worsening' ? 'text-amber-600'
    : 'text-slate-500';
  const trendLabel = stats.trend === 'improving' ? 'Improving'
    : stats.trend === 'worsening' ? 'Worsening'
    : stats.trend === 'flat' ? 'Stable'
    : 'Early data';
  const TrendIcon = trendIcon;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Knee pain</h3>
        {hasTodayEntry && (
          <button
            onClick={() => onOpenPainModal('daily')}
            className="text-[11px] text-slate-600 hover:text-slate-900 underline underline-offset-2">
            Edit
          </button>
        )}
      </div>

      {!hasTodayEntry ? (
        <div className="bg-gradient-to-br from-rose-50 to-pink-50 border border-rose-200 rounded-lg p-4 mb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Heart className="h-5 w-5 text-rose-600 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">How's the knee today?</p>
                <p className="text-[11px] text-slate-600">A quick check-in helps track trends over time.</p>
              </div>
            </div>
            <button
              onClick={() => onOpenPainModal('daily')}
              className="px-4 py-2 bg-rose-600 text-white text-sm font-medium rounded-md hover:bg-rose-700 flex-shrink-0">
              Log now
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg p-3 mb-3">
          <div className="flex items-center gap-4 flex-wrap">
            <div>
              <span className="text-[10px] text-slate-500 uppercase tracking-wide">Today</span>
              <div className="flex items-center gap-2 mt-0.5">
                {todayEntry.morningPain !== undefined && (
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-semibold text-slate-900">{todayEntry.morningPain}</span>
                    <span className="text-[10px] text-slate-500">AM</span>
                  </div>
                )}
                {todayEntry.deskPain !== undefined && (
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-semibold text-slate-900">{todayEntry.deskPain}</span>
                    <span className="text-[10px] text-slate-500">desk</span>
                  </div>
                )}
                {todayEntry.postRunPain !== undefined && (
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-semibold text-slate-900">{todayEntry.postRunPain}</span>
                    <span className="text-[10px] text-slate-500">run</span>
                  </div>
                )}
              </div>
            </div>
            {stats.trend && (
              <div className={`flex items-center gap-1 ${trendColor}`}>
                <TrendIcon className="h-4 w-4" />
                <span className="text-xs font-medium">{trendLabel}</span>
              </div>
            )}
            {stats.painFreeStreak >= 3 && (
              <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 rounded px-2 py-0.5">
                {stats.painFreeStreak}d under 2/10
              </span>
            )}
          </div>
          {todayEntry.note && (
            <p className="text-[11px] text-slate-600 italic mt-2 pl-0.5">"{todayEntry.note}"</p>
          )}
        </div>
      )}

      {daysLogged >= 2 && (
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[10px] font-semibold text-slate-600 uppercase tracking-wide">Last 30 days</h4>
            {daysLogged >= 3 && (
              <button
                onClick={() => {
                  const csv = painLogToCSV(painLog);
                  const blob = new Blob([csv], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `knee-pain-log-${today}.csv`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
                className="text-[10px] text-slate-500 hover:text-slate-900 underline underline-offset-2">
                Export CSV
              </button>
            )}
          </div>
          <PainChart painLog={painLog} />
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <Stat label="Avg AM (7d)" value={stats.avgMorning7 !== null ? stats.avgMorning7 : '—'} />
            <Stat label="Avg desk (7d)" value={stats.avgDesk7 !== null ? stats.avgDesk7 : '—'} />
            <Stat label="Days logged" value={`${daysLogged}/14`} />
          </div>
        </div>
      )}

      {daysLogged < 2 && hasTodayEntry && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-center">
          <p className="text-[11px] text-slate-500">Log for a few days to see your trend chart here.</p>
        </div>
      )}
    </div>
  );
}

// Rehab checklist section: list of exercises with daily checkboxes + consistency grid
function RehabSection({ config, rehabLog, onToggleRehab, onUpdateConfig }) {
  const today = todayISO();
  const [editing, setEditing] = useState(false);
  const [editingId, setEditingId] = useState(null);  // exercise id being edited
  const [addingCategory, setAddingCategory] = useState(null);  // category to add to, or null
  const [newName, setNewName] = useState('');
  const [newDose, setNewDose] = useState('');
  const [newCategory, setNewCategory] = useState(STRENGTH_CATEGORIES[0]);

  const exercises = config.exercises || [];
  const grid = getRehabGridData(rehabLog, 14, today);

  // Group exercises by category
  const byCategory = {};
  STRENGTH_CATEGORIES.forEach(c => { byCategory[c] = []; });
  exercises.forEach(ex => {
    const cat = ex.category && STRENGTH_CATEGORIES.includes(ex.category) ? ex.category : 'Mobility';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(ex);
  });

  const handleAdd = (category) => {
    const name = newName.trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
    onUpdateConfig(prev => ({
      ...prev,
      exercises: [
        ...(prev.exercises || []),
        { id, name, dose: newDose.trim() || undefined, category: category || newCategory },
      ],
    }));
    setNewName('');
    setNewDose('');
    setAddingCategory(null);
  };

  const handleSaveEdit = (id, updated) => {
    onUpdateConfig(prev => ({
      ...prev,
      exercises: (prev.exercises || []).map(e => e.id === id ? { ...e, ...updated } : e),
    }));
    setEditingId(null);
  };

  const handleRemove = (id) => {
    if (!confirm('Remove this exercise? (Past completion records are kept.)')) return;
    onUpdateConfig(prev => ({
      ...prev,
      exercises: (prev.exercises || []).filter(e => e.id !== id),
    }));
    setEditingId(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Today's exercises</h3>
        <button
          onClick={() => { setEditing(!editing); setEditingId(null); setAddingCategory(null); }}
          className="text-[11px] text-slate-600 hover:text-slate-900 underline underline-offset-2">
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      <div className="space-y-3">
        {STRENGTH_CATEGORIES.map(category => {
          const items = byCategory[category] || [];
          if (items.length === 0 && !editing) return null;
          return (
            <div key={category} className="bg-white border border-slate-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[11px] font-semibold text-slate-800 uppercase tracking-wide">{category}</h4>
                {editing && (
                  <button
                    onClick={() => { setAddingCategory(category); setNewName(''); setNewDose(''); }}
                    className="text-[10px] text-purple-600 hover:text-purple-700 font-medium inline-flex items-center gap-1">
                    <Plus className="h-3 w-3" />
                    Add
                  </button>
                )}
              </div>

              {items.length === 0 && !editing && (
                <p className="text-[11px] text-slate-400 italic">No exercises</p>
              )}

              <div className="space-y-1.5">
                {items.map(ex => {
                  const isDone = wasExerciseDone(rehabLog, today, ex.id);
                  const isEditingThis = editingId === ex.id;

                  if (isEditingThis) {
                    return <ExerciseEditor key={ex.id}
                      exercise={ex}
                      onSave={(updates) => handleSaveEdit(ex.id, updates)}
                      onRemove={() => handleRemove(ex.id)}
                      onCancel={() => setEditingId(null)}
                    />;
                  }

                  return (
                    <div key={ex.id} className="flex items-center gap-2">
                      <button
                        onClick={() => !editing && onToggleRehab(ex.id)}
                        disabled={editing}
                        className={`flex items-center gap-2 flex-1 text-left p-2 rounded-md border transition ${
                          isDone
                            ? 'bg-purple-50 border-purple-200 text-purple-900'
                            : 'bg-white border-slate-200 hover:border-slate-300'
                        } ${editing ? 'opacity-60 cursor-not-allowed' : ''}`}>
                        {isDone
                          ? <CheckCircle2 className="h-4 w-4 text-purple-600 flex-shrink-0" />
                          : <Circle className="h-4 w-4 text-slate-400 flex-shrink-0" />
                        }
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm font-medium truncate ${isDone ? 'line-through text-purple-900/70' : 'text-slate-900'}`}>
                            {ex.name}
                          </p>
                          {(ex.dose || ex.note) && (
                            <p className="text-[10px] text-slate-500 truncate">{ex.dose || ex.note}</p>
                          )}
                        </div>
                      </button>
                      {editing && (
                        <button
                          onClick={() => setEditingId(ex.id)}
                          className="p-2 text-slate-400 hover:text-slate-700 flex-shrink-0"
                          title="Edit">
                          <Settings className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}

                {addingCategory === category && (
                  <div className="bg-slate-50 border border-slate-200 rounded-md p-2 space-y-2">
                    <input
                      type="text"
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                      placeholder="Exercise name"
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                      autoFocus
                    />
                    <input
                      type="text"
                      value={newDose}
                      onChange={e => setNewDose(e.target.value)}
                      placeholder="Dose (e.g. 3×10 each) — optional"
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => setAddingCategory(null)}
                        className="flex-1 py-1.5 border border-slate-300 rounded text-xs text-slate-700 hover:bg-slate-100">
                        Cancel
                      </button>
                      <button
                        onClick={() => handleAdd(category)}
                        disabled={!newName.trim()}
                        className="flex-1 py-1.5 bg-purple-600 text-white rounded text-xs font-medium hover:bg-purple-700 disabled:bg-slate-300">
                        Add
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Consistency grid: last 14 days */}
      {exercises.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-3 mt-3">
          <h4 className="text-[10px] font-semibold text-slate-600 uppercase tracking-wide mb-2">Last 14 days</h4>
          <div className="flex gap-1">
            {grid.map((day) => {
              const pct = exercises.length > 0 ? day.count / exercises.length : 0;
              const bg = day.count === 0 ? 'bg-slate-100'
                : pct >= 0.7 ? 'bg-purple-600'
                : pct >= 0.3 ? 'bg-purple-400'
                : 'bg-purple-200';
              const [, dd] = day.date.slice(5).split('-');
              return (
                <div
                  key={day.date}
                  className="flex-1 flex flex-col items-center"
                  title={`${day.date}: ${day.count} exercises`}>
                  <div className={`w-full h-6 rounded ${bg}`} />
                  <span className="text-[8px] text-slate-400 mt-0.5">{Number(dd)}</span>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-slate-500 mt-2">
            Bar height shows how many exercises were checked off each day.
          </p>
        </div>
      )}
    </div>
  );
}

// Inline editor for an individual exercise (name, dose, category, remove)
function ExerciseEditor({ exercise, onSave, onRemove, onCancel }) {
  const [name, setName] = useState(exercise.name || '');
  const [dose, setDose] = useState(exercise.dose || exercise.note || '');
  const [category, setCategory] = useState(exercise.category || STRENGTH_CATEGORIES[0]);

  return (
    <div className="bg-slate-50 border border-slate-300 rounded-md p-2 space-y-2">
      <input
        type="text"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Exercise name"
        className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
      />
      <input
        type="text"
        value={dose}
        onChange={e => setDose(e.target.value)}
        placeholder="Dose (e.g. 3×10 each)"
        className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
      />
      <select
        value={category}
        onChange={e => setCategory(e.target.value)}
        className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm bg-white">
        {STRENGTH_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      <div className="flex gap-2">
        <button
          onClick={onRemove}
          className="px-2 py-1.5 border border-rose-300 rounded text-xs text-rose-600 hover:bg-rose-50 inline-flex items-center gap-1">
          <Trash2 className="h-3 w-3" />
          Remove
        </button>
        <button
          onClick={onCancel}
          className="flex-1 py-1.5 border border-slate-300 rounded text-xs text-slate-700 hover:bg-slate-100">
          Cancel
        </button>
        <button
          onClick={() => {
            if (!name.trim()) return;
            onSave({ name: name.trim(), dose: dose.trim() || undefined, category });
          }}
          disabled={!name.trim()}
          className="flex-1 py-1.5 bg-purple-600 text-white rounded text-xs font-medium hover:bg-purple-700 disabled:bg-slate-300">
          Save
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="bg-slate-50 rounded p-2">
      <div className="text-lg font-semibold text-slate-900">{value}</div>
      <div className="text-[9px] text-slate-500 uppercase tracking-wide">{label}</div>
    </div>
  );
}

// 30-day SVG line chart of pain metrics
function PainChart({ painLog }) {
  const today = todayISO();
  const days = getRecentEntries(painLog, 30, today);
  const W = 320, H = 120, PAD_L = 22, PAD_R = 8, PAD_T = 8, PAD_B = 18;
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
  const xAt = (i) => PAD_L + (i / (days.length - 1)) * innerW;
  const yAt = (v) => PAD_T + (1 - v / 10) * innerH;

  // Build paths for each metric, breaking where data is missing
  const buildPath = (field) => {
    const segments = [];
    let current = [];
    days.forEach((d, i) => {
      const v = d.entry?.[field];
      if (typeof v === 'number') {
        current.push(`${current.length === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`);
      } else {
        if (current.length > 0) segments.push(current.join(' '));
        current = [];
      }
    });
    if (current.length > 0) segments.push(current.join(' '));
    return segments.join(' ');
  };

  const morningPath = buildPath('morningPain');
  const deskPath = buildPath('deskPain');
  const runPath = buildPath('postRunPain');

  // Run-day markers
  const runDays = days.map((d, i) => ({ i, v: d.entry?.postRunPain }))
    .filter(d => typeof d.v === 'number');

  // Find first and last date labels
  const firstLabel = days[0]?.date ? days[0].date.slice(5).replace('-', '/') : '';
  const lastLabel = days[days.length - 1]?.date ? days[days.length - 1].date.slice(5).replace('-', '/') : '';

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Y-axis gridlines at 0, 2, 5, 8, 10 */}
        {[0, 2, 5, 8, 10].map(v => (
          <g key={v}>
            <line x1={PAD_L} y1={yAt(v)} x2={W - PAD_R} y2={yAt(v)}
              stroke="#e2e8f0" strokeWidth="1" strokeDasharray={v === 0 || v === 10 ? '0' : '2,2'} />
            <text x={PAD_L - 3} y={yAt(v) + 3} textAnchor="end"
              fontSize="8" fill="#94a3b8">{v}</text>
          </g>
        ))}

        {/* Data paths */}
        {morningPath && <path d={morningPath} fill="none" stroke="#0f766e" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />}
        {deskPath && <path d={deskPath} fill="none" stroke="#9333ea" strokeWidth="1.25" strokeDasharray="3,2" strokeLinecap="round" strokeLinejoin="round" />}

        {/* Morning pain data points */}
        {days.map((d, i) => {
          const v = d.entry?.morningPain;
          if (typeof v !== 'number') return null;
          return <circle key={`m${i}`} cx={xAt(i)} cy={yAt(v)} r="1.75" fill="#0f766e" />;
        })}

        {/* Post-run pain points (larger, filled with accent) */}
        {runDays.map(({ i, v }) => (
          <circle key={`r${i}`} cx={xAt(i)} cy={yAt(v)} r="3.25" fill="#dc2626" stroke="white" strokeWidth="1.5" />
        ))}

        {/* X-axis labels */}
        <text x={PAD_L} y={H - 4} fontSize="8" fill="#94a3b8">{firstLabel}</text>
        <text x={W - PAD_R} y={H - 4} fontSize="8" fill="#94a3b8" textAnchor="end">{lastLabel}</text>
      </svg>

      {/* Legend */}
      <div className="flex items-center justify-center gap-4 mt-1 text-[9px] text-slate-600">
        <div className="flex items-center gap-1">
          <div className="w-3 h-0.5 bg-teal-700" />
          <span>Morning</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-0.5 bg-purple-600" style={{ borderTop: '1px dashed #9333ea', height: 0 }} />
          <span>Desk</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-red-600" />
          <span>Post-run</span>
        </div>
      </div>
    </div>
  );
}

// Modal for entering pain ratings
function PainModal({ date, mode, painLog, onSave, onClose }) {
  // Track the date internally so arrows can navigate without closing the modal
  const [currentDate, setCurrentDate] = useState(date);
  const today = todayISO();

  // Re-derive initial values whenever the date changes
  const existingEntry = getEntryForDate(painLog, currentDate);
  const initial = existingEntry || {};
  const [morningPain, setMorningPain] = useState(initial.morningPain ?? null);
  const [deskPain, setDeskPain] = useState(initial.deskPain ?? null);
  const [postRunPain, setPostRunPain] = useState(initial.postRunPain ?? null);
  const [note, setNote] = useState(initial.note || '');

  // When the currentDate changes (via nav arrows), reload the fields from that day's entry
  useEffect(() => {
    const entry = getEntryForDate(painLog, currentDate) || {};
    setMorningPain(entry.morningPain ?? null);
    setDeskPain(entry.deskPain ?? null);
    setPostRunPain(entry.postRunPain ?? null);
    setNote(entry.note || '');
  }, [currentDate, painLog]);

  const buildUpdates = () => {
    const updates = {};
    if (morningPain !== null) updates.morningPain = morningPain;
    if (deskPain !== null) updates.deskPain = deskPain;
    if (postRunPain !== null) updates.postRunPain = postRunPain;
    if (note.trim()) updates.note = note.trim();
    return updates;
  };

  const hasAnyValue = morningPain !== null || deskPain !== null || postRunPain !== null || note.trim().length > 0;

  const handleSave = () => {
    onSave(currentDate, buildUpdates());
  };

  // Navigate to another day, auto-saving current entry if it has values
  const navigateToDate = (newDate) => {
    if (hasAnyValue) {
      // Save current day's entries before navigating
      onSave(currentDate, buildUpdates(), { keepOpen: true });
    }
    setCurrentDate(newDate);
  };

  const shiftDay = (delta) => {
    const [y, m, d] = currentDate.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + delta);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    navigateToDate(`${yyyy}-${mm}-${dd}`);
  };

  const [y, m, d] = currentDate.split('-').map(Number);
  const isToday_ = currentDate === today;
  const dateObj = new Date(y, m - 1, d);
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dateObj.getDay()];
  const displayDate = isToday_
    ? `Today · ${m}/${d}`
    : `${dayName} · ${m}/${d}/${y}`;

  // Disable forward arrow if we're already at today
  const canGoForward = !isToday_;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}>
      <div
        className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Heart className="h-4 w-4 text-rose-600" />
            <h3 className="text-base font-semibold text-slate-900">Knee pain</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Date navigation */}
        <div className="flex items-center justify-between mb-4 bg-slate-50 rounded-md p-1">
          <button
            onClick={() => shiftDay(-1)}
            className="p-1.5 rounded hover:bg-white text-slate-600 hover:text-slate-900"
            title="Previous day">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="text-sm font-medium text-slate-700">{displayDate}</div>
          <button
            onClick={() => shiftDay(1)}
            disabled={!canGoForward}
            className="p-1.5 rounded hover:bg-white text-slate-600 hover:text-slate-900 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Next day">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-slate-500 mb-4">Rate 0 (none) to 10 (worst imaginable)</p>

        <div className="space-y-4">
          <PainSlider
            label="Morning pain"
            sublabel="When you first stand up"
            value={morningPain}
            onChange={setMorningPain}
          />
          <PainSlider
            label="Desk pain"
            sublabel="After prolonged sitting, extending the leg"
            value={deskPain}
            onChange={setDeskPain}
          />
          <PainSlider
            label="Post-run pain"
            sublabel="Only if you ran today"
            value={postRunPain}
            onChange={setPostRunPain}
            optional
          />

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Note <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              type="text"
              value={note}
              onChange={e => setNote(e.target.value)}
              maxLength={140}
              placeholder="e.g. flared at mile 3, better after foam rolling"
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 border border-slate-300 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={morningPain === null && deskPain === null && postRunPain === null}
            className="flex-1 py-2.5 bg-rose-600 text-white rounded-md text-sm font-medium hover:bg-rose-700 disabled:bg-slate-300 disabled:cursor-not-allowed">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// 0-10 slider with value display and clear button
function PainSlider({ label, sublabel, value, onChange, optional }) {
  const isSet = value !== null;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <div>
          <label className="text-xs font-semibold text-slate-700">{label}</label>
          {sublabel && <p className="text-[10px] text-slate-500">{sublabel}</p>}
        </div>
        <div className="flex items-center gap-2">
          {isSet ? (
            <>
              <span className={`text-base font-bold ${value >= 6 ? 'text-rose-600' : value >= 3 ? 'text-amber-600' : 'text-emerald-600'}`}>
                {value}
              </span>
              <button
                onClick={() => onChange(null)}
                className="text-[10px] text-slate-400 hover:text-slate-700">
                Clear
              </button>
            </>
          ) : (
            <span className="text-[10px] text-slate-400">
              {optional ? 'Not set' : 'Tap scale below'}
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-11 gap-0.5">
        {Array.from({ length: 11 }).map((_, i) => {
          const selected = value === i;
          const color = i === 0 ? 'bg-emerald-500'
            : i <= 2 ? 'bg-emerald-400'
            : i <= 4 ? 'bg-yellow-400'
            : i <= 6 ? 'bg-amber-500'
            : i <= 8 ? 'bg-orange-500'
            : 'bg-rose-600';
          return (
            <button
              key={i}
              onClick={() => onChange(i)}
              className={`h-10 rounded text-xs font-medium transition ${
                selected ? `${color} text-white ring-2 ring-offset-1 ring-slate-900` : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}>
              {i}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Sum miles from unscheduled runs in a week. Cross-training is excluded.
function extraRunMiles(week) {
  let extra = 0;
  for (const day of week.days || []) {
    for (const s of day.sessions || []) {
      if (s.unscheduled && (s.type === 'easy' || s.type === 'subT' || s.type === 'long') && typeof s.miles === 'number') {
        extra += s.miles;
      }
    }
  }
  return extra;
}

function WeekView({ plan, currentWeekIdx, setCurrentWeekIdx, completions, logs, onToggleCompletion, onMoveSession, onSessionClick, onAddSessionRequest, goalMarathonTime, goalDistance, goalMP }) {
  // Move-mode state: { fromDay, sessionId } when a session has been selected for moving
  const [moveSelection, setMoveSelection] = useState(null);
  const week = plan[currentWeekIdx];
  if (!week) return null;

  const isMoveMode = moveSelection !== null;

  const handleSelectForMove = (fromDay, sessionId) => {
    if (moveSelection && moveSelection.sessionId === sessionId) {
      // Tapping the selected card again cancels move mode
      setMoveSelection(null);
    } else {
      setMoveSelection({ fromDay, sessionId });
    }
  };

  const handleDayTap = (toDay) => {
    if (!moveSelection) return;
    if (moveSelection.fromDay !== toDay) {
      onMoveSession(week.weekIndex, moveSelection.fromDay, toDay, moveSelection.sessionId);
    }
    setMoveSelection(null);
  };

  const cancelMove = () => setMoveSelection(null);

  let totalCount = 0, doneCount = 0;
  week.days.forEach((d, i) => {
    d.sessions.forEach(s => {
      totalCount++;
      if (completions[`${week.weekIndex}-${i}-${s.id}`]) doneCount++;
    });
  });

  // Format goal time as "h:mm"
  const fmtHM = (sec) => {
    if (!sec) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}`;
  };

  return (
    <div>
      {/* Goal card */}
      {goalMarathonTime && (
        <div className="mb-3 bg-gradient-to-br from-slate-900 to-slate-700 text-white rounded-lg p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-300">Projected goal</p>
              <p className="text-xl font-bold">{fmtHM(goalMarathonTime)} <span className="text-sm font-medium text-slate-300">marathon</span></p>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wide text-slate-300">Distance · MP</p>
              <p className="text-sm font-medium">{goalDistance} · {goalMP}/mi</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-3 bg-white rounded-lg border border-slate-200 p-3">
        <button onClick={() => setCurrentWeekIdx(Math.max(0, currentWeekIdx - 1))}
          disabled={currentWeekIdx === 0}
          className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-30">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="text-center">
          <div className="flex items-center gap-2 justify-center">
            <h2 className="text-base font-semibold">{week.label}</h2>
            {week.isStepback && (
              <span className="text-[10px] font-bold text-amber-700 bg-amber-100 rounded px-1.5 py-0.5 uppercase">Step-back</span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {week.phase} · {(() => {
              const extra = extraRunMiles(week);
              if (extra > 0) {
                return `${(week.totalMiles + extra).toFixed(extra % 1 === 0 ? 0 : 1)} mi (${week.totalMiles} planned + ${extra.toFixed(extra % 1 === 0 ? 0 : 1)} extra)`;
              }
              return `${week.totalMiles} mi`;
            })()} · {doneCount}/{totalCount} done
          </p>
        </div>
        <button onClick={() => setCurrentWeekIdx(Math.min(plan.length - 1, currentWeekIdx + 1))}
          disabled={currentWeekIdx === plan.length - 1}
          className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-30">
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      {/* Move-mode banner */}
      {isMoveMode && (
        <div className="mb-3 bg-slate-900 text-white rounded-lg p-3 flex items-center justify-between gap-3 sticky top-14 z-10 shadow-lg">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <GripVertical className="h-4 w-4 flex-shrink-0" />
            <p className="text-sm font-medium truncate">Tap a day to move this session there</p>
          </div>
          <button onClick={cancelMove}
            className="text-xs px-3 py-1 bg-white/10 hover:bg-white/20 rounded-md font-medium flex-shrink-0">
            Cancel
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-7 gap-2">
        {week.days.map((day, idx) => {
          const today = day.date && isToday(day.date);
          // Parse YYYY-MM-DD as LOCAL date (not UTC) to avoid the off-by-one
          // bug where "2026-04-20" would parse as UTC midnight and render as
          // April 19 in Eastern Time.
          let dateDisplay = '';
          if (day.date) {
            const [y, m, d] = day.date.split('-').map(Number);
            dateDisplay = `${m}/${d}`;
          }
          const isMoveTarget = isMoveMode && moveSelection.fromDay !== idx;
          const isSourceDay = isMoveMode && moveSelection.fromDay === idx;

          return (
            <div key={idx}
              onClick={() => isMoveTarget && handleDayTap(idx)}
              className={`rounded-lg border-2 bg-white p-2 min-h-[90px] transition ${
                today ? 'border-slate-900 shadow-sm' : 'border-slate-100'
              } ${isMoveTarget ? 'border-emerald-400 bg-emerald-50 cursor-pointer hover:bg-emerald-100 hover:border-emerald-500' : ''} ${
                isSourceDay ? 'border-slate-400 bg-slate-50' : ''
              }`}
            >
              <div className="flex items-baseline justify-between mb-1.5">
                <div>
                  <p className={`text-xs font-semibold ${today ? 'text-slate-900' : 'text-slate-500'} uppercase`}>
                    {DAYS[idx]}
                  </p>
                  {dateDisplay && <p className="text-[10px] text-slate-400">{dateDisplay}</p>}
                </div>
                {today && <span className="text-[9px] font-bold text-white bg-slate-900 rounded px-1.5 py-0.5">TODAY</span>}
                {isMoveTarget && <span className="text-[9px] font-bold text-emerald-700 bg-emerald-100 rounded px-1.5 py-0.5">↓ MOVE HERE</span>}
              </div>
              <div className="space-y-1">
                {(() => {
                  const hasRun = day.sessions.some(s => ['easy', 'subT', 'long'].includes(s.type));
                  if (!hasRun && day.sessions.every(s => s.type === 'activation')) {
                    return (
                      <>
                        <p className="text-[9px] text-slate-400 italic mb-1">Rest day</p>
                        {day.sessions.map(session => {
                          const key = `${week.weekIndex}-${idx}-${session.id}`;
                          return (
                            <SessionCard key={session.id} session={session}
                              completed={!!completions[key]} onToggle={() => onToggleCompletion(key)}
                              hasLog={!!logs[key]}
                              isMoveMode={isMoveMode}
                              isSelected={false}
                              onClick={() => !isMoveMode && onSessionClick({ session, date: day.date, weekIdx: week.weekIndex, dayIdx: idx, sessionKey: key, onMoveStart: null })} />
                          );
                        })}
                      </>
                    );
                  }
                  return day.sessions.map(session => {
                    const key = `${week.weekIndex}-${idx}-${session.id}`;
                    const isSelected = moveSelection && moveSelection.sessionId === session.id;
                    // Movable: runs and strength. Not movable: activation (daily habit) and warmup (tied to its run)
                    const isMovable = ['easy', 'subT', 'long', 'strength'].includes(session.type);
                    return (
                      <SessionCard key={session.id} session={session}
                        completed={!!completions[key]} onToggle={() => onToggleCompletion(key)}
                        hasLog={!!logs[key]}
                        isMoveMode={isMoveMode}
                        isSelected={isSelected}
                        onClick={() => onSessionClick({
                          session,
                          date: day.date,
                          weekIdx: week.weekIndex,
                          dayIdx: idx,
                          sessionKey: key,
                          onMoveStart: isMovable ? () => handleSelectForMove(idx, session.id) : null,
                        })} />
                    );
                  });
                })()}
              </div>
              {/* Make empty days a clear drop target when moving */}
              {isMoveTarget && day.sessions.length === 0 && (
                <p className="text-xs text-emerald-700 italic text-center py-2">Drop here</p>
              )}
              {/* Add unscheduled session button (hidden in move mode) */}
              {!isMoveMode && onAddSessionRequest && (
                <button
                  onClick={() => onAddSessionRequest(idx)}
                  className="mt-1.5 w-full text-[10px] text-slate-400 hover:text-slate-700 hover:bg-slate-50 rounded py-1 px-2 border border-dashed border-slate-200 hover:border-slate-300 flex items-center justify-center gap-1 transition"
                  title="Log an unscheduled session">
                  <Plus className="h-3 w-3" />
                  <span>Add session</span>
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 text-xs text-slate-500 bg-slate-100 rounded-lg p-3">
        <p className="font-semibold mb-1">How to use:</p>
        <ul className="space-y-0.5 list-disc list-inside text-slate-600">
          <li>Tap the <Circle className="h-3 w-3 inline" /> circle to mark a session done</li>
          <li>Tap a session card for details, target paces, and watch export</li>
          <li>To move a run to a different day: tap it, then tap "Move to another day"</li>
        </ul>
      </div>
    </div>
  );
}

function ArcView({ plan, completions, logs, paces, onJumpToWeek }) {
  // Format seconds as "h:mm" for compact display
  const fmtHM = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}`;
  };

  return (
    <div className="space-y-2">
      {plan.map((week, idx) => {
        // Target time: derived from total miles at user's easy pace (midpoint)
        const avgEasyPaceSec = paces ? (paces.easy.low + paces.easy.high) / 2 : 9 * 60;
        const targetSec = week.totalMiles * avgEasyPaceSec;

        // Actual time completed: sum of logged times for sessions checked off in this week
        let actualSec = 0;
        let sessionTotal = 0, sessionDone = 0;
        week.days.forEach((d, i) => {
          d.sessions.forEach(s => {
            if (!['easy', 'subT', 'long'].includes(s.type)) return;  // skip non-run sessions
            sessionTotal++;
            const key = `${week.weekIndex}-${i}-${s.id}`;
            const isDone = completions[key];
            const log = logs ? logs[key] : null;
            if (isDone) {
              sessionDone++;
              if (log?.timeSec) {
                actualSec += log.timeSec;
              } else if (s.miles) {
                // No log, assume planned time from session miles
                actualSec += s.miles * avgEasyPaceSec;
              }
            }
          });
        });

        const pct = targetSec > 0 ? Math.min(100, (actualSec / targetSec) * 100) : 0;

        return (
          <button key={idx} onClick={() => onJumpToWeek(idx)}
            className="w-full text-left bg-white rounded-lg border border-slate-200 p-3 hover:border-slate-400 transition">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold">
                  {idx + 1}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-sm truncate">{week.phase}</p>
                    {week.isStepback && <span className="text-[9px] font-bold text-amber-700 bg-amber-100 rounded px-1 py-0.5">STEP-BACK</span>}
                  </div>
                  <p className="text-xs text-slate-500">
                    {fmtHM(actualSec)} of {fmtHM(targetSec)} · {week.subTcount} sub-T
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <div className="w-20 bg-slate-100 rounded-full h-1.5 overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-xs text-slate-500 tabular-nums w-10 text-right">{sessionDone}/{sessionTotal}</p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function buildSummaryText(session) {
  const lines = [session.title || session.label || 'Session'];
  if (session.pace) lines.push(`Target pace: ${session.pace}`);
  if (session.hr) lines.push(`Target HR: ${session.hr}`);
  if (session.detail) {
    lines.push('');
    lines.push(session.detail);
  }
  return lines.join('\n');
}

// Parse "mm:ss" or "h:mm:ss" or just minutes as decimal into seconds
function parseTimeInput(str) {
  if (!str) return null;
  const trimmed = String(str).trim();
  if (!trimmed) return null;
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map(p => parseInt(p, 10));
    if (parts.some(p => isNaN(p))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }
  const num = parseFloat(trimmed);
  if (isNaN(num)) return null;
  return Math.round(num * 60); // assume decimal minutes
}

// Calculate pace in seconds per mile from total seconds and miles
function calcPaceSecPerMile(totalSec, miles) {
  if (!totalSec || !miles || miles <= 0) return null;
  return totalSec / miles;
}

// Compute deterministic feedback for a logged run vs its plan
function computeFeedback(session, log, paces, hr) {
  if (!log || !log.distMi || !log.timeSec) return [];
  const messages = [];
  const actualPace = calcPaceSecPerMile(log.timeSec, log.distMi);

  if (session.type === 'easy' || session.type === 'long') {
    // Check easy-day HR
    if (log.avgHR && hr.easyMax) {
      const drift = log.avgHR - hr.easyMax;
      if (drift > 8) {
        messages.push({
          tone: 'warning',
          text: `HR was ${drift} bpm above easy ceiling (${hr.easyMax}). This was a moderate effort, not easy. Slow down next time — the recovery isn't there.`,
        });
      } else if (drift > 3) {
        messages.push({
          tone: 'caution',
          text: `HR was ${drift} bpm above target (${hr.easyMax}). Slightly too fast — try dropping pace 10–15 sec/mi.`,
        });
      } else if (log.avgHR <= hr.easyMax) {
        messages.push({
          tone: 'good',
          text: `HR stayed in the easy zone (avg ${log.avgHR}, target <${hr.easyMax}). This is exactly right.`,
        });
      }
    }
    // Distance vs plan
    if (session.miles && log.distMi) {
      const diff = log.distMi - session.miles;
      if (Math.abs(diff) > 1) {
        messages.push({
          tone: 'info',
          text: `Distance was ${diff > 0 ? '+' : ''}${diff.toFixed(1)} mi vs plan (${session.miles} mi).`,
        });
      }
    }
  }

  if (session.type === 'subT') {
    // Check sub-T HR window
    if (log.avgHR && hr.subTHigh) {
      if (log.avgHR > hr.subTHigh + 3) {
        messages.push({
          tone: 'warning',
          text: `HR was ${log.avgHR - hr.subTHigh} bpm above sub-T ceiling (${hr.subTHigh}). Too hard — repeatability matters more than intensity. Drop pace 10–15 sec/mi next time.`,
        });
      } else if (log.avgHR < hr.subTLow - 5) {
        messages.push({
          tone: 'caution',
          text: `HR was below sub-T zone (avg ${log.avgHR}, target ${hr.subTLow}+). Was the effort firm enough? Sub-T should feel "comfortably hard".`,
        });
      } else {
        messages.push({
          tone: 'good',
          text: `HR landed in the sub-T zone (avg ${log.avgHR}). Well-executed.`,
        });
      }
    }
    // Pace vs target
    if (actualPace && paces.subT.high) {
      if (actualPace < paces.subT.low - 10) {
        messages.push({
          tone: 'warning',
          text: `Pace was faster than sub-T target. Easy to do, hard to recover from. Hold yourself back next session.`,
        });
      }
    }
  }

  // Notes always shown verbatim if present (no feedback computed)
  return messages;
}

function SessionModal({ session, onMoveStart, sessionKey, log, onSaveLog, paces, hr, onClose }) {
  const canExportTCX = session.type === 'subT' && session.structured;
  const canExportRun = ['easy', 'subT', 'long'].includes(session.type);
  const canMove = !!onMoveStart;
  const canLog = canExportRun; // only runs are loggable
  const [copied, setCopied] = useState(false);
  const [showLogForm, setShowLogForm] = useState(false);

  // Form state
  const [distInput, setDistInput] = useState(log?.distMi ?? '');
  const [timeInput, setTimeInput] = useState(log?.timeSec ? secondsToMMSS(log.timeSec) : '');
  const [hrInput, setHrInput] = useState(log?.avgHR ?? '');
  const [notesInput, setNotesInput] = useState(log?.notes ?? '');

  const handleTCX = () => {
    const ok = downloadTCX(session, paces.easy);
    if (!ok) alert('Could not generate workout file for this session.');
  };

  const handleMove = () => {
    onMoveStart();
    onClose();
  };

  const handleCopy = async () => {
    const text = buildSummaryText(session);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      alert('Could not copy to clipboard: ' + err.message);
    }
  };

  const handleSaveLog = () => {
    const dist = parseFloat(distInput);
    const timeSec = parseTimeInput(timeInput);
    const avgHR = hrInput ? parseInt(hrInput, 10) : null;
    if (!dist || !timeSec) {
      alert('Please enter at least distance and time.');
      return;
    }
    onSaveLog({
      distMi: dist,
      timeSec,
      avgHR: avgHR && !isNaN(avgHR) ? avgHR : null,
      notes: notesInput?.trim() || '',
      loggedAt: new Date().toISOString(),
    });
    setShowLogForm(false);
  };

  const handleDeleteLog = () => {
    if (!confirm('Delete this run log?')) return;
    onSaveLog(null);
    setDistInput('');
    setTimeInput('');
    setHrInput('');
    setNotesInput('');
    setShowLogForm(false);
  };

  const feedback = log ? computeFeedback(session, log, paces, hr) : [];
  const actualPaceSec = log ? calcPaceSecPerMile(log.timeSec, log.distMi) : null;

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <div className="flex items-start justify-between gap-3 mb-3">
            <h3 className="font-semibold text-lg">{session.title || session.label || 'Session'}</h3>
            <button onClick={onClose} className="text-slate-400 text-2xl leading-none">×</button>
          </div>

          {session.pace && (
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="bg-slate-50 rounded-md p-2">
                <p className="text-[10px] text-slate-500 uppercase font-semibold">Target pace</p>
                <p className="text-sm font-medium">{session.pace}</p>
              </div>
              <div className="bg-slate-50 rounded-md p-2">
                <p className="text-[10px] text-slate-500 uppercase font-semibold">Target HR</p>
                <p className="text-sm font-medium">{session.hr}</p>
              </div>
            </div>
          )}

          <p className="text-sm text-slate-700 mb-4 leading-relaxed">{session.detail}</p>

          {/* Logged run summary */}
          {log && !showLogForm && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 mb-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-bold text-emerald-900 uppercase tracking-wider">Logged</p>
                <button onClick={() => setShowLogForm(true)} className="text-xs text-emerald-700 underline">Edit</button>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs mb-2">
                <div>
                  <p className="text-emerald-700 text-[10px] uppercase">Distance</p>
                  <p className="font-semibold text-slate-900">{log.distMi.toFixed(2)} mi</p>
                </div>
                <div>
                  <p className="text-emerald-700 text-[10px] uppercase">Time</p>
                  <p className="font-semibold text-slate-900">{secondsToMMSS(log.timeSec)}</p>
                </div>
                <div>
                  <p className="text-emerald-700 text-[10px] uppercase">Pace</p>
                  <p className="font-semibold text-slate-900">{actualPaceSec ? paceFromSeconds(actualPaceSec) : '—'}/mi</p>
                </div>
              </div>
              {log.avgHR && (
                <div className="text-xs mb-2">
                  <p className="text-emerald-700 text-[10px] uppercase">Avg HR</p>
                  <p className="font-semibold text-slate-900">{log.avgHR} bpm</p>
                </div>
              )}
              {log.notes && (
                <div className="text-xs mt-2 pt-2 border-t border-emerald-200">
                  <p className="text-emerald-700 text-[10px] uppercase mb-1">Notes</p>
                  <p className="text-slate-700 italic">"{log.notes}"</p>
                </div>
              )}
            </div>
          )}

          {/* Feedback messages */}
          {log && !showLogForm && feedback.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {feedback.map((f, i) => {
                const styles = {
                  good: 'bg-emerald-50 border-emerald-200 text-emerald-900',
                  warning: 'bg-rose-50 border-rose-200 text-rose-900',
                  caution: 'bg-amber-50 border-amber-200 text-amber-900',
                  info: 'bg-slate-50 border-slate-200 text-slate-700',
                };
                return (
                  <div key={i} className={`rounded-md border p-2.5 text-xs leading-snug ${styles[f.tone]}`}>
                    {f.text}
                  </div>
                );
              })}
            </div>
          )}

          {/* Log form */}
          {showLogForm && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-3 space-y-3">
              <p className="text-xs font-bold text-slate-700 uppercase tracking-wider">Log this run</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-slate-500 uppercase font-semibold mb-1">Distance (mi)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={distInput}
                    onChange={(e) => setDistInput(e.target.value)}
                    placeholder={session.miles?.toFixed(1) ?? ''}
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 uppercase font-semibold mb-1">Time (mm:ss)</label>
                  <input
                    type="text"
                    value={timeInput}
                    onChange={(e) => setTimeInput(e.target.value)}
                    placeholder="42:30"
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[10px] text-slate-500 uppercase font-semibold mb-1">Avg HR (optional)</label>
                <input
                  type="number"
                  value={hrInput}
                  onChange={(e) => setHrInput(e.target.value)}
                  placeholder="138"
                  className="w-32 px-2 py-1.5 border border-slate-200 rounded text-sm"
                />
              </div>
              <div>
                <label className="block text-[10px] text-slate-500 uppercase font-semibold mb-1">Notes (optional)</label>
                <textarea
                  value={notesInput}
                  onChange={(e) => setNotesInput(e.target.value)}
                  placeholder="Felt good, no ITB pain..."
                  rows={2}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm resize-none"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={handleSaveLog}
                  className="flex-1 px-3 py-2 bg-slate-900 text-white rounded-md text-sm font-medium hover:bg-slate-800">
                  Save log
                </button>
                <button onClick={() => setShowLogForm(false)}
                  className="px-3 py-2 bg-white text-slate-700 border border-slate-200 rounded-md text-sm font-medium hover:bg-slate-50">
                  Cancel
                </button>
                {log && (
                  <button onClick={handleDeleteLog}
                    className="px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded-md text-sm font-medium hover:bg-red-100">
                    Delete
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Action buttons */}
          {canLog && !log && !showLogForm && (
            <button onClick={() => setShowLogForm(true)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-sm font-medium transition mb-2">
              <CheckCircle2 className="h-4 w-4" />
              Log this run
            </button>
          )}

          {canMove && !showLogForm && (
            <button onClick={handleMove}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-900 rounded-md text-sm font-medium transition mb-2">
              <GripVertical className="h-4 w-4" />
              Move to another day
            </button>
          )}

          {canExportRun && !showLogForm && (
            <button onClick={handleCopy}
              className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-md text-sm font-medium transition mb-2 ${
                copied ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-100 hover:bg-slate-200 text-slate-900'
              }`}>
              {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied!' : 'Copy summary to clipboard'}
            </button>
          )}

          {canExportTCX && !showLogForm && (
            <button onClick={handleTCX}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-900 text-white rounded-md text-sm font-medium hover:bg-slate-800 transition">
              <Watch className="h-4 w-4" />
              Transfer to watch (.tcx)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function secondsToMMSS(totalSec) {
  if (!totalSec || isNaN(totalSec)) return '';
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ZonesLegend({ paces, hr }) {
  return (
    <div className="bg-slate-50 rounded-lg p-3">
      <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">Your zones</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <div className="bg-white rounded p-2 border border-emerald-200">
          <p className="font-semibold text-emerald-900">Easy</p>
          <p className="text-slate-600 mt-0.5">{paceFromSeconds(paces.easy.low)}–{paceFromSeconds(paces.easy.high)}/mi</p>
          <p className="text-slate-500">HR &lt; {hr.easyMax}</p>
        </div>
        <div className="bg-white rounded p-2 border border-rose-200">
          <p className="font-semibold text-rose-900">Sub-T</p>
          <p className="text-slate-600 mt-0.5">{paceFromSeconds(paces.subT.low)}–{paceFromSeconds(paces.subT.high)}/mi</p>
          <p className="text-slate-500">HR {hr.subTLow}–{hr.subTHigh}</p>
        </div>
        <div className="bg-white rounded p-2 border border-slate-200">
          <p className="font-semibold text-slate-900">Threshold</p>
          <p className="text-slate-600 mt-0.5">~{paceFromSeconds(paces.threshold)}/mi</p>
          <p className="text-slate-500">HR ~{hr.lt2}</p>
        </div>
        <div className="bg-white rounded p-2 border border-amber-200 flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
          <p className="text-slate-600 leading-snug">If sub-T HR drifts over {hr.subTHigh}, slow down.</p>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Weather view
// ============================================================

function todayDateInput() {
  return formatLocalISO(new Date());
}

function maxForecastDate() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return formatLocalISO(d);
}

function WeatherView({ location, onLocationChange, biases, onFeedback, onResetBiases }) {
  const [zipInput, setZipInput] = useState(location?.zip || '');
  const [date, setDate] = useState(todayDateInput());
  const [hour, setHour] = useState(7); // 0-23
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Auto-load forecast whenever location/date/hour changes
  useEffect(() => {
    const run = async () => {
      if (!location) return;
      setLoading(true);
      setError(null);
      try {
        const hours = await fetchForecast(location.lat, location.lon, date);
        const picked = pickHour(hours, hour);
        setForecast(picked);
      } catch (e) {
        setError(e.message);
        setForecast(null);
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [location, date, hour]);

  const handleSetZip = async () => {
    setError(null);
    try {
      const loc = await geocodeZip(zipInput);
      onLocationChange(loc);
    } catch (e) {
      setError(e.message);
    }
  };

  const outfit = forecast ? recommendOutfit(forecast, { biases }) : null;

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Cloud className="h-5 w-5 text-blue-500" />
        Weather & outfit
      </h2>

      {/* Location section */}
      <div className="bg-white rounded-lg border border-slate-200 p-3">
        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
          <MapPin className="h-3 w-3 inline mr-1" />
          ZIP code
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={zipInput}
            onChange={(e) => setZipInput(e.target.value.replace(/\D/g, '').slice(0, 5))}
            placeholder="10001"
            className="flex-1 px-3 py-2 border border-slate-200 rounded-md text-sm"
          />
          <button onClick={handleSetZip}
            className="px-4 py-2 bg-slate-900 text-white rounded-md text-sm font-medium hover:bg-slate-800">
            Set
          </button>
        </div>
        {location && (
          <p className="text-xs text-slate-500 mt-2">
            Showing forecast for <span className="font-medium text-slate-700">{location.city}, {location.state} {location.zip}</span>
          </p>
        )}
      </div>

      {/* Date and time picker */}
      {location && (
        <div className="bg-white rounded-lg border border-slate-200 p-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
                Date
              </label>
              <input
                type="date"
                value={date}
                min={todayDateInput()}
                max={maxForecastDate()}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
                Time of run
              </label>
              <select value={hour} onChange={(e) => setHour(parseInt(e.target.value, 10))}
                className="w-full px-2 py-1.5 border border-slate-200 rounded-md text-sm bg-white">
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Loading / error */}
      {loading && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 text-center text-sm text-slate-500">
          Loading forecast...
        </div>
      )}
      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm text-rose-900 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Forecast + outfit */}
      {forecast && outfit && !loading && (
        <>
          <ForecastCard forecast={forecast} />
          <OutfitCard outfit={outfit} forecast={forecast} onFeedback={onFeedback} />
        </>
      )}

      {/* Biases display */}
      {(biases.cold || biases.cool || biases.warm || biases.hot) ? (
        <div className="bg-white rounded-lg border border-slate-200 p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Your warmth biases</p>
            <button onClick={onResetBiases} className="text-xs text-slate-500 underline hover:text-slate-700">
              Reset all
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            {['cold', 'cool', 'warm', 'hot'].map(band => (
              <BiasChip key={band} band={band} value={biases[band] || 0} />
            ))}
          </div>
          <p className="text-[10px] text-slate-400 mt-2 leading-snug">
            Negative = dressed warmer (you run cold). Positive = dressed cooler (you run hot). Adjusts based on your feedback.
          </p>
        </div>
      ) : null}

      {!location && !loading && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900">
          Enter a 5-digit US ZIP code to see weather and outfit recommendations.
        </div>
      )}
    </div>
  );
}

function BiasChip({ band, value }) {
  const labels = { cold: '<40°F', cool: '40–60°F', warm: '60–75°F', hot: '>75°F' };
  const isCold = value < 0;
  const isHot = value > 0;
  return (
    <div className={`rounded-md p-2 border ${
      isCold ? 'bg-blue-50 border-blue-200' :
      isHot ? 'bg-orange-50 border-orange-200' :
      'bg-slate-50 border-slate-200'
    }`}>
      <p className="text-[9px] uppercase font-semibold text-slate-500">{band}</p>
      <p className="text-[10px] text-slate-500">{labels[band]}</p>
      <p className={`text-sm font-bold tabular-nums ${
        isCold ? 'text-blue-900' : isHot ? 'text-orange-900' : 'text-slate-400'
      }`}>
        {value > 0 ? '+' : ''}{value}°F
      </p>
    </div>
  );
}

function ForecastCard({ forecast }) {
  const w = describeWeather(forecast.weatherCode);
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-3xl font-bold tabular-nums">{Math.round(forecast.tempF)}°F</p>
          <p className="text-sm text-slate-500">Feels like {Math.round(forecast.feelsLikeF)}°F</p>
        </div>
        <div className="text-right">
          <p className="text-3xl">{w.icon}</p>
          <p className="text-xs text-slate-500">{w.desc}</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs pt-3 border-t border-slate-100">
        <div className="flex items-center gap-1.5 text-slate-600">
          <Wind className="h-3.5 w-3.5 text-slate-400" />
          <span>{Math.round(forecast.windMph)} mph {compassFromDeg(forecast.windDeg)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-slate-600">
          <Droplets className="h-3.5 w-3.5 text-slate-400" />
          <span>{Math.round(forecast.precipPct)}% rain</span>
        </div>
        <div className="flex items-center gap-1.5 text-slate-600">
          <span className="text-slate-400">💧</span>
          <span>{Math.round(forecast.humidity)}% humidity</span>
        </div>
      </div>
    </div>
  );
}

function OutfitCard({ outfit, forecast, onFeedback }) {
  const { items, effectiveTempF, band, bias, rainAdjusted, topAlternatives } = outfit;
  // Track 2-step feedback flow for ambiguous-top bands
  // null = feedback closed; 'choosing' = asking which they wore; then final: applies shift
  const [pendingFeedback, setPendingFeedback] = useState(null); // { feedback: 'too-cold', ... }

  const sections = [
    { label: 'Top', items: items.top, icon: Shirt },
    { label: 'Bottom', items: items.bottom, icon: null },
    { label: 'Head', items: items.head, icon: null },
    { label: 'Hands', items: items.hands, icon: null },
  ].filter(s => s.items.length > 0);

  const handleFeedbackClick = (feedback) => {
    if (topAlternatives) {
      // Ambiguous top: ask which option they wore before applying
      setPendingFeedback(feedback);
    } else {
      onFeedback(band, feedback);
    }
  };

  const handleWornChoice = (wornKey) => {
    // wornKey is topAlternatives.primary or topAlternatives.secondary
    const wore = wornKey === topAlternatives.primary ? 'primary'
      : wornKey === topAlternatives.primary === 'tank' || wornKey === 'ls' ? 'warmer'
      : null;
    // Simpler: determine 'cooler'/'warmer' based on key — LS > T-shirt > tank
    const warmthRank = { ls: 2, tshirt: 1, tank: 0 };
    const wornRank = warmthRank[wornKey];
    const primaryRank = warmthRank[topAlternatives.primary];
    const contextWore = wornRank > primaryRank ? 'warmer'
      : wornRank < primaryRank ? 'cooler'
      : 'primary';
    onFeedback(band, pendingFeedback, { wore: contextWore });
    setPendingFeedback(null);
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm flex items-center gap-2">
          <Shirt className="h-4 w-4 text-purple-500" />
          What to wear
        </h3>
        <p className="text-[10px] text-slate-500">
          Dressed for {effectiveTempF}°F
          {bias !== 0 && <span className={bias < 0 ? 'text-blue-600' : 'text-orange-600'}> ({bias > 0 ? '+' : ''}{bias} bias)</span>}
        </p>
      </div>
      <p className="text-[10px] text-slate-400 mb-3 italic leading-snug">
        Based on the "dress for 10–20°F warmer" principle — your body heats up once you start running{rainAdjusted ? ', and wet clothing cools you further, so the effective temperature is shifted 7°F cooler for rain' : ''}.
      </p>

      <div className="space-y-2 mb-4">
        {sections.map(s => (
          <div key={s.label} className="flex items-start gap-3 text-sm">
            <p className="text-xs font-semibold text-slate-500 uppercase w-14 flex-shrink-0 pt-0.5">{s.label}</p>
            <div className="flex-1 text-slate-800">
              {s.items.map((item, i) => <p key={i}>{item}</p>)}
            </div>
          </div>
        ))}
        {items.extras.length > 0 && (
          <div className="pt-3 mt-3 border-t border-slate-100 space-y-1.5">
            {items.extras.map((extra, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-amber-900 bg-amber-50 rounded p-2">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-amber-600" />
                <span>{extra}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Feedback section */}
      <div className="border-t border-slate-100 pt-3">
        {pendingFeedback && topAlternatives ? (
          // Step 2: ask which option was worn
          <div>
            <p className="text-xs text-slate-700 mb-2 font-medium">
              Which top did you wear?
            </p>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <button
                onClick={() => handleWornChoice(topAlternatives.primary)}
                className="px-2 py-2 bg-slate-100 hover:bg-slate-200 text-slate-900 rounded-md text-xs font-medium transition">
                {topAlternatives.primaryLabel}
              </button>
              <button
                onClick={() => handleWornChoice(topAlternatives.secondary)}
                className="px-2 py-2 bg-slate-100 hover:bg-slate-200 text-slate-900 rounded-md text-xs font-medium transition">
                {topAlternatives.secondaryLabel}
              </button>
            </div>
            <button
              onClick={() => setPendingFeedback(null)}
              className="text-[10px] text-slate-400 hover:text-slate-600">
              ← back
            </button>
          </div>
        ) : (
          // Step 1: how did it feel?
          <>
            <p className="text-xs text-slate-500 mb-2">After your run, how was this dressing recommendation?</p>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => handleFeedbackClick('way-too-cold')}
                className="flex items-center justify-center gap-1.5 px-2 py-2 bg-blue-100 hover:bg-blue-200 text-blue-900 rounded-md text-xs font-medium transition">
                <ThermometerSnowflake className="h-3.5 w-3.5" />
                Way too cold
              </button>
              <button onClick={() => handleFeedbackClick('way-too-hot')}
                className="flex items-center justify-center gap-1.5 px-2 py-2 bg-orange-100 hover:bg-orange-200 text-orange-900 rounded-md text-xs font-medium transition">
                <ThermometerSun className="h-3.5 w-3.5" />
                Way too hot
              </button>
              <button onClick={() => handleFeedbackClick('too-cold')}
                className="flex items-center justify-center gap-1.5 px-2 py-2 bg-blue-50 hover:bg-blue-100 text-blue-800 rounded-md text-xs font-medium transition">
                <ThermometerSnowflake className="h-3.5 w-3.5" />
                A bit cold
              </button>
              <button onClick={() => handleFeedbackClick('too-hot')}
                className="flex items-center justify-center gap-1.5 px-2 py-2 bg-orange-50 hover:bg-orange-100 text-orange-800 rounded-md text-xs font-medium transition">
                <ThermometerSun className="h-3.5 w-3.5" />
                A bit hot
              </button>
            </div>
            <p className="text-[10px] text-slate-400 mt-2 italic leading-snug">
              Feedback adjusts the {band} band only ({band === 'cold' ? '<40°F' : band === 'cool' ? '40–60°F' : band === 'warm' ? '60–75°F' : '>75°F'}). Your other bands are unchanged.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
