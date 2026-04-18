import React, { useState, useEffect, useCallback } from 'react';
import {
  Calendar, Settings, CheckCircle2, Circle, ChevronLeft, ChevronRight,
  Activity, Dumbbell, Footprints, TrendingUp, RotateCcw, AlertCircle,
  GripVertical, Sunrise, Zap, Download, Watch, Share2, Info,
} from 'lucide-react';

import { storage } from './storage.js';
import { DAYS, paceFromSeconds, computePaces, computeHRzones, generatePlan } from './planLogic.js';
import { downloadICS } from './icsExport.js';
import { downloadTCX } from './tcxExport.js';

const SESSION_COLORS = {
  activation: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-900', icon: Sunrise },
  warmup: { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-900', icon: Zap },
  easy: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-900', icon: Footprints },
  subT: { bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-900', icon: TrendingUp },
  long: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-900', icon: Activity },
  strength: { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-900', icon: Dumbbell },
};

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function nextMondayISO() {
  const d = new Date();
  const js = d.getDay();
  const daysUntilMon = js === 0 ? 1 : (js === 1 ? 0 : 8 - js);
  d.setDate(d.getDate() + daysUntilMon);
  return d.toISOString().slice(0, 10);
}

function isToday(dateStr) {
  return dateStr === todayISO();
}

export default function App() {
  const [setup, setSetup] = useState({
    fiveKminutes: 21,
    fiveKseconds: 15,
    maxHR: 190,
    daysPerWeek: 4,
    startingMiles: 16,
    weeks: 8,
    recovering: true,
    longDay: 6,
    qualityDays: [1, 3],
    startDate: nextMondayISO(),
  });
  const [plan, setPlan] = useState(null);
  const [currentWeekIdx, setCurrentWeekIdx] = useState(0);
  const [completions, setCompletions] = useState({});
  const [view, setView] = useState('setup');
  const [loading, setLoading] = useState(true);
  const [selectedSession, setSelectedSession] = useState(null); // for detail/export modal

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
          // Jump to current week if plan has dates
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
      setLoading(false);
    };
    load();
  }, []);

  const savePlan = useCallback(async (p) => { await storage.set('plan', JSON.stringify(p)); }, []);
  const saveSetup = useCallback(async (s) => { await storage.set('setup', JSON.stringify(s)); }, []);
  const saveCompletions = useCallback(async (c) => { await storage.set('completions', JSON.stringify(c)); }, []);

  const handleGenerate = () => {
    const fiveKseconds = setup.fiveKminutes * 60 + setup.fiveKseconds;
    const paces = computePaces(fiveKseconds);
    const hr = computeHRzones(setup.maxHR);
    const newPlan = generatePlan({
      weeks: setup.weeks,
      daysPerWeek: setup.daysPerWeek,
      startingMiles: setup.startingMiles,
      recovering: setup.recovering,
      paces,
      hr,
      preferredLongDay: setup.longDay,
      preferredQualityDays: setup.qualityDays,
      startDate: setup.startDate,
    });
    setPlan(newPlan);
    setCurrentWeekIdx(0);
    setCompletions({});
    savePlan(newPlan);
    saveSetup(setup);
    saveCompletions({});
    setView('week');
  };

  const handleReset = async () => {
    if (!confirm('Reset plan and clear all completion history?')) return;
    setPlan(null);
    setCompletions({});
    await storage.delete('plan');
    await storage.delete('completions');
    setView('setup');
  };

  const toggleCompletion = (key) => {
    const updated = { ...completions, [key]: !completions[key] };
    setCompletions(updated);
    saveCompletions(updated);
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

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-slate-500">Loading...</div>;
  }

  const fiveKsec = setup.fiveKminutes * 60 + setup.fiveKseconds;
  const paces = computePaces(fiveKsec);
  const hrZones = computeHRzones(setup.maxHR);

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
          <SetupForm setup={setup} onChange={setSetup} onGenerate={handleGenerate} onReset={plan ? handleReset : null} />
        )}
        {view === 'week' && plan && (
          <WeekView
            plan={plan}
            currentWeekIdx={currentWeekIdx}
            setCurrentWeekIdx={setCurrentWeekIdx}
            completions={completions}
            onToggleCompletion={toggleCompletion}
            onMoveSession={moveSession}
            onSessionClick={setSelectedSession}
          />
        )}
        {view === 'arc' && plan && (
          <ArcView
            plan={plan}
            completions={completions}
            onJumpToWeek={(i) => { setCurrentWeekIdx(i); setView('week'); }}
          />
        )}

        {plan && view !== 'setup' && (
          <div className="mt-6 pt-4 border-t border-slate-200">
            <ZonesLegend paces={paces} hr={hrZones} />
          </div>
        )}
      </main>

      {/* Bottom nav */}
      {plan && (
        <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex items-center justify-around py-2 z-10">
          <NavButton icon={Calendar} label="Week" active={view === 'week'} onClick={() => setView('week')} />
          <NavButton icon={TrendingUp} label="Full Arc" active={view === 'arc'} onClick={() => setView('arc')} />
          <NavButton icon={Settings} label="Setup" active={view === 'setup'} onClick={() => setView('setup')} />
        </nav>
      )}

      {/* Session detail modal */}
      {selectedSession && (
        <SessionModal
          session={selectedSession.session}
          paces={paces}
          onClose={() => setSelectedSession(null)}
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

function SetupForm({ setup, onChange, onGenerate, onReset }) {
  const update = (patch) => onChange({ ...setup, ...patch });
  const toggleQualityDay = (d) => {
    const has = setup.qualityDays.includes(d);
    const next = has ? setup.qualityDays.filter(x => x !== d) : [...setup.qualityDays, d].sort();
    update({ qualityDays: next.slice(0, 3) });
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">Set up your plan</h2>
      <p className="text-sm text-slate-500 mb-5">Calibrates pace/HR zones and ramp aggressiveness.</p>

      <div className="space-y-5">
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
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">Max heart rate (bpm)</label>
          <input type="number" value={setup.maxHR}
            onChange={(e) => update({ maxHR: parseInt(e.target.value) || 0 })}
            className="w-24 px-3 py-2 border border-slate-200 rounded-md text-sm" min="140" max="220" />
          <p className="text-xs text-slate-400 mt-1">Observed max, not 220-age.</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">Plan start date</label>
          <input type="date" value={setup.startDate}
            onChange={(e) => update({ startDate: e.target.value })}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm" />
          <p className="text-xs text-slate-400 mt-1">Week 1 begins on this date.</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">Days running per week: {setup.daysPerWeek}</label>
          <input type="range" min="3" max="6" value={setup.daysPerWeek}
            onChange={(e) => update({ daysPerWeek: parseInt(e.target.value) })}
            className="w-full accent-slate-900" />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">Starting weekly mileage: {setup.startingMiles} mi</label>
          <input type="range" min="8" max="40" step="1" value={setup.startingMiles}
            onChange={(e) => update({ startingMiles: parseInt(e.target.value) })}
            className="w-full accent-slate-900" />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">Plan length: {setup.weeks} weeks</label>
          <input type="range" min="4" max="16" value={setup.weeks}
            onChange={(e) => update({ weeks: parseInt(e.target.value) })}
            className="w-full accent-slate-900" />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">Long run day</label>
          <div className="grid grid-cols-7 gap-1">
            {DAYS.map((d, i) => (
              <button key={d} onClick={() => update({ longDay: i })}
                className={`py-2 text-xs font-medium rounded-md transition ${setup.longDay === i ? 'bg-slate-900 text-white' : 'bg-slate-100'}`}>
                {d}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">Preferred sub-T days (pick 2–3)</label>
          <div className="grid grid-cols-7 gap-1">
            {DAYS.map((d, i) => {
              const selected = setup.qualityDays.includes(i);
              const disabled = i === setup.longDay;
              return (
                <button key={d} onClick={() => !disabled && toggleQualityDay(i)} disabled={disabled}
                  className={`py-2 text-xs font-medium rounded-md transition ${disabled ? 'bg-slate-50 text-slate-300' : selected ? 'bg-rose-500 text-white' : 'bg-slate-100'}`}>
                  {d}
                </button>
              );
            })}
          </div>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={setup.recovering}
              onChange={(e) => update({ recovering: e.target.checked })}
              className="mt-0.5 accent-amber-600" />
            <div>
              <p className="text-sm font-medium text-amber-900">Returning from injury</p>
              <p className="text-xs text-amber-700 mt-0.5">Conservative ramp: 2 weeks easy, then 2 weeks with 1 sub-T, then full Singles.</p>
            </div>
          </label>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mt-6">
        <button onClick={onGenerate}
          className="px-5 py-2.5 bg-slate-900 text-white rounded-md font-medium text-sm hover:bg-slate-800 transition">
          Generate plan
        </button>
        {onReset && (
          <button onClick={onReset}
            className="px-5 py-2.5 bg-white text-slate-700 border border-slate-200 rounded-md font-medium text-sm hover:bg-slate-50 transition flex items-center justify-center gap-1.5">
            <RotateCcw className="h-3.5 w-3.5" /> Reset plan
          </button>
        )}
      </div>
    </div>
  );
}

function SessionCard({ session, completed, onToggle, draggable, onDragStart, onClick, date }) {
  const style = SESSION_COLORS[session.type] || SESSION_COLORS.easy;
  const Icon = style.icon;
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => onDragStart && onDragStart(e, session)}
      onClick={onClick}
      className={`group rounded-lg border ${style.border} ${style.bg} p-2 transition ${completed ? 'opacity-60' : ''} ${draggable ? 'cursor-pointer hover:shadow-sm' : 'cursor-pointer'}`}
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
              {session.title}
            </p>
          </div>
          {session.pace && (
            <p className="text-[10px] text-slate-600 leading-tight">{session.pace} · {session.hr}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function WeekView({ plan, currentWeekIdx, setCurrentWeekIdx, completions, onToggleCompletion, onMoveSession, onSessionClick }) {
  const [dragging, setDragging] = useState(null);
  const week = plan[currentWeekIdx];
  if (!week) return null;

  const handleDragStart = (e, session, fromDay) => {
    setDragging({ session, fromDay });
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDrop = (e, toDay) => {
    e.preventDefault();
    if (dragging && dragging.fromDay !== toDay) {
      onMoveSession(week.weekIndex, dragging.fromDay, toDay, dragging.session.id);
    }
    setDragging(null);
  };
  const handleDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };

  let totalCount = 0, doneCount = 0;
  week.days.forEach((d, i) => {
    d.sessions.forEach(s => {
      totalCount++;
      if (completions[`${week.weekIndex}-${i}-${s.id}`]) doneCount++;
    });
  });

  return (
    <div>
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
            {week.phase} · {week.totalMiles} mi · {doneCount}/{totalCount} done
          </p>
        </div>
        <button onClick={() => setCurrentWeekIdx(Math.min(plan.length - 1, currentWeekIdx + 1))}
          disabled={currentWeekIdx === plan.length - 1}
          className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-30">
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-7 gap-2">
        {week.days.map((day, idx) => {
          const today = day.date && isToday(day.date);
          const d = day.date ? new Date(day.date) : null;
          const dateDisplay = d ? `${d.getMonth() + 1}/${d.getDate()}` : '';
          return (
            <div key={idx}
              onDrop={(e) => handleDrop(e, idx)}
              onDragOver={handleDragOver}
              className={`rounded-lg border-2 bg-white p-2 min-h-[90px] transition ${today ? 'border-slate-900 shadow-sm' : 'border-slate-100'} ${dragging ? 'hover:border-slate-400' : ''}`}
            >
              <div className="flex items-baseline justify-between mb-1.5">
                <div>
                  <p className={`text-xs font-semibold ${today ? 'text-slate-900' : 'text-slate-500'} uppercase`}>
                    {DAYS[idx]}
                  </p>
                  {dateDisplay && <p className="text-[10px] text-slate-400">{dateDisplay}</p>}
                </div>
                {today && <span className="text-[9px] font-bold text-white bg-slate-900 rounded px-1.5 py-0.5">TODAY</span>}
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
                              draggable={false} onClick={() => onSessionClick({ session, date: day.date })} />
                          );
                        })}
                      </>
                    );
                  }
                  return day.sessions.map(session => {
                    const key = `${week.weekIndex}-${idx}-${session.id}`;
                    const draggable = !['activation', 'warmup', 'strength'].includes(session.type);
                    return (
                      <SessionCard key={session.id} session={session}
                        completed={!!completions[key]} onToggle={() => onToggleCompletion(key)}
                        draggable={draggable}
                        onDragStart={(e, s) => handleDragStart(e, s, idx)}
                        onClick={() => onSessionClick({ session, date: day.date })} />
                    );
                  });
                })()}
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-xs text-slate-400 flex items-center gap-1.5">
        <Info className="h-3 w-3" /> Tap any session for details & export. Drag runs between days to rearrange.
      </p>
    </div>
  );
}

function ArcView({ plan, completions, onJumpToWeek }) {
  return (
    <div className="space-y-2">
      {plan.map((week, idx) => {
        let total = 0, done = 0;
        week.days.forEach((d, i) => {
          d.sessions.forEach(s => {
            total++;
            if (completions[`${week.weekIndex}-${i}-${s.id}`]) done++;
          });
        });
        const pct = total ? (done / total) * 100 : 0;
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
                  <p className="text-xs text-slate-500">{week.totalMiles} mi · {week.subTcount} sub-T</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <div className="w-20 bg-slate-100 rounded-full h-1.5 overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-xs text-slate-500 tabular-nums w-10 text-right">{done}/{total}</p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function SessionModal({ session, paces, onClose }) {
  const canExportTCX = session.type === 'subT' && session.structured;
  const canExportRun = ['easy', 'subT', 'long'].includes(session.type);

  const handleTCX = () => {
    const ok = downloadTCX(session, paces.easy);
    if (!ok) alert('Could not generate workout file for this session.');
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-xl max-w-lg w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <div className="flex items-start justify-between gap-3 mb-3">
            <h3 className="font-semibold text-lg">{session.title}</h3>
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

          {canExportRun && (
            <div className="space-y-2 border-t border-slate-100 pt-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Export</p>
              {canExportTCX && (
                <button onClick={handleTCX}
                  className="w-full flex items-center gap-2 px-3 py-2.5 bg-slate-900 text-white rounded-md text-sm font-medium hover:bg-slate-800 transition">
                  <Watch className="h-4 w-4" />
                  Download as Garmin/Coros workout (.tcx)
                </button>
              )}
              <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-xs text-blue-900 leading-relaxed">
                <p className="font-semibold mb-1">To get this onto Strava:</p>
                <p>Run it on your Garmin/Coros (import the .tcx via Garmin Connect or Coros app). After the run, your watch auto-syncs to Strava with the full workout data.</p>
                {!canExportTCX && (
                  <p className="mt-2 italic">Non-interval runs don't need a structured file — just run by feel or pace target.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
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
