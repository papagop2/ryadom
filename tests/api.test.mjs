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
     where p.name = $1 and o.is_active and p.is_published and s.starts_at > now()
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

async function addOperatorRole(userId) {
  await pool.query(`insert into memberships (user_id, role) values ($1, 'operator')
    on conflict (user_id, role) do nothing`, [userId]);
}

async function completeBooking(placeName) {
  const slot = await freeSlot(placeName);
  const client = await login();
  const booking = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: client.headers, payload: { slotId: slot.id } });
  assert.equal(booking.statusCode, 201, booking.body);
  const partner = await login();
  await addPartnerRole(partner.userId, 'Студия «Форма»');
  await app.inject({ method: 'POST', url: `/api/v1/bookings/${booking.json().id}/confirm`, headers: partner.headers });
  await app.inject({ method: 'POST', url: `/api/v1/bookings/${booking.json().id}/complete`, headers: partner.headers });
  return { client, booking: booking.json(), placeId: (await pool.query(
    'select o.place_id from bookings b join availability_slots s on s.id=b.slot_id join offers o on o.id=s.offer_id where b.id=$1',
    [booking.json().id])).rows[0].place_id };
}

test('отзыв ждёт модерации и публикуется только оператором', async (t) => {
  if (!ready) return t.skip(skipReason);
  const { client, booking } = await completeBooking('Форма');
  const review = await app.inject({ method: 'POST', url: '/api/v1/reviews', headers: client.headers,
    payload: { bookingId: booking.id, rating: 5, body: 'Модерация' } });
  assert.equal(review.statusCode, 201, review.body);
  assert.equal(review.json().status, 'pending');

  const publicBefore = await app.inject(`/api/v1/places/${(await pool.query(
    'select place_id from reviews where id=$1', [review.json().id])).rows[0].place_id}/reviews`);
  assert.ok(!publicBefore.json().items.some(item => item.id === review.json().id));

  const operator = await login();
  await addOperatorRole(operator.userId);
  const queue = await app.inject({ url: '/api/v1/operator/reviews?status=pending', headers: operator.headers });
  assert.equal(queue.statusCode, 200, queue.body);
  assert.ok(queue.json().items.some(item => item.id === review.json().id));

  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/operator/reviews/${review.json().id}/moderate`, headers: client.headers, payload: { action: 'publish' } })).statusCode, 403);
  const published = await app.inject({ method: 'POST', url: `/api/v1/operator/reviews/${review.json().id}/moderate`, headers: operator.headers, payload: { action: 'publish' } });
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().status, 'published');

  const placeId = (await pool.query('select place_id from reviews where id=$1', [review.json().id])).rows[0].place_id;
  const publicAfter = await app.inject(`/api/v1/places/${placeId}/reviews`);
  assert.ok(publicAfter.json().items.some(item => item.id === review.json().id));

  const hidden = await app.inject({ method: 'POST', url: `/api/v1/operator/reviews/${review.json().id}/moderate`, headers: operator.headers, payload: { action: 'hide' } });
  assert.equal(hidden.statusCode, 200);
  const publicHidden = await app.inject(`/api/v1/places/${placeId}/reviews`);
  assert.ok(!publicHidden.json().items.some(item => item.id === review.json().id));
});

test('партнёр редактирует только свою карточку и услуги', async (t) => {
  if (!ready) return t.skip(skipReason);
  const partner = await login();
  await addPartnerRole(partner.userId, 'Студия «Форма»');
  const ownList = await app.inject({ url: '/api/v1/partner/places', headers: partner.headers });
  assert.equal(ownList.statusCode, 200, ownList.body);
  const own = ownList.json().items.find(item => item.name === 'Форма');
  assert.ok(own);
  assert.ok(own.offers.length >= 1);

  const original = (await pool.query('select about, phone from places where id=$1', [own.id])).rows[0];
  let createdOfferId = null;
  try {
    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/partner/places/${own.id}`, headers: partner.headers,
      payload: { about: 'Обновлено тестом', phone: '+79000000099' } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().about, 'Обновлено тестом');

    const created = await app.inject({ method: 'POST', url: `/api/v1/partner/places/${own.id}/offers`, headers: partner.headers,
      payload: { title: `Тестовая услуга ${Date.now()}`, durationMin: 30, priceCents: 50000 } });
    assert.equal(created.statusCode, 201, created.body);
    createdOfferId = created.json().id;
    const slots = await app.inject({ method: 'POST', url: `/api/v1/partner/offers/${created.json().id}/slots`, headers: partner.headers,
      payload: { days: 2, hours: [9, 11] } });
    assert.equal(slots.statusCode, 200, slots.body);
    assert.equal(slots.json().created, 4);

    const deactivated = await app.inject({ method: 'PATCH', url: `/api/v1/partner/offers/${created.json().id}`, headers: partner.headers,
      payload: { isActive: false } });
    assert.equal(deactivated.statusCode, 200);
    assert.equal(deactivated.json().isActive, false);

    const outsider = await login();
    await addPartnerRole(outsider.userId, 'Мастерская «Линия»');
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/partner/places/${own.id}`, headers: outsider.headers, payload: { about: 'Чужое' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/partner/offers/${own.offers[0].id}`, headers: outsider.headers, payload: { title: 'Чужое' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/v1/partner/places', headers: outsider.headers })).json().items.every(item => item.name !== 'Форма'), true);
  } finally {
    if (createdOfferId) await pool.query('delete from offers where id=$1', [createdOfferId]);
    await pool.query('update places set about=$2, phone=$3 where id=$1', [own.id, original.about, original.phone]);
  }
});

