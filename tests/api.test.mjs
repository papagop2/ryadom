// Проверки API на реальной тестовой БД. Без доступной БД тесты помечаются
// skip, чтобы сборка не врала о покрытии.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool } from '../api/db.mjs';
import { migrate } from '../db/migrate.mjs';
import { seed } from '../db/seed.mjs';
import { makeServer } from '../api/server.mjs';
import { tokenHash } from '../api/security.mjs';

const pool = createPool({ max: 4 });
const app = makeServer({ pool, demoLogin: true });
let ready = false;
let skipReason = 'нет PostgreSQL';

const phone = () => '+79' + String(Math.floor(100000000 + Math.random() * 899999999));

function cookiesOf(response) {
  const header = response.headers['set-cookie'];
  const list = Array.isArray(header) ? header : [header ?? ''];
  const jar = {};
  for (const item of list) {
    const [pair] = item.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return jar;
}

async function login() {
  const number = phone();
  const code = await app.inject({ method: 'POST', url: '/api/v1/auth/code', payload: { phone: number } });
  assert.equal(code.statusCode, 200, code.body);
  const secret = code.json().demoCode;
  const session = await app.inject({
    method: 'POST', url: '/api/v1/auth/session',
    payload: { phone: number, code: secret, displayName: 'Тест' },
  });
  assert.equal(session.statusCode, 200, session.body);
  const jar = cookiesOf(session);
  const headers = { cookie: `rjadom_sid=${jar.rjadom_sid}`, 'x-csrf-token': jar.rjadom_csrf };
  return { phone: number, userId: session.json().user.id, headers };
}

async function addPartnerRole(userId, partnerName) {
  const partner = await pool.query('select id from partners where name = $1', [partnerName]);
  await pool.query(`insert into memberships (user_id, role, partner_id) values ($1, 'partner', $2)
    on conflict (user_id, role) do update set partner_id = excluded.partner_id`, [userId, partner.rows[0].id]);
  return partner.rows[0].id;
}

async function freeSlot(placeName) {
  const { rows } = await pool.query(
    `select s.id, s.starts_at from availability_slots s
     join offers o on o.id = s.offer_id
     join places p on p.id = o.place_id
     where p.name = $1 and s.starts_at > now()
       and not exists (select 1 from bookings b where b.slot_id = s.id and b.status in ('requested','confirmed'))
     order by s.starts_at limit 1`, [placeName]);
  return rows[0];
}

// Миграции требуют роли-владельца схемы; если она задана отдельно,
// тесты используют её, а не прикладную роль.
const migratorPool = process.env.PGMIGRATOR_USER
  ? createPool({ user: process.env.PGMIGRATOR_USER, password: process.env.PGMIGRATOR_PASSWORD })
  : pool;

before(async () => {
  try {
    await pool.query('select 1');
    await migrate(migratorPool);
    // Тесты каталога и окон требуют демоданных; сид идемпотентен.
    await seed(pool);
    ready = true;
  } catch (error) {
    skipReason = `PostgreSQL недоступен: ${error.message}`;
    console.warn(skipReason);
  }
});

after(async () => {
  await app.close();
  if (migratorPool !== pool) await migratorPool.end();
  await pool.end();
});

test('живость и готовность различаются', async (t) => {
  assert.equal((await app.inject('/api/health/live')).statusCode, 200);
  if (!ready) return t.skip(skipReason);
  const readyResponse = await app.inject('/api/health/ready');
  assert.equal(readyResponse.statusCode, 200);
  assert.equal(readyResponse.json().database, 'ok');
});

test('каталог отдаёт карточки с ценой от и не кэшируется', async (t) => {
  if (!ready) return t.skip(skipReason);
  const all = await app.inject('/api/v1/places');
  assert.equal(all.statusCode, 200);
  assert.equal(all.headers['cache-control'], 'no-store');
  assert.ok(all.json().items.length >= 3);
  assert.ok(all.json().items.every(item => item.priceFrom && item.offerCount > 0));
  const salons = await app.inject('/api/v1/places?category=salon');
  assert.ok(salons.json().items.every(item => item.category === 'salon'));
  assert.equal((await app.inject('/api/v1/places?category=unknown')).statusCode, 400);
  assert.equal((await app.inject('/api/v1/places/not-a-uuid')).statusCode, 404);
});

test('вход по коду выдаёт сессию и отклоняет неверный код', async (t) => {
  if (!ready) return t.skip(skipReason);
  const number = phone();
  const code = await app.inject({ method: 'POST', url: '/api/v1/auth/code', payload: { phone: number } });
  const demoCode = code.json().demoCode;
  const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/session', payload: { phone: number, code: '000000' } });
  assert.equal(wrong.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/session', payload: { phone: number, code: demoCode } });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.headers['set-cookie'][0], /HttpOnly/);
  const me = await app.inject({ url: '/api/v1/me', headers: { cookie: `rjadom_sid=${cookiesOf(ok).rjadom_sid}` } });
  assert.equal(me.json().user.phone, number);
  assert.equal(me.json().roles[0].role, 'client');
});

test('двое одновременно берут один слот: проходит ровно одна запись', async (t) => {
  if (!ready) return t.skip(skipReason);
  const slot = await freeSlot('Форма');
  assert.ok(slot, 'нет свободного окна у «Форма»');
  const first = await login();
  const second = await login();
  const payload = { slotId: slot.id, idempotencyKey: `race-${Date.now()}` };
  const [a, b] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/v1/bookings', headers: first.headers, payload }),
    app.inject({ method: 'POST', url: '/api/v1/bookings', headers: second.headers, payload: { ...payload, idempotencyKey: `race2-${Date.now()}` } }),
  ]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [201, 409]);
  const winner = a.statusCode === 201 ? a : b;
  assert.equal(winner.json().status, 'requested');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: second.headers, payload: { slotId: slot.id } })).statusCode, 409);
});

