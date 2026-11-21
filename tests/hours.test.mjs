import assert from 'node:assert/strict';
import test from 'node:test';
import { groupHourRows, openStateFromDays, scheduleRowsForDb, validateSchedule } from '../api/hours.mjs';

const days = (intervals, extra = {}) => Array.from({ length: 7 }, (_, weekday) => ({
  weekday, isClosed: false, is24h: false, intervals, present: true, ...extra,
}));

test('часы: открыто, закрыто и ночная смена', () => {
  const regular = days([{ from: '10:00', to: '20:00' }]);
  assert.equal(openStateFromDays(regular, 'Asia/Irkutsk', new Date('2026-11-21T04:00:00Z')).state, 'open');
  assert.match(openStateFromDays(regular, 'Asia/Irkutsk', new Date('2026-11-21T13:00:00Z')).label, /завтра в 10:00/);
  const overnight = days([{ from: '22:00', to: '02:00' }]);
  assert.equal(openStateFromDays(overnight, 'Asia/Irkutsk', new Date('2026-11-21T17:00:00Z')).state, 'open');
  assert.equal(openStateFromDays(overnight, 'Asia/Irkutsk', new Date('2026-11-21T19:30:00Z')).state, 'closed');
  const h24 = days([], { is24h: true });
  assert.equal(openStateFromDays(h24, 'Asia/Irkutsk', new Date('2026-11-21T19:30:00Z')).label, 'Круглосуточно');
});

test('часы: перерыв и часовой пояс города', () => {
  const withBreak = days([{ from: '09:00', to: '13:00' }, { from: '14:00', to: '21:00' }]);
  // 06:30 UTC = 14:30 в Иркутске, после перерыва.
  assert.equal(openStateFromDays(withBreak, 'Asia/Irkutsk', new Date('2026-11-21T06:30:00Z')).state, 'open');
  // 05:30 UTC = 13:30 в Иркутске, перерыв.
  assert.equal(openStateFromDays(withBreak, 'Asia/Irkutsk', new Date('2026-11-21T05:30:00Z')).state, 'closed');
  // В Москве в это время ещё 08:30, до открытия.
  assert.match(openStateFromDays(withBreak, 'Europe/Moscow', new Date('2026-11-21T05:30:00Z')).label, /в 09:00/);
});

test('часы: принимается только полная корректная неделя', () => {
  const valid = days([{ from: '10:00', to: '20:00' }])
    .map(({ weekday, isClosed, is24h, intervals }) => ({ weekday, isClosed, is24h, intervals }));
  assert.equal(validateSchedule(valid).length, 7);
  assert.equal(validateSchedule(valid.slice(0, 6)), null);
  assert.equal(validateSchedule([
    { weekday: 0, isClosed: true, is24h: true, intervals: [] }, ...valid.slice(1),
  ]), null);
  assert.equal(validateSchedule([
    { weekday: 0, isClosed: false, is24h: false, intervals: [{ from: '25:00', to: '10:00' }] }, ...valid.slice(1),
  ]), null);
  assert.equal(validateSchedule([
    { weekday: 0, isClosed: false, is24h: false, intervals: [{ from: '10:00', to: '10:00' }] }, ...valid.slice(1),
  ]), null);
});

test('часы: строки для БД сохраняют порядок интервалов', () => {
  const valid = validateSchedule(days([{ from: '09:00', to: '13:00' }, { from: '14:00', to: '21:00' }])
    .map(({ weekday, isClosed, is24h, intervals }) => ({ weekday, isClosed, is24h, intervals })));
  const rows = scheduleRowsForDb(valid);
  assert.equal(rows.length, 14);
  assert.deepEqual(rows.slice(0, 2).map(row => [row.position, row.opensAt, row.closesAt]),
    [[0, '09:00', '13:00'], [1, '14:00', '21:00']]);
});

test('часы: строки БД группируются по дням и пустые дни закрыты', () => {
  const map = groupHourRows([
    { place_id: 'p1', weekday: 0, is_closed: false, is_24h: false, opens_at: '10:00', closes_at: '20:00' },
    { place_id: 'p1', weekday: 0, is_closed: false, is_24h: false, opens_at: '21:00', closes_at: '23:00' },
  ]);
  const list = map.get('p1');
  assert.equal(list.length, 7);
  assert.deepEqual(list[0].intervals, [{ from: '10:00', to: '20:00' }, { from: '21:00', to: '23:00' }]);
  assert.equal(list[1].isClosed, true);
});