async function loginPhone(number) {
  const code = await app.inject({ method: 'POST', url: '/api/v1/auth/code', payload: { phone: number } });
  assert.equal(code.statusCode, 200, code.body);
  const session = await app.inject({ method: 'POST', url: '/api/v1/auth/session',
    payload: { phone: number, code: code.json().demoCode } });
  assert.equal(session.statusCode, 200, session.body);
  const jar = cookiesOf(session);
  return { headers: { cookie: `rjadom_sid=${jar.rjadom_sid}`, 'x-csrf-token': jar.rjadom_csrf }, userId: session.json().user.id };
}

async function makeDriver() {
  const user = await login();
  await pool.query("insert into memberships (user_id, role) values ($1, 'driver') on conflict (user_id, role) do nothing", [user.userId]);
  await pool.query("insert into driver_profiles (user_id, car_model, plate) values ($1, 'Test', 'T000TT') on conflict (user_id) do nothing", [user.userId]);
  return user;
}

test('такси: оценка, заказ, принятие водителем и завершение', async (t) => {
  if (!ready) return t.skip(skipReason);
  const client = await login();
  const from = { label: 'Центр', lat: 55.7601, lng: 37.6186 };
  const to = { label: 'Аэропорт', lat: 55.9726, lng: 37.4146 };
  const estimate = await app.inject({ method: 'POST', url: '/api/v1/trips/estimate', payload: { from, to } });
  assert.equal(estimate.statusCode, 200, estimate.body);
  assert.ok(estimate.json().distanceKm > 10);
  assert.ok(estimate.json().price.cents >= 14900);

  const key = `trip-${Date.now()}`;
  const created = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: client.headers,
    payload: { from, to, idempotencyKey: key } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().status, 'requested');
  const tripId = created.json().id;

  const again = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: client.headers,
    payload: { from, to, idempotencyKey: key } });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().id, tripId);

  const second = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: client.headers,
    payload: { from, to, idempotencyKey: `trip2-${Date.now()}` } });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'active_trip');

  const driver = await makeDriver();
  const list = await app.inject({ url: '/api/v1/driver/trips', headers: driver.headers });
  assert.ok(list.json().available.some(item => item.id === tripId));
  const accepted = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/accept`, headers: driver.headers });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().status, 'assigned');
  assert.equal(accepted.json().driver.id, driver.userId);

  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/arrive`, headers: driver.headers })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/start`, headers: driver.headers })).statusCode, 200);
  const completed = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/complete`, headers: driver.headers });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json().status, 'completed');

  const mine = await app.inject({ url: '/api/v1/me/trips', headers: client.headers });
  const seen = mine.json().items.find(item => item.id === tripId);
  assert.equal(seen.status, 'completed');
  assert.ok(seen.price.cents >= 14900);
});

test('такси: чужая поездка недоступна, отмена освобождает клиента', async (t) => {
  if (!ready) return t.skip(skipReason);
  const client = await login();
  const from = { label: 'Дом', lat: 55.749, lng: 37.64 };
  const to = { label: 'Вокзал', lat: 55.776, lng: 37.655 };
  const created = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: client.headers, payload: { from, to } });
  assert.equal(created.statusCode, 201, created.body);
  const tripId = created.json().id;

  const stranger = await login();
  assert.equal((await app.inject({ url: `/api/v1/trips/${tripId}`, headers: stranger.headers })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/accept`, headers: stranger.headers })).statusCode, 403);

  const cancelled = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/cancel`, headers: client.headers });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().status, 'cancelled');

  const next = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: client.headers,
    payload: { from, to, idempotencyKey: `next-${Date.now()}` } });
  assert.equal(next.statusCode, 201, next.body);
});

test('такси: оператор назначает водителя и не даёт два активных заказа', async (t) => {
  if (!ready) return t.skip(skipReason);
  const operator = await login();
  await pool.query("insert into memberships (user_id, role) values ($1, 'operator') on conflict do nothing", [operator.userId]);
  const driver = await makeDriver();
  const firstClient = await login();
  const secondClient = await login();
  const from = { label: 'Офис', lat: 55.755, lng: 37.617 };
  const to = { label: 'Дом', lat: 55.741, lng: 37.632 };
  const first = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: firstClient.headers, payload: { from, to } });
  const second = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: secondClient.headers, payload: { from, to } });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(second.statusCode, 201, second.body);

  const assigned = await app.inject({ method: 'POST', url: `/api/v1/operator/trips/${first.json().id}/assign`,
    headers: operator.headers, payload: { driverUserId: driver.userId } });
  assert.equal(assigned.statusCode, 200, assigned.body);
  assert.equal(assigned.json().status, 'assigned');
  assert.equal(assigned.json().driver.id, driver.userId);

  const busy = await app.inject({ method: 'POST', url: `/api/v1/operator/trips/${second.json().id}/assign`,
    headers: operator.headers, payload: { driverUserId: driver.userId } });
  assert.equal(busy.statusCode, 409, busy.body);
  assert.equal(busy.json().error, 'driver_busy');

  for (const action of ['arrive', 'start', 'complete']) {
    const moved = await app.inject({ method: 'POST', url: `/api/v1/trips/${first.json().id}/${action}`, headers: driver.headers });
    assert.equal(moved.statusCode, 200, moved.body);
  }
  const nowFree = await app.inject({ method: 'POST', url: `/api/v1/operator/trips/${second.json().id}/assign`,
    headers: operator.headers, payload: { driverUserId: driver.userId } });
  assert.equal(nowFree.statusCode, 200, nowFree.body);
});
