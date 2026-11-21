// Пересобирает статический снимок района для GitHub Pages из PostgreSQL.
// Часы работы берутся из place_hours, чтобы демо совпадало с боевым API.
import fs from 'node:fs/promises';
import { createPool } from '../api/db.mjs';
import { groupHourRows } from '../api/hours.mjs';

const target = new URL('../web/src/demo-district.json', import.meta.url);
const pool = createPool({ max: 2 });
try {
  const current = JSON.parse(await fs.readFile(target, 'utf8'));
  const { rows } = await pool.query(
    `select p.id as place_id, p.source_id, c.timezone,
            h.weekday, h.is_closed, h.is_24h,
            to_char(i.opens_at, 'HH24:MI') as opens_at,
            to_char(i.closes_at, 'HH24:MI') as closes_at
     from places p
     join cities c on c.slug = p.city_slug
     join place_hours h on h.place_id = p.id
     left join place_hour_intervals i
       on i.place_id = h.place_id and i.weekday = h.weekday
     where p.is_published and p.source = '2gis'
     order by p.id, h.weekday, i.position`);
  const grouped = groupHourRows(rows);
  const sourceId = new Map(rows.map(row => [row.place_id, row.source_id]));
  const timezone = new Map(rows.map(row => [row.place_id, row.timezone]));
  const hoursByDemoId = new Map();
  for (const [dbId, days] of grouped) {
    const source = sourceId.get(dbId);
    if (source) hoursByDemoId.set(`2gis-${source}`, { days, timezone: timezone.get(dbId) });
  }
  for (const place of current) {
    const schedule = hoursByDemoId.get(place.id);
    if (schedule) {
      place.timezone = schedule.timezone;
      place.hours = schedule.days.map(({ weekday, isClosed, is24h, intervals }) => ({ weekday, isClosed, is24h, intervals }));
    } else {
      delete place.timezone;
      delete place.hours;
    }
  }
  await fs.writeFile(target, `${JSON.stringify(current)}\n`, 'utf8');
  console.log(`демо-район: ${current.length} карточек, ${grouped.size} с часами`);
} finally {
  await pool.end();
}
