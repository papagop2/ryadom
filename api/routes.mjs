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
                     where place_id = p.id and status = 'published'
                       and source = 'own' and rating is not null),
       rating_count = (select count(*)::int from reviews
                       where place_id = p.id and status = 'published'
                         and source = 'own' and rating is not null)
     where p.id = $1`, [placeId]);
}

const money = (cents, currency = 'RUB') => ({ cents, currency });

const WEEK = [['Mon', 'Пн'], ['Tue', 'Вт'], ['Wed', 'Ср'], ['Thu', 'Чт'],
  ['Fri', 'Пт'], ['Sat', 'Сб'], ['Sun', 'Вс']];

function dayHours(day) {
  if (!day) return 'выходной';
  if (day.is_24_hours) return 'круглосуточно';
  const hours = (day.working_hours ?? [])
    .map(item => `${item.from}–${item.to}`).filter(Boolean);
  return hours.join(', ') || 'выходной';
}

function scheduleText(schedule) {
  if (!schedule || typeof schedule !== 'object') return null;
  const values = WEEK.map(([key]) => dayHours(schedule[key]));
  if (values.every(value => value === values[0])) return `Ежедневно ${values[0]}`;
  if (values.slice(0, 5).every(value => value === values[0]) && values[5] === values[6]) {
    return `Пн–Пт ${values[0]} · Сб–Вс ${values[5]}`;
  }
  return WEEK.map(([, label], index) => `${label} ${values[index]}`).join(' · ');
}

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

const TRIP_ACTIVE = ['requested', 'assigned', 'arrived', 'in_progress'];
const TRIP_SELECT = `
  select t.*, c.display_name as client_name,
         d.display_name as driver_name, dp.car_model, dp.plate
  from trips t
  join users c on c.id = t.client_user_id
  left join users d on d.id = t.driver_user_id
  left join driver_profiles dp on dp.user_id = t.driver_user_id`;

function tripOfferView(row) {
  return {
    id: row.id,
    price: money(row.price_cents, 'RUB'),
    etaMin: row.eta_min,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    driver: { id: row.driver_user_id, name: row.driver_name, car: row.car_model, plate: row.plate },
  };
}

async function tripOffersForTrips(db, tripIds, driverId = null) {
  const byTrip = new Map();
  if (!tripIds.length) return byTrip;
  const params = [tripIds];
  let sql = `select o.*, u.display_name as driver_name, dp.car_model, dp.plate
             from trip_offers o
             join users u on u.id = o.driver_user_id
             left join driver_profiles dp on dp.user_id = o.driver_user_id
             where o.trip_id = any($1::uuid[])`;
  if (driverId) { sql += ' and o.driver_user_id = $2'; params.push(driverId); }
  sql += ' order by o.created_at';
  const { rows } = await db.query(sql, params);
  for (const row of rows) {
    if (!byTrip.has(row.trip_id)) byTrip.set(row.trip_id, []);
    byTrip.get(row.trip_id).push(row);
  }
  return byTrip;
}

function tripView(row, offers = []) {
  return {
    id: row.id,
    status: row.status,
    from: { label: row.from_label, lat: Number(row.from_lat), lng: Number(row.from_lng) },
    to: { label: row.to_label, lat: Number(row.to_lat), lng: Number(row.to_lng) },
    distanceKm: Number(row.distance_km),
    durationMin: row.duration_min,
    price: row.price_cents == null ? null : money(row.price_cents, row.currency),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    client: { id: row.client_user_id, name: row.client_name },
    driver: row.driver_user_id ? { id: row.driver_user_id, name: row.driver_name, car: row.car_model, plate: row.plate } : null,
    offers: offers.map(tripOfferView),
  };
}

const POINT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['label', 'lat', 'lng'],
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 160 },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
  },
};

function distanceKm(from, to) {
  const radius = 6371;
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(to.lat - from.lat);
  const dLng = rad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

const ROUTE_CACHE = new Map();
async function roadRoute(from, to) {
  const key = `${from.lat.toFixed(5)},${from.lng.toFixed(5)};${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
  if (ROUTE_CACHE.has(key)) return ROUTE_CACHE.get(key);
  const path = `${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  const bases = [
    process.env.OSRM_URL,
    'https://router.project-osrm.org',
    'https://routing.openstreetmap.de/routed-car',
  ].filter(Boolean);
  for (const base of bases) {
    try {
      const response = await fetch(`${base}/route/v1/driving/${path}`, { signal: AbortSignal.timeout(3200) });
      if (!response.ok) continue;
      const data = await response.json();
      const route = data.routes?.[0];
      if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) continue;
      const value = { distanceKm: route.distance / 1000, durationMin: route.duration / 60 };
      if (ROUTE_CACHE.size > 500) ROUTE_CACHE.clear();
      ROUTE_CACHE.set(key, value);
      return value;
    } catch { /* пробуем следующий маршрутизатор */ }
  }
  return null;
}

// Оценка поездки — только дорожный километраж и время. Стоимость не считаем:
// цену предлагает водитель, клиент выбирает предложение.
async function routeQuote(from, to) {
  const road = await roadRoute(from, to);
  const straight = distanceKm(from, to);
  const km = Math.max(0.3, Math.round((road?.distanceKm ?? straight * 1.35) * 10) / 10);
  const minutes = Math.max(4, Math.round(road?.durationMin ?? (km / 24 * 60 + 3)));
  return { distanceKm: km, durationMin: minutes, route: road ? 'osrm' : 'straight' };
}

const SERVICE_CATEGORIES = ['repair', 'cleaning', 'beauty', 'tutoring', 'moving', 'other'];
const SERVICE_ACTIVE = ['open', 'assigned', 'in_progress'];
const SERVICE_SELECT = `
  select r.*, c.display_name as client_name, p.name as partner_name
  from service_requests r
  join users c on c.id = r.client_user_id
  left join partners p on p.id = r.partner_id`;

function uuidValue(value, label = 'Объект') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(404, 'not_found', `${label} не найден`);
  return value;
}

function serviceOfferView(row) {
  return {
    id: row.id,
    price: money(row.price_cents, row.currency ?? 'RUB'),
    message: row.message,
    etaMin: row.eta_min,
    status: row.status,
    createdAt: row.created_at,
    partner: { id: row.partner_id, name: row.partner_name },
  };
}

function serviceRequestView(row, offers = []) {
  return {
    id: row.id,
    status: row.status,
    category: row.category,
    title: row.title,
    description: row.description,
    address: row.address,
    budget: { min: money(row.budget_min_cents), max: money(row.budget_max_cents) },
    preferred: { from: row.preferred_from, to: row.preferred_to },
    price: row.price_cents === null ? null : money(row.price_cents, row.currency),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignedAt: row.assigned_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    client: { id: row.client_user_id, name: row.client_name },
    partner: row.partner_id ? { id: row.partner_id, name: row.partner_name } : null,
    offers: offers.map(serviceOfferView),
  };
}

async function offersForRequests(db, requestIds, partnerIds = null) {
  const byRequest = new Map();
  if (!requestIds.length) return byRequest;
  const params = [requestIds];
  let sql = `select o.*, p.name as partner_name from service_offers o
             join partners p on p.id = o.partner_id
             where o.request_id = any($1::uuid[])`;
  if (partnerIds?.length) { sql += ' and o.partner_id = any($2::uuid[])'; params.push(partnerIds); }
  sql += ' order by o.created_at';
  const { rows } = await db.query(sql, params);
  for (const row of rows) {
    if (!byRequest.has(row.request_id)) byRequest.set(row.request_id, []);
    byRequest.get(row.request_id).push(row);
  }
  return byRequest;
}

async function loadServiceRequest(db, id, partnerIds = null) {
  const { rows } = await db.query(`${SERVICE_SELECT} where r.id = $1`, [id]);
  if (!rows[0]) return null;
  const offers = await offersForRequests(db, [id], partnerIds);
  return serviceRequestView(rows[0], offers.get(id) ?? []);
}

async function notifyPartner(db, partnerId, kind, payload) {
  const { rows } = await db.query(
    "select user_id from memberships where partner_id = $1 and role = 'partner'", [partnerId]);
  for (const row of rows) {
    await db.query('insert into notifications (user_id, kind, payload) values ($1, $2, $3)',
      [row.user_id, kind, JSON.stringify(payload)]);
  }
}

function shopProductView(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    price: money(row.price_cents, row.currency),
    stockQty: row.stock_qty,
    unit: row.unit,
    isActive: row.is_active,
  };
}

const SHOP_ORDER_SELECT = `
  select o.*, p.name as place_name, p.address as place_address, p.district as place_district,
         u.display_name as client_name, dj.id as delivery_job_id, dj.status as delivery_status,
         dj.eta_min as delivery_eta_min, dj.fee_cents as delivery_job_fee,
         dj.courier_user_id, c.display_name as courier_name
  from shop_orders o
  join places p on p.id = o.place_id
  join users u on u.id = o.client_user_id
  left join delivery_jobs dj on dj.order_id = o.id
  left join users c on c.id = dj.courier_user_id`;

function deliveryZoneView(row) {
  return {
    id: row.id, district: row.district, fee: money(row.fee_cents), minOrder: money(row.min_order_cents),
    etaMin: row.eta_min, isActive: row.is_active,
  };
}

const DELIVERY_JOB_SELECT = `
  select dj.*, o.status as order_status, o.pickup_code, o.total_cents, o.client_user_id, o.place_id,
         p.name as place_name, p.address as place_address, u.display_name as client_name,
         c.display_name as courier_name
  from delivery_jobs dj
  join shop_orders o on o.id = dj.order_id
  join places p on p.id = o.place_id
  join users u on u.id = o.client_user_id
  left join users c on c.id = dj.courier_user_id`;

function deliveryJobView(row) {
  return {
    id: row.id, orderId: row.order_id, status: row.status,
    address: row.address, district: row.district,
    fee: money(row.fee_cents), etaMin: row.eta_min,
    createdAt: row.created_at,
    courier: row.courier_user_id ? { id: row.courier_user_id, name: row.courier_name } : null,
    order: {
      id: row.order_id, status: row.order_status, pickupCode: row.pickup_code,
      total: money(row.total_cents), client: { id: row.client_user_id, name: row.client_name },
      place: { id: row.place_id, name: row.place_name, address: row.place_address },
    },
  };
}

async function shopItemsFor(db, orderIds) {
  const byOrder = new Map();
  if (!orderIds.length) return byOrder;
  const { rows } = await db.query(
    `select * from shop_order_items where order_id = any($1::uuid[]) order by id`, [orderIds]);
  for (const row of rows) {
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
    byOrder.get(row.order_id).push(row);
  }
  return byOrder;
}

async function restockShopOrder(db, orderId) {
  await db.query(`update products p set stock_qty = p.stock_qty + i.qty, updated_at = now()
                from shop_order_items i where i.order_id = $1 and i.product_id = p.id`, [orderId]);
}

async function loadShopOrder(db, id) {
  const { rows } = await db.query(`${SHOP_ORDER_SELECT} where o.id = $1`, [id]);
  if (!rows[0]) return null;
  const items = await shopItemsFor(db, [id]);
  return shopOrderView(rows[0], items.get(id) ?? []);
}

function shopOrderView(row, items = []) {
  return {
    id: row.id,
    status: row.status,
    total: money(row.total_cents, row.currency),
    goods: money(row.goods_total_cents, row.currency),
    deliveryFee: money(row.delivery_fee_cents, row.currency),
    fulfillment: row.fulfillment,
    pickupCode: row.pickup_code,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    delivery: row.delivery_job_id ? {
      id: row.delivery_job_id, status: row.delivery_status,
      address: row.delivery_address, district: row.delivery_district,
      fee: money(row.delivery_fee_cents, row.currency), etaMin: row.delivery_eta_min,
      courier: row.courier_user_id ? { id: row.courier_user_id, name: row.courier_name } : null,
    } : null,
    client: { id: row.client_user_id, name: row.client_name },
    place: { id: row.place_id, name: row.place_name, address: row.place_address, district: row.place_district },
    items: items.map(item => ({
      id: item.id,
      productId: item.product_id,
      title: item.title,
      unit: item.unit,
      qty: item.qty,
      price: money(item.unit_price_cents, row.currency),
      total: money(item.total_cents, row.currency),
    })),
  };
}

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
    if (process.env.TEST_DEBUG) console.error(error);
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
        city: { type: 'string', maxLength: 40 },
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
    const { city, category, district, q, maxPrice, minRating, limit = 20, offset = 0 } = request.query;
    const { rows } = await pool.query(
      `select p.id, p.name, p.category, p.district, p.address, p.lat, p.lng, p.about,
              p.rating_avg, p.rating_count, p.source, p.source_url, p.source_rating,
              p.source_rating_count, p.city_slug, p.image_url, oo.min_price_cents, oo.offer_count,
              count(*) over()::int as total,
              case when $7::numeric is null or $8::numeric is null
                   then null else round((point(p.lng, p.lat) <-> point($7, $8))::numeric * 111.32, 2) end as distance_km
       from places p
       left join lateral (
         select min(price_cents) as min_price_cents, count(*)::int as offer_count
         from offers o where o.place_id = p.id and o.is_active
       ) oo on true
       where p.is_published
         and ($10::text is null or p.city_slug = $10)
         and ($1::text is null or p.category::text = $1)
         and ($2::text is null or p.district = $2)
         and ($3::text is null or p.name ilike '%' || $3 || '%' or p.about ilike '%' || $3 || '%')
         and ($4::int is null or oo.min_price_cents <= $4)
         and ($5::numeric is null or coalesce(p.rating_avg, p.source_rating, 0) >= $5)
       order by distance_km asc nulls last,
         coalesce(p.rating_avg, p.source_rating) desc nulls last, p.name asc
       limit $6 offset $9`,
      [category ?? null, district ?? null, q ?? null, maxPrice ?? null, minRating ?? null, limit,
        request.query.lng ?? null, request.query.lat ?? null, offset, city ?? null]);
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
        city: row.city_slug,
        image: row.image_url,
        rating: row.rating_avg === null ? null : Number(row.rating_avg),
        ratingCount: row.rating_count,
        source: row.source === '2gis' ? {
          name: '2ГИС', url: row.source_url,
          rating: row.source_rating === null ? null : Number(row.source_rating),
          ratingCount: row.source_rating_count,
        } : null,
        priceFrom: row.min_price_cents === null ? null : money(row.min_price_cents),
        offerCount: row.offer_count,
        distanceKm: row.distance_km === null ? null : Number(row.distance_km),
      })),
      total: rows[0]?.total ?? 0,
      limit,
      offset,
    };
  });

  app.get('/api/v1/cities', async (_request, reply) => {
    const { rows } = await pool.query(
      `select c.slug, c.name, c.region, c.lat, c.lng,
              count(p.id) filter (where p.is_published)::int as places
       from cities c left join places p on p.city_slug = c.slug
       where c.is_active group by c.slug order by places desc, c.name`);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => ({
      slug: row.slug, name: row.name, region: row.region,
      center: { lat: Number(row.lat), lng: Number(row.lng) }, places: row.places,
    })) };
  });

  app.get('/api/v1/districts', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      city: { type: 'string', maxLength: 40 },
    } } },
  }, async (request, reply) => {
    const { rows } = await pool.query(
      `select distinct district from places
       where is_published and ($1::text is null or city_slug = $1) order by district`,
      [request.query.city ?? null]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(r => r.district) };
  });

  app.get('/api/v1/places/:id', async (request, reply) => {
    const { rows } = await pool.query(
      `select p.id, p.name, p.category, p.district, p.address, p.about, p.phone,
              p.lat, p.lng, p.rating_avg, p.rating_count, p.city_slug, p.source,
              p.source_url, p.source_reviews_url, p.source_rating, p.source_rating_count, p.image_url, p.photos,
              p.metadata, (p.partner_id is not null) as bookable
       from places p where p.id = $1 and p.is_published`, [uuidParam(request)]);
    if (!rows[0]) fail(404, 'place_not_found', 'Заведение не найдено');
    const place = rows[0];
    const offers = await pool.query(
      `select o.id, o.title, o.description, o.duration_min, o.price_cents, o.currency,
              (select min(s.starts_at) from availability_slots s
                where s.offer_id = o.id and s.starts_at > now()) as next_slot
       from offers o where o.place_id = $1 and o.is_active order by o.price_cents`, [place.id]);
    const reviews = await pool.query(
      `select r.id, r.rating, r.body, r.created_at, r.source, r.author_name,
              r.external_url, r.published_at, u.display_name
       from reviews r left join users u on u.id = r.author_user_id
       where r.place_id = $1 and r.status = 'published'
       order by (r.source = 'own') desc, r.created_at desc limit 50`, [place.id]);
    const products = await pool.query(
      `select id, title, description, price_cents, currency, stock_qty, unit, is_active
       from products where place_id = $1 and is_active order by price_cents`, [place.id]);
    const zones = await pool.query(
      `select id, district, fee_cents, min_order_cents, eta_min, is_active
       from delivery_zones where place_id = $1 and is_active order by fee_cents`, [place.id]);
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
        city: place.city_slug,
        image: place.image_url,
        photos: Array.isArray(place.photos) ? place.photos : [],
        bookable: place.bookable,
        rating: place.rating_avg === null ? null : Number(place.rating_avg),
        ratingCount: place.rating_count,
        source: place.source === '2gis' ? {
          name: '2ГИС', url: place.source_url, reviewsUrl: place.source_reviews_url,
          rating: place.source_rating === null ? null : Number(place.source_rating),
          ratingCount: place.source_rating_count,
        } : null,
        info: {
          schedule: scheduleText(place.metadata?.schedule),
          sites: Array.isArray(place.metadata?.sites) ? place.metadata.sites.filter(Boolean).slice(0, 3) : [],
        },
      },
      offers: offers.rows.map(o => ({
        id: o.id,
        title: o.title,
        description: o.description,
        durationMin: o.duration_min,
        price: money(o.price_cents, o.currency),
        nextSlot: o.next_slot,
      })),
      products: products.rows.map(shopProductView),
      delivery: { available: zones.rows.length > 0, zones: zones.rows.map(deliveryZoneView) },
      reviews: reviews.rows.map(r => ({
        id: r.id, source: r.source, rating: r.rating, body: r.body,
        createdAt: r.published_at ?? r.created_at,
        author: r.source === '2gis' ? (r.author_name || 'Гость 2ГИС') : r.display_name,
        externalUrl: r.external_url,
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

  async function loadProductForManager(auth, productId, client = pool) {
    const { rows } = await client.query(
      `select pr.id, pr.place_id, p.partner_id from products pr
       join places p on p.id = pr.place_id where pr.id = $1`, [productId]);
    if (!rows[0]) fail(404, 'product_not_found', 'Товар не найден');
    if (!canManagePartner(auth, rows[0].partner_id)) fail(403, 'forbidden', 'Это не ваш товар');
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
    const products = await client.query(
      `select id, title, description, price_cents, currency, stock_qty, unit, is_active
       from products where place_id = $1 order by created_at`, [p.id]);
    const zones = await client.query(
      `select id, district, fee_cents, min_order_cents, eta_min, is_active
       from delivery_zones where place_id = $1 order by district`, [p.id]);
    return {
      id: p.id, name: p.name, category: p.category, district: p.district, address: p.address,
      about: p.about, phone: p.phone, location: { lat: Number(p.lat), lng: Number(p.lng) },
      isPublished: p.is_published, updatedAt: p.updated_at,
      offers: offers.rows.map(o => ({
        id: o.id, title: o.title, description: o.description, durationMin: o.duration_min,
        price: money(o.price_cents, o.currency), isActive: o.is_active,
        slotCount: o.slot_count, nextSlot: o.next_slot,
      })),
      products: products.rows.map(shopProductView),
      zones: zones.rows.map(deliveryZoneView),
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

  app.post('/api/v1/partner/places/:id/products', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['title', 'priceCents'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 1000 },
        priceCents: { type: 'integer', minimum: 1, maximum: 100000000 },
        stockQty: { type: 'integer', minimum: 0, maximum: 1000000 },
        unit: { type: 'string', minLength: 1, maxLength: 20 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireRole(request, 'partner', 'operator');
    await loadPlaceForManager(auth, uuidParam(request));
    const { title, description = '', priceCents, stockQty = 0, unit = 'шт' } = request.body;
    const { rows } = await pool.query(
      `insert into products (place_id, title, description, price_cents, stock_qty, unit)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [uuidParam(request), title, description, priceCents, stockQty, unit]);
    reply.code(201);
    return (await partnerPlaceView(pool, uuidParam(request))).products.find(product => product.id === rows[0].id);
  });

  app.patch('/api/v1/partner/products/:id', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 1000 },
        priceCents: { type: 'integer', minimum: 1, maximum: 100000000 },
        stockQty: { type: 'integer', minimum: 0, maximum: 1000000 },
        unit: { type: 'string', minLength: 1, maxLength: 20 },
        isActive: { type: 'boolean' },
      },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'partner', 'operator');
    const product = await loadProductForManager(auth, uuidParam(request));
    const columns = { title: 'title', description: 'description', priceCents: 'price_cents',
      stockQty: 'stock_qty', unit: 'unit', isActive: 'is_active' };
    const updates = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in request.body)) continue;
      values.push(request.body[key]);
      updates.push(`${column} = $${values.length}`);
    }
    if (!updates.length) fail(400, 'empty_update', 'Нет полей для изменения');
    values.push(product.id);
    await pool.query(
      `update products set ${updates.join(', ')}, updated_at = now() where id = $${values.length}`, values);
    return (await partnerPlaceView(pool, product.place_id)).products.find(item => item.id === product.id);
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
      if (isUniqueViolation(error) && (error.constraint === 'reviews_booking_id_key'
        || error.constraint === 'reviews_own_place_user_uq')) {
        fail(409, 'review_exists', 'Отзыв об этом месте уже есть');
      }
      throw error;
    }
  });

  app.get('/api/v1/places/:id/reviews', async (request, reply) => {
    const { rows } = await pool.query(
      `select r.id, r.rating, r.body, r.created_at, r.source, r.author_name, r.external_url,
              r.published_at, u.display_name
       from reviews r left join users u on u.id = r.author_user_id
       where r.place_id = $1 and r.status = 'published'
       order by (r.source = 'own') desc, r.created_at desc limit 100`,
      [uuidParam(request)]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(r => ({
      id: r.id, source: r.source, rating: r.rating, body: r.body,
      createdAt: r.published_at ?? r.created_at,
      author: r.source === '2gis' ? (r.author_name || 'Гость 2ГИС') : r.display_name,
      externalUrl: r.external_url,
    })) };
  });

  app.post('/api/v1/places/:id/reviews', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['rating'],
      properties: {
        rating: { type: 'integer', minimum: 1, maximum: 5 },
        body: { type: 'string', maxLength: 1000 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireUser(request);
    const placeId = uuidParam(request);
    const { rating, body = '' } = request.body;
    const place = await pool.query('select id from places where id = $1 and is_published', [placeId]);
    if (!place.rows[0]) fail(404, 'place_not_found', 'Заведение не найдено');
    try {
      const inserted = await pool.query(
        `insert into reviews (booking_id, place_id, author_user_id, rating, body, status, source)
         values (null, $1, $2, $3, $4, 'pending', 'own')
         returning id, created_at, status`,
        [placeId, auth.userId, rating, body]);
      reply.code(201);
      return { id: inserted.rows[0].id, createdAt: inserted.rows[0].created_at, status: inserted.rows[0].status };
    } catch (error) {
      if (isUniqueViolation(error) && error.constraint === 'reviews_own_place_user_uq') {
        fail(409, 'review_exists', 'Вы уже оставляли отзыв об этом месте');
      }
      throw error;
    }
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
       left join users u on u.id = r.author_user_id
       join places p on p.id = r.place_id
       left join bookings b on b.id = r.booking_id
       where r.source = 'own' and ($1::text = 'all' or r.status::text = $1)
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
      if (review.author_user_id) {
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'review_moderated', $2)`,
          [review.author_user_id, JSON.stringify({ reviewId: review.id, status })]);
      }
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
  // ---- такси ----
  app.post('/api/v1/trips/estimate', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['from', 'to'],
      properties: { from: POINT_SCHEMA, to: POINT_SCHEMA },
    } },
  }, async (request) => routeQuote(request.body.from, request.body.to));

  app.post('/api/v1/trips', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['from', 'to'],
      properties: {
        from: POINT_SCHEMA,
        to: POINT_SCHEMA,
        idempotencyKey: { type: 'string', minLength: 8, maxLength: 80 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireUser(request);
    const { from, to, idempotencyKey = null } = request.body;
    const quote = await routeQuote(from, to);
    const attempt = async () => withTransaction(pool, async (client) => {
      if (idempotencyKey) {
        const existing = await client.query(
          `${TRIP_SELECT} where t.client_user_id = $1 and t.idempotency_key = $2`, [auth.userId, idempotencyKey]);
        if (existing.rows[0]) return { trip: tripView(existing.rows[0]), created: false };
      }
      const inserted = await client.query(
        `insert into trips (client_user_id, from_label, from_lat, from_lng, to_label, to_lat, to_lng,
                            distance_km, duration_min, idempotency_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [auth.userId, from.label, from.lat, from.lng, to.label, to.lat, to.lng,
          quote.distanceKm, quote.durationMin, idempotencyKey]);
      const tripId = inserted.rows[0].id;
      await client.query(
        `insert into trip_events (trip_id, status, actor_user_id) values ($1, 'requested', $2)`, [tripId, auth.userId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'trip_requested', $2)`,
        [auth.userId, JSON.stringify({ tripId, from: from.label, to: to.label })]);
      const drivers = await client.query(
        `select m.user_id from memberships m join driver_profiles dp on dp.user_id = m.user_id
         where m.role = 'driver' and dp.is_online`);
      for (const driver of drivers.rows) {
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'trip_new', $2)`,
          [driver.user_id, JSON.stringify({ tripId, from: from.label, to: to.label })]);
      }
      const view = await client.query(`${TRIP_SELECT} where t.id = $1`, [tripId]);
      return { trip: tripView(view.rows[0]), created: true };
    });
    try {
      const result = await attempt();
      reply.code(result.created ? 201 : 200);
      return result.trip;
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (error.constraint === 'trips_client_active_uq') fail(409, 'active_trip', 'У вас уже есть активная поездка');
        if (error.constraint === 'trips_client_idem_uq') fail(409, 'duplicate_request', 'Повтор запроса');
      }
      throw error;
    }
  });

  app.get('/api/v1/me/trips', async (request, reply) => {
    const auth = requireUser(request);
    const { rows } = await pool.query(
      `${TRIP_SELECT} where t.client_user_id = $1 order by t.created_at desc limit 50`, [auth.userId]);
    const offers = await tripOffersForTrips(pool, rows.map(row => row.id));
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => tripView(row, offers.get(row.id) ?? [])) };
  });

  app.get('/api/v1/trips/:id', async (request, reply) => {
    const auth = requireUser(request);
    const { rows } = await pool.query(`${TRIP_SELECT} where t.id = $1`, [uuidParam(request)]);
    if (!rows[0]) fail(404, 'trip_not_found', 'Поездка не найдена');
    const trip = rows[0];
    if (trip.client_user_id !== auth.userId && trip.driver_user_id !== auth.userId && !isOperator(auth)) {
      fail(403, 'forbidden', 'Нет доступа к поездке');
    }
    const ownOnly = trip.client_user_id !== auth.userId && !isOperator(auth) ? auth.userId : null;
    const offers = await tripOffersForTrips(pool, [trip.id], ownOnly);
    reply.header('Cache-Control', 'no-store');
    return tripView(trip, offers.get(trip.id) ?? []);
  });

  app.post('/api/v1/trips/:id/cancel', async (request) => {
    const auth = requireUser(request);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query('select * from trips where id = $1 for update', [uuidParam(request)]);
      const trip = rows[0];
      if (!trip) fail(404, 'trip_not_found', 'Поездка не найдена');
      const isClient = trip.client_user_id === auth.userId;
      const isDriver = trip.driver_user_id === auth.userId;
      const clientCan = isClient && ['requested', 'assigned', 'arrived'].includes(trip.status);
      const driverCan = isDriver && ['assigned', 'arrived'].includes(trip.status);
      if (!clientCan && !driverCan && !isOperator(auth)) fail(403, 'forbidden', 'Отменить поездку нельзя');
      await client.query(
        `update trips set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = $1`, [trip.id]);
      await client.query(
        `update trip_offers set status = 'declined', updated_at = now()
         where trip_id = $1 and status = 'pending'`, [trip.id]);
      await client.query(
        `insert into trip_events (trip_id, status, actor_user_id) values ($1, 'cancelled', $2)`, [trip.id, auth.userId]);
      const target = isClient ? trip.driver_user_id : trip.client_user_id;
      if (target) {
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'trip_cancelled', $2)`,
          [target, JSON.stringify({ tripId: trip.id })]);
      }
      const view = await client.query(`${TRIP_SELECT} where t.id = $1`, [trip.id]);
      return tripView(view.rows[0]);
    });
  });

  async function driverTransition(request, fromStatuses, toStatus, stampColumn) {
    const auth = requireRole(request, 'driver', 'operator');
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query('select * from trips where id = $1 for update', [uuidParam(request)]);
      const trip = rows[0];
      if (!trip) fail(404, 'trip_not_found', 'Поездка не найдена');
      if (trip.driver_user_id !== auth.userId && !isOperator(auth)) fail(403, 'forbidden', 'Это не ваша поездка');
      if (!fromStatuses.includes(trip.status)) fail(409, 'invalid_transition', 'Поездка уже в другом состоянии');
      if (toStatus === 'completed' && trip.price_cents == null) {
        fail(409, 'price_not_agreed', 'Сначала согласуйте цену с клиентом');
      }
      const stamp = stampColumn === 'updated_at' ? '' : `, ${stampColumn} = now()`;
      await client.query(
        `update trips set status = $2${stamp}, updated_at = now() where id = $1`,
        [trip.id, toStatus]);
      await client.query(
        `insert into trip_events (trip_id, status, actor_user_id) values ($1, $2, $3)`, [trip.id, toStatus, auth.userId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, $2, $3)`,
        [trip.client_user_id, `trip_${toStatus}`, JSON.stringify({ tripId: trip.id, status: toStatus })]);
      if (toStatus === 'completed' && trip.driver_user_id) {
        await client.query(
          'update driver_profiles set rides_count = rides_count + 1 where user_id = $1', [trip.driver_user_id]);
      }
      const view = await client.query(`${TRIP_SELECT} where t.id = $1`, [trip.id]);
      return tripView(view.rows[0]);
    });
  }

  app.get('/api/v1/driver/trips', async (request, reply) => {
    const auth = requireRole(request, 'driver', 'operator');
    const available = await pool.query(
      `${TRIP_SELECT} where t.status = 'requested' order by t.created_at asc limit 50`);
    const mine = await pool.query(
      `${TRIP_SELECT} where t.driver_user_id = $1 and t.status in ('assigned', 'arrived', 'in_progress')
       order by t.created_at desc limit 50`, [auth.userId]);
    const allIds = [...available.rows, ...mine.rows].map(row => row.id);
    const offers = await tripOffersForTrips(pool, allIds, auth.userId);
    reply.header('Cache-Control', 'no-store');
    return {
      available: available.rows.map(row => tripView(row, offers.get(row.id) ?? [])),
      mine: mine.rows.map(row => tripView(row, offers.get(row.id) ?? [])),
    };
  });

  app.post('/api/v1/trips/:id/offers', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['priceCents'],
      properties: {
        priceCents: { type: 'integer', minimum: 5000, maximum: 10000000 },
        etaMin: { type: 'integer', minimum: 1, maximum: 180 },
        message: { type: 'string', maxLength: 200 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireRole(request, 'driver');
    const tripId = uuidParam(request);
    const priceCents = request.body.priceCents;
    const etaMin = request.body.etaMin ?? null;
    const message = String(request.body.message ?? '').trim().slice(0, 200);
    const result = await withTransaction(pool, async (client) => {
      const { rows } = await client.query('select * from trips where id = $1 for update', [tripId]);
      const trip = rows[0];
      if (!trip) fail(404, 'trip_not_found', 'Поездка не найдена');
      if (trip.client_user_id === auth.userId) fail(400, 'own_trip', 'Нельзя предложить цену на свою поездку');
      if (trip.status !== 'requested') fail(409, 'trip_taken', 'Поездка уже не ищет водителя');
      const busy = await client.query(
        `select 1 from trips where driver_user_id = $1
           and status in ('assigned', 'arrived', 'in_progress') limit 1`, [auth.userId]);
      if (busy.rows[0]) fail(409, 'driver_busy', 'У вас уже есть активная поездка');
      const existing = await client.query(
        'select * from trip_offers where trip_id = $1 and driver_user_id = $2 for update', [tripId, auth.userId]);
      let offerId;
      if (existing.rows[0]) {
        if (existing.rows[0].status !== 'pending') fail(409, 'offer_locked', 'Предложение уже обработано');
        offerId = existing.rows[0].id;
        await client.query(
          `update trip_offers set price_cents = $2, eta_min = $3, message = $4, updated_at = now()
           where id = $1`, [offerId, priceCents, etaMin, message]);
      } else {
        const inserted = await client.query(
          `insert into trip_offers (trip_id, driver_user_id, price_cents, eta_min, message)
           values ($1, $2, $3, $4, $5) returning id`, [tripId, auth.userId, priceCents, etaMin, message]);
        offerId = inserted.rows[0].id;
      }
      const offer = await client.query(
        `select o.*, u.display_name as driver_name, dp.car_model, dp.plate
         from trip_offers o join users u on u.id = o.driver_user_id
         left join driver_profiles dp on dp.user_id = o.driver_user_id
         where o.id = $1`, [offerId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'trip_offer', $2)`,
        [trip.client_user_id, JSON.stringify({
          tripId, offerId, priceCents, driverName: offer.rows[0].driver_name,
        })]);
      return tripOfferView(offer.rows[0]);
    });
    reply.code(201);
    return result;
  });

  app.post('/api/v1/trips/:id/offers/:offerId/accept', async (request) => {
    const auth = requireUser(request);
    const tripId = uuidParam(request);
    const offerId = uuidValue(request.params.offerId, 'Предложение');
    try {
      return await withTransaction(pool, async (client) => {
        const { rows } = await client.query('select * from trips where id = $1 for update', [tripId]);
        const trip = rows[0];
        if (!trip) fail(404, 'trip_not_found', 'Поездка не найдена');
        if (trip.client_user_id !== auth.userId) fail(403, 'forbidden', 'Это не ваша поездка');
        if (trip.status !== 'requested') fail(409, 'trip_taken', 'Поездка уже назначена');
        const offer = await client.query(
          `select o.*, u.display_name as driver_name, dp.car_model, dp.plate
           from trip_offers o join users u on u.id = o.driver_user_id
           left join driver_profiles dp on dp.user_id = o.driver_user_id
           where o.id = $1 and o.trip_id = $2 and o.status = 'pending' for update of o`, [offerId, tripId]);
        if (!offer.rows[0]) fail(404, 'offer_not_found', 'Предложение недоступно');
        const selected = offer.rows[0];
        await client.query(
          `update trips set status = 'assigned', driver_user_id = $2, price_cents = $3, currency = 'RUB',
             accepted_at = now(), updated_at = now() where id = $1`,
          [tripId, selected.driver_user_id, selected.price_cents]);
        await client.query(
          `update trip_offers set status = 'accepted', updated_at = now() where id = $1`, [selected.id]);
        await client.query(
          `update trip_offers set status = 'declined', updated_at = now()
           where trip_id = $1 and id <> $2 and status = 'pending'`, [tripId, selected.id]);
        await client.query(
          `insert into trip_events (trip_id, status, actor_user_id, note)
           values ($1, 'assigned', $2, $3)`,
          [tripId, auth.userId, `цена ${selected.price_cents} копеек`]);
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'trip_assigned', $2)`,
          [selected.driver_user_id, JSON.stringify({ tripId, priceCents: selected.price_cents, status: 'assigned' })]);
        const view = await client.query(`${TRIP_SELECT} where t.id = $1`, [tripId]);
        const offers = await tripOffersForTrips(client, [tripId]);
        return tripView(view.rows[0], offers.get(tripId) ?? []);
      });
    } catch (error) {
      if (isUniqueViolation(error) && error.constraint === 'trips_driver_active_uq') {
        fail(409, 'driver_busy', 'У водителя уже есть активная поездка');
      }
      throw error;
    }
  });

  app.post('/api/v1/trips/:id/arrive', async (request) =>
    driverTransition(request, ['assigned'], 'arrived', 'updated_at'));
  app.post('/api/v1/trips/:id/start', async (request) =>
    driverTransition(request, ['arrived'], 'in_progress', 'started_at'));
  app.post('/api/v1/trips/:id/complete', async (request) =>
    driverTransition(request, ['in_progress'], 'completed', 'completed_at'));

  app.get('/api/v1/operator/trips', async (request, reply) => {
    requireRole(request, 'operator');
    const { rows } = await pool.query(
      `${TRIP_SELECT} where t.status in ('requested', 'assigned', 'arrived', 'in_progress')
       order by t.created_at asc limit 100`);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(tripView) };
  });

  app.get('/api/v1/operator/drivers', async (request, reply) => {
    requireRole(request, 'operator');
    const { rows } = await pool.query(
      `select u.id, u.display_name, dp.car_model, dp.plate, dp.is_online,
              (select count(*)::int from trips t where t.driver_user_id = u.id
                and t.status in ('assigned', 'arrived', 'in_progress')) as active_trips
       from memberships m
       join users u on u.id = m.user_id
       left join driver_profiles dp on dp.user_id = u.id
       where m.role = 'driver' order by u.display_name`);
    reply.header('Cache-Control', 'no-store');
    return { items: rows };
  });

  app.post('/api/v1/operator/trips/:id/assign', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['driverUserId', 'priceCents'],
      properties: {
        driverUserId: { type: 'string', format: 'uuid' },
        priceCents: { type: 'integer', minimum: 5000, maximum: 10000000 },
      },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'operator');
    try {
    return await withTransaction(pool, async (client) => {
      const driver = await client.query(
        `select u.id from memberships m join users u on u.id = m.user_id
         join driver_profiles dp on dp.user_id = u.id
         where m.role = 'driver' and u.id = $1`, [request.body.driverUserId]);
      if (!driver.rows[0]) fail(404, 'driver_not_found', 'Водитель не найден');
      const { rows } = await client.query('select * from trips where id = $1 for update', [uuidParam(request)]);
      const trip = rows[0];
      if (!trip) fail(404, 'trip_not_found', 'Поездка не найдена');
      if (trip.status !== 'requested') fail(409, 'trip_taken', 'Поездка уже назначена');
      await client.query(
        `update trips set status = 'assigned', driver_user_id = $2, price_cents = $3, currency = 'RUB',
           accepted_at = now(), updated_at = now() where id = $1`,
        [trip.id, request.body.driverUserId, request.body.priceCents]);
      await client.query(
        `insert into trip_events (trip_id, status, actor_user_id, note) values ($1, 'assigned', $2, 'operator')`,
        [trip.id, auth.userId]);
      for (const userId of [trip.client_user_id, request.body.driverUserId]) {
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'trip_assigned', $2)`,
          [userId, JSON.stringify({ tripId: trip.id, priceCents: request.body.priceCents, status: 'assigned' })]);
      }
      const view = await client.query(`${TRIP_SELECT} where t.id = $1`, [trip.id]);
      return tripView(view.rows[0]);
    });
    } catch (error) {
      if (isUniqueViolation(error) && error.constraint === 'trips_driver_active_uq') {
        fail(409, 'driver_busy', 'У водителя уже есть активная поездка');
      }
      throw error;
    }
  });


  // ---- частные услуги с выездом ----
  function parseServiceWindow(preferredFrom, preferredTo) {
    const from = new Date(preferredFrom);
    const to = new Date(preferredTo);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
      fail(400, 'invalid_window', 'Укажите время заявки');
    }
    if (to <= from) fail(400, 'invalid_window', 'Конец окна должен быть позже начала');
    if (to.getTime() < Date.now() - 60_000) fail(400, 'window_in_past', 'Это время уже прошло');
    return { from, to };
  }

  app.get('/api/v1/me/service-requests', async (request, reply) => {
    const auth = requireUser(request);
    const { rows } = await pool.query(
      `${SERVICE_SELECT} where r.client_user_id = $1 order by r.created_at desc limit 50`, [auth.userId]);
    const offers = await offersForRequests(pool, rows.map(row => row.id));
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => serviceRequestView(row, offers.get(row.id) ?? [])) };
  });

  app.post('/api/v1/me/service-requests', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      required: ['category', 'title', 'address', 'budgetMinCents', 'budgetMaxCents', 'preferredFrom', 'preferredTo'],
      properties: {
        category: { type: 'string', enum: SERVICE_CATEGORIES },
        title: { type: 'string', minLength: 3, maxLength: 120 },
        description: { type: 'string', maxLength: 1500 },
        address: { type: 'string', minLength: 3, maxLength: 240 },
        budgetMinCents: { type: 'integer', minimum: 0, maximum: 100000000 },
        budgetMaxCents: { type: 'integer', minimum: 0, maximum: 100000000 },
        preferredFrom: { type: 'string', format: 'date-time' },
        preferredTo: { type: 'string', format: 'date-time' },
        idempotencyKey: { type: 'string', minLength: 8, maxLength: 80 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireUser(request);
    const body = request.body;
    if (body.budgetMaxCents < body.budgetMinCents) fail(400, 'invalid_budget', 'Максимум меньше минимума');
    const { from, to } = parseServiceWindow(body.preferredFrom, body.preferredTo);
    const idempotencyKey = body.idempotencyKey ?? null;
    const attempt = async () => withTransaction(pool, async (client) => {
      if (idempotencyKey) {
        const existing = await client.query(
          `${SERVICE_SELECT} where r.client_user_id = $1 and r.idempotency_key = $2`, [auth.userId, idempotencyKey]);
        if (existing.rows[0]) {
          const item = await loadServiceRequest(client, existing.rows[0].id);
          return { item, created: false };
        }
      }
      const inserted = await client.query(
        `insert into service_requests
           (client_user_id, category, title, description, address, budget_min_cents, budget_max_cents,
            preferred_from, preferred_to, idempotency_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [auth.userId, body.category, body.title, body.description ?? '', body.address,
          body.budgetMinCents, body.budgetMaxCents, from, to, idempotencyKey]);
      const id = inserted.rows[0].id;
      await client.query(
        `insert into service_request_events (request_id, status, actor_user_id) values ($1, 'open', $2)`,
        [id, auth.userId]);
      return { item: await loadServiceRequest(client, id), created: true };
    });
    try {
      const result = await attempt();
      reply.code(result.created ? 201 : 200);
      return result.item;
    } catch (error) {
      if (isUniqueViolation(error) && error.constraint === 'service_requests_client_idem_uq') {
        fail(409, 'duplicate_request', 'Повтор заявки');
      }
      throw error;
    }
  });

  app.post('/api/v1/me/service-requests/:id/offers/:offerId/accept', async (request) => {
    const auth = requireUser(request);
    const requestId = uuidValue(request.params.id, 'Заявка');
    const offerId = uuidValue(request.params.offerId, 'Предложение');
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query('select * from service_requests where id = $1 for update', [requestId]);
      const item = rows[0];
      if (!item) fail(404, 'request_not_found', 'Заявка не найдена');
      if (item.client_user_id !== auth.userId) fail(403, 'forbidden', 'Это не ваша заявка');
      if (item.status !== 'open') fail(409, 'request_closed', 'Заявка уже не открыта');
      const offerResult = await client.query(
        'select * from service_offers where id = $1 and request_id = $2 for update', [offerId, requestId]);
      const offer = offerResult.rows[0];
      if (!offer) fail(404, 'offer_not_found', 'Предложение не найдено');
      if (offer.status !== 'pending') fail(409, 'offer_closed', 'Предложение уже недоступно');
      await client.query(
        `update service_requests set status = 'assigned', partner_id = $2, accepted_offer_id = $3,
                price_cents = $4, assigned_at = now(), updated_at = now()
         where id = $1`, [requestId, offer.partner_id, offer.id, offer.price_cents]);
      await client.query(
        `update service_offers set status = 'accepted', updated_at = now() where id = $1`, [offer.id]);
      const declined = await client.query(
        `update service_offers set status = 'declined', updated_at = now()
         where request_id = $1 and id <> $2 and status = 'pending' returning created_by`, [requestId, offer.id]);
      await client.query(
        `insert into service_request_events (request_id, status, actor_user_id, note)
         values ($1, 'assigned', $2, 'accepted_offer')`, [requestId, auth.userId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'service_offer_accepted', $2)`,
        [offer.created_by, JSON.stringify({ requestId, price: offer.price_cents })]);
      for (const row of declined.rows) {
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'service_offer_declined', $2)`,
          [row.created_by, JSON.stringify({ requestId })]);
      }
      return loadServiceRequest(client, requestId);
    });
  });

  app.post('/api/v1/me/service-requests/:id/cancel', async (request) => {
    const auth = requireUser(request);
    const requestId = uuidValue(request.params.id, 'Заявка');
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query('select * from service_requests where id = $1 for update', [requestId]);
      const item = rows[0];
      if (!item) fail(404, 'request_not_found', 'Заявка не найдена');
      if (item.client_user_id !== auth.userId) fail(403, 'forbidden', 'Это не ваша заявка');
      if (!['open', 'assigned'].includes(item.status)) fail(409, 'invalid_transition', 'Заявку уже нельзя отменить');
      await client.query(
        `update service_requests set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = $1`,
        [requestId]);
      await client.query(
        `insert into service_request_events (request_id, status, actor_user_id) values ($1, 'cancelled', $2)`,
        [requestId, auth.userId]);
      if (item.partner_id) await notifyPartner(client, item.partner_id, 'service_cancelled', { requestId });
      return loadServiceRequest(client, requestId);
    });
  });

  app.get('/api/v1/partner/service-requests', async (request, reply) => {
    const auth = requireRole(request, 'partner');
    const partnerIds = partnerIdsOf(auth);
    if (!partnerIds.length) fail(403, 'forbidden', 'Нет кабинета партнёра');
    const open = await pool.query(
      `${SERVICE_SELECT} where r.status = 'open' and r.preferred_to > now()
       order by r.created_at limit 100`);
    const jobs = await pool.query(
      `${SERVICE_SELECT} where r.partner_id = any($1::uuid[]) and r.status in ('assigned', 'in_progress')
       order by r.created_at desc limit 100`, [partnerIds]);
    const visibleOffers = await offersForRequests(pool, open.rows.map(row => row.id), partnerIds);
    reply.header('Cache-Control', 'no-store');
    return {
      open: open.rows.map(row => serviceRequestView(row, visibleOffers.get(row.id) ?? [])),
      jobs: jobs.rows.map(row => serviceRequestView(row, [])),
    };
  });

  app.post('/api/v1/partner/service-requests/:id/offers', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['priceCents'],
      properties: {
        priceCents: { type: 'integer', minimum: 1, maximum: 100000000 },
        message: { type: 'string', maxLength: 1000 },
        etaMin: { type: 'integer', minimum: 0, maximum: 1440 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireRole(request, 'partner');
    const partnerIds = partnerIdsOf(auth);
    if (!partnerIds.length) fail(403, 'forbidden', 'Нет кабинета партнёра');
    const partnerId = partnerIds[0];
    const requestId = uuidValue(request.params.id, 'Заявка');
    const result = await withTransaction(pool, async (client) => {
      const { rows } = await client.query('select * from service_requests where id = $1 for update', [requestId]);
      const item = rows[0];
      if (!item) fail(404, 'request_not_found', 'Заявка не найдена');
      if (item.client_user_id === auth.userId) fail(403, 'own_request', 'Нельзя предлагать услугу самому себе');
      if (item.status !== 'open') fail(409, 'request_closed', 'Заявка уже не открыта');
      if (new Date(item.preferred_to).getTime() < Date.now()) fail(409, 'request_expired', 'Время заявки прошло');
      const approved = await client.query(
        "select id from partners where id = $1 and status = 'approved'", [partnerId]);
      if (!approved.rows[0]) fail(403, 'partner_not_approved', 'Партнёр не подтверждён');
      const existing = await client.query(
        'select * from service_offers where request_id = $1 and partner_id = $2 for update', [requestId, partnerId]);
      let offerId;
      if (existing.rows[0]) {
        if (['pending', 'accepted'].includes(existing.rows[0].status)) {
          fail(409, 'already_offered', 'Вы уже предложили цену');
        }
        const updated = await client.query(
          `update service_offers set price_cents = $2, message = $3, eta_min = $4, status = 'pending',
                  updated_at = now() where id = $1 returning id`,
          [existing.rows[0].id, request.body.priceCents, request.body.message ?? '', request.body.etaMin ?? null]);
        offerId = updated.rows[0].id;
      } else {
        const inserted = await client.query(
          `insert into service_offers (request_id, partner_id, created_by, price_cents, message, eta_min)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [requestId, partnerId, auth.userId, request.body.priceCents,
            request.body.message ?? '', request.body.etaMin ?? null]);
        offerId = inserted.rows[0].id;
      }
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'service_offer', $2)`,
        [item.client_user_id, JSON.stringify({ requestId, price: request.body.priceCents, partnerId })]);
      const offer = await client.query(
        `select o.*, p.name as partner_name from service_offers o
         join partners p on p.id = o.partner_id where o.id = $1`, [offerId]);
      return serviceOfferView(offer.rows[0]);
    });
    reply.code(201);
    return result;
  });

  app.post('/api/v1/partner/service-offers/:id/withdraw', async (request) => {
    const auth = requireRole(request, 'partner');
    const partnerIds = partnerIdsOf(auth);
    const offerId = uuidValue(request.params.id, 'Предложение');
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        'select * from service_offers where id = $1 for update', [offerId]);
      const offer = rows[0];
      if (!offer) fail(404, 'offer_not_found', 'Предложение не найдено');
      if (!partnerIds.includes(offer.partner_id)) fail(403, 'forbidden', 'Это не ваше предложение');
      if (offer.status !== 'pending') fail(409, 'offer_closed', 'Предложение уже нельзя отозвать');
      await client.query(
        `update service_offers set status = 'withdrawn', updated_at = now() where id = $1`, [offer.id]);
      return { ok: true };
    });
  });

  async function serviceTransition(request, fromStatus, toStatus, stampColumn) {
    const auth = requireRole(request, 'partner', 'operator');
    const partnerIds = partnerIdsOf(auth);
    const requestId = uuidValue(request.params.id, 'Заявка');
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query('select * from service_requests where id = $1 for update', [requestId]);
      const item = rows[0];
      if (!item) fail(404, 'request_not_found', 'Заявка не найдена');
      if (!isOperator(auth) && !partnerIds.includes(item.partner_id)) {
        fail(403, 'forbidden', 'Это не ваша заявка');
      }
      if (item.status !== fromStatus) fail(409, 'invalid_transition', 'Заявка уже в другом состоянии');
      await client.query(
        `update service_requests set status = $2, ${stampColumn} = now(), updated_at = now() where id = $1`,
        [requestId, toStatus]);
      await client.query(
        `insert into service_request_events (request_id, status, actor_user_id) values ($1, $2, $3)`,
        [requestId, toStatus, auth.userId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, $2, $3)`,
        [item.client_user_id, `service_${toStatus}`, JSON.stringify({ requestId, status: toStatus })]);
      return loadServiceRequest(client, requestId);
    });
  }

  app.post('/api/v1/partner/service-requests/:id/start', async (request) =>
    serviceTransition(request, 'assigned', 'in_progress', 'started_at'));
  app.post('/api/v1/partner/service-requests/:id/complete', async (request) =>
    serviceTransition(request, 'in_progress', 'completed', 'completed_at'));

  app.get('/api/v1/operator/service-requests', async (request, reply) => {
    requireRole(request, 'operator');
    const { rows } = await pool.query(
      `${SERVICE_SELECT} where r.status in ('open', 'assigned', 'in_progress')
       order by r.created_at limit 100`);
    const offers = await offersForRequests(pool, rows.map(row => row.id));
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => serviceRequestView(row, offers.get(row.id) ?? [])) };
  });


  // ---- товары и самовывоз ----
  app.get('/api/v1/me/shop-orders', async (request, reply) => {
    const auth = requireUser(request);
    const { rows } = await pool.query(
      `${SHOP_ORDER_SELECT} where o.client_user_id = $1 order by o.created_at desc limit 50`, [auth.userId]);
    const items = await shopItemsFor(pool, rows.map(row => row.id));
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => shopOrderView(row, items.get(row.id) ?? [])) };
  });

  app.post('/api/v1/me/shop-orders', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['placeId', 'items'],
      properties: {
        placeId: { type: 'string', format: 'uuid' },
        items: {
          type: 'array', minItems: 1, maxItems: 40,
          items: {
            type: 'object', additionalProperties: false, required: ['productId', 'qty'],
            properties: {
              productId: { type: 'string', format: 'uuid' },
              qty: { type: 'integer', minimum: 1, maximum: 99 },
            },
          },
        },
        note: { type: 'string', maxLength: 300 },
        idempotencyKey: { type: 'string', minLength: 8, maxLength: 80 },
        fulfillment: { type: 'string', enum: ['pickup', 'delivery'] },
        deliveryAddress: { type: 'string', maxLength: 240 },
        deliveryDistrict: { type: 'string', maxLength: 60 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireUser(request);
    const body = request.body;
    const idempotencyKey = body.idempotencyKey ?? null;
    const attempt = async () => withTransaction(pool, async (client) => {
      if (idempotencyKey) {
        const existing = await client.query(
          `${SHOP_ORDER_SELECT} where o.client_user_id = $1 and o.idempotency_key = $2`,
          [auth.userId, idempotencyKey]);
        if (existing.rows[0]) return { order: await loadShopOrder(client, existing.rows[0].id), created: false };
      }
      const place = await client.query(
        'select id, partner_id from places where id = $1 and is_published', [uuidValue(body.placeId, 'Заведение')]);
      if (!place.rows[0]) fail(404, 'place_not_found', 'Заведение не найдено');

      const wanted = new Map();
      for (const item of body.items) wanted.set(item.productId, (wanted.get(item.productId) ?? 0) + item.qty);
      if ([...wanted.values()].some(qty => qty > 99)) fail(400, 'too_many', 'Слишком много одного товара');
      const ids = [...wanted.keys()];
      const products = await client.query(
        `select id, title, price_cents, stock_qty, unit from products
         where id = any($1::uuid[]) and place_id = $2 and is_active order by id for update`,
        [ids, place.rows[0].id]);
      if (products.rows.length !== ids.length) fail(409, 'product_unavailable', 'Часть товаров уже недоступна');
      let goodsCents = 0;
      const lines = products.rows.map(row => {
        const qty = wanted.get(row.id);
        if (row.stock_qty < qty) fail(409, 'out_of_stock', `«${row.title}»: осталось ${row.stock_qty}`);
        goodsCents += row.price_cents * qty;
        return { row, qty, total: row.price_cents * qty };
      });
      const fulfillment = body.fulfillment ?? 'pickup';
      let deliveryFeeCents = 0;
      let deliveryEtaMin = null;
      if (fulfillment === 'delivery') {
        const address = (body.deliveryAddress ?? '').trim();
        const district = (body.deliveryDistrict ?? '').trim();
        if (address.length < 3 || !district) fail(400, 'delivery_address_required', 'Укажите адрес доставки');
        const zone = await client.query(
          `select fee_cents, min_order_cents, eta_min from delivery_zones
           where place_id = $1 and district = $2 and is_active`, [place.rows[0].id, district]);
        if (!zone.rows[0]) fail(409, 'delivery_unavailable', 'Доставка в этот район недоступна');
        if (goodsCents < zone.rows[0].min_order_cents) {
          fail(409, 'min_order', 'Сумма меньше минимальной для доставки');
        }
        deliveryFeeCents = zone.rows[0].fee_cents;
        deliveryEtaMin = zone.rows[0].eta_min;
      }
      const totalCents = goodsCents + deliveryFeeCents;
      const orderId = (await client.query(
        `insert into shop_orders (place_id, client_user_id, total_cents, goods_total_cents, fulfillment,
                                  delivery_address, delivery_district, delivery_fee_cents,
                                  pickup_code, note, idempotency_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [place.rows[0].id, auth.userId, totalCents, goodsCents, fulfillment,
          body.deliveryAddress ?? null, body.deliveryDistrict ?? null, deliveryFeeCents,
          String(randomInt(1000, 10000)), body.note ?? '', idempotencyKey]
      )).rows[0].id;
      for (const line of lines) {
        await client.query(
          `insert into shop_order_items (order_id, product_id, title, unit, unit_price_cents, qty, total_cents)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [orderId, line.row.id, line.row.title, line.row.unit, line.row.price_cents, line.qty, line.total]);
        await client.query(
          'update products set stock_qty = stock_qty - $2, updated_at = now() where id = $1',
          [line.row.id, line.qty]);
      }
      await client.query(
        `insert into shop_order_events (order_id, status, actor_user_id) values ($1, 'placed', $2)`,
        [orderId, auth.userId]);
      if (fulfillment === 'delivery') {
        await client.query(
          `insert into delivery_jobs (order_id, address, district, fee_cents, eta_min)
           values ($1, $2, $3, $4, $5)`,
          [orderId, body.deliveryAddress, body.deliveryDistrict, deliveryFeeCents, deliveryEtaMin]);
      }
      await notifyPartner(client, place.rows[0].partner_id, 'shop_order_new',
        { orderId, total: totalCents, placeId: place.rows[0].id });
      return { order: await loadShopOrder(client, orderId), created: true };
    });
    try {
      const result = await attempt();
      reply.code(result.created ? 201 : 200);
      return result.order;
    } catch (error) {
      if (isUniqueViolation(error) && error.constraint === 'shop_orders_client_idem_uq') {
        fail(409, 'duplicate_order', 'Повтор заказа');
      }
      throw error;
    }
  });

  app.post('/api/v1/me/shop-orders/:id/cancel', async (request) => {
    const auth = requireUser(request);
    const orderId = uuidParam(request);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `select o.*, p.partner_id from shop_orders o join places p on p.id = o.place_id
         where o.id = $1 for update`, [orderId]);
      const order = rows[0];
      if (!order) fail(404, 'order_not_found', 'Заказ не найден');
      if (order.client_user_id !== auth.userId) fail(403, 'forbidden', 'Это не ваш заказ');
      if (!['placed', 'confirmed'].includes(order.status)) {
        fail(409, 'invalid_transition', 'Заказ уже нельзя отменить');
      }
      await restockShopOrder(client, orderId);
      const job = await client.query(
        'select courier_user_id, status from delivery_jobs where order_id = $1 for update', [orderId]);
      await client.query(
        `update delivery_jobs set status = 'cancelled', cancelled_at = now(), updated_at = now()
         where order_id = $1 and status in ('pending', 'assigned')`, [orderId]);
      if (job.rows[0]?.courier_user_id) {
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'delivery_cancelled', $2)`,
          [job.rows[0].courier_user_id, JSON.stringify({ orderId })]);
      }
      await client.query(
        `update shop_orders set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = $1`,
        [orderId]);
      await client.query(
        `insert into shop_order_events (order_id, status, actor_user_id) values ($1, 'cancelled', $2)`,
        [orderId, auth.userId]);
      await notifyPartner(client, order.partner_id, 'shop_order_cancelled', { orderId });
      return loadShopOrder(client, orderId);
    });
  });

  app.get('/api/v1/partner/shop-orders', async (request, reply) => {
    const auth = requireRole(request, 'partner');
    const partnerIds = partnerIdsOf(auth);
    if (!partnerIds.length) fail(403, 'forbidden', 'Нет кабинета партнёра');
    const { rows } = await pool.query(
      `${SHOP_ORDER_SELECT} where p.partner_id = any($1::uuid[])
       order by case o.status when 'placed' then 0 when 'confirmed' then 1 when 'ready' then 2 else 3 end,
                o.created_at desc limit 100`, [partnerIds]);
    const items = await shopItemsFor(pool, rows.map(row => row.id));
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => shopOrderView(row, items.get(row.id) ?? [])) };
  });

  app.post('/api/v1/partner/shop-orders/:id/status', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: { action: { type: 'string', enum: ['confirm', 'ready', 'complete', 'cancel'] } },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'partner', 'operator');
    const orderId = uuidParam(request);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `select o.*, p.partner_id from shop_orders o join places p on p.id = o.place_id
         where o.id = $1 for update`, [orderId]);
      const order = rows[0];
      if (!order) fail(404, 'order_not_found', 'Заказ не найден');
      if (!isOperator(auth) && !partnerIdsOf(auth).includes(order.partner_id)) {
        fail(403, 'forbidden', 'Это не ваш заказ');
      }
      const action = request.body.action;
      const transitions = {
        confirm: { from: 'placed', to: 'confirmed', stamp: 'confirmed_at' },
        ready: { from: 'confirmed', to: 'ready', stamp: 'ready_at' },
        complete: { from: 'ready', to: 'completed', stamp: 'completed_at' },
      };
      if (action === 'cancel') {
        if (!['placed', 'confirmed'].includes(order.status)) fail(409, 'invalid_transition', 'Заказ уже нельзя отменить');
        await restockShopOrder(client, orderId);
        await client.query(
          `update delivery_jobs set status = 'cancelled', cancelled_at = now(), updated_at = now()
           where order_id = $1 and status in ('pending', 'assigned')`, [orderId]);
        await client.query(
          `update shop_orders set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = $1`,
          [orderId]);
      } else {
        if (action === 'complete' && order.fulfillment === 'delivery') {
          fail(409, 'courier_required', 'Доставку завершает курьер');
        }
        const transition = transitions[action];
        if (order.status !== transition.from) fail(409, 'invalid_transition', 'Заказ уже в другом состоянии');
        await client.query(
          `update shop_orders set status = $2, ${transition.stamp} = now(), updated_at = now() where id = $1`,
          [orderId, transition.to]);
        if (action === 'ready' && order.fulfillment === 'delivery') {
          const job = await client.query('select id from delivery_jobs where order_id = $1', [orderId]);
          const couriers = await client.query('select user_id from courier_profiles where is_online');
          for (const courier of couriers.rows) {
            await client.query(
              `insert into notifications (user_id, kind, payload) values ($1, 'delivery_available', $2)`,
              [courier.user_id, JSON.stringify({ orderId, jobId: job.rows[0]?.id })]);
          }
        }
      }
      const nextStatus = action === 'cancel' ? 'cancelled' : transitions[action].to;
      await client.query(
        `insert into shop_order_events (order_id, status, actor_user_id) values ($1, $2, $3)`,
        [orderId, nextStatus, auth.userId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, $2, $3)`,
        [order.client_user_id, `shop_${nextStatus}`, JSON.stringify({ orderId, status: nextStatus })]);
      return loadShopOrder(client, orderId);
    });
  });

  app.get('/api/v1/operator/shop-orders', async (request, reply) => {
    requireRole(request, 'operator');
    const { rows } = await pool.query(
      `${SHOP_ORDER_SELECT} order by o.created_at desc limit 100`);
    const items = await shopItemsFor(pool, rows.map(row => row.id));
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => shopOrderView(row, items.get(row.id) ?? [])) };
  });


  // ---- зоны доставки и курьер ----
  app.post('/api/v1/partner/places/:id/zones', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['district', 'feeCents', 'etaMin'],
      properties: {
        district: { type: 'string', minLength: 1, maxLength: 60 },
        feeCents: { type: 'integer', minimum: 0, maximum: 100000 },
        minOrderCents: { type: 'integer', minimum: 0, maximum: 100000000 },
        etaMin: { type: 'integer', minimum: 5, maximum: 180 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireRole(request, 'partner', 'operator');
    const place = await loadPlaceForManager(auth, uuidParam(request));
    const { district, feeCents, minOrderCents = 0, etaMin } = request.body;
    const { rows } = await pool.query(
      `insert into delivery_zones (place_id, district, fee_cents, min_order_cents, eta_min)
       values ($1, $2, $3, $4, $5)
       on conflict (place_id, district) do update set fee_cents = excluded.fee_cents,
         min_order_cents = excluded.min_order_cents, eta_min = excluded.eta_min, is_active = true, updated_at = now()
       returning *`, [place.id, district, feeCents, minOrderCents, etaMin]);
    reply.code(201);
    return deliveryZoneView(rows[0]);
  });

  app.patch('/api/v1/partner/zones/:id', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: {
        feeCents: { type: 'integer', minimum: 0, maximum: 100000 },
        minOrderCents: { type: 'integer', minimum: 0, maximum: 100000000 },
        etaMin: { type: 'integer', minimum: 5, maximum: 180 },
        isActive: { type: 'boolean' },
      },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'partner', 'operator');
    const zone = await pool.query(
      `select z.id, z.place_id, p.partner_id from delivery_zones z
       join places p on p.id = z.place_id where z.id = $1`, [uuidParam(request)]);
    if (!zone.rows[0]) fail(404, 'zone_not_found', 'Зона не найдена');
    if (!canManagePartner(auth, zone.rows[0].partner_id)) fail(403, 'forbidden', 'Это не ваша зона');
    const columns = { feeCents: 'fee_cents', minOrderCents: 'min_order_cents', etaMin: 'eta_min', isActive: 'is_active' };
    const updates = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in request.body)) continue;
      values.push(request.body[key]);
      updates.push(`${column} = $${values.length}`);
    }
    if (!updates.length) fail(400, 'empty_update', 'Нет полей для изменения');
    values.push(zone.rows[0].id);
    const { rows } = await pool.query(
      `update delivery_zones set ${updates.join(', ')}, updated_at = now() where id = $${values.length} returning *`, values);
    return deliveryZoneView(rows[0]);
  });

  app.get('/api/v1/courier/delivery-jobs', async (request, reply) => {
    const auth = requireRole(request, 'courier', 'operator');
    const available = await pool.query(
      `${DELIVERY_JOB_SELECT} where dj.status = 'pending' and o.status = 'ready' order by dj.created_at limit 50`);
    const mine = await pool.query(
      `${DELIVERY_JOB_SELECT} where dj.courier_user_id = $1 and dj.status in ('assigned', 'picked_up')
       order by dj.created_at`, [auth.userId]);
    reply.header('Cache-Control', 'no-store');
    return { available: available.rows.map(deliveryJobView), mine: mine.rows.map(deliveryJobView) };
  });

  app.post('/api/v1/courier/delivery-jobs/:id/claim', async (request) => {
    const auth = requireRole(request, 'courier');
    const jobId = uuidParam(request);
    try {
      return await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `select dj.*, o.status as order_status, o.client_user_id, o.place_id from delivery_jobs dj
           join shop_orders o on o.id = dj.order_id where dj.id = $1 for update`, [jobId]);
        const job = rows[0];
        if (!job) fail(404, 'delivery_not_found', 'Доставка не найдена');
        if (job.status !== 'pending') fail(409, 'delivery_taken', 'Доставку уже взяли');
        if (job.order_status !== 'ready') fail(409, 'not_ready', 'Заказ ещё не готов');
        await client.query(
          `update delivery_jobs set status = 'assigned', courier_user_id = $2, assigned_at = now(), updated_at = now()
           where id = $1`, [jobId, auth.userId]);
        await client.query(
          `insert into delivery_job_events (job_id, status, actor_user_id) values ($1, 'assigned', $2)`,
          [jobId, auth.userId]);
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'delivery_assigned', $2)`,
          [job.client_user_id, JSON.stringify({ jobId, orderId: job.order_id })]);
        const view = await client.query(`${DELIVERY_JOB_SELECT} where dj.id = $1`, [jobId]);
        return deliveryJobView(view.rows[0]);
      });
    } catch (error) {
      if (isUniqueViolation(error) && error.constraint === 'delivery_jobs_courier_active_uq') {
        fail(409, 'courier_busy', 'У вас уже есть активная доставка');
      }
      throw error;
    }
  });

  async function courierTransition(request, fromStatus, toStatus) {
    const auth = requireRole(request, 'courier');
    const jobId = uuidParam(request);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `select dj.*, o.status as order_status, o.client_user_id, o.place_id, p.partner_id
         from delivery_jobs dj join shop_orders o on o.id = dj.order_id
         join places p on p.id = o.place_id where dj.id = $1 for update`, [jobId]);
      const job = rows[0];
      if (!job) fail(404, 'delivery_not_found', 'Доставка не найдена');
      if (job.courier_user_id !== auth.userId) fail(403, 'forbidden', 'Это не ваша доставка');
      if (job.status !== fromStatus) fail(409, 'invalid_transition', 'Доставка уже в другом состоянии');
      await client.query(
        `update delivery_jobs set status = $2, ${toStatus === 'picked_up' ? 'picked_up_at' : 'delivered_at'} = now(),
                updated_at = now() where id = $1`, [jobId, toStatus]);
      await client.query(
        `insert into delivery_job_events (job_id, status, actor_user_id) values ($1, $2, $3)`,
        [jobId, toStatus, auth.userId]);
      if (toStatus === 'picked_up') {
        await client.query(
          `update shop_orders set status = 'out_for_delivery', updated_at = now() where id = $1`, [job.order_id]);
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'delivery_picked_up', $2)`,
          [job.client_user_id, JSON.stringify({ jobId, orderId: job.order_id })]);
      } else {
        await client.query(
          `update shop_orders set status = 'completed', completed_at = now(), updated_at = now() where id = $1`,
          [job.order_id]);
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'delivery_completed', $2)`,
          [job.client_user_id, JSON.stringify({ jobId, orderId: job.order_id })]);
        await notifyPartner(client, job.partner_id, 'delivery_completed', { orderId: job.order_id });
        await client.query(
          'update courier_profiles set deliveries_count = deliveries_count + 1 where user_id = $1', [auth.userId]);
      }
      const view = await client.query(`${DELIVERY_JOB_SELECT} where dj.id = $1`, [jobId]);
      return deliveryJobView(view.rows[0]);
    });
  }

  app.post('/api/v1/courier/delivery-jobs/:id/pickup', async (request) =>
    courierTransition(request, 'assigned', 'picked_up'));
  app.post('/api/v1/courier/delivery-jobs/:id/deliver', async (request) =>
    courierTransition(request, 'picked_up', 'delivered'));

  app.get('/api/v1/operator/delivery-jobs', async (request, reply) => {
    requireRole(request, 'operator');
    const { rows } = await pool.query(
      `${DELIVERY_JOB_SELECT} where dj.status in ('pending', 'assigned', 'picked_up')
       order by dj.created_at limit 100`);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(deliveryJobView) };
  });

  app.get('/api/v1/operator/couriers', async (request, reply) => {
    requireRole(request, 'operator');
    const { rows } = await pool.query(
      `select u.id, u.display_name, cp.transport, cp.is_online, cp.deliveries_count,
              (select count(*)::int from delivery_jobs dj where dj.courier_user_id = u.id
                and dj.status in ('assigned', 'picked_up')) as active_jobs
       from courier_profiles cp join users u on u.id = cp.user_id order by u.display_name`);
    reply.header('Cache-Control', 'no-store');
    return { items: rows };
  });

  app.post('/api/v1/operator/delivery-jobs/:id/assign', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['courierUserId'],
      properties: { courierUserId: { type: 'string', format: 'uuid' } },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'operator');
    const jobId = uuidParam(request);
    const courier = await pool.query(
      'select user_id from courier_profiles where user_id = $1', [request.body.courierUserId]);
    if (!courier.rows[0]) fail(404, 'courier_not_found', 'Курьер не найден');
    try {
      return await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          'select * from delivery_jobs where id = $1 for update', [jobId]);
        const job = rows[0];
        if (!job) fail(404, 'delivery_not_found', 'Доставка не найдена');
        if (job.status === 'picked_up' || job.status === 'delivered') {
          fail(409, 'invalid_transition', 'Доставку уже нельзя переназначить');
        }
        await client.query(
          `update delivery_jobs set status = 'assigned', courier_user_id = $2, assigned_at = now(), updated_at = now()
           where id = $1`, [jobId, request.body.courierUserId]);
        await client.query(
          `insert into delivery_job_events (job_id, status, actor_user_id, note) values ($1, 'assigned', $2, 'operator')`,
          [jobId, auth.userId]);
        return deliveryJobView((await client.query(`${DELIVERY_JOB_SELECT} where dj.id = $1`, [jobId])).rows[0]);
      });
    } catch (error) {
      if (isUniqueViolation(error) && error.constraint === 'delivery_jobs_courier_active_uq') {
        fail(409, 'courier_busy', 'У курьера уже есть активная доставка');
      }
      throw error;
    }
  });


}