test('повтор с тем же ключом идемпотентности не создаёт вторую запись', async (t) => {
  if (!ready) return t.skip(skipReason);
  const slot = await freeSlot('Линия');
  const user = await login();
  const key = `idem-${Date.now()}`;
  const first = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: user.headers, payload: { slotId: slot.id, idempotencyKey: key } });
  const again = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: user.headers, payload: { slotId: slot.id, idempotencyKey: key } });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().id, first.json().id);
});

test('партнёр видит и меняет только свои записи, чужой слот недоступен', async (t) => {
  if (!ready) return t.skip(skipReason);
  const slot = await freeSlot('Форма');
  const client = await login();
  const booking = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: client.headers, payload: { slotId: slot.id } });
  assert.equal(booking.statusCode, 201, booking.body);

  const outsider = await login();
  await addPartnerRole(outsider.userId, 'Мастерская «Линия»');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/bookings/${booking.json().id}/confirm`, headers: outsider.headers })).statusCode, 403);

  const own = await login();
  await addPartnerRole(own.userId, 'Студия «Форма»');
  const list = await app.inject({ url: '/api/v1/partner/bookings', headers: own.headers });
  assert.ok(list.json().items.every(item => item.place.name !== 'Линия'));
  assert.ok(list.json().items.some(item => item.id === booking.json().id));
  const confirmed = await app.inject({ method: 'POST', url: `/api/v1/bookings/${booking.json().id}/confirm`, headers: own.headers });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().status, 'confirmed');

  const clientOrders = await app.inject({ url: '/api/v1/me/orders', headers: client.headers });
  assert.equal(clientOrders.json().items[0].status, 'confirmed');
  // чужой клиент не видит эту запись
  assert.equal((await app.inject({ url: `/api/v1/bookings/${booking.json().id}`, headers: outsider.headers })).statusCode, 403);
});

test('отмена освобождает окно', async (t) => {
  if (!ready) return t.skip(skipReason);
  const slot = await freeSlot('Мастерская на углу');
  const client = await login();
  const booking = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: client.headers, payload: { slotId: slot.id } });
  const offer = await pool.query('select offer_id from availability_slots where id = $1', [slot.id]);
  const before = await app.inject(`/api/v1/offers/${offer.rows[0].offer_id}/slots`);
  assert.ok(!before.json().slots.some(item => item.id === slot.id));
  const cancelled = await app.inject({ method: 'POST', url: `/api/v1/bookings/${booking.json().id}/cancel`, headers: client.headers });
  assert.equal(cancelled.statusCode, 200);
  const afterList = await app.inject(`/api/v1/offers/${offer.rows[0].offer_id}/slots`);
  assert.ok(afterList.json().slots.some(item => item.id === slot.id));
});

test('отзыв можно оставить один раз и только после завершения', async (t) => {
  if (!ready) return t.skip(skipReason);
  const slot = await freeSlot('Тихий час');
  const client = await login();
  const booking = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: client.headers, payload: { slotId: slot.id } });
  const id = booking.json().id;
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/reviews', headers: client.headers, payload: { bookingId: id, rating: 5 } })).statusCode, 409);

  const partner = await login();
  await addPartnerRole(partner.userId, 'Студия «Форма»');
  await app.inject({ method: 'POST', url: `/api/v1/bookings/${id}/confirm`, headers: partner.headers });
  await app.inject({ method: 'POST', url: `/api/v1/bookings/${id}/complete`, headers: partner.headers });

  const review = await app.inject({ method: 'POST', url: '/api/v1/reviews', headers: client.headers, payload: { bookingId: id, rating: 5, body: 'Хорошо' } });
  assert.equal(review.statusCode, 201, review.body);
  const second = await app.inject({ method: 'POST', url: '/api/v1/reviews', headers: client.headers, payload: { bookingId: id, rating: 4 } });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'review_exists');
});

test('изменение без сессии и без CSRF отклоняется', async (t) => {
  if (!ready) return t.skip(skipReason);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bookings', payload: { slotId: '00000000-0000-4000-8000-000000000000' } })).statusCode, 401);
  const user = await login();
  const noToken = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { cookie: user.headers.cookie }, payload: { slotId: '00000000-0000-4000-8000-000000000000' } });
  assert.equal(noToken.statusCode, 403);
  // Клиент не должен отправлять content-type JSON без тела: это не 500.
  const emptyBody = await app.inject({
    method: 'POST', url: '/api/v1/bookings',
    headers: { ...user.headers, 'content-type': 'application/json' }, payload: '',
  });
  assert.equal(emptyBody.statusCode, 400);
});

test('сессия хранится только хешем', async (t) => {
  if (!ready) return t.skip(skipReason);
  const user = await login();
  const sid = user.headers.cookie.split('=')[1];
  const found = await pool.query('select 1 from sessions where token_hash = $1', [tokenHash(sid)]);
  assert.equal(found.rowCount, 1);
  const plain = await pool.query('select 1 from sessions where token_hash = $1', [sid]);
  assert.equal(plain.rowCount, 0);
});
