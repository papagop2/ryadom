// Проверки API на реальной тестовой БД. Без доступной БД тесты помечаются
// skip, чтобы сборка не врала о покрытии.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool } from '../api/db.mjs';
import { migrate } from '../db/migrate.mjs';
import { seed } from '../db/seed.mjs';
import { makeServer } from '../api/server.mjs';
import { tokenHash } from '../api/security.mjs';
import { createECDH, randomBytes } from 'node:crypto';

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

async function addCourierRole(userId) {
  await pool.query(`insert into memberships (user_id, role) values ($1, 'courier')
    on conflict (user_id, role) do nothing`, [userId]);
  await pool.query(`insert into courier_profiles (user_id, transport) values ($1, 'Тестовый')
    on conflict (user_id) do update set transport = excluded.transport`, [userId]);
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
  const all = await app.inject('/api/v1/places?city=demograd');
  assert.equal(all.statusCode, 200);
  assert.equal(all.headers['cache-control'], 'no-store');
  assert.ok(all.json().items.length >= 3);
  assert.ok(all.json().items.every(item => item.priceFrom && item.offerCount > 0));
  const salons = await app.inject('/api/v1/places?city=demograd&category=salon');
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
  const completed = await app.inject({ method: 'POST', url: `/api/v1/bookings/${id}/complete`, headers: partner.headers });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json().status, 'confirmed');
  assert.deepEqual(completed.json().cash, { client: false, provider: true });
  const paid = await app.inject({ method: 'POST', url: `/api/v1/bookings/${id}/cash`, headers: client.headers });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().status, 'completed');
  assert.deepEqual(paid.json().cash, { client: true, provider: true });

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
  const paid = await app.inject({ method: 'POST', url: `/api/v1/bookings/${booking.json().id}/cash`, headers: client.headers });
  assert.equal(paid.statusCode, 200, paid.body);
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
  const from = { label: 'Центр', address: 'Москва, Красная площадь, 1', lat: 55.7601, lng: 37.6186 };
  const to = { label: 'Аэропорт', address: 'Москва, Шереметьевское шоссе', lat: 55.9726, lng: 37.4146 };
  const estimate = await app.inject({ method: 'POST', url: '/api/v1/trips/estimate', payload: { from, to } });
  assert.equal(estimate.statusCode, 200, estimate.body);
  assert.ok(estimate.json().distanceKm > 10);
  assert.equal(estimate.json().price, undefined);
  assert.equal(estimate.json().tariff, undefined);

  const key = `trip-${Date.now()}`;
  const scheduledFor = new Date(Date.now() + 3600_000).toISOString();
  const stops = [{ label: 'Набережная', address: 'Москва, набережная, 1', lat: 55.7502, lng: 37.6203 }];
  const created = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: client.headers,
    payload: { from, to, stops, scheduledFor, passengers: 3, childSeat: true, luggage: true,
      comment: 'Один чемодан', idempotencyKey: key } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().status, 'requested');
  assert.equal(created.json().price, null);
  assert.equal(created.json().from.address, from.address);
  assert.equal(created.json().stops.length, 1);
  assert.equal(created.json().stops[0].address, 'Москва, набережная, 1');
  assert.equal(created.json().scheduledFor, scheduledFor);
  assert.deepEqual(created.json().requirements, { passengers: 3, childSeat: true, luggage: true, pets: false, comment: 'Один чемодан' });
  assert.ok(created.json().offersUntil);
  assert.ok(created.json().offersLeft > 0);
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
  const offered = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/offers`, headers: driver.headers,
    payload: { priceCents: 50000, etaMin: 7, message: 'Буду через семь минут' } });
  assert.equal(offered.statusCode, 201, offered.body);
  assert.equal(offered.json().price.cents, 50000);
  assert.equal(offered.json().driver.id, driver.userId);

  const withOffer = await app.inject({ url: '/api/v1/me/trips', headers: client.headers });
  const offeredTrip = withOffer.json().items.find(item => item.id === tripId);
  assert.equal(offeredTrip.offers.length, 1);
  assert.equal(offeredTrip.offers[0].price.cents, 50000);
  assert.equal(offeredTrip.price, null);

  const accepted = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/offers/${offered.json().id}/accept`,
    headers: client.headers });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().status, 'assigned');
  assert.equal(accepted.json().driver.id, driver.userId);
  assert.equal(accepted.json().price.cents, 50000);
  assert.equal(accepted.json().offers[0].status, 'accepted');

  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/arrive`, headers: driver.headers })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/start`, headers: driver.headers })).statusCode, 200);
  const completed = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/complete`, headers: driver.headers });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json().status, 'completed');

  const mine = await app.inject({ url: '/api/v1/me/trips', headers: client.headers });
  const seen = mine.json().items.find(item => item.id === tripId);
  assert.equal(seen.status, 'completed');
  assert.equal(seen.price.cents, 50000);
  assert.equal(seen.stops.length, 1);
  assert.equal(seen.cash.client, false);
  assert.equal(seen.cash.driver, false);

  const cashClient = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/cash`, headers: client.headers });
  assert.equal(cashClient.statusCode, 200, cashClient.body);
  assert.equal(cashClient.json().cash.client, true);
  assert.equal(cashClient.json().cash.driver, false);
  const cashDriver = await app.inject({ method: 'POST', url: `/api/v1/trips/${tripId}/cash`, headers: driver.headers });
  assert.equal(cashDriver.statusCode, 200, cashDriver.body);
  assert.equal(cashDriver.json().cash.client, true);
  assert.equal(cashDriver.json().cash.driver, true);

  const driverHistory = await app.inject({ url: '/api/v1/driver/trips', headers: driver.headers });
  assert.ok(driverHistory.json().completed.some(item => item.id === tripId));
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
    headers: operator.headers, payload: { driverUserId: driver.userId, priceCents: 45000 } });
  assert.equal(assigned.statusCode, 200, assigned.body);
  assert.equal(assigned.json().status, 'assigned');
  assert.equal(assigned.json().driver.id, driver.userId);
  assert.equal(assigned.json().price.cents, 45000);

  const busy = await app.inject({ method: 'POST', url: `/api/v1/operator/trips/${second.json().id}/assign`,
    headers: operator.headers, payload: { driverUserId: driver.userId, priceCents: 45000 } });
  assert.equal(busy.statusCode, 409, busy.body);
  assert.equal(busy.json().error, 'driver_busy');

  for (const action of ['arrive', 'start', 'complete']) {
    const moved = await app.inject({ method: 'POST', url: `/api/v1/trips/${first.json().id}/${action}`, headers: driver.headers });
    assert.equal(moved.statusCode, 200, moved.body);
  }
  const nowFree = await app.inject({ method: 'POST', url: `/api/v1/operator/trips/${second.json().id}/assign`,
    headers: operator.headers, payload: { driverUserId: driver.userId, priceCents: 45000 } });
  assert.equal(nowFree.statusCode, 200, nowFree.body);
});

