// Generate an .ics file from the training plan

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatICSDate(dateStr, hour = 6, min = 0) {
  // dateStr is YYYY-MM-DD, produce YYYYMMDDTHHMMSS (floating local time)
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${y}${pad(m)}${pad(d)}T${pad(hour)}${pad(min)}00`;
}

function escapeICS(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

const SESSION_TIMES = {
  activation: { hour: 6, duration: 5 },
  warmup: { hour: 6, duration: 5 },
  easy: { hour: 7, duration: 60 },
  subT: { hour: 7, duration: 70 },
  long: { hour: 7, duration: 90 },
  strength: { hour: 18, duration: 20 },
};

export function buildICS(plan, calendarName = 'Singles Training') {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Norwegian Singles Planner//EN',
    `X-WR-CALNAME:${escapeICS(calendarName)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  plan.forEach(week => {
    week.days.forEach((day, dayIdx) => {
      let currentHour = 6;
      day.sessions.forEach(session => {
        const timing = SESSION_TIMES[session.type] || { hour: currentHour, duration: 30 };
        let hour = timing.hour;
        // stack sessions that share a starting hour
        if (session.type === 'warmup') hour = 6;
        if (session.type === 'activation') hour = 6;

        const dtstart = formatICSDate(day.date, hour, 0);
        const endTotalMin = hour * 60 + timing.duration;
        const endH = Math.floor(endTotalMin / 60);
        const endM = endTotalMin % 60;
        const dtend = formatICSDate(day.date, endH, endM);

        const uid = `${week.weekIndex}-${dayIdx}-${session.id}@singles-planner`;
        const summary = session.title;
        const desc = [
          session.pace ? `Target pace: ${session.pace}` : null,
          session.hr ? `Target HR: ${session.hr}` : null,
          session.detail,
          `Week ${week.weekIndex + 1} (${week.phase}) — ${week.totalMiles} mi total`,
        ].filter(Boolean).join('\n');

        lines.push(
          'BEGIN:VEVENT',
          `UID:${uid}`,
          `DTSTAMP:${dtstamp}`,
          `DTSTART:${dtstart}`,
          `DTEND:${dtend}`,
          `SUMMARY:${escapeICS(summary)}`,
          `DESCRIPTION:${escapeICS(desc)}`,
          `CATEGORIES:${session.type.toUpperCase()}`,
          'END:VEVENT',
        );
      });
    });
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export function downloadICS(plan, filename = 'singles-training.ics') {
  const content = buildICS(plan);
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
