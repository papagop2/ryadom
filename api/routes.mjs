// Маршруты «Рядом»: каталог, расписание, запись, отзывы, кабинеты.
// Правила доступа проверяются на сервере для каждого объекта.
import { randomInt } from 'node:crypto';
import {
  CODE_TTL_MS, CSRF_COOKIE, SESSION_COOKIE, SESSION_TTL_MS,
  clearSessionCookies, hashCode, normalizePhone, parseCookies, randomToken,
  safeEqual, setSessionCookies, tokenHash,
} from './security.mjs';
import { isUniqueViolation, withTransaction } from './db.mjs';

const CATEGORIES = ['salon', 'services', 'food', 'health'];
const ACTIVE = ['requested', 'confirmed'];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => { throw new HttpError(status, code, message); };

function requireUser(request) {
  if (!request.auth) fail(401, 'unauthorized', 'Нужен вход');
  return request.auth;
}

function requireRole(request, ...roles) {
  const auth = requireUser(request);
  const has = auth.roles.some(r => roles.includes(r.role));
  if (!has) fail(403, 'forbidden', 'Недостаточно прав');
  return auth;
}

const partnerIdsOf = (auth) => auth.roles.filter(r => r.role === 'partner' && r.partner_id).map(r => r.partner_id);
const isOperator = (auth) => auth.roles.some(r => r.role === 'operator');
const canManagePartner = (auth, partnerId) => isOperator(auth) || partnerIdsOf(auth).includes(partnerId);

async function refreshPlaceRating(client, placeId) {
  await client.query(
    `update places p set
       rating_avg = (select round(avg(rating)::numeric, 2) from reviews
                     where place_id = p.id and status = 'published'),
       rating_count = (select count(*)::int from reviews
                       where place_id = p.id and status = 'published')
     where p.id = $1`, [placeId]);
}

const money = (cents, currency = 'RUB') => ({ cents, currency });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidParam(request) {
  const value = request.params.id;
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(404, 'not_found', 'Объект не найден');
  return value;
}

function bookingView(row) {
  return {
    id: row.id,
    status: row.status,
    note: row.note,
    price: money(row.price_cents, row.currency),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    slot: { id: row.slot_id, startsAt: row.starts_at, endsAt: row.ends_at },
    offer: { id: row.offer_id, title: row.offer_title, durationMin: row.duration_min },
    place: { id: row.place_id, name: row.place_name, address: row.place_address, district: row.place_district },
    review: row.review_id ? { id: row.review_id, rating: row.review_rating, status: row.review_status } : null,
  };
}

const BOOKING_SELECT = `
  select b.id, b.client_user_id, b.status, b.note, b.price_cents, b.currency, b.created_at, b.updated_at,
         s.id as slot_id, s.starts_at, s.ends_at,
         o.id as offer_id, o.title as offer_title, o.duration_min,
         p.id as place_id, p.name as place_name, p.address as place_address, p.district as place_district,
         r.id as review_id, r.rating as review_rating, r.status as review_status
  from bookings b
  join availability_slots s on s.id = b.slot_id
  join offers o on o.id = s.offer_id
  join places p on p.id = o.place_id
  left join reviews r on r.booking_id = b.id`;

