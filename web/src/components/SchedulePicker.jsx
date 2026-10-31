import React, { useState } from 'react';
import { DAY_SHORT, DAY_NAMES, WEEK_ORDER, MINUTE_STEPS, HOUR_STEPS, MODES, DEFAULTS, buildCron, parseCron, describe, runsPerDay } from '../schedule.js';

/** "When should this run?" without cron: pick how often, then the details. Writes a cron string via onChange. */
export function SchedulePicker({ value, onChange }) {
  const parsed = parseCron(value);
  const [advanced, setAdvanced] = useState(!parsed);
  const mode = advanced || !parsed ? 'custom' : parsed.mode;
  const s = parsed ?? DEFAULTS.day;

  const change = (next) => { const cron = buildCron(next); if (cron) onChange(cron); };
  const pickMode = (id) => {
    if (id === 'custom') { setAdvanced(true); return; }
    setAdvanced(false);
    change({ ...DEFAULTS[id], ...(parsed?.time && DEFAULTS[id].time ? { time: parsed.time } : {}) });
  };
  const perDay = parsed && !advanced ? runsPerDay(parsed) : 0;

  return (
    <div className="stack tight sched">
      <span className="field-label">When should it run?</span>
      <select aria-label="How often" value={mode} onChange={(e) => pickMode(e.target.value)}>
        {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>

      {mode === 'minutes' && (
        <div className="row gap wrap">
          <span>Every</span>
          <select aria-label="Minutes between runs" value={s.every} onChange={(e) => change({ ...s, every: Number(e.target.value) })}>
            {MINUTE_STEPS.map((n) => <option key={n} value={n}>{n === 1 ? '1 minute' : `${n} minutes`}</option>)}
          </select>
        </div>
      )}

      {mode === 'hours' && (
        <div className="row gap wrap">
          <span>Every</span>
          <select aria-label="Hours between runs" value={s.every} onChange={(e) => change({ ...s, every: Number(e.target.value) })}>
            {HOUR_STEPS.map((n) => <option key={n} value={n}>{n === 1 ? '1 hour' : `${n} hours`}</option>)}
          </select>
          <span>at minute</span>
          <input type="number" min="0" max="59" aria-label="Minute of the hour" className="narrow" value={s.minute}
            onChange={(e) => { const m = Number(e.target.value); if (Number.isInteger(m) && m >= 0 && m <= 59) change({ ...s, minute: m }); }} />
        </div>
      )}

      {mode === 'day' && (
        <div className="row gap wrap">
          <span>At</span>
          <input type="time" aria-label="Time of day" value={s.time} onChange={(e) => e.target.value && change({ ...s, time: e.target.value })} />
        </div>
      )}

      {mode === 'week' && (
        <>
          <div className="row gap wrap" role="group" aria-label="Days of the week">
            {WEEK_ORDER.map((d) => {
              const on = s.days.includes(d);
              return (
                <button key={d} type="button" className={`chip ${on ? 'active' : ''}`} aria-pressed={on} title={DAY_NAMES[d]}
                  onClick={() => { const days = on ? s.days.filter((x) => x !== d) : [...s.days, d]; change({ ...s, days }); }}>
                  {DAY_SHORT[d]}
                </button>
              );
            })}
          </div>
          <div className="row gap wrap">
            <button type="button" className="small" onClick={() => change({ ...s, days: [1, 2, 3, 4, 5] })}>Weekdays</button>
            <button type="button" className="small" onClick={() => change({ ...s, days: [0, 6] })}>Weekends</button>
            <button type="button" className="small" onClick={() => change({ ...s, days: [0, 1, 2, 3, 4, 5, 6] })}>Every day</button>
          </div>
          <div className="row gap wrap">
            <span>At</span>
            <input type="time" aria-label="Time of day" value={s.time} onChange={(e) => e.target.value && change({ ...s, time: e.target.value })} />
          </div>
        </>
      )}

      {mode === 'month' && (
        <>
          <div className="row gap wrap">
            <span>On day</span>
            <select aria-label="Day of the month" value={s.date} onChange={(e) => change({ ...s, date: Number(e.target.value) })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>at</span>
            <input type="time" aria-label="Time of day" value={s.time} onChange={(e) => e.target.value && change({ ...s, time: e.target.value })} />
          </div>
          <span className="muted small">Days 29-31 are not offered because not every month has them.</span>
        </>
      )}

      {mode === 'custom' && (
        <>
          <input className="mono" aria-label="Cron expression" spellCheck={false} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
          <span className="muted small">
            Five parts: minute, hour, day of month, month, day of week. Example: <code>0 9 * * 1-5</code> = 9:00 AM on weekdays.
            Prefer clicking? Pick another option above.
          </span>
        </>
      )}

      {mode !== 'custom' && parsed && <span className="sched-summary">{describe(parsed)}</span>}
      {mode === 'week' && !s.days.length && <span className="error">Pick at least one day.</span>}
      {perDay >= 100 && <span className="muted small">That is about {perDay} runs a day, which can use up a plan's monthly runs quickly.</span>}
    </div>
  );
}

const COMMON_ZONES = ['UTC'];

/** Timezone dropdown with a one-click "use my computer's timezone". */
export function TimezoneSelect({ value, onChange }) {
  let mine = 'UTC';
  let zones = COMMON_ZONES;
  try {
    mine = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    zones = ['UTC', ...(Intl.supportedValuesOf?.('timeZone') ?? [mine])];
  } catch { /* old browser: UTC + the free-text fallback below */ }
  const list = zones.includes(value) || !value ? zones : [value, ...zones];
  return (
    <div className="stack tight">
      <span className="field-label">Timezone</span>
      <select aria-label="Timezone" value={value || 'UTC'} onChange={(e) => onChange(e.target.value)}>
        {list.map((z) => <option key={z} value={z}>{z}</option>)}
      </select>
      <span className="muted small">
        The times above use this timezone.{' '}
        {(value || 'UTC') !== mine && <button type="button" className="link-button" onClick={() => onChange(mine)}>Use my computer's timezone ({mine})</button>}
      </span>
    </div>
  );
}
