// Часы работы и «открыто сейчас». Время всегда считается в часовом поясе
// города, а не сервера: Слюдянка и демо-город могут быть в разных зонах.
export const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const JS_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;

export function minutesOf(value) {
  if (typeof value !== 'string') return 0;
  const [h, m] = value.split(':').map(Number);
  return (h % 24) * 60 + (m || 0);
}

export function clockOf(minutes) {
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function normalizeClock(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  if (!TIME_RE.test(clean)) return null;
  return clean === '24:00' ? '00:00' : clean;
}

function closeLabel(value) {
  return value === '00:00' ? '24:00' : value;
}

export function groupHourRows(rows) {
  const map = new Map();
  for (const row of rows) {
    let days = map.get(row.place_id);
    if (!days) {
      days = Array.from({ length: 7 }, (_, weekday) => ({
        weekday, isClosed: false, is24h: false, intervals: [], present: false,
      }));
      map.set(row.place_id, days);
    }
    const day = days[row.weekday];
    day.present = true;
    day.isClosed = Boolean(row.is_closed);
    day.is24h = Boolean(row.is_24h);
    if (row.opens_at) {
      day.intervals.push({ from: normalizeClock(row.opens_at), to: normalizeClock(row.closes_at) });
    }
  }
  for (const days of map.values()) {
    for (const day of days) {
      if (!day.present) { day.isClosed = true; day.is24h = false; }
      day.intervals.sort((a, b) => minutesOf(a.from) - minutesOf(b.from));
    }
  }
  return map;
}

function localNow(now, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'Asia/Irkutsk', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
  }
  const get = type => parts.find(part => part.type === type)?.value ?? '';
  const jsDay = JS_WEEKDAYS.indexOf(get('weekday'));
  const weekday = jsDay < 0 ? 0 : (jsDay + 6) % 7;
  const minute = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  return { weekday, minute };
}

function intervalAt(day, minute) {
  if (!day || day.isClosed || day.is24h) return null;
  for (const interval of day.intervals) {
    const from = minutesOf(interval.from);
    const to = minutesOf(interval.to);
    if (from === to) return interval; // защита от старых/ручных данных
    if (to > from && minute >= from && minute < to) return interval;
    if (to < from && (minute >= from || minute < to)) return interval;
  }
  return null;
}

function nextOpening(days, weekday, minute) {
  const today = days[weekday];
  if (today && !today.isClosed) {
    if (today.is24h) return { day: today, weekday, interval: null, offset: 0 };
    const later = today.intervals
      .map(interval => ({ interval, from: minutesOf(interval.from) }))
      .filter(item => item.from > minute)
      .sort((a, b) => a.from - b.from)[0];
    if (later) return { day: today, weekday, interval: later.interval, offset: 0 };
  }
  for (let offset = 1; offset <= 7; offset++) {
    const index = (weekday + offset) % 7;
    const day = days[index];
    if (!day || day.isClosed) continue;
    if (day.is24h) return { day, weekday: index, interval: null, offset };
    const first = day.intervals
      .map(interval => ({ interval, from: minutesOf(interval.from) }))
      .sort((a, b) => a.from - b.from)[0];
    if (first) return { day, weekday: index, interval: first.interval, offset };
  }
  return null;
}

function publicDay(day) {
  return {
    weekday: day.weekday,
    isClosed: day.isClosed,
    is24h: day.is24h,
    intervals: day.intervals.map(interval => ({ from: interval.from, to: interval.to })),
    present: day.present,
  };
}