test('выезд: заявка, предложения партнёров, выбор цены и выполнение', async (t) => {
  if (!ready) return t.skip(skipReason);
  const client = await login();
  const partnerA = await login();
  const partnerB = await login();
  const partnerAId = await addPartnerRole(partnerA.userId, 'Студия «Форма»');
  const partnerBId = await addPartnerRole(partnerB.userId, 'Мастерская «Линия»');
  const preferredFrom = new Date(Date.now() + 86400000);
  const preferredTo = new Date(Date.now() + 90000000);
  const payload = {
    category: 'repair', title: 'Починить смеситель', description: 'Течёт кран на кухне',
    address: 'ул. Тестовая, 7', budgetMinCents: 150000, budgetMaxCents: 400000,
    preferredFrom: preferredFrom.toISOString(), preferredTo: preferredTo.toISOString(),
    idempotencyKey: `service-${Date.now()}`,
  };

  const created = await app.inject({ method: 'POST', url: '/api/v1/me/service-requests', headers: client.headers, payload });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().status, 'open');
  assert.equal(created.json().price, null);
  const requestId = created.json().id;

  const again = await app.inject({ method: 'POST', url: '/api/v1/me/service-requests', headers: client.headers, payload });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().id, requestId);

  const badBudget = await app.inject({ method: 'POST', url: '/api/v1/me/service-requests', headers: client.headers,
    payload: { ...payload, idempotencyKey: `bad-${Date.now()}`, budgetMinCents: 500000 } });
  assert.equal(badBudget.statusCode, 400);

  const seenByA = await app.inject({ url: '/api/v1/partner/service-requests', headers: partnerA.headers });
  assert.equal(seenByA.statusCode, 200, seenByA.body);
  assert.ok(seenByA.json().open.some(item => item.id === requestId));
  assert.equal(seenByA.json().open.find(item => item.id === requestId).client.phone, undefined);

  const offerA = await app.inject({ method: 'POST', url: `/api/v1/partner/service-requests/${requestId}/offers`,
    headers: partnerA.headers, payload: { priceCents: 300000, message: 'Приеду завтра', etaMin: 60 } });
  assert.equal(offerA.statusCode, 201, offerA.body);
  assert.equal(offerA.json().status, 'pending');
  assert.equal(offerA.json().partner.id, partnerAId);

  const duplicate = await app.inject({ method: 'POST', url: `/api/v1/partner/service-requests/${requestId}/offers`,
    headers: partnerA.headers, payload: { priceCents: 290000 } });
  assert.equal(duplicate.statusCode, 409);

  const offerB = await app.inject({ method: 'POST', url: `/api/v1/partner/service-requests/${requestId}/offers`,
    headers: partnerB.headers, payload: { priceCents: 250000 } });
  assert.equal(offerB.statusCode, 201, offerB.body);
  assert.equal(offerB.json().partner.id, partnerBId);

  const mine = await app.inject({ url: '/api/v1/me/service-requests', headers: client.headers });
  const withOffers = mine.json().items.find(item => item.id === requestId);
  assert.equal(withOffers.offers.length, 2);

  const accepted = await app.inject({ method: 'POST',
    url: `/api/v1/me/service-requests/${requestId}/offers/${offerB.json().id}/accept`, headers: client.headers });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().status, 'assigned');
  assert.equal(accepted.json().price.cents, 250000);
  assert.equal(accepted.json().partner.name, 'Мастерская «Линия»');
  assert.equal(accepted.json().offers.find(offer => offer.id === offerA.json().id).status, 'declined');

  assert.equal((await app.inject({ method: 'POST',
    url: `/api/v1/me/service-requests/${requestId}/offers/${offerA.json().id}/accept`, headers: client.headers })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST',
    url: `/api/v1/partner/service-requests/${requestId}/start`, headers: partnerA.headers })).statusCode, 403);

  const started = await app.inject({ method: 'POST',
    url: `/api/v1/partner/service-requests/${requestId}/start`, headers: partnerB.headers });
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(started.json().status, 'in_progress');
  const earlyCash = await app.inject({ method: 'POST',
    url: `/api/v1/me/service-requests/${requestId}/cash`, headers: client.headers });
  assert.equal(earlyCash.statusCode, 409);
  assert.equal(earlyCash.json().error, 'cash_not_ready');

  const completed = await app.inject({ method: 'POST',
    url: `/api/v1/partner/service-requests/${requestId}/complete`, headers: partnerB.headers });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json().status, 'awaiting_cash');
  assert.deepEqual(completed.json().cash, { client: false, provider: true });

  const paid = await app.inject({ method: 'POST',
    url: `/api/v1/me/service-requests/${requestId}/cash`, headers: client.headers });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().status, 'completed');
  assert.deepEqual(paid.json().cash, { client: true, provider: true });
  assert.equal(paid.json().price.cents, 250000);

  const jobs = await app.inject({ url: '/api/v1/partner/service-requests', headers: partnerB.headers });
  assert.equal(jobs.json().jobs.find(item => item.id === requestId), undefined);
});

