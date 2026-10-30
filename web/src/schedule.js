// Friendly schedules <-> cron expressions. The server only ever stores/uses the cron string; this file lets the UI
// show "Every weekday at 9:00 AM" instead of "0 9 * * 1-5". Pure functions (no React) so they can be unit-tested.

const pad = (n) => String(n).padStart(2, '0');

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first
export const MINUTE_STEPS = [1, 2, 5, 10, 15, 20, 30];
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];

export const MODES = [
  { id: 'minutes', label: 'Every few minutes' },
  { id: 'hours', label: 'Every few hours' },
  { id: 'day', label: 'Every day' },
  { id: 'week', label: 'On certain days of the week' },
  { id: 'month', label: 'Once a month' },
  { id: 'custom', label: 'Advanced (cron expression)' },
];

export const DEFAULTS = {
  minutes: { mode: 'minutes', every: 15 },
  hours: { mode: 'hours', every: 1, minute: 0 },
  day: { mode: 'day', time: '09:00' },
  week: { mode: 'week', days: [1, 2, 3, 4, 5], time: '09:00' },
  month: { mode: 'month', date: 1, time: '09:00' },
};

const parts = (time) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [9, 0];
};

const uniqSorted = (days) => [...new Set(days)].sort((a, b) => a - b);

/** Friendly settings -> cron string, or null when the settings are incomplete (for example no weekday picked). */
export function buildCron(s) {
  switch (s.mode) {
    case 'minutes': return s.every === 1 ? '* * * * *' : `*/${s.every} * * * *`;
    case 'hours': return `${s.minute} ${s.every === 1 ? '*' : `*/${s.every}`} * * *`;
    case 'day': { const [h, m] = parts(s.time); return `${m} ${h} * * *`; }
    case 'week': {
      const days = uniqSorted(s.days ?? []);
      if (!days.length) return null;
      const [h, m] = parts(s.time);
      const list = days.join(',') === '1,2,3,4,5' ? '1-5' : days.length === 7 ? '*' : days.join(',');
      return `${m} ${h} * * ${list}`;
    }
    case 'month': { const [h, m] = parts(s.time); return `${m} ${h} ${s.date} * *`; }
    default: return null;
  }
}

const int = (s, min, max) => (/^\d+$/.test(s) && Number(s) >= min && Number(s) <= max ? Number(s) : null);

function parseDays(field) {
  if (field === '*') return [0, 1, 2, 3, 4, 5, 6];
  const out = [];
  for (const piece of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(piece);
    if (range) {
      const [a, b] = [int(range[1], 0, 7), int(range[2], 0, 7)];
      if (a === null || b === null || a > b) return null;
      for (let d = a; d <= b; d += 1) out.push(d % 7);
    } else {
      const d = int(piece, 0, 7);
      if (d === null) return null;
      out.push(d % 7);
    }
  }
  return uniqSorted(out);
}

/** Cron string -> friendly settings, or null when it cannot be shown with the simple controls (then "Advanced" is used). */
export function parseCron(cron) {
  const f = String(cron ?? '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, ho, dom, mon, dow] = f;
  if (mon !== '*') return null;

  if (ho === '*' && dom === '*' && dow === '*') {
    if (mi === '*') return { mode: 'minutes', every: 1 };
    const step = /^\*\/(\d+)$/.exec(mi);
    if (step && MINUTE_STEPS.includes(Number(step[1]))) return { mode: 'minutes', every: Number(step[1]) };
    const m = int(mi, 0, 59);
    return m === null ? null : { mode: 'hours', every: 1, minute: m };
  }
  const minute = int(mi, 0, 59);
  if (minute === null) return null;
  const hstep = /^\*\/(\d+)$/.exec(ho);
  if (hstep && dom === '*' && dow === '*') return HOUR_STEPS.includes(Number(hstep[1])) ? { mode: 'hours', every: Number(hstep[1]), minute } : null;

  const hour = int(ho, 0, 23);
  if (hour === null) return null;
  const time = `${pad(hour)}:${pad(minute)}`;
  if (dom === '*' && dow === '*') return { mode: 'day', time };
  if (dom === '*') {
    const days = parseDays(dow);
    return days?.length ? { mode: 'week', days, time } : null;
  }
  const date = int(dom, 1, 28);
  return dow === '*' && date !== null ? { mode: 'month', date, time } : null;
}

export const formatTime = (time) => {
  const [h, m] = parts(time);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
};

const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')}`;

/** A sentence for a settings object, e.g. "Every weekday at 9:00 AM". */
export function describe(s) {
  switch (s.mode) {
    case 'minutes': return s.every === 1 ? 'Every minute' : `Every ${s.every} minutes`;
    case 'hours': return `${s.every === 1 ? 'Every hour' : `Every ${s.every} hours`}, at ${s.minute === 0 ? 'the start of the hour' : `${s.minute} minutes past`}`;
    case 'day': return `Every day at ${formatTime(s.time)}`;
    case 'week': {
      const days = uniqSorted(s.days ?? []);
      const key = days.join(',');
      const label = key === '1,2,3,4,5' ? 'weekday' : key === '0,6' ? 'weekend day' : days.length === 7 ? 'day' : null;
      if (label) return `Every ${label} at ${formatTime(s.time)}`;
      return `Every ${days.map((d) => DAY_NAMES[d]).join(', ')} at ${formatTime(s.time)}`;
    }
    case 'month': return `On the ${ordinal(s.date)} of every month at ${formatTime(s.time)}`;
    default: return 'Custom schedule';
  }
}

/** How many times a day a schedule runs (only for the very frequent ones, to warn about plan limits); otherwise 0. */
export function runsPerDay(s) {
  if (s.mode === 'minutes') return Math.floor(1440 / s.every);
  if (s.mode === 'hours') return Math.floor(24 / s.every);
  return 0;
}