export function openStateFromDays(days, timezone, now = new Date()) {
  if (!Array.isArray(days) || !days.some(day => day.present)) {
    return { state: 'unknown', label: null, opensAt: null, closesAt: null, weekday: null };
  }
  const { weekday, minute } = localNow(now, timezone);
  const today = days[weekday];
  const current = intervalAt(today, minute);
  if (today?.is24h) {
    return { state: 'open', label: 'Круглосуточно', opensAt: '00:00', closesAt: '24:00', weekday, is24h: true };
  }
  if (current) {
    const label = `Открыто до ${closeLabel(current.to)}`;
    return { state: 'open', label, opensAt: current.from, closesAt: current.to, weekday };
  }
  const previous = days[(weekday + 6) % 7];
  if (previous && !previous.isClosed && !previous.is24h) {
    const overnight = previous.intervals.find(interval => {
      const from = minutesOf(interval.from);
      const to = minutesOf(interval.to);
      return to < from && minute < to;
    });
    if (overnight) {
      return { state: 'open', label: `Открыто до ${closeLabel(overnight.to)}`,
        opensAt: overnight.from, closesAt: overnight.to, weekday };
    }
  }
  const next = nextOpening(days, weekday, minute);
  if (!next) return { state: 'closed', label: 'Закрыто', opensAt: null, closesAt: null, weekday };
  if (next.day.is24h) {
    const when = next.offset === 0 ? 'сейчас' : next.offset === 1 ? 'завтра' : WEEKDAY_LABELS[next.weekday];
    return { state: 'closed', label: next.offset === 0 ? 'Откроется сейчас' : `Откроется ${when} · круглосуточно`,
      opensAt: '00:00', closesAt: '24:00', weekday };
  }
  const when = next.offset === 0 ? 'в ' : next.offset === 1 ? 'завтра в ' : `${WEEKDAY_LABELS[next.weekday]} в `;
  return { state: 'closed', label: `Откроется ${when}${next.interval.from}`,
    opensAt: next.interval.from, closesAt: next.interval.to, weekday };
}

export function hoursView(rows, timezone, now = new Date()) {
  const days = groupHourRows(rows).get(rows[0]?.place_id) ?? [];
  const base = days.length ? days : Array.from({ length: 7 }, (_, weekday) => ({
    weekday, isClosed: true, is24h: false, intervals: [], present: false,
  }));
  return {
    timezone: timezone || 'Asia/Irkutsk',
    days: base.map(publicDay),
    openNow: openStateFromDays(base, timezone, now),
  };
}

export function openNowFromRows(rows, timezone, now = new Date()) {
  const days = groupHourRows(rows).get(rows[0]?.place_id);
  if (!days) return { state: 'unknown', label: null, opensAt: null, closesAt: null, weekday: null };
  return openStateFromDays(days, timezone, now);
}

export function validateSchedule(days) {
  if (!Array.isArray(days) || days.length !== 7) return null;
  const seen = new Set();
  const normalized = [];
  for (const raw of days) {
    if (!raw || typeof raw !== 'object') return null;
    const weekday = Number(raw.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || seen.has(weekday)) return null;
    seen.add(weekday);
    const isClosed = Boolean(raw.isClosed);
    const is24h = Boolean(raw.is24h);
    if (isClosed && is24h) return null;
    const intervals = [];
    if (!isClosed && !is24h) {
      if (!Array.isArray(raw.intervals) || raw.intervals.length === 0 || raw.intervals.length > 4) return null;
      for (const item of raw.intervals) {
        const from = normalizeClock(item?.from);
        const to = normalizeClock(item?.to);
        if (!from || !to || from === to) return null;
        intervals.push({ from, to });
      }
      intervals.sort((a, b) => minutesOf(a.from) - minutesOf(b.from));
    }
    normalized.push({ weekday, isClosed, is24h, intervals });
  }
  return normalized.sort((a, b) => a.weekday - b.weekday);
}

export function scheduleRowsForDb(days) {
  const flat = [];
  for (const day of days) {
    if (day.isClosed || day.is24h) continue;
    day.intervals.forEach((interval, position) => flat.push({
      weekday: day.weekday, position, opensAt: interval.from, closesAt: interval.to,
    }));
  }
  return flat;
}