test('товары: витрина, остатки, самовывоз и изоляция заказов', async (t) => {
  if (!ready) return t.skip(skipReason);
  const client = await login();
  const partner = await login();
  await addPartnerRole(partner.userId, 'Мастерская «Линия»');
  const catalogue = await app.inject({ url: '/api/v1/places?city=demograd&category=food' });
  const place = catalogue.json().items.find(item => item.name === 'Кухня на районе');
  assert.ok(place, 'нужна витрина «Кухня на районе»');
  const detail = await app.inject({ url: `/api/v1/places/${place.id}` });
  assert.equal(detail.statusCode, 200, detail.body);
  const lunch = detail.json().products.find(item => item.title === 'Обед дня');
  const drink = detail.json().products.find(item => item.title === 'Компот');
  assert.ok(lunch && drink, 'товары должны попадать в карточку');
  const stockBefore = lunch.stockQty;

  const key = `shop-${Date.now()}`;
  const created = await app.inject({ method: 'POST', url: '/api/v1/me/shop-orders', headers: client.headers,
    payload: { placeId: place.id, items: [{ productId: lunch.id, qty: 2 }, { productId: drink.id, qty: 1 }],
      note: 'Приду к 13:00', idempotencyKey: key } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().total.cents, lunch.price.cents * 2 + drink.price.cents);
  assert.match(created.json().pickupCode, /^[0-9]{4}$/);
  const orderId = created.json().id;

  const repeated = await app.inject({ method: 'POST', url: '/api/v1/me/shop-orders', headers: client.headers,
    payload: { placeId: place.id, items: [{ productId: lunch.id, qty: 2 }], idempotencyKey: key } });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().id, orderId);

  const afterOrder = await app.inject({ url: `/api/v1/places/${place.id}` });
  assert.equal(afterOrder.json().products.find(item => item.id === lunch.id).stockQty, stockBefore - 2);

  const partnerOrders = await app.inject({ url: '/api/v1/partner/shop-orders', headers: partner.headers });
  assert.equal(partnerOrders.statusCode, 200, partnerOrders.body);
  assert.ok(partnerOrders.json().items.some(item => item.id === orderId));
  const otherPartner = await login();
  await addPartnerRole(otherPartner.userId, 'Студия «Форма»');
  const foreign = await app.inject({ url: '/api/v1/partner/shop-orders', headers: otherPartner.headers });
  assert.equal(foreign.json().items.some(item => item.id === orderId), false);

  for (const action of ['confirm', 'ready']) {
    const moved = await app.inject({ method: 'POST', url: `/api/v1/partner/shop-orders/${orderId}/status`,
      headers: partner.headers, payload: { action } });
    assert.equal(moved.statusCode, 200, moved.body);
  }
  const earlyCash = await app.inject({ method: 'POST', url: `/api/v1/me/shop-orders/${orderId}/cash`,
    headers: client.headers });
  assert.equal(earlyCash.statusCode, 409);
  assert.equal(earlyCash.json().error, 'cash_not_ready');
  const handed = await app.inject({ method: 'POST', url: `/api/v1/partner/shop-orders/${orderId}/status`,
    headers: partner.headers, payload: { action: 'complete' } });
  assert.equal(handed.statusCode, 200, handed.body);
  assert.equal(handed.json().status, 'awaiting_cash');
  assert.deepEqual(handed.json().cash, { client: false, provider: true });
  const paid = await app.inject({ method: 'POST', url: `/api/v1/me/shop-orders/${orderId}/cash`,
    headers: client.headers });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().status, 'completed');
  assert.deepEqual(paid.json().cash, { client: true, provider: true });
  const mine = await app.inject({ url: '/api/v1/me/shop-orders', headers: client.headers });
  assert.equal(mine.json().items.find(item => item.id === orderId).status, 'completed');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/me/shop-orders/${orderId}/cancel`,
    headers: client.headers })).statusCode, 409);

  const tooMany = await app.inject({ method: 'POST', url: '/api/v1/me/shop-orders', headers: client.headers,
    payload: { placeId: place.id, items: [{ productId: lunch.id, qty: 100 }], idempotencyKey: `many-${Date.now()}` } });
  assert.equal(tooMany.statusCode, 400);

  const second = await app.inject({ method: 'POST', url: '/api/v1/me/shop-orders', headers: client.headers,
    payload: { placeId: place.id, items: [{ productId: lunch.id, qty: 29 }], idempotencyKey: `stock-${Date.now()}` } });
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().error, 'out_of_stock');

  const beforeCancel = (await app.inject({ url: `/api/v1/places/${place.id}` })).json()
    .products.find(item => item.id === lunch.id).stockQty;
  const cancellable = await app.inject({ method: 'POST', url: '/api/v1/me/shop-orders', headers: client.headers,
    payload: { placeId: place.id, items: [{ productId: lunch.id, qty: 1 }], idempotencyKey: `cancel-${Date.now()}` } });
  assert.equal(cancellable.statusCode, 201, cancellable.body);
  const cancelled = await app.inject({ method: 'POST', url: `/api/v1/me/shop-orders/${cancellable.json().id}/cancel`,
    headers: client.headers });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().status, 'cancelled');
  const afterCancel = (await app.inject({ url: `/api/v1/places/${place.id}` })).json()
    .products.find(item => item.id === lunch.id).stockQty;
  assert.equal(afterCancel, beforeCancel);
});

test('товары: партнёр добавляет позицию и меняет остаток', async (t) => {
  if (!ready) return t.skip(skipReason);
  const partner = await login();
  await addPartnerRole(partner.userId, 'Мастерская «Линия»');
  const places = await app.inject({ url: '/api/v1/partner/places', headers: partner.headers });
  const kitchen = places.json().items.find(item => item.name === 'Кухня на районе');
  assert.ok(kitchen);
  const title = `Тестовый товар ${Date.now()}`;
  const created = await app.inject({ method: 'POST', url: `/api/v1/partner/places/${kitchen.id}/products`,
    headers: partner.headers, payload: { title, priceCents: 12300, stockQty: 4, unit: 'шт' } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().stockQty, 4);
  const updated = await app.inject({ method: 'PATCH', url: `/api/v1/partner/products/${created.json().id}`,
    headers: partner.headers, payload: { stockQty: 9, priceCents: 15000 } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().stockQty, 9);
  assert.equal(updated.json().price.cents, 15000);
  const publicPlace = await app.inject({ url: `/api/v1/places/${kitchen.id}` });
  assert.equal(publicPlace.json().products.find(item => item.id === created.json().id).stockQty, 9);
  const outsider = await login();
  const forbidden = await app.inject({ method: 'PATCH', url: `/api/v1/partner/products/${created.json().id}`,
    headers: outsider.headers, payload: { stockQty: 1 } });
  assert.equal(forbidden.statusCode, 403);
});

test('доставка: зона, сбор за доставку и путь курьера', async (t) => {
  if (!ready) return t.skip(skipReason);
  const client = await login();
  const partner = await login();
  await addPartnerRole(partner.userId, 'Мастерская «Линия»');
  const courier = await login();
  await addCourierRole(courier.userId);
  const place = (await app.inject({ url: '/api/v1/places?city=demograd&category=food' })).json().items
    .find(item => item.name === 'Кухня на районе');
  const detail = (await app.inject({ url: `/api/v1/places/${place.id}` })).json();
  assert.equal(detail.delivery.available, true);
  const zone = detail.delivery.zones.find(item => item.district === 'Центр');
  assert.ok(zone, 'должна быть зона Центр');
  const lunch = detail.products.find(item => item.title === 'Обед дня');
  assert.ok(lunch);
  const payload = {
    placeId: place.id, items: [{ productId: lunch.id, qty: 1 }],
    fulfillment: 'delivery', deliveryDistrict: 'Центр', deliveryAddress: 'ул. Тестовая, 1',
  };
  const created = await app.inject({ method: 'POST', url: '/api/v1/me/shop-orders', headers: client.headers,
    payload: { ...payload, idempotencyKey: `delivery-${Date.now()}` } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().fulfillment, 'delivery');
  assert.equal(created.json().goods.cents, lunch.price.cents);
  assert.equal(created.json().deliveryFee.cents, zone.fee.cents);
  assert.equal(created.json().total.cents, lunch.price.cents + zone.fee.cents);
  assert.equal(created.json().delivery.status, 'pending');
  const orderId = created.json().id;

  const noAddress = await app.inject({ method: 'POST', url: '/api/v1/me/shop-orders', headers: client.headers,
    payload: { ...payload, deliveryAddress: '', idempotencyKey: `noaddr-${Date.now()}` } });
  assert.equal(noAddress.statusCode, 400);
  const unknownZone = await app.inject({ method: 'POST', url: '/api/v1/me/shop-orders', headers: client.headers,
    payload: { ...payload, deliveryDistrict: 'Луна', idempotencyKey: `moon-${Date.now()}` } });
  assert.equal(unknownZone.statusCode, 409);
  const drink = detail.products.find(item => item.title === 'Компот');
  const tooSmall = await app.inject({ method: 'POST', url: '/api/v1/me/shop-orders', headers: client.headers,
    payload: { ...payload, items: [{ productId: drink.id, qty: 1 }], idempotencyKey: `small-${Date.now()}` } });
  assert.equal(tooSmall.statusCode, 409);
  assert.equal(tooSmall.json().error, 'min_order');

  for (const action of ['confirm', 'ready']) {
    const moved = await app.inject({ method: 'POST', url: `/api/v1/partner/shop-orders/${orderId}/status`,
      headers: partner.headers, payload: { action } });
    assert.equal(moved.statusCode, 200, moved.body);
  }
  const partnerComplete = await app.inject({ method: 'POST', url: `/api/v1/partner/shop-orders/${orderId}/status`,
    headers: partner.headers, payload: { action: 'complete' } });
  assert.equal(partnerComplete.statusCode, 409);
  assert.equal(partnerComplete.json().error, 'courier_required');

  const available = await app.inject({ url: '/api/v1/courier/delivery-jobs', headers: courier.headers });
  const job = available.json().available.find(item => item.orderId === orderId);
  assert.ok(job, 'готовый заказ должен быть доступен курьеру');
  const claimed = await app.inject({ method: 'POST', url: `/api/v1/courier/delivery-jobs/${job.id}/claim`,
    headers: courier.headers });
  assert.equal(claimed.statusCode, 200, claimed.body);
  assert.equal(claimed.json().status, 'assigned');
  assert.equal(claimed.json().courier.id, courier.userId);
  const picked = await app.inject({ method: 'POST', url: `/api/v1/courier/delivery-jobs/${job.id}/pickup`,
    headers: courier.headers });
  assert.equal(picked.statusCode, 200, picked.body);
  assert.equal(picked.json().status, 'picked_up');
  assert.equal(picked.json().order.status, 'out_for_delivery');
  const delivered = await app.inject({ method: 'POST', url: `/api/v1/courier/delivery-jobs/${job.id}/deliver`,
    headers: courier.headers });
  assert.equal(delivered.statusCode, 200, delivered.body);
  assert.equal(delivered.json().status, 'delivered');
  assert.equal(delivered.json().order.status, 'awaiting_cash');
  const mine = await app.inject({ url: '/api/v1/me/shop-orders', headers: client.headers });
  const deliveredOrder = mine.json().items.find(item => item.id === orderId);
  assert.equal(deliveredOrder.delivery.status, 'delivered');
  assert.equal(deliveredOrder.status, 'awaiting_cash');
  assert.deepEqual(deliveredOrder.cash, { client: false, provider: true });
  const paid = await app.inject({ method: 'POST', url: `/api/v1/me/shop-orders/${orderId}/cash`,
    headers: client.headers });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().status, 'completed');
  assert.deepEqual(paid.json().cash, { client: true, provider: true });
});

test('push: публичный ключ и подписка устройства', async (t) => {
  if (!ready) return t.skip(skipReason);
  const client = await login();
  const key = await app.inject({ url: '/api/v1/push/public-key' });
  assert.equal(key.statusCode, 200, key.body);
  assert.equal(typeof key.json().enabled, 'boolean');

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const endpoint = `https://push.example.test/${randomBytes(6).toString('hex')}`;
  const invalid = await app.inject({ method: 'POST', url: '/api/v1/me/push-subscriptions',
    headers: client.headers, payload: { endpoint: 'http://insecure.example/push', p256dh: 'x', auth: 'y' } });
  assert.equal(invalid.statusCode, 400);
  const added = await app.inject({ method: 'POST', url: '/api/v1/me/push-subscriptions',
    headers: client.headers, payload: {
      endpoint, p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'), userAgent: 'test',
    } });
  assert.equal(added.statusCode, 200, added.body);
  assert.equal(added.json().subscribed, true);

  const list = await app.inject({ url: '/api/v1/me/push-subscriptions', headers: client.headers });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().items.some(item => item.endpoint === endpoint), true);

  const removed = await app.inject({ method: 'DELETE', url: '/api/v1/me/push-subscriptions',
    headers: client.headers, payload: { endpoint } });
  assert.equal(removed.statusCode, 200, removed.body);
  const after = await app.inject({ url: '/api/v1/me/push-subscriptions', headers: client.headers });
  assert.equal(after.json().items.some(item => item.endpoint === endpoint), false);
});