export function routes(app, { pool, demoLogin = false }) {
  // ---- сессия и CSRF ----
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    const cookies = parseCookies(request.headers.cookie);
    const sid = cookies[SESSION_COOKIE];
    if (sid) {
      const { rows } = await pool.query(
        `select s.user_id, s.csrf_token, s.expires_at, u.display_name, u.phone
         from sessions s join users u on u.id = s.user_id
         where s.token_hash = $1`, [tokenHash(sid)]);
      const session = rows[0];
      if (session && new Date(session.expires_at) > new Date()) {
        const roles = await pool.query('select role, partner_id from memberships where user_id = $1', [session.user_id]);
        request.auth = {
          userId: session.user_id,
          displayName: session.display_name,
          phone: session.phone,
          csrf: session.csrf_token,
          roles: roles.rows,
        };
      }
    }
    if (!safeMethods.includes(request.method) && request.auth) {
      const header = request.headers['x-csrf-token'];
      if (!header || !safeEqual(header, request.auth.csrf)) {
        fail(403, 'csrf_token_invalid', 'Повторите действие');
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    if (error.validation) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Проверьте поля запроса' });
    }
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'invalid_request', message: 'Проверьте запрос' });
    }
    request.log.error({ err: error }, 'unhandled');
    return reply.code(500).send({ error: 'server_error', message: 'Внутренняя ошибка' });
  });

  app.get('/api/health/live', async () => ({ ok: true }));

  app.get('/api/health/ready', async (_request, reply) => {
    try {
      const { rows } = await pool.query('select (select count(*) from schema_migrations) as migrations');
      if (Number(rows[0].migrations) === 0) throw new Error('no migrations');
      return { ok: true, database: 'ok', migrations: Number(rows[0].migrations) };
    } catch (error) {
      return reply.code(503).send({ ok: false, reason: 'database_unavailable' });
    }
  });

  // ---- вход по коду ----
  app.post('/api/v1/auth/code', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['phone'],
      properties: { phone: { type: 'string', maxLength: 24 } },
    } },
  }, async (request, reply) => {
    const phone = normalizePhone(request.body.phone);
    if (!phone) fail(400, 'invalid_phone', 'Укажите телефон в формате +7XXXXXXXXXX');

    const recent = await pool.query(
      `select count(*)::int as sent from login_codes where phone = $1 and created_at > now() - interval '15 minutes'`, [phone]);
    if (recent.rows[0].sent >= 5) return reply.code(429).send({ error: 'code_rate_limited', message: 'Слишком много кодов, подождите 15 минут' });

    const code = String(randomInt(100000, 1000000));
    await pool.query(
      `insert into login_codes (phone, code_hash, expires_at) values ($1, $2, now() + $3::interval)`,
      [phone, hashCode(phone, code), `${Math.floor(CODE_TTL_MS / 1000)} seconds`]);

    const user = await pool.query('select id from users where phone = $1', [phone]);
    if (user.rows[0]) {
      await pool.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'login_code', $2)`,
        [user.rows[0].id, JSON.stringify({ hint: 'Код входа «Рядом»', expiresInMinutes: 5 })]);
    }
    reply.header('Cache-Control', 'no-store');
    // На стенде без СМС код возвращается явно; в остальных режимах его видно
    // только в уведомлениях приложения.
    return demoLogin ? { sent: true, demoCode: code } : { sent: true };
  });

  app.post('/api/v1/auth/session', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['phone', 'code'],
      properties: {
        phone: { type: 'string', maxLength: 24 },
        code: { type: 'string', maxLength: 8 },
        displayName: { type: 'string', maxLength: 80 },
      },
    } },
  }, async (request, reply) => {
    const phone = normalizePhone(request.body.phone);
    if (!phone) fail(400, 'invalid_phone', 'Укажите телефон в формате +7XXXXXXXXXX');
    const code = request.body.code.replace(/\D/g, '');
    if (code.length !== 6) fail(400, 'invalid_code', 'Код состоит из шести цифр');

    const { rows } = await pool.query(
      `select id, code_hash, attempts from login_codes
       where phone = $1 and consumed_at is null and expires_at > now()
       order by created_at desc limit 1`, [phone]);
    const record = rows[0];
    if (!record || record.attempts >= 5) fail(400, 'code_not_found', 'Код истёк, запросите новый');
    if (!safeEqual(hashCode(phone, code), record.code_hash)) {
      await pool.query('update login_codes set attempts = attempts + 1 where id = $1', [record.id]);
      fail(400, 'code_mismatch', 'Неверный код');
    }

    await pool.query('update login_codes set consumed_at = now() where id = $1', [record.id]);
    const name = (request.body.displayName || '').trim();
    const user = await withTransaction(pool, async (client) => {
      const upsert = await client.query(
        `insert into users (phone, display_name) values ($1, $2)
         on conflict (phone) do update set display_name = case when $3 = '' then users.display_name else excluded.display_name end
         returning id, phone, display_name`, [phone, name || 'Гость', name]);
      await client.query(
        `insert into memberships (user_id, role) values ($1, 'client') on conflict (user_id, role) do nothing`,
        [upsert.rows[0].id]);
      return upsert.rows[0];
    });

    const sid = randomToken(32);
    const csrf = randomToken(24);
    await pool.query(
      'insert into sessions (token_hash, user_id, csrf_token, expires_at) values ($1, $2, $3, now() + $4::interval)',
      [tokenHash(sid), user.id, csrf, `${Math.floor(SESSION_TTL_MS / 1000)} seconds`]);
    setSessionCookies(reply, request, { sid, csrf });
    reply.header('Cache-Control', 'no-store');
    return { user: { id: user.id, phone: user.phone, displayName: user.display_name } };
  });

  app.get('/api/v1/me', async (request, reply) => {
    const auth = requireUser(request);
    reply.header('Cache-Control', 'no-store');
    return {
      user: { id: auth.userId, phone: auth.phone, displayName: auth.displayName },
      roles: auth.roles,
      partnerIds: partnerIdsOf(auth),
    };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const auth = requireUser(request);
    const sid = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    await pool.query('delete from sessions where token_hash = $1 and user_id = $2', [tokenHash(sid || ''), auth.userId]);
    clearSessionCookies(reply, request);
    void CSRF_COOKIE;
    return { ok: true };
  });

  // ---- каталог ----
  app.get('/api/v1/places', {
    schema: { querystring: {
      type: 'object', additionalProperties: false,
      properties: {
        category: { type: 'string', enum: CATEGORIES },
        district: { type: 'string', maxLength: 60 },
        q: { type: 'string', maxLength: 80 },
        maxPrice: { type: 'integer', minimum: 0, maximum: 100000000 },
        minRating: { type: 'number', minimum: 0, maximum: 5 },
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lng: { type: 'number', minimum: -180, maximum: 180 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        offset: { type: 'integer', minimum: 0, maximum: 500 },
      },
    } },
  }, async (request, reply) => {
    const { category, district, q, maxPrice, minRating, limit = 20, offset = 0 } = request.query;
    const { rows } = await pool.query(
      `select p.id, p.name, p.category, p.district, p.address, p.lat, p.lng, p.about,
              p.rating_avg, p.rating_count, oo.min_price_cents, oo.offer_count,
              case when $7::numeric is null or $8::numeric is null
                   then null else round((point(p.lng, p.lat) <-> point($7, $8))::numeric * 111.32, 2) end as distance_km
       from places p
       left join lateral (
         select min(price_cents) as min_price_cents, count(*)::int as offer_count
         from offers o where o.place_id = p.id and o.is_active
       ) oo on true
       where p.is_published
         and ($1::text is null or p.category::text = $1)
         and ($2::text is null or p.district = $2)
         and ($3::text is null or p.name ilike '%' || $3 || '%' or p.about ilike '%' || $3 || '%')
         and ($4::int is null or oo.min_price_cents <= $4)
         and ($5::numeric is null or coalesce(p.rating_avg, 0) >= $5)
         and oo.offer_count > 0
       order by distance_km asc nulls last, p.rating_avg desc nulls last, p.name asc
       limit $6 offset $9`,
      [category ?? null, district ?? null, q ?? null, maxPrice ?? null, minRating ?? null, limit,
        request.query.lng ?? null, request.query.lat ?? null, offset]);
    reply.header('Cache-Control', 'no-store');
    return {
      items: rows.map(row => ({
        id: row.id,
        name: row.name,
        category: row.category,
        district: row.district,
        address: row.address,
        about: row.about,
        location: { lat: Number(row.lat), lng: Number(row.lng) },
        rating: row.rating_avg === null ? null : Number(row.rating_avg),
        ratingCount: row.rating_count,
        priceFrom: row.min_price_cents === null ? null : money(row.min_price_cents),
        offerCount: row.offer_count,
        distanceKm: row.distance_km === null ? null : Number(row.distance_km),
      })),
      limit,
      offset,
    };
  });

  app.get('/api/v1/districts', async (_request, reply) => {
    const { rows } = await pool.query('select distinct district from places where is_published order by district');
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(r => r.district) };
  });

  app.get('/api/v1/places/:id', async (request, reply) => {
    const { rows } = await pool.query(
      `select p.id, p.name, p.category, p.district, p.address, p.about, p.phone,
              p.lat, p.lng, p.rating_avg, p.rating_count
       from places p where p.id = $1 and p.is_published`, [uuidParam(request)]);
    if (!rows[0]) fail(404, 'place_not_found', 'Заведение не найдено');
    const place = rows[0];
    const offers = await pool.query(
      `select o.id, o.title, o.description, o.duration_min, o.price_cents, o.currency,
              (select min(s.starts_at) from availability_slots s
                where s.offer_id = o.id and s.starts_at > now()) as next_slot
       from offers o where o.place_id = $1 and o.is_active order by o.price_cents`, [place.id]);
    const reviews = await pool.query(
      `select r.id, r.rating, r.body, r.created_at, u.display_name
       from reviews r join users u on u.id = r.author_user_id
       where r.place_id = $1 and r.status = 'published'
       order by r.created_at desc limit 5`, [place.id]);
    reply.header('Cache-Control', 'no-store');
    return {
      place: {
        id: place.id,
        name: place.name,
        category: place.category,
        district: place.district,
        address: place.address,
        about: place.about,
        phone: place.phone,
        location: { lat: Number(place.lat), lng: Number(place.lng) },
        rating: place.rating_avg === null ? null : Number(place.rating_avg),
        ratingCount: place.rating_count,
      },
      offers: offers.rows.map(o => ({
        id: o.id,
        title: o.title,
        description: o.description,
        durationMin: o.duration_min,
        price: money(o.price_cents, o.currency),
        nextSlot: o.next_slot,
      })),
      reviews: reviews.rows.map(r => ({
        id: r.id, rating: r.rating, body: r.body, createdAt: r.created_at, author: r.display_name,
      })),
    };
  });

  app.get('/api/v1/offers/:id/slots', {
    schema: { querystring: {
      type: 'object', additionalProperties: false,
      properties: { days: { type: 'integer', minimum: 1, maximum: 30 } },
    } },
  }, async (request, reply) => {
    const days = request.query.days ?? 10;
    const offer = await pool.query(
      `select o.id, o.title, o.duration_min, o.price_cents, o.currency, p.id as place_id, p.name as place_name
       from offers o join places p on p.id = o.place_id
       where o.id = $1 and o.is_active and p.is_published`, [uuidParam(request)]);
    if (!offer.rows[0]) fail(404, 'offer_not_found', 'Услуга не найдена');
    const { rows } = await pool.query(
      `select s.id, s.starts_at, s.ends_at
       from availability_slots s
       where s.offer_id = $1
         and s.starts_at > now()
         and s.starts_at < now() + ($2::int || ' days')::interval
         and not exists (
           select 1 from bookings b where b.slot_id = s.id and b.status in ('requested', 'confirmed'))
       order by s.starts_at
       limit 200`, [uuidParam(request), days]);
    reply.header('Cache-Control', 'no-store');
    const o = offer.rows[0];
    return {
      offer: { id: o.id, title: o.title, durationMin: o.duration_min, price: money(o.price_cents, o.currency) },
      place: { id: o.place_id, name: o.place_name },
      slots: rows.map(r => ({ id: r.id, startsAt: r.starts_at, endsAt: r.ends_at })),
    };
  });

  // ---- запись ----
  app.post('/api/v1/bookings', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['slotId'],
      properties: {
        slotId: { type: 'string', format: 'uuid' },
        note: { type: 'string', maxLength: 500 },
        idempotencyKey: { type: 'string', minLength: 8, maxLength: 80 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireUser(request);
    const { slotId, note = '', idempotencyKey = null } = request.body;
    if (!UUID_RE.test(slotId)) fail(404, 'slot_not_found', 'Окно недоступно');

    const attempt = async () => withTransaction(pool, async (client) => {
      if (idempotencyKey) {
        const existing = await client.query(
          `${BOOKING_SELECT} where b.client_user_id = $1 and b.idempotency_key = $2`,
          [auth.userId, idempotencyKey]);
        if (existing.rows[0]) return { booking: bookingView(existing.rows[0]), created: false };
      }
      const slot = await client.query(
        `select s.id, s.starts_at, s.ends_at, o.id as offer_id, o.price_cents, o.currency, o.is_active,
                p.id as place_id, p.name as place_name, p.partner_id, p.is_published
         from availability_slots s
         join offers o on o.id = s.offer_id
         join places p on p.id = o.place_id
         where s.id = $1`, [slotId]);
      const found = slot.rows[0];
      if (!found || !found.is_active || !found.is_published) fail(404, 'slot_not_found', 'Окно недоступно');
      if (new Date(found.starts_at) <= new Date()) fail(409, 'slot_in_past', 'Это время уже прошло');

      const booking = await client.query(
        `insert into bookings (slot_id, client_user_id, note, price_cents, currency, idempotency_key)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [slotId, auth.userId, note, found.price_cents, found.currency, idempotencyKey]);
      const bookingId = booking.rows[0].id;

      await client.query(
        `insert into booking_events (booking_id, status, actor_user_id, note) values ($1, 'requested', $2, '')`,
        [bookingId, auth.userId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'booking_requested', $2)`,
        [auth.userId, JSON.stringify({ bookingId, place: found.place_name, startsAt: found.starts_at })]);

      const owners = await client.query(
        `select user_id from memberships where role = 'partner' and partner_id = $1`, [found.partner_id]);
      for (const owner of owners.rows) {
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'booking_new', $2)`,
          [owner.user_id, JSON.stringify({ bookingId, place: found.place_name, startsAt: found.starts_at })]);
      }

      const view = await client.query(`${BOOKING_SELECT} where b.id = $1`, [bookingId]);
      return { booking: bookingView(view.rows[0]), created: true };
    });

    try {
      const result = await attempt();
      reply.code(result.created ? 201 : 200);
      return result.booking;
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (error.constraint === 'bookings_active_slot_uq') fail(409, 'slot_taken', 'Это время уже заняли');
        if (error.constraint === 'bookings_client_idem_uq') fail(409, 'duplicate_request', 'Повтор запроса');
      }
      throw error;
    }
  });

  app.get('/api/v1/me/orders', async (request, reply) => {
    const auth = requireUser(request);
    const { rows } = await pool.query(
      `${BOOKING_SELECT} where b.client_user_id = $1 order by b.created_at desc limit 100`, [auth.userId]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(bookingView) };
  });

  async function loadBookingForActor(auth, bookingId, client = pool) {
    const { rows } = await client.query(
      `${BOOKING_SELECT} where b.id = $1::uuid`, [bookingId]);
    if (!rows[0]) fail(404, 'booking_not_found', 'Запись не найдена');
    const booking = rows[0];
    const partnerId = (await client.query(
      `select p.partner_id from offers o join places p on p.id = o.place_id
       where o.id = $1`, [booking.offer_id])).rows[0]?.partner_id;
    const owns = partnerIdsOf(auth).includes(partnerId);
    const isClient = booking.client_user_id === auth.userId;
    return { booking, partnerId, owns, isClient, canManage: owns || isOperator(auth) };
  }

  app.get('/api/v1/bookings/:id', async (request, reply) => {
    const auth = requireUser(request);
    const { booking, isClient, canManage } = await loadBookingForActor(auth, uuidParam(request));
    if (!isClient && !canManage) fail(403, 'forbidden', 'Нет доступа к записи');
    reply.header('Cache-Control', 'no-store');
    return bookingView(booking);
  });

  async function transition(request, { from, to, requireManager }) {
    const auth = requireUser(request);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `${BOOKING_SELECT} where b.id = $1 for update of b`, [uuidParam(request)]);
      const booking = rows[0];
      if (!booking) fail(404, 'booking_not_found', 'Запись не найдена');
      const partnerId = (await client.query(
        `select p.partner_id from offers o join places p on p.id = o.place_id where o.id = $1`,
        [booking.offer_id])).rows[0].partner_id;
      const owns = partnerIdsOf(auth).includes(partnerId);
      const canManage = owns || isOperator(auth);
      const isClient = booking.client_user_id === auth.userId;
      if (requireManager && !canManage) fail(403, 'forbidden', 'Действие доступно партнёру');
      if (!requireManager && !isClient && !canManage) fail(403, 'forbidden', 'Нет доступа к записи');
      if (!from.includes(booking.status)) {
        fail(409, 'invalid_transition', 'Запись уже в другом состоянии');
      }
      const updated = await client.query(
        `update bookings set status = $2, updated_at = now() where id = $1 returning status`,
        [booking.id, to]);
      await client.query(
        `insert into booking_events (booking_id, status, actor_user_id) values ($1, $2, $3)`,
        [booking.id, to, auth.userId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, $2, $3)`,
        [booking.client_user_id, `booking_${to}`, JSON.stringify({ bookingId: booking.id, status: to })]);
      return { id: booking.id, status: updated.rows[0].status };
    });
  }

  app.post('/api/v1/bookings/:id/cancel', async (request) =>
    transition(request, { from: ACTIVE, to: 'cancelled', requireManager: false }));

  app.post('/api/v1/bookings/:id/confirm', async (request) =>
    transition(request, { from: ['requested'], to: 'confirmed', requireManager: true }));

  app.post('/api/v1/bookings/:id/complete', async (request) =>
    transition(request, { from: ['confirmed'], to: 'completed', requireManager: true }));

  app.get('/api/v1/partner/bookings', async (request, reply) => {
    const auth = requireRole(request, 'partner', 'operator');
    const partnerIds = partnerIdsOf(auth);
    if (!isOperator(auth) && partnerIds.length === 0) fail(403, 'forbidden', 'Нет партнёрского кабинета');
    const status = request.query?.status;
    const { rows } = await pool.query(
      `${BOOKING_SELECT}
       where ($1::uuid[] is null or p.partner_id = any($1::uuid[]))
         and ($2::text is null or b.status::text = $2)
       order by s.starts_at asc limit 200`,
      [isOperator(auth) ? null : partnerIds, typeof status === 'string' ? status : null]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(bookingView) };
  });

  app.get('/api/v1/partner/notifications', async (request, reply) => {
    requireRole(request, 'partner', 'operator');
    const auth = requireUser(request);
    const { rows } = await pool.query(
      `select id, kind, payload, created_at, read_at from notifications
       where user_id = $1 order by created_at desc limit 50`, [auth.userId]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows };
  });

  // ---- кабинет партнёра: карточки, услуги и расписание ----
  async function loadPlaceForManager(auth, placeId, client = pool) {
    const { rows } = await client.query(
      'select id, partner_id from places where id = $1', [placeId]);
    if (!rows[0]) fail(404, 'place_not_found', 'Заведение не найдено');
    if (!canManagePartner(auth, rows[0].partner_id)) fail(403, 'forbidden', 'Это не ваша карточка');
    return rows[0];
  }

  async function loadOfferForManager(auth, offerId, client = pool) {
    const { rows } = await client.query(
      `select o.id, o.place_id, p.partner_id from offers o
       join places p on p.id = o.place_id where o.id = $1`, [offerId]);
    if (!rows[0]) fail(404, 'offer_not_found', 'Услуга не найдена');
    if (!canManagePartner(auth, rows[0].partner_id)) fail(403, 'forbidden', 'Это не ваша услуга');
    return rows[0];
  }

  async function partnerPlaceView(client, placeId) {
    const place = await client.query(
      `select id, name, category, district, address, about, phone, lat, lng, is_published, updated_at
       from places where id = $1`, [placeId]);
    if (!place.rows[0]) return null;
    const p = place.rows[0];
    const offers = await client.query(
      `select o.id, o.title, o.description, o.duration_min, o.price_cents, o.currency, o.is_active,
              (select count(*)::int from availability_slots s where s.offer_id = o.id and s.starts_at > now()) as slot_count,
              (select min(s.starts_at) from availability_slots s where s.offer_id = o.id and s.starts_at > now()) as next_slot
       from offers o where o.place_id = $1 order by o.created_at`, [p.id]);
    return {
      id: p.id, name: p.name, category: p.category, district: p.district, address: p.address,
      about: p.about, phone: p.phone, location: { lat: Number(p.lat), lng: Number(p.lng) },
      isPublished: p.is_published, updatedAt: p.updated_at,
      offers: offers.rows.map(o => ({
        id: o.id, title: o.title, description: o.description, durationMin: o.duration_min,
        price: money(o.price_cents, o.currency), isActive: o.is_active,
        slotCount: o.slot_count, nextSlot: o.next_slot,
      })),
    };
  }

  app.get('/api/v1/partner/places', async (request, reply) => {
    const auth = requireRole(request, 'partner', 'operator');
    const ids = isOperator(auth) ? null : partnerIdsOf(auth);
    const { rows } = await pool.query(
      `select id from places
       where $1::uuid[] is null or partner_id = any($1::uuid[])
       order by name`, [ids]);
    const items = [];
    for (const row of rows) items.push(await partnerPlaceView(pool, row.id));
    reply.header('Cache-Control', 'no-store');
    return { items };
  });

  app.patch('/api/v1/partner/places/:id', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        category: { type: 'string', enum: CATEGORIES },
        district: { type: 'string', minLength: 1, maxLength: 60 },
        address: { type: 'string', minLength: 1, maxLength: 160 },
        about: { type: 'string', maxLength: 2000 },
        phone: { anyOf: [{ type: 'string', maxLength: 32 }, { type: 'null' }] },
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lng: { type: 'number', minimum: -180, maximum: 180 },
        isPublished: { type: 'boolean' },
      },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'partner', 'operator');
    await loadPlaceForManager(auth, uuidParam(request));
    const columns = { name: 'name', category: 'category', district: 'district', address: 'address',
      about: 'about', phone: 'phone', lat: 'lat', lng: 'lng', isPublished: 'is_published' };
    const updates = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in request.body)) continue;
      values.push(request.body[key]);
      updates.push(`${column} = $${values.length}`);
    }
    if (!updates.length) fail(400, 'empty_update', 'Нет полей для изменения');
    values.push(uuidParam(request));
    await pool.query(
      `update places set ${updates.join(', ')}, updated_at = now() where id = $${values.length}`, values);
    return partnerPlaceView(pool, uuidParam(request));
  });

  app.post('/api/v1/partner/places/:id/offers', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['title', 'durationMin', 'priceCents'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 1000 },
        durationMin: { type: 'integer', minimum: 5, maximum: 600 },
        priceCents: { type: 'integer', minimum: 0, maximum: 100000000 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireRole(request, 'partner', 'operator');
    await loadPlaceForManager(auth, uuidParam(request));
    const { title, description = '', durationMin, priceCents } = request.body;
    const { rows } = await pool.query(
      `insert into offers (place_id, title, description, duration_min, price_cents)
       values ($1, $2, $3, $4, $5) returning id`, [uuidParam(request), title, description, durationMin, priceCents]);
    reply.code(201);
    return (await partnerPlaceView(pool, uuidParam(request))).offers.find(o => o.id === rows[0].id);
  });

  app.patch('/api/v1/partner/offers/:id', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 1000 },
        durationMin: { type: 'integer', minimum: 5, maximum: 600 },
        priceCents: { type: 'integer', minimum: 0, maximum: 100000000 },
        isActive: { type: 'boolean' },
      },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'partner', 'operator');
    const offer = await loadOfferForManager(auth, uuidParam(request));
    const columns = { title: 'title', description: 'description', durationMin: 'duration_min',
      priceCents: 'price_cents', isActive: 'is_active' };
    const updates = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in request.body)) continue;
      values.push(request.body[key]);
      updates.push(`${column} = $${values.length}`);
    }
    if (!updates.length) fail(400, 'empty_update', 'Нет полей для изменения');
    values.push(offer.id);
    await pool.query(
      `update offers set ${updates.join(', ')}, updated_at = now() where id = $${values.length}`, values);
    return (await partnerPlaceView(pool, offer.place_id)).offers.find(o => o.id === offer.id);
  });

  app.post('/api/v1/partner/offers/:id/slots', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 30 },
        hours: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'integer', minimum: 0, maximum: 23 } },
      },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'partner', 'operator');
    const offer = await loadOfferForManager(auth, uuidParam(request));
    const days = request.body.days ?? 14;
    const hours = request.body.hours ?? [10, 12, 14, 16, 18];
    const { rows } = await pool.query(
      `insert into availability_slots (offer_id, starts_at, ends_at)
       select $1,
              (d + make_interval(hours => h)) at time zone 'Europe/Moscow',
              (d + make_interval(hours => h)) at time zone 'Europe/Moscow' + ($2::int || ' minutes')::interval
       from generate_series(
         (date_trunc('day', now() at time zone 'Europe/Moscow') + interval '1 day')::timestamp,
         (date_trunc('day', now() at time zone 'Europe/Moscow') + ($3::int || ' days')::interval)::timestamp,
         interval '1 day') d
       cross join unnest($4::int[]) h
       on conflict (offer_id, starts_at) do nothing
       returning id`, [offer.id, (await pool.query('select duration_min from offers where id = $1', [offer.id])).rows[0].duration_min, days, hours]);
    return { created: rows.length, days, hours };
  });

  // ---- отзывы ----
  app.post('/api/v1/reviews', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['bookingId', 'rating'],
      properties: {
        bookingId: { type: 'string', format: 'uuid' },
        rating: { type: 'integer', minimum: 1, maximum: 5 },
        body: { type: 'string', maxLength: 1000 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireUser(request);
    const { bookingId, rating, body = '' } = request.body;
    if (!UUID_RE.test(bookingId)) fail(404, 'booking_not_found', 'Запись не найдена');
    try {
      const review = await withTransaction(pool, async (client) => {
        const booking = await client.query(
          `select b.id, b.status, b.client_user_id, o.place_id
           from bookings b join availability_slots s on s.id = b.slot_id
           join offers o on o.id = s.offer_id where b.id = $1 for update of b`, [bookingId]);
        const found = booking.rows[0];
        if (!found) fail(404, 'booking_not_found', 'Запись не найдена');
        if (found.client_user_id !== auth.userId) fail(403, 'forbidden', 'Отзыв только по своей записи');
        if (found.status !== 'completed') fail(409, 'booking_not_completed', 'Отзыв доступен после услуги');
        const inserted = await client.query(
          `insert into reviews (booking_id, place_id, author_user_id, rating, body, status)
           values ($1, $2, $3, $4, $5, 'pending') returning id, created_at, status`,
          [found.id, found.place_id, auth.userId, rating, body]);
        return { id: inserted.rows[0].id, createdAt: inserted.rows[0].created_at, status: inserted.rows[0].status };
      });
      reply.code(201);
      return review;
    } catch (error) {
      if (isUniqueViolation(error) && error.constraint === 'reviews_booking_id_key') {
        fail(409, 'review_exists', 'Отзыв по этой записи уже есть');
      }
      throw error;
    }
  });

  app.get('/api/v1/places/:id/reviews', async (request, reply) => {
    const { rows } = await pool.query(
      `select r.id, r.rating, r.body, r.created_at, u.display_name
       from reviews r join users u on u.id = r.author_user_id
       where r.place_id = $1 and r.status = 'published' order by r.created_at desc limit 50`,
      [uuidParam(request)]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(r => ({ id: r.id, rating: r.rating, body: r.body, createdAt: r.created_at, author: r.display_name })) };
  });

  // ---- модерация отзывов ----
  app.get('/api/v1/operator/reviews', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      status: { type: 'string', enum: ['pending', 'published', 'hidden', 'all'] },
    } } },
  }, async (request, reply) => {
    requireRole(request, 'operator');
    const status = request.query.status ?? 'pending';
    const { rows } = await pool.query(
      `select r.id, r.rating, r.body, r.status, r.created_at, r.moderated_at,
              u.display_name as author, p.name as place_name, p.id as place_id,
              b.id as booking_id, b.created_at as booking_created_at
       from reviews r
       join users u on u.id = r.author_user_id
       join places p on p.id = r.place_id
       join bookings b on b.id = r.booking_id
       where ($1::text = 'all' or r.status::text = $1)
       order by r.created_at asc limit 100`, [status]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows };
  });

  app.post('/api/v1/operator/reviews/:id/moderate', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: { action: { type: 'string', enum: ['publish', 'hide'] } },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'operator');
    const reviewId = uuidParam(request);
    return withTransaction(pool, async (client) => {
      const found = await client.query(
        `select id, place_id, author_user_id, status from reviews where id = $1 for update`, [reviewId]);
      if (!found.rows[0]) fail(404, 'review_not_found', 'Отзыв не найден');
      const review = found.rows[0];
      const status = request.body.action === 'publish' ? 'published' : 'hidden';
      await client.query(
        `update reviews set status = $2, moderated_by = $3, moderated_at = now()
         where id = $1`, [review.id, status, auth.userId]);
      await refreshPlaceRating(client, review.place_id);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'review_moderated', $2)`,
        [review.author_user_id, JSON.stringify({ reviewId: review.id, status })]);
      return { id: review.id, status };
    });
  });

  // ---- уведомления ----
  app.get('/api/v1/me/notifications', async (request, reply) => {
    const auth = requireUser(request);
    const { rows } = await pool.query(
      `select id, kind, payload, channel, created_at, read_at, delivered_at, last_error
       from notifications where user_id = $1 order by created_at desc limit 50`, [auth.userId]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows };
  });

  app.post('/api/v1/me/notifications/read', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'integer', minimum: 1 } },
    } },
  }, async (request) => {
    const auth = requireUser(request);
    if (request.body.id) {
      await pool.query(
        'update notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null',
        [request.body.id, auth.userId]);
    } else {
      await pool.query(
        'update notifications set read_at = now() where user_id = $1 and read_at is null', [auth.userId]);
    }
    return { ok: true };
  });
}