test('избранное: добавить, увидеть и убрать заведение', async (t) => {
  if (!ready) return t.skip(skipReason);
  const client = await login();
  const place = (await pool.query("select id from places where name = 'Форма'")).rows[0];
  await pool.query('delete from favorites where user_id = $1 and place_id = $2', [client.userId, place.id]);

  const added = await app.inject({ method: 'POST', url: `/api/v1/me/favorites/${place.id}`, headers: client.headers });
  assert.equal(added.statusCode, 200, added.body);
  assert.equal(added.json().favorite, true);
  const repeated = await app.inject({ method: 'POST', url: `/api/v1/me/favorites/${place.id}`, headers: client.headers });
  assert.equal(repeated.statusCode, 200, repeated.body);

  const list = await app.inject({ url: '/api/v1/me/favorites', headers: client.headers });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().items.filter(item => item.id === place.id).length, 1);
  assert.equal(list.json().items.find(item => item.id === place.id).isFavorite, true);

  const removed = await app.inject({ method: 'DELETE', url: `/api/v1/me/favorites/${place.id}`, headers: client.headers });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().favorite, false);
  const after = await app.inject({ url: '/api/v1/me/favorites', headers: client.headers });
  assert.equal(after.json().items.some(item => item.id === place.id), false);
});

test('живая очередь: талон, вызов и завершение визита', async (t) => {
  if (!ready) return t.skip(skipReason);
  const client = await login();
  const partner = await login();
  await addPartnerRole(partner.userId, 'Студия «Форма»');
  const place = (await pool.query("select id from places where name = 'Форма'")).rows[0];
  await pool.query('delete from queue_tickets where place_id = $1', [place.id]);
  await pool.query('delete from queue_days where place_id = $1', [place.id]);

  const settings = await app.inject({ method: 'PUT', url: `/api/v1/partner/places/${place.id}/queue`,
    headers: partner.headers, payload: { isActive: true, avgMinutes: 12, notice: 'Тестовая очередь' } });
  assert.equal(settings.statusCode, 200, settings.body);
  assert.equal(settings.json().isActive, true);

  const first = await app.inject({ method: 'POST', url: `/api/v1/places/${place.id}/queue`,
    headers: client.headers, payload: { note: 'Тест' } });
  assert.equal(first.statusCode, 201, first.body);
  const ticket = first.json().myTicket;
  assert.equal(ticket.status, 'waiting');
  assert.equal(ticket.number, 1);
  assert.equal(first.json().position, 1);

  const repeated = await app.inject({ method: 'POST', url: `/api/v1/places/${place.id}/queue`,
    headers: client.headers, payload: {} });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().myTicket.id, ticket.id);

  const partnerQueue = await app.inject({ url: `/api/v1/partner/places/${place.id}/queue`, headers: partner.headers });
  assert.equal(partnerQueue.statusCode, 200, partnerQueue.body);
  assert.equal(partnerQueue.json().tickets.length, 1);

  const called = await app.inject({ method: 'POST', url: `/api/v1/partner/places/${place.id}/queue/next`,
    headers: partner.headers });
  assert.equal(called.statusCode, 200, called.body);
  assert.equal(called.json().status, 'called');
  const clientQueue = await app.inject({ url: `/api/v1/places/${place.id}/queue`, headers: client.headers });
  assert.equal(clientQueue.json().myTicket.status, 'called');

  const serving = await app.inject({ method: 'POST', url: `/api/v1/partner/queue/${ticket.id}/status`,
    headers: partner.headers, payload: { action: 'serving' } });
  assert.equal(serving.statusCode, 200, serving.body);
  assert.equal(serving.json().status, 'serving');
  const done = await app.inject({ method: 'POST', url: `/api/v1/partner/queue/${ticket.id}/status`,
    headers: partner.headers, payload: { action: 'done' } });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().status, 'done');

  const second = await app.inject({ method: 'POST', url: `/api/v1/places/${place.id}/queue`,
    headers: client.headers, payload: {} });
  assert.equal(second.statusCode, 201, second.body);
  assert.equal(second.json().myTicket.number, 2);
  const cancelled = await app.inject({ method: 'POST', url: `/api/v1/queue/${second.json().myTicket.id}/cancel`,
    headers: client.headers });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().status, 'cancelled');
  await pool.query('delete from queue_tickets where place_id = $1', [place.id]);
  await pool.query('delete from queue_days where place_id = $1', [place.id]);
});

test('доставка: оператор назначает курьера и видит активные задания', async (t) => {
  if (!ready) return t.skip(skipReason);
  const client = await login();
  const partner = await login();
  await addPartnerRole(partner.userId, 'Мастерская «Линия»');
  const courier = await login();
  await addCourierRole(courier.userId);
  const operator = await login();
  await addOperatorRole(operator.userId);
  const place = (await app.inject({ url: '/api/v1/places?city=demograd&category=food' })).json().items
    .find(item => item.name === 'Кухня на районе');
  const detail = (await app.inject({ url: `/api/v1/places/${place.id}` })).json();
  const lunch = detail.products.find(item => item.title === 'Обед дня');
  const created = await app.inject({ method: 'POST', url: '/api/v1/me/shop-orders', headers: client.headers,
    payload: { placeId: place.id, items: [{ productId: lunch.id, qty: 1 }], fulfillment: 'delivery',
      deliveryDistrict: 'Центр', deliveryAddress: 'ул. Операторская, 7', idempotencyKey: `assign-${Date.now()}` } });
  assert.equal(created.statusCode, 201, created.body);
  for (const action of ['confirm', 'ready']) {
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/partner/shop-orders/${created.json().id}/status`,
      headers: partner.headers, payload: { action } })).statusCode, 200);
  }
  const jobs = await app.inject({ url: '/api/v1/operator/delivery-jobs', headers: operator.headers });
  const job = jobs.json().items.find(item => item.orderId === created.json().id);
  assert.ok(job);
  const couriers = await app.inject({ url: '/api/v1/operator/couriers', headers: operator.headers });
  assert.ok(couriers.json().items.some(item => item.id === courier.userId));
  const assigned = await app.inject({ method: 'POST', url: `/api/v1/operator/delivery-jobs/${job.id}/assign`,
    headers: operator.headers, payload: { courierUserId: courier.userId } });
  assert.equal(assigned.statusCode, 200, assigned.body);
  assert.equal(assigned.json().status, 'assigned');
  assert.equal(assigned.json().courier.id, courier.userId);
  const mine = await app.inject({ url: '/api/v1/courier/delivery-jobs', headers: courier.headers });
  assert.ok(mine.json().mine.some(item => item.id === job.id));
});

test('Слюдянка: каталог 2ГИС, честный источник и отзыв от аккаунта', async (t) => {
  if (!ready) return t.skip(skipReason);
  const cities = await app.inject('/api/v1/cities');
  assert.equal(cities.statusCode, 200, cities.body);
  const city = cities.json().items.find(item => item.slug === 'slyudyanka');
  assert.ok(city, 'Слюдянка должна быть в списке городов');
  assert.ok(city.places >= 290, `ожидалось >= 290 мест, пришло ${city.places}`);
  assert.ok(!cities.json().items.some(item => item.slug === 'demograd'), 'демо-город не показывается в рабочем списке');

  const list = await app.inject('/api/v1/places?city=slyudyanka&limit=50');
  assert.equal(list.statusCode, 200, list.body);
  const imported = list.json().items.find(item => item.source?.name === '2ГИС'
    && /^https:\/\/2gis\.ru\/slyudyanka\/firm\//.test(item.source.url));
  assert.ok(imported, 'в каталоге должны быть организации 2ГИС');
  assert.equal(imported.offerCount, 0);
  assert.match(imported.image, /^https:\/\/i\d\.photo\.2gis\.com\//);

  const map = await app.inject('/api/v1/places/map?city=slyudyanka');
  assert.equal(map.statusCode, 200, map.body);
  assert.equal(map.json().total, city.places, 'карта должна отдавать весь каталог города');
  assert.equal(map.json().items.length, map.json().total);
  assert.ok(map.json().items.some(item => item.source?.kind === 'osm'), 'на карте должен быть слой OpenStreetMap');

  const detail = await app.inject(`/api/v1/places/${imported.id}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().place.bookable, false);
  assert.equal(detail.json().place.source.name, '2ГИС');
  assert.ok(detail.json().place.photos.length > 0, 'у карточки должна быть фотолента');
  assert.match(detail.json().place.photos[0].large, /_656x340\.jpg$/);
  assert.ok(detail.json().reviews.some(review => review.source === '2gis'));
  assert.ok(detail.json().reviews.every(review => review.source === '2gis'));

  const client = await login();
  const created = await app.inject({ method: 'POST', url: `/api/v1/places/${imported.id}/reviews`,
    headers: client.headers, payload: { rating: 5, body: 'Проверка отзыва из аккаунта Рядом' } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().status, 'pending');
  const again = await app.inject({ method: 'POST', url: `/api/v1/places/${imported.id}/reviews`,
    headers: client.headers, payload: { rating: 4 } });
  assert.equal(again.statusCode, 409);
  const hidden = await app.inject(`/api/v1/places/${imported.id}`);
  assert.ok(hidden.json().reviews.every(review => review.source === '2gis'));

  const operator = await loginPhone('+79000000003');
  const queue = await app.inject({ url: '/api/v1/operator/reviews', headers: operator.headers });
  const pending = queue.json().items.find(review => review.id === created.json().id);
  assert.ok(pending, 'отзыв о месте должен попасть в очередь модерации');
  const moderated = await app.inject({ method: 'POST', url: `/api/v1/operator/reviews/${pending.id}/moderate`,
    headers: operator.headers, payload: { action: 'publish' } });
  assert.equal(moderated.statusCode, 200, moderated.body);
  const shown = await app.inject(`/api/v1/places/${imported.id}`);
  assert.equal(shown.json().reviews[0].source, 'own');
  assert.equal(shown.json().place.rating, 5);
  assert.equal(shown.json().place.source.rating, imported.source.rating);
  await pool.query('delete from reviews where place_id=$1 and author_user_id=$2', [imported.id, client.userId]);
  await pool.query('update places set rating_avg = null, rating_count = 0 where id=$1', [imported.id]);
});
