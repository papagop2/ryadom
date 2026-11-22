// Маршруты «Рядом»: каталог, расписание, запись, отзывы, кабинеты.
// Правила доступа проверяются на сервере для каждого объекта.
import { randomInt } from 'node:crypto';
import {
  CODE_TTL_MS, CSRF_COOKIE, SESSION_COOKIE, SESSION_TTL_MS,
  clearSessionCookies, hashCode, normalizePhone, parseCookies, randomToken,
  safeEqual, setSessionCookies, tokenHash,
} from './security.mjs';
import { isUniqueViolation, withTransaction } from './db.mjs';
import { groupHourRows, hoursView, openStateFromDays, scheduleRowsForDb, validateSchedule } from './hours.mjs';
import { pushEnabled, pushPublicKey } from './push.mjs';

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

function sourceView(row) {
  if (row.source === '2gis') {
    return {
      kind: '2gis', name: '2ГИС', url: row.source_url,
      reviewsUrl: row.source_reviews_url,
      rating: row.source_rating === null ? null : Number(row.source_rating),
      ratingCount: row.source_rating_count,
    };
  }
  if (row.source === 'osm') {
    return {
      kind: 'osm', name: 'OpenStreetMap', url: row.source_url, reviewsUrl: null,
      rating: null, ratingCount: 0, license: 'ODbL',
    };
  }
  return null;
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
    cash: { client: Boolean(row.cash_confirmed_client_at), provider: Boolean(row.cash_confirmed_provider_at) },
    slot: { id: row.slot_id, startsAt: row.starts_at, endsAt: row.ends_at },
    offer: { id: row.offer_id, title: row.offer_title, durationMin: row.duration_min },
    place: { id: row.place_id, name: row.place_name, address: row.place_address, district: row.place_district },
    review: row.review_id ? { id: row.review_id, rating: row.review_rating, status: row.review_status } : null,
  };
}

const BOOKING_SELECT = `
  select b.id, b.client_user_id, b.status, b.note, b.price_cents, b.currency, b.created_at, b.updated_at,
         b.cash_confirmed_client_at, b.cash_confirmed_provider_at,
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
  select t.*, t.created_at + interval '3 minutes' as offers_until,
    greatest(0, floor(extract(epoch from (t.created_at + interval '3 minutes' - now()))))::int as offers_left,
         c.display_name as client_name,
         d.display_name as driver_name, dp.car_model, dp.plate,
         dp.rating_avg as driver_rating, dp.rides_count as driver_rides, dp.is_verified as driver_verified
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
    driver: {
      id: row.driver_user_id, name: row.driver_name, car: row.car_model, plate: row.plate,
      rating: row.driver_rating == null ? null : Number(row.driver_rating),
      ridesCount: Number(row.driver_rides ?? 0),
      verified: Boolean(row.driver_verified),
    },
  };
}

async function tripOffersForTrips(db, tripIds, driverId = null) {
  const byTrip = new Map();
  if (!tripIds.length) return byTrip;
  const params = [tripIds];
  let sql = `select o.*, u.display_name as driver_name, dp.car_model, dp.plate,
                    dp.rating_avg as driver_rating, dp.rides_count as driver_rides, dp.is_verified as driver_verified
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
    from: { label: row.from_label, address: row.from_address ?? undefined, lat: Number(row.from_lat), lng: Number(row.from_lng) },
    to: { label: row.to_label, address: row.to_address ?? undefined, lat: Number(row.to_lat), lng: Number(row.to_lng) },
    distanceKm: Number(row.distance_km),
    durationMin: row.duration_min,
    price: row.price_cents == null ? null : money(row.price_cents, row.currency),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    client: { id: row.client_user_id, name: row.client_name },
    stops: Array.isArray(row.stops) ? row.stops : [],
    scheduledFor: row.scheduled_for,
    requirements: {
      passengers: Number(row.passengers ?? 1),
      childSeat: Boolean(row.child_seat),
      luggage: Boolean(row.luggage),
      pets: Boolean(row.pets),
      comment: row.ride_comment ?? '',
    },
    arrivedAt: row.arrived_at,
    cash: {
      client: Boolean(row.cash_confirmed_client_at),
      driver: Boolean(row.cash_confirmed_driver_at),
    },
    offersUntil: row.offers_until,
    offersLeft: row.offers_left,
    driver: row.driver_user_id ? {
      id: row.driver_user_id, name: row.driver_name, car: row.car_model, plate: row.plate,
      rating: row.driver_rating == null ? null : Number(row.driver_rating),
      ridesCount: Number(row.driver_rides ?? 0),
      verified: Boolean(row.driver_verified),
    } : null,
    offers: offers.map(tripOfferView),
  };
}

const POINT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['label', 'lat', 'lng'],
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 200 },
    address: { type: 'string', maxLength: 500 },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
  },
};

const GEOCODER_BASE = (process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const GEO_CACHE = new Map();
let geoChain = Promise.resolve();
let geoLast = 0;

function cleanGeoText(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function geoView(row) {
  const address = cleanGeoText(row.display_name);
  const details = row.address ?? {};
  const street = details.road || details.pedestrian || details.footway || details.square
    || details.neighbourhood || details.suburb || details.city_district;
  const house = details.house_number;
  const streetHouse = cleanGeoText([street, house].filter(Boolean).join(', '));
  const placeName = cleanGeoText(row.name);
  const label = placeName && streetHouse && !streetHouse.startsWith(placeName)
    ? cleanGeoText(`${placeName}, ${streetHouse}`)
    : streetHouse || placeName || address.split(',').slice(0, 2).join(', ');
  if (!label || !address) return null;
  return {
    label,
    address,
    name: cleanGeoText(row.name) || null,
    kind: row.type ?? row.class ?? null,
    lat: Number(row.lat),
    lng: Number(row.lon),
  };
}

async function geocoderJson(path, params) {
  const search = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', 'accept-language': 'ru', ...params });
  const key = `${path}?${search}`;
  if (GEO_CACHE.has(key)) return GEO_CACHE.get(key);
  const task = async () => {
    const wait = Math.max(0, 1100 - (Date.now() - geoLast));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    geoLast = Date.now();
    const response = await fetch(`${GEOCODER_BASE}${path}?${search}`, {
      headers: {
        'User-Agent': 'Ryadom/1.0 (+https://github.com/papagop2/ryadom)',
        'Accept-Language': 'ru',
      },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error(`geocoder ${response.status}`);
    return response.json();
  };
  const pending = geoChain.then(task, task);
  geoChain = pending.catch(() => undefined);
  const data = await pending;
  if (GEO_CACHE.size > 600) GEO_CACHE.clear();
  GEO_CACHE.set(key, data);
  return data;
}

async function searchGeo(query, citySlug, db) {
  const params = {
    q: query,
    limit: '6',
    countrycodes: 'ru',
    dedupe: '1',
  };
  if (citySlug) {
    const city = await db.query('select lat, lng from cities where slug = $1', [citySlug]);
    if (city.rows[0]) {
      const { lat, lng } = city.rows[0];
      params.viewbox = `${Number(lng) - 0.35},${Number(lat) + 0.3},${Number(lng) + 0.35},${Number(lat) - 0.3}`;
      params.bounded = '1';
    }
  }
  let rows = await geocoderJson('/search', params);
  if (!rows.length && params.bounded) {
    const relaxed = { ...params };
    delete relaxed.bounded;
    delete relaxed.viewbox;
    rows = await geocoderJson('/search', relaxed);
  }
  return rows.map(geoView).filter(Boolean);
}

function distanceKm(from, to) {
  const radius = 6371;
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(to.lat - from.lat);
  const dLng = rad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

const ROUTE_CACHE = new Map();
async function roadRoute(from, to, stops = []) {
  const points = [from, ...stops, to];
  const key = points.map(point => `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`).join(';');
  if (ROUTE_CACHE.has(key)) return ROUTE_CACHE.get(key);
  const path = `${points.map(point => `${point.lng},${point.lat}`).join(';')}?overview=false`;
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
async function routeQuote(from, to, stops = []) {
  const road = await roadRoute(from, to, stops);
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
    cash: { client: Boolean(row.cash_confirmed_client_at), provider: Boolean(row.cash_confirmed_provider_at) },
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


const CHAT_KINDS = ['booking', 'shop_order', 'trip', 'service_request'];

async function chatSubject(db, kind, subjectId) {
  if (kind === 'booking') {
    const { rows } = await db.query(
      `select b.id as subject_id, b.client_user_id, b.status, p.partner_id,
              p.name as place_name, o.title as offer_title, s.starts_at,
              u.display_name as client_name
       from bookings b
       join availability_slots s on s.id = b.slot_id
       join offers o on o.id = s.offer_id
       join places p on p.id = o.place_id
       join users u on u.id = b.client_user_id
       where b.id = $1`, [subjectId]);
    const row = rows[0];
    if (!row) return null;
    return { ...row, title: `${row.place_name} · ${row.offer_title}`, subtitle: 'Запись', kind };
  }
  if (kind === 'shop_order') {
    const { rows } = await db.query(
      `select o.id as subject_id, o.client_user_id, o.status, p.partner_id,
              p.name as place_name, o.total_cents, o.currency, o.pickup_code,
              u.display_name as client_name
       from shop_orders o
       join places p on p.id = o.place_id
       join users u on u.id = o.client_user_id
       where o.id = $1`, [subjectId]);
    const row = rows[0];
    if (!row) return null;
    return { ...row, title: row.place_name, subtitle: `Заказ · код ${row.pickup_code}`, kind };
  }
  if (kind === 'trip') {
    const { rows } = await db.query(
      `select t.id as subject_id, t.client_user_id, t.driver_user_id as provider_user_id,
              t.status, t.from_label, t.to_label, u.display_name as client_name
       from trips t join users u on u.id = t.client_user_id
       where t.id = $1`, [subjectId]);
    const row = rows[0];
    if (!row) return null;
    return { ...row, title: `${row.from_label} → ${row.to_label}`, subtitle: 'Поездка', kind };
  }
  if (kind === 'service_request') {
    const { rows } = await db.query(
      `select r.id as subject_id, r.client_user_id, r.status, r.partner_id,
              r.title, r.address, u.display_name as client_name
       from service_requests r join users u on u.id = r.client_user_id
       where r.id = $1`, [subjectId]);
    const row = rows[0];
    if (!row) return null;
    return { ...row, subtitle: row.address, kind };
  }
  return null;
}

const CHAT_THREAD_SELECT = `
  select t.*, cu.display_name as client_name, pu.display_name as provider_name,
         p.name as partner_name
  from chat_threads t
  join users cu on cu.id = t.client_user_id
  left join users pu on pu.id = t.provider_user_id
  left join partners p on p.id = t.partner_id`;

const CHAT_MESSAGE_SELECT = `
  select m.*, u.display_name as sender_name
  from chat_messages m join users u on u.id = m.sender_user_id`;

function chatMessageView(row, auth) {
  return {
    id: row.id,
    body: row.status === 'hidden' ? 'Сообщение скрыто модератором' : row.body,
    quickReply: row.quick_reply,
    status: row.status,
    createdAt: row.created_at,
    mine: row.sender_user_id === auth.userId,
    sender: { id: row.sender_user_id, name: row.sender_name },
  };
}

function chatAccessRole(thread, auth) {
  if (isOperator(auth)) return 'operator';
  if (thread.client_user_id === auth.userId) return 'client';
  if (thread.provider_user_id === auth.userId) return 'provider';
  if (thread.partner_id && canManagePartner(auth, thread.partner_id)) return 'provider';
  return null;
}

function chatThreadView(thread, subject, role, extras = {}) {
  const providerName = thread.partner_name || thread.provider_name || 'Исполнитель';
  return {
    id: thread.id,
    kind: thread.kind,
    subjectId: thread.subject_id,
    title: subject?.title || 'Переписка',
    subtitle: subject?.subtitle || null,
    status: thread.status,
    role,
    unread: extras.unread ?? 0,
    lastMessageAt: thread.last_message_at,
    lastMessage: extras.lastMessage ?? null,
    client: { id: thread.client_user_id, name: thread.client_name },
    provider: { id: thread.provider_user_id, name: providerName },
    createdAt: thread.created_at,
  };
}

async function loadChatThread(db, threadId) {
  const { rows } = await db.query(`${CHAT_THREAD_SELECT} where t.id = $1`, [threadId]);
  return rows[0] ?? null;
}

async function chatThreadDetail(db, thread, auth) {
  const role = chatAccessRole(thread, auth);
  if (!role) fail(403, 'forbidden', 'Нет доступа к переписке');
  const subject = await chatSubject(db, thread.kind, thread.subject_id);
  const last = await db.query(
    `${CHAT_MESSAGE_SELECT} where m.thread_id = $1 and m.status = 'visible'
     order by m.created_at desc limit 1`, [thread.id]);
  const unread = await db.query(
    `select count(*)::int as count from chat_messages m
     left join chat_reads r on r.thread_id = m.thread_id and r.user_id = $2
     where m.thread_id = $1 and m.sender_user_id <> $2 and m.status = 'visible'
       and m.created_at > coalesce(r.last_read_at, 'epoch'::timestamptz)`, [thread.id, auth.userId]);
  return chatThreadView(thread, subject, role, {
    unread: unread.rows[0]?.count ?? 0,
    lastMessage: last.rows[0] ? chatMessageView(last.rows[0], auth) : null,
  });
}

async function notifyChatRecipients(db, thread, auth, subject, message) {
  const payload = {
    threadId: thread.id,
    kind: thread.kind,
    subjectId: thread.subject_id,
    title: subject?.title || 'Сообщение',
    body: message.body.slice(0, 160),
    sender: auth.displayName || 'Собеседник',
    messageId: message.id,
  };
  const clientId = thread.client_user_id;
  if (clientId !== auth.userId) {
    await db.query(
      `insert into notifications (user_id, kind, payload) values ($1, 'chat_message', $2)`,
      [clientId, JSON.stringify(payload)]);
  }
  if (thread.provider_user_id && thread.provider_user_id !== auth.userId) {
    await db.query(
      `insert into notifications (user_id, kind, payload) values ($1, 'chat_message', $2)`,
      [thread.provider_user_id, JSON.stringify(payload)]);
  }
  if (thread.partner_id) {
    const members = await db.query(
      `select user_id from memberships
       where partner_id = $1 and role = 'partner' and user_id <> $2`, [thread.partner_id, auth.userId]);
    for (const member of members.rows) {
      await db.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'chat_message', $2)`,
        [member.user_id, JSON.stringify(payload)]);
    }
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

function loyaltyCardView(row) {
  return {
    stamps: row.stamps,
    rewardsAvailable: row.rewards_available,
    totalVisits: row.total_visits,
    lastStampAt: row.last_stamp_at,
  };
}

const WAITLIST_SELECT = `
  select w.id, w.status, to_char(w.preferred_date, 'YYYY-MM-DD') as preferred_date,
         w.created_at, w.notified_at, w.expires_at,
         o.id as offer_id, o.title as offer_title, o.duration_min, o.price_cents, o.currency,
         p.id as place_id, p.name as place_name, p.address as place_address,
         p.district as place_district, p.image_url as place_image
  from waitlist_entries w
  join offers o on o.id = w.offer_id
  join places p on p.id = o.place_id`;

function waitlistView(row) {
  return {
    id: row.id,
    status: row.status,
    preferredDate: row.preferred_date,
    createdAt: row.created_at,
    notifiedAt: row.notified_at,
    offer: {
      id: row.offer_id, title: row.offer_title, durationMin: row.duration_min,
      price: money(row.price_cents, row.currency),
    },
    place: {
      id: row.place_id, name: row.place_name, address: row.place_address,
      district: row.place_district, image: row.place_image,
    },
  };
}

function validWaitlistDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(400, 'invalid_date', 'Дата должна быть в формате ГГГГ-ММ-ДД');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(400, 'invalid_date', 'Такой даты нет');
  }
  return value;
}

const QUEUE_TICKET_SELECT = `
  select t.*, p.name as place_name, p.address as place_address, p.district as place_district
  from queue_tickets t join places p on p.id = t.place_id`;

function queueTicketView(row) {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    note: row.note,
    day: row.day,
    createdAt: row.created_at,
    calledAt: row.called_at,
    closedAt: row.closed_at,
    place: {
      id: row.place_id, name: row.place_name,
      address: row.place_address, district: row.place_district,
    },
  };
}

async function queueSnapshot(db, placeId, userId = null) {
  const place = await db.query(
    'select id, partner_id, name, address, district from places where id = $1 and is_published', [placeId]);
  if (!place.rows[0]) fail(404, 'place_not_found', 'Заведение не найдено');
  const settings = await db.query(
    'select is_active, avg_minutes, notice from queue_settings where place_id = $1', [placeId]);
  const counts = await db.query(
    `select count(*) filter (where status = 'waiting')::int as waiting,
            count(*) filter (where status = 'called')::int as called,
            count(*) filter (where status = 'serving')::int as serving,
            min(number) filter (where status = 'waiting') as next_number,
            max(number) filter (where status in ('called', 'serving')) as current_number
     from queue_tickets where place_id = $1 and day = current_date`, [placeId]);
  let myTicket = null;
  let position = null;
  if (userId) {
    const mine = await db.query(
      `${QUEUE_TICKET_SELECT} where t.place_id = $1 and t.client_user_id = $2
       and t.status in ('waiting', 'called', 'serving') order by t.number limit 1`, [placeId, userId]);
    if (mine.rows[0]) {
      myTicket = queueTicketView(mine.rows[0]);
      if (myTicket.status === 'waiting') {
        const ahead = await db.query(
          `select count(*)::int as n from queue_tickets
           where place_id = $1 and day = current_date and status = 'waiting' and number < $2`,
          [placeId, myTicket.number]);
        position = ahead.rows[0].n + 1;
      }
    }
  }
  const row = counts.rows[0];
  return {
    active: Boolean(settings.rows[0]?.is_active),
    avgMinutes: settings.rows[0]?.avg_minutes ?? null,
    notice: settings.rows[0]?.notice ?? '',
    waiting: row.waiting,
    called: row.called,
    serving: row.serving,
    nextNumber: row.next_number,
    currentNumber: row.current_number,
    myTicket,
    position,
    place: {
      id: place.rows[0].id, name: place.rows[0].name,
      address: place.rows[0].address, district: place.rows[0].district,
    },
  };
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
    cash: { client: Boolean(row.cash_confirmed_client_at), provider: Boolean(row.cash_confirmed_provider_at) },
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

  app.get('/api/v1/geo/search', {
    schema: { querystring: {
      type: 'object', additionalProperties: false, required: ['q'],
      properties: {
        q: { type: 'string', minLength: 3, maxLength: 120 },
        city: { type: 'string', maxLength: 60 },
      },
    } },
  }, async (request, reply) => {
    const q = request.query.q.trim();
    if (q.length < 3) return { items: [] };
    try {
      const items = await searchGeo(q, request.query.city || null, pool);
      reply.header('Cache-Control', 'private, max-age=300');
      return { items };
    } catch (error) {
      request.log.error({ err: error }, 'geo search failed');
      return { items: [] };
    }
  });

  app.get('/api/v1/geo/reverse', {
    schema: { querystring: {
      type: 'object', additionalProperties: false, required: ['lat', 'lng'],
      properties: {
        lat: { type: 'string', maxLength: 30 },
        lng: { type: 'string', maxLength: 30 },
      },
    } },
  }, async (request, reply) => {
    const lat = Number(request.query.lat);
    const lng = Number(request.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return reply.code(400).send({ error: 'invalid_point', message: 'Некорректная точка' });
    }
    try {
      const row = await geocoderJson('/reverse', { lat: String(lat), lon: String(lng), zoom: '18' });
      const place = row?.error ? null : geoView(row);
      if (!place) return reply.code(404).send({ error: 'address_not_found', message: 'Адрес не найден' });
      reply.header('Cache-Control', 'private, max-age=600');
      return place;
    } catch {
      return reply.code(502).send({ error: 'geocoder_unavailable', message: 'Геокодер недоступен' });
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
        openNow: { type: 'string', enum: ['1', '0', 'true', 'false'] },
      },
    } },
  }, async (request, reply) => {
    const { city, category, district, q, maxPrice, minRating, limit = 20, offset = 0, openNow } = request.query;
    const onlyOpen = openNow === '1' || openNow === 'true';
    const { rows } = await pool.query(
      `select p.id, p.name, p.category, p.district, p.address, p.lat, p.lng, p.about,
              p.rating_avg, p.rating_count, p.source, p.source_url, p.source_rating,
              p.source_rating_count, p.city_slug, p.image_url, c.timezone, oo.min_price_cents, oo.offer_count,
              count(*) over()::int as total,
              case when $7::numeric is null or $8::numeric is null
                   then null else round((point(p.lng, p.lat) <-> point($7, $8))::numeric * 111.32, 2) end as distance_km
       from places p
       join cities c on c.slug = p.city_slug
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
      [category ?? null, district ?? null, q ?? null, maxPrice ?? null, minRating ?? null,
        onlyOpen ? 5000 : limit, request.query.lng ?? null, request.query.lat ?? null,
        onlyOpen ? 0 : offset, city ?? null]);
    const hourMap = await hoursForPlaces(rows.map(row => row.id));
    const visible = rows.map(row => {
      const hours = hourMap.get(row.id) ?? [];
      return {
        id: row.id, name: row.name, category: row.category, district: row.district,
        address: row.address, about: row.about,
        location: { lat: Number(row.lat), lng: Number(row.lng) },
        city: row.city_slug, image: row.image_url,
        rating: row.rating_avg === null ? null : Number(row.rating_avg),
        ratingCount: row.rating_count, source: sourceView(row),
        priceFrom: row.min_price_cents === null ? null : money(row.min_price_cents),
        offerCount: row.offer_count,
        distanceKm: row.distance_km === null ? null : Number(row.distance_km),
        openNow: openStateFromDays(hours, row.timezone),
      };
    }).filter(row => !onlyOpen || row.openNow.state === 'open');
    reply.header('Cache-Control', 'no-store');
    return {
      items: onlyOpen ? visible.slice(offset, offset + limit) : visible,
      total: onlyOpen ? visible.length : rows[0]?.total ?? 0,
      limit,
      offset,
    };
  });

  app.get('/api/v1/places/map', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      city: { type: 'string', maxLength: 40 },
      openNow: { type: 'string', enum: ['1', '0', 'true', 'false'] },
    } } },
  }, async (request, reply) => {
    const { city, openNow } = request.query;
    const onlyOpen = openNow === '1' || openNow === 'true';
    const { rows } = await pool.query(
      `select p.id, p.name, p.category, p.district, p.address, p.about, p.lat, p.lng,
              p.rating_avg, p.rating_count, p.source, p.source_url, p.source_reviews_url,
              p.source_rating, p.source_rating_count, p.city_slug, p.image_url, c.timezone
       from places p join cities c on c.slug = p.city_slug
       where p.is_published and ($1::text is null or p.city_slug = $1)
       order by p.name asc`, [city ?? null]);
    const hourMap = await hoursForPlaces(rows.map(row => row.id));
    const items = rows.map(row => ({
      id: row.id, name: row.name, category: row.category, district: row.district,
      address: row.address, about: row.about, location: { lat: Number(row.lat), lng: Number(row.lng) },
      city: row.city_slug, image: row.image_url,
      rating: row.rating_avg === null ? null : Number(row.rating_avg), ratingCount: row.rating_count,
      source: sourceView(row),
      priceFrom: null, offerCount: 0, distanceKm: null,
      openNow: openStateFromDays(hourMap.get(row.id) ?? [], row.timezone),
    })).filter(row => !onlyOpen || row.openNow.state === 'open');
    reply.header('Cache-Control', 'no-store');
    return { items, total: items.length };
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
              p.metadata, c.timezone, (p.partner_id is not null) as bookable
       from places p join cities c on c.slug = p.city_slug
       where p.id = $1 and p.is_published`, [uuidParam(request)]);
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
    const hourRows = await pool.query(
      `select h.place_id, h.weekday, h.is_closed, h.is_24h,
              to_char(i.opens_at, 'HH24:MI') as opens_at,
              to_char(i.closes_at, 'HH24:MI') as closes_at
       from place_hours h
       left join place_hour_intervals i
         on i.place_id = h.place_id and i.weekday = h.weekday
       where h.place_id = $1 order by h.weekday, i.position`, [place.id]);
    const schedule = hoursView(hourRows.rows, place.timezone);
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
        source: sourceView(place),
        timezone: schedule.timezone,
        hours: schedule.days,
        openNow: schedule.openNow,
        info: {
          schedule: scheduleText(place.metadata?.schedule) || place.metadata?.openingHours || null,
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

  app.get('/api/v1/queues', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      city: { type: 'string', maxLength: 40 },
    } } },
  }, async (request, reply) => {
    const { rows } = await pool.query(
      `select p.id, p.name, p.category, p.district, p.address, p.image_url,
              qs.avg_minutes, qs.notice,
              (select count(*)::int from queue_tickets t
                where t.place_id = p.id and t.day = current_date and t.status = 'waiting') as waiting,
              (select max(t.number) from queue_tickets t
                where t.place_id = p.id and t.day = current_date
                  and t.status in ('called', 'serving')) as current_number
       from queue_settings qs join places p on p.id = qs.place_id
       where qs.is_active and p.is_published
         and ($1::text is null or p.city_slug = $1)
       order by waiting desc, p.name asc`, [request.query.city ?? null]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => ({
      place: { id: row.id, name: row.name, category: row.category, district: row.district,
        address: row.address, image: row.image_url },
      waiting: row.waiting, currentNumber: row.current_number,
      avgMinutes: row.avg_minutes, notice: row.notice,
    })) };
  });

  app.get('/api/v1/places/:id/queue', async (request, reply) => {
    const placeId = uuidParam(request);
    reply.header('Cache-Control', 'no-store');
    return queueSnapshot(pool, placeId, request.auth?.userId ?? null);
  });

  app.post('/api/v1/places/:id/queue', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: { note: { type: 'string', maxLength: 200 } },
    } },
  }, async (request, reply) => {
    const auth = requireUser(request);
    const placeId = uuidParam(request);
    const place = await pool.query(
      'select id, partner_id from places where id = $1 and is_published', [placeId]);
    if (!place.rows[0]) fail(404, 'place_not_found', 'Заведение не найдено');
    const settings = await pool.query('select is_active from queue_settings where place_id = $1', [placeId]);
    if (!settings.rows[0]?.is_active) fail(409, 'queue_closed', 'Очередь сейчас закрыта');
    const existing = await pool.query(
      `select id from queue_tickets where place_id = $1 and client_user_id = $2
       and status in ('waiting', 'called', 'serving')`, [placeId, auth.userId]);
    if (existing.rows[0]) {
      reply.code(200);
      return queueSnapshot(pool, placeId, auth.userId);
    }
    try {
      await withTransaction(pool, async (client) => {
        const day = await client.query(
          `insert into queue_days (place_id, day, last_number) values ($1, current_date, 1)
           on conflict (place_id, day) do update set last_number = queue_days.last_number + 1
           returning last_number`, [placeId]);
        const ticket = await client.query(
          `insert into queue_tickets (place_id, client_user_id, day, number, note)
           values ($1, $2, current_date, $3, $4) returning id`,
          [placeId, auth.userId, day.rows[0].last_number, request.body?.note ?? '']);
        if (place.rows[0].partner_id) {
          await notifyPartner(client, place.rows[0].partner_id, 'queue_ticket_new',
            { placeId, ticketId: ticket.rows[0].id, number: day.rows[0].last_number });
        }
      });
    } catch (error) {
      if (isUniqueViolation(error) && error.constraint === 'queue_tickets_active_uq') {
        reply.code(200);
        return queueSnapshot(pool, placeId, auth.userId);
      }
      throw error;
    }
    reply.code(201);
    return queueSnapshot(pool, placeId, auth.userId);
  });

  app.post('/api/v1/queue/:id/cancel', async (request) => {
    const auth = requireUser(request);
    const ticketId = uuidParam(request);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query(`${QUEUE_TICKET_SELECT} where t.id = $1 for update of t`, [ticketId]);
      const ticket = rows[0];
      if (!ticket) fail(404, 'queue_ticket_not_found', 'Талон не найден');
      if (ticket.client_user_id !== auth.userId) fail(403, 'forbidden', 'Это не ваш талон');
      if (ticket.status !== 'waiting') fail(409, 'invalid_transition', 'Талон уже нельзя отменить');
      await client.query(
        `update queue_tickets set status = 'cancelled', closed_at = now() where id = $1`, [ticketId]);
      return queueTicketView({ ...ticket, status: 'cancelled', closed_at: new Date() });
    });
  });

  app.get('/api/v1/me/queue', async (request, reply) => {
    const auth = requireUser(request);
    const { rows } = await pool.query(
      `${QUEUE_TICKET_SELECT} where t.client_user_id = $1
       order by (t.status in ('waiting', 'called', 'serving')) desc, t.created_at desc limit 30`,
      [auth.userId]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(queueTicketView) };
  });

  app.get('/api/v1/push/public-key', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { enabled: pushEnabled(), publicKey: pushPublicKey() };
  });

  app.get('/api/v1/me/push-subscriptions', async (request, reply) => {
    const auth = requireUser(request);
    const { rows } = await pool.query(
      'select id, endpoint, created_at, last_seen_at, last_error from push_subscriptions where user_id = $1 order by created_at desc',
      [auth.userId]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => ({
      id: row.id, endpoint: row.endpoint, createdAt: row.created_at,
      lastSeenAt: row.last_seen_at, lastError: row.last_error,
    })), enabled: pushEnabled() };
  });

  app.post('/api/v1/me/push-subscriptions', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['endpoint', 'p256dh', 'auth'],
      properties: {
        endpoint: { type: 'string', minLength: 12, maxLength: 2000 },
        p256dh: { type: 'string', minLength: 40, maxLength: 200 },
        auth: { type: 'string', minLength: 16, maxLength: 100 },
        userAgent: { type: 'string', maxLength: 300 },
      },
    } },
  }, async (request) => {
    const auth = requireUser(request);
    let endpoint;
    try { endpoint = new URL(request.body.endpoint); } catch { fail(400, 'invalid_endpoint', 'Некорректный endpoint'); }
    if (endpoint.protocol !== 'https:') fail(400, 'invalid_endpoint', 'Push работает только по HTTPS');
    let p256dh; let authSecret;
    try {
      p256dh = Buffer.from(request.body.p256dh, 'base64url');
      authSecret = Buffer.from(request.body.auth, 'base64url');
    } catch { fail(400, 'invalid_subscription', 'Некорректный ключ подписки'); }
    if (p256dh.length !== 65 || authSecret.length !== 16) {
      fail(400, 'invalid_subscription', 'Некорректный ключ подписки');
    }
    const { rows } = await pool.query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       values ($1, $2, $3, $4, $5)
       on conflict (endpoint) do update set user_id = excluded.user_id,
         p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent,
         last_seen_at = now(), last_error = null
       returning id, endpoint, created_at`,
      [auth.userId, endpoint.href, request.body.p256dh, request.body.auth, request.body.userAgent ?? '']);
    return { subscribed: true, subscription: { id: rows[0].id, endpoint: rows[0].endpoint, createdAt: rows[0].created_at } };
  });

  app.delete('/api/v1/me/push-subscriptions', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['endpoint'],
      properties: { endpoint: { type: 'string', minLength: 12, maxLength: 2000 } },
    } },
  }, async (request) => {
    const auth = requireUser(request);
    const { rowCount } = await pool.query(
      'delete from push_subscriptions where user_id = $1 and endpoint = $2',
      [auth.userId, request.body.endpoint]);
    return { subscribed: false, removed: rowCount };
  });

  app.get('/api/v1/places/:id/loyalty', async (request, reply) => {
    const placeId = uuidParam(request);
    const place = await pool.query('select id from places where id = $1 and is_published', [placeId]);
    if (!place.rows[0]) fail(404, 'place_not_found', 'Заведение не найдено');
    const program = await pool.query(
      'select goal, reward_title, reward_note from loyalty_programs where place_id = $1 and is_active', [placeId]);
    if (!program.rows[0]) {
      reply.header('Cache-Control', 'no-store');
      return { active: false };
    }
    let card = null;
    if (request.auth?.userId) {
      const mine = await pool.query(
        'select stamps, rewards_available, total_visits, last_stamp_at from loyalty_cards where user_id = $1 and place_id = $2',
        [request.auth.userId, placeId]);
      if (mine.rows[0]) card = loyaltyCardView(mine.rows[0]);
    }
    reply.header('Cache-Control', 'no-store');
    return {
      active: true,
      goal: program.rows[0].goal,
      rewardTitle: program.rows[0].reward_title,
      rewardNote: program.rows[0].reward_note,
      card,
    };
  });

  app.get('/api/v1/me/loyalty', async (request, reply) => {
    const auth = requireUser(request);
    const { rows } = await pool.query(
      `select c.stamps, c.rewards_available, c.total_visits, c.last_stamp_at,
              p.id as place_id, p.name as place_name, p.category, p.district, p.address, p.image_url,
              lp.goal, lp.reward_title, lp.reward_note
       from loyalty_cards c
       join places p on p.id = c.place_id
       join loyalty_programs lp on lp.place_id = c.place_id and lp.is_active
       where c.user_id = $1
       order by c.rewards_available desc, c.last_stamp_at desc`, [auth.userId]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => ({
      place: { id: row.place_id, name: row.place_name, category: row.category,
        district: row.district, address: row.address, image: row.image_url },
      goal: row.goal, rewardTitle: row.reward_title, rewardNote: row.reward_note,
      card: loyaltyCardView(row),
    })) };
  });

  app.get('/api/v1/partner/places/:id/loyalty', async (request, reply) => {
    const auth = requireRole(request, 'partner', 'operator');
    const placeId = uuidParam(request);
    await loadPlaceForManager(auth, placeId);
    const program = await pool.query(
      'select is_active, goal, reward_title, reward_note from loyalty_programs where place_id = $1', [placeId]);
    const cards = await pool.query(
      `select c.stamps, c.rewards_available, c.total_visits, c.last_stamp_at,
              u.id as user_id, u.display_name
       from loyalty_cards c join users u on u.id = c.user_id
       where c.place_id = $1
       order by c.rewards_available desc, c.last_stamp_at desc limit 100`, [placeId]);
    reply.header('Cache-Control', 'no-store');
    return {
      settings: {
        isActive: Boolean(program.rows[0]?.is_active),
        goal: program.rows[0]?.goal ?? 5,
        rewardTitle: program.rows[0]?.reward_title ?? 'Подарок',
        rewardNote: program.rows[0]?.reward_note ?? '',
      },
      cards: cards.rows.map(row => ({
        client: { id: row.user_id, name: row.display_name },
        ...loyaltyCardView(row),
      })),
    };
  });

  app.put('/api/v1/partner/places/:id/loyalty', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: {
        isActive: { type: 'boolean' },
        goal: { type: 'integer', minimum: 1, maximum: 50 },
        rewardTitle: { type: 'string', minLength: 1, maxLength: 120 },
        rewardNote: { type: 'string', maxLength: 300 },
      },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'partner', 'operator');
    const placeId = uuidParam(request);
    await loadPlaceForManager(auth, placeId);
    const current = await pool.query(
      'select is_active, goal, reward_title, reward_note from loyalty_programs where place_id = $1', [placeId]);
    const previous = current.rows[0] ?? { is_active: false, goal: 5, reward_title: 'Подарок', reward_note: '' };
    const { rows } = await pool.query(
      `insert into loyalty_programs (place_id, is_active, goal, reward_title, reward_note)
       values ($1, $2, $3, $4, $5)
       on conflict (place_id) do update set is_active = excluded.is_active,
         goal = excluded.goal, reward_title = excluded.reward_title,
         reward_note = excluded.reward_note, updated_at = now()
       returning is_active, goal, reward_title, reward_note`,
      [placeId, request.body.isActive ?? previous.is_active,
        request.body.goal ?? previous.goal,
        request.body.rewardTitle ?? previous.reward_title,
        request.body.rewardNote ?? previous.reward_note]);
    return { isActive: rows[0].is_active, goal: rows[0].goal,
      rewardTitle: rows[0].reward_title, rewardNote: rows[0].reward_note };
  });

  app.post('/api/v1/partner/places/:id/loyalty/redeem', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['userId'],
      properties: { userId: { type: 'string', format: 'uuid' } },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'partner', 'operator');
    const placeId = uuidParam(request);
    await loadPlaceForManager(auth, placeId);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `select stamps, rewards_available, total_visits, last_stamp_at
         from loyalty_cards where user_id = $1 and place_id = $2 for update`,
        [request.body.userId, placeId]);
      const card = rows[0];
      if (!card) fail(404, 'loyalty_card_not_found', 'Карта не найдена');
      if (card.rewards_available < 1) fail(409, 'reward_not_available', 'Нет доступной награды');
      await client.query(
        `update loyalty_cards set rewards_available = rewards_available - 1
         where user_id = $1 and place_id = $2`, [request.body.userId, placeId]);
      await client.query(
        `insert into loyalty_events (user_id, place_id, delta, kind, source)
         values ($1, $2, 0, 'reward', 'partner')`, [request.body.userId, placeId]);
      return { ...loyaltyCardView({ ...card, rewards_available: card.rewards_available - 1 }), redeemed: true };
    });
  });

  app.get('/api/v1/me/favorites', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      city: { type: 'string', maxLength: 40 },
    } } },
  }, async (request, reply) => {
    const auth = requireUser(request);
    const { rows } = await pool.query(
      `select p.id, p.name, p.category, p.district, p.address, p.lat, p.lng, p.about,
              p.rating_avg, p.rating_count, p.source, p.source_url, p.source_reviews_url,
              p.source_rating, p.source_rating_count, p.city_slug, p.image_url,
              oo.min_price_cents, oo.offer_count
       from favorites f join places p on p.id = f.place_id
       left join lateral (
         select min(o.price_cents) as min_price_cents, count(*)::int as offer_count
         from offers o where o.place_id = p.id and o.is_active
       ) oo on true
       where f.user_id = $1 and p.is_published
         and ($2::text is null or p.city_slug = $2)
       order by f.created_at desc`, [auth.userId, request.query.city ?? null]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => ({
      id: row.id, name: row.name, category: row.category, district: row.district,
      address: row.address, about: row.about,
      location: { lat: Number(row.lat), lng: Number(row.lng) },
      city: row.city_slug, image: row.image_url,
      rating: row.rating_avg === null ? null : Number(row.rating_avg), ratingCount: row.rating_count,
      source: sourceView(row),
      priceFrom: row.min_price_cents === null ? null : money(row.min_price_cents),
      offerCount: row.offer_count, distanceKm: null, isFavorite: true,
    })) };
  });

  app.post('/api/v1/me/favorites/:id', async (request) => {
    const auth = requireUser(request);
    const placeId = uuidParam(request);
    const place = await pool.query('select id from places where id = $1 and is_published', [placeId]);
    if (!place.rows[0]) fail(404, 'place_not_found', 'Заведение не найдено');
    await pool.query(
      'insert into favorites (user_id, place_id) values ($1, $2) on conflict do nothing',
      [auth.userId, placeId]);
    return { favorite: true, placeId };
  });

  app.delete('/api/v1/me/favorites/:id', async (request) => {
    const auth = requireUser(request);
    const placeId = uuidParam(request);
    await pool.query('delete from favorites where user_id = $1 and place_id = $2', [auth.userId, placeId]);
    return { favorite: false, placeId };
  });


  app.get('/api/v1/me/waitlist', async (request, reply) => {
    const auth = requireUser(request);
    const { rows } = await pool.query(
      `${WAITLIST_SELECT}
       where w.user_id = $1 and w.status in ('waiting', 'notified') and w.expires_at > now()
       order by w.created_at desc limit 100`, [auth.userId]);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(waitlistView) };
  });

  app.post('/api/v1/offers/:id/waitlist', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: { date: { anyOf: [
        { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        { type: 'null' },
      ] } },
    } },
  }, async (request, reply) => {
    const auth = requireUser(request);
    const offerId = uuidParam(request);
    const preferredDate = validWaitlistDate(request.body?.date);
    const offer = await pool.query(
      `select o.id, o.title, o.duration_min, o.price_cents, o.currency, p.id as place_id, p.name as place_name
       from offers o join places p on p.id = o.place_id
       where o.id = $1 and o.is_active and p.is_published`, [offerId]);
    if (!offer.rows[0]) fail(404, 'offer_not_found', 'Услуга не найдена');

    // Старая заявка со статусом notified могла остаться после освободившегося окна.
    // Новая заявка заменяет её, а не создаёт вторую активную.
    await pool.query(
      `update waitlist_entries set status = 'cancelled', updated_at = now()
       where user_id = $1 and offer_id = $2 and status = 'notified'`,
      [auth.userId, offerId]);
    const inserted = await pool.query(
      `insert into waitlist_entries (user_id, offer_id, preferred_date)
       values ($1, $2, $3)
       on conflict (user_id, offer_id) where status = 'waiting' do nothing
       returning id`, [auth.userId, offerId, preferredDate]);
    let entryId = inserted.rows[0]?.id;
    if (!entryId) {
      const existing = await pool.query(
        `select id from waitlist_entries
         where user_id = $1 and offer_id = $2 and status = 'waiting'`, [auth.userId, offerId]);
      if (!existing.rows[0]) fail(409, 'waitlist_busy', 'Попробуйте ещё раз');
      entryId = existing.rows[0].id;
      await pool.query(
        `update waitlist_entries set preferred_date = $2, expires_at = now() + interval '30 days',
           updated_at = now() where id = $1`, [entryId, preferredDate]);
    }
    const entry = await pool.query(`${WAITLIST_SELECT} where w.id = $1`, [entryId]);
    reply.code(inserted.rows[0] ? 201 : 200);
    return { entry: waitlistView(entry.rows[0]), place: offer.rows[0].place_name };
  });

  app.delete('/api/v1/me/waitlist/:id', async (request) => {
    const auth = requireUser(request);
    const result = await pool.query(
      `update waitlist_entries set status = 'cancelled', updated_at = now()
       where id = $1 and user_id = $2 and status in ('waiting', 'notified') returning id`,
      [uuidParam(request), auth.userId]);
    if (!result.rows[0]) fail(404, 'waitlist_not_found', 'Заявка не найдена');
    return { cancelled: true, id: result.rows[0].id };
  });


  // ---- чат по заказу ----
  app.post('/api/v1/chat/threads/resolve', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['kind', 'subjectId'],
      properties: {
        kind: { type: 'string', enum: CHAT_KINDS },
        subjectId: { type: 'string', format: 'uuid' },
      },
    } },
  }, async (request) => {
    const auth = requireUser(request);
    const { kind, subjectId } = request.body;
    const subject = await chatSubject(pool, kind, subjectId);
    if (!subject) fail(404, 'chat_subject_not_found', 'Заказ не найден');
    const partnerId = subject.partner_id ?? null;
    const providerUserId = subject.provider_user_id ?? null;
    if (kind === 'trip' && !providerUserId) {
      fail(409, 'chat_unavailable', 'Чат появится после назначения водителя');
    }
    if (kind !== 'trip' && !partnerId) {
      fail(409, 'chat_unavailable', 'Чат появится после подключения исполнителя');
    }
    const allowed = auth.userId === subject.client_user_id
      || (providerUserId && auth.userId === providerUserId)
      || (partnerId && canManagePartner(auth, partnerId))
      || isOperator(auth);
    if (!allowed) fail(403, 'forbidden', 'Нет доступа к этому заказу');

    let existing = await pool.query(
      `${CHAT_THREAD_SELECT} where t.kind = $1 and t.subject_id = $2`, [kind, subjectId]);
    if (existing.rows[0]) {
      const thread = existing.rows[0];
      if (thread.provider_user_id !== providerUserId || thread.partner_id !== partnerId) {
        await pool.query(
          `update chat_threads set provider_user_id = $2, partner_id = $3, updated_at = now()
           where id = $1`, [thread.id, providerUserId, partnerId]);
      }
      const fresh = await loadChatThread(pool, thread.id);
      return { thread: await chatThreadDetail(pool, fresh, auth) };
    }
    const inserted = await pool.query(
      `insert into chat_threads (kind, subject_id, client_user_id, partner_id, provider_user_id)
       values ($1, $2, $3, $4, $5)
       on conflict (kind, subject_id) do nothing returning id`,
      [kind, subjectId, subject.client_user_id, partnerId, providerUserId]);
    const id = inserted.rows[0]?.id
      ?? (await pool.query('select id from chat_threads where kind = $1 and subject_id = $2',
        [kind, subjectId])).rows[0]?.id;
    if (!id) fail(409, 'chat_busy', 'Попробуйте ещё раз');
    const fresh = await loadChatThread(pool, id);
    return { thread: await chatThreadDetail(pool, fresh, auth) };
  });

  app.get('/api/v1/chat/threads', async (request, reply) => {
    const auth = requireUser(request);
    const partnerIds = partnerIdsOf(auth);
    const { rows } = await pool.query(
      `${CHAT_THREAD_SELECT}
       where ${isOperator(auth) ? 'true' : `(t.client_user_id = $1 or t.provider_user_id = $1
         or t.partner_id = any($2::uuid[]))`}
       order by coalesce(t.last_message_at, t.created_at) desc limit 100`,
      isOperator(auth) ? [] : [auth.userId, partnerIds]);
    const ids = rows.map(row => row.id);
    let lastByThread = new Map();
    let unreadByThread = new Map();
    if (ids.length) {
      const last = await pool.query(
        `select distinct on (m.thread_id) m.*, u.display_name as sender_name
         from chat_messages m join users u on u.id = m.sender_user_id
         where m.thread_id = any($1::uuid[]) and m.status = 'visible'
         order by m.thread_id, m.created_at desc`, [ids]);
      lastByThread = new Map(last.rows.map(row => [row.thread_id, row]));
      const unread = await pool.query(
        `select m.thread_id, count(*)::int as count
         from chat_messages m
         left join chat_reads r on r.thread_id = m.thread_id and r.user_id = $2
         where m.thread_id = any($1::uuid[]) and m.sender_user_id <> $2 and m.status = 'visible'
           and m.created_at > coalesce(r.last_read_at, 'epoch'::timestamptz)
         group by m.thread_id`, [ids, auth.userId]);
      unreadByThread = new Map(unread.rows.map(row => [row.thread_id, row.count]));
    }
    const items = await Promise.all(rows.map(async row => {
      const subject = await chatSubject(pool, row.kind, row.subject_id);
      const role = chatAccessRole(row, auth);
      const last = lastByThread.get(row.id);
      return chatThreadView(row, subject, role, {
        unread: unreadByThread.get(row.id) ?? 0,
        lastMessage: last ? chatMessageView(last, auth) : null,
      });
    }));
    reply.header('Cache-Control', 'no-store');
    return { items };
  });

  app.get('/api/v1/chat/threads/:id/messages', async (request, reply) => {
    const auth = requireUser(request);
    const thread = await loadChatThread(pool, uuidParam(request));
    if (!thread) fail(404, 'thread_not_found', 'Переписка не найдена');
    const role = chatAccessRole(thread, auth);
    if (!role) fail(403, 'forbidden', 'Нет доступа к переписке');
    const hidden = role === 'operator' ? '' : "and m.status = 'visible'";
    const { rows } = await pool.query(
      `${CHAT_MESSAGE_SELECT} where m.thread_id = $1 ${hidden}
       order by m.created_at asc limit 200`, [thread.id]);
    const subject = await chatSubject(pool, thread.kind, thread.subject_id);
    const detail = await chatThreadDetail(pool, thread, auth);
    reply.header('Cache-Control', 'no-store');
    return { thread: detail, messages: rows.map(row => chatMessageView(row, auth)) };
  });

  app.post('/api/v1/chat/threads/:id/read', async (request) => {
    const auth = requireUser(request);
    const thread = await loadChatThread(pool, uuidParam(request));
    if (!thread) fail(404, 'thread_not_found', 'Переписка не найдена');
    if (!chatAccessRole(thread, auth)) fail(403, 'forbidden', 'Нет доступа к переписке');
    await pool.query(
      `insert into chat_reads (thread_id, user_id, last_read_at) values ($1, $2, now())
       on conflict (thread_id, user_id) do update set last_read_at = now()`,
      [thread.id, auth.userId]);
    return { ok: true };
  });

  app.post('/api/v1/chat/threads/:id/messages', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['body'],
      properties: {
        body: { type: 'string', minLength: 1, maxLength: 1000 },
        quickReply: { anyOf: [{ type: 'string', maxLength: 60 }, { type: 'null' }] },
      },
    } },
  }, async (request) => {
    const auth = requireUser(request);
    const text = request.body.body.trim();
    if (!text) fail(400, 'empty_message', 'Сообщение пустое');
    return withTransaction(pool, async client => {
      const thread = await loadChatThread(client, uuidParam(request));
      if (!thread) fail(404, 'thread_not_found', 'Переписка не найдена');
      if (!chatAccessRole(thread, auth)) fail(403, 'forbidden', 'Нет доступа к переписке');
      if (thread.status !== 'open') fail(409, 'chat_closed', 'Переписка закрыта');
      const subject = await chatSubject(client, thread.kind, thread.subject_id);
      const created = await client.query(
        `insert into chat_messages (thread_id, sender_user_id, body, quick_reply)
         values ($1, $2, $3, $4)
         returning id, thread_id, sender_user_id, body, quick_reply, status, created_at`,
        [thread.id, auth.userId, text, request.body.quickReply ?? null]);
      const row = { ...created.rows[0], sender_name: auth.displayName };
      await client.query(
        `update chat_threads set last_message_at = now(), updated_at = now() where id = $1`,
        [thread.id]);
      await client.query(
        `insert into chat_reads (thread_id, user_id, last_read_at) values ($1, $2, now())
         on conflict (thread_id, user_id) do update set last_read_at = now()`,
        [thread.id, auth.userId]);
      await notifyChatRecipients(client, thread, auth, subject, row);
      return { message: chatMessageView(row, auth) };
    });
  });

  app.post('/api/v1/chat/messages/:id/report', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: { reason: { type: 'string', maxLength: 300 } },
    } },
  }, async (request) => {
    const auth = requireUser(request);
    const messageId = uuidParam(request);
    const found = await pool.query(
      `select m.id, m.thread_id, t.* from chat_messages m
       join chat_threads t on t.id = m.thread_id where m.id = $1`, [messageId]);
    if (!found.rows[0]) fail(404, 'message_not_found', 'Сообщение не найдено');
    const thread = found.rows[0];
    if (!chatAccessRole(thread, auth)) fail(403, 'forbidden', 'Нет доступа к сообщению');
    await pool.query(
      `insert into chat_reports (message_id, reporter_user_id, reason)
       values ($1, $2, $3) on conflict (message_id, reporter_user_id) do nothing`,
      [messageId, auth.userId, (request.body?.reason ?? '').trim()]);
    return { reported: true };
  });


  app.get('/api/v1/today', async (request, reply) => {
    const auth = requireUser(request);
    const partnerIds = partnerIdsOf(auth);
    const isPartner = partnerIds.length > 0;
    const isOp = isOperator(auth);
    const isDriver = auth.roles.some(role => role.role === 'driver');
    const isCourier = auth.roles.some(role => role.role === 'courier');
    const tasks = [];
    const add = (role, kind, title, subtitle, count, priority, tab, view = null) => {
      if (!count) return;
      tasks.push({
        id: `${role}-${kind}`, role, kind, title, subtitle, count,
        priority: priority ?? 1, action: { tab, view },
      });
    };

    const [bookings, shop, trips, services, queueTicket, waitlist, chatUnread] = await Promise.all([
      pool.query(
        `select b.status, b.cash_confirmed_provider_at, b.cash_confirmed_client_at,
                p.name as place_name, s.starts_at
         from bookings b join availability_slots s on s.id = b.slot_id
         join offers o on o.id = s.offer_id join places p on p.id = o.place_id
         where b.client_user_id = $1 and b.status in ('requested', 'confirmed')
         order by s.starts_at asc limit 20`, [auth.userId]),
      pool.query(
        `select o.status, p.name as place_name
         from shop_orders o join places p on p.id = o.place_id
         where o.client_user_id = $1 and o.status in ('placed', 'confirmed', 'ready', 'out_for_delivery', 'awaiting_cash')
         order by o.created_at desc limit 20`, [auth.userId]),
      pool.query(
        `select t.status, t.from_label, t.to_label, t.cash_confirmed_client_at, t.cash_confirmed_driver_at
         from trips t where t.client_user_id = $1
           and t.status in ('requested', 'assigned', 'arrived', 'in_progress')
         order by t.created_at desc limit 10`, [auth.userId]),
      pool.query(
        `select r.status, r.title
         from service_requests r where r.client_user_id = $1
           and r.status in ('open', 'assigned', 'in_progress', 'awaiting_cash')
         order by r.created_at desc limit 10`, [auth.userId]),
      pool.query(
        `select t.id, t.number, t.status, p.name as place_name
         from queue_tickets t join places p on p.id = t.place_id
         where t.client_user_id = $1 and t.status in ('waiting', 'called', 'serving')
         order by t.created_at desc limit 1`, [auth.userId]),
      pool.query(
        `select count(*)::int as count from waitlist_entries
         where user_id = $1 and status = 'notified' and expires_at > now()`, [auth.userId]),
      pool.query(
        `select count(*)::int as count from chat_messages m
         join chat_threads t on t.id = m.thread_id
         left join chat_reads r on r.thread_id = t.id and r.user_id = $1
         where (t.client_user_id = $1 or t.provider_user_id = $1 or t.partner_id = any($2::uuid[]))
           and m.sender_user_id <> $1 and m.status = 'visible'
           and m.created_at > coalesce(r.last_read_at, 'epoch'::timestamptz)`,
        [auth.userId, partnerIds]),
    ]);

    const cashPending = bookings.rows.filter(row => row.status === 'confirmed'
      && row.cash_confirmed_provider_at && !row.cash_confirmed_client_at);
    add('client', 'cash', 'Подтвердить наличные',
      cashPending[0] ? `${cashPending[0].place_name}: работа выполнена` : 'Ждут вашего подтверждения',
      cashPending.length, 4, 'orders', 'bookings');
    add('client', 'bookings', 'Активные записи',
      bookings.rows[0] ? `${bookings.rows[0].place_name} · ${new Date(bookings.rows[0].starts_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '',
      bookings.rows.length, 2, 'orders', 'bookings');
    add('client', 'shop', 'Заказы и доставка',
      shop.rows[0]?.place_name ?? 'Проверьте статусы',
      shop.rows.length, 2, 'orders', 'shop');
    add('client', 'trips', 'Поездки',
      trips.rows[0] ? `${trips.rows[0].from_label} → ${trips.rows[0].to_label}` : 'Проверьте поездку',
      trips.rows.length, 3, 'taxi');
    add('client', 'service', 'Заявки мастеру',
      services.rows[0]?.title ?? 'Проверьте предложения',
      services.rows.length, 2, 'orders', 'requests');
    add('client', 'queue', 'Живая очередь',
      queueTicket.rows[0] ? `${queueTicket.rows[0].place_name} · № ${String(queueTicket.rows[0].number).padStart(2, '0')}` : '',
      queueTicket.rows.length, 3, 'orders', 'queue');
    add('client', 'waitlist', 'Окно освободилось', 'Можно записаться на услугу',
      waitlist.rows[0]?.count ?? 0, 4, 'orders', 'bookings');
    add('client', 'chat', 'Непрочитанные сообщения', 'Вам написали по заказу',
      chatUnread.rows[0]?.count ?? 0, 4, 'orders', 'chat');

    if (isPartner) {
      const [pBookings, pShop, pQueue, pService] = await Promise.all([
        pool.query(
          `select b.status, b.cash_confirmed_provider_at, b.cash_confirmed_client_at,
                  p.name as place_name, s.starts_at
           from bookings b join availability_slots s on s.id = b.slot_id
           join offers o on o.id = s.offer_id join places p on p.id = o.place_id
           where p.partner_id = any($1::uuid[]) and b.status in ('requested', 'confirmed')
           order by s.starts_at asc limit 20`, [partnerIds]),
        pool.query(
          `select o.status, p.name as place_name from shop_orders o join places p on p.id = o.place_id
           where p.partner_id = any($1::uuid[])
             and o.status in ('placed', 'confirmed', 'ready', 'out_for_delivery', 'awaiting_cash')
           order by o.created_at asc limit 20`, [partnerIds]),
        pool.query(
          `select t.status, p.name as place_name from queue_tickets t join places p on p.id = t.place_id
           where p.partner_id = any($1::uuid[]) and t.status in ('waiting', 'called')
           order by t.created_at asc limit 20`, [partnerIds]),
        pool.query(
          `select r.status, r.title from service_requests r
           where r.partner_id = any($1::uuid[])
             and r.status in ('open', 'assigned', 'in_progress', 'awaiting_cash')
           order by r.created_at asc limit 20`, [partnerIds]),
      ]);
      const pCash = pBookings.rows.filter(row => row.status === 'confirmed'
        && !row.cash_confirmed_provider_at);
      add('partner', 'bookings', 'Записи клиентов',
        pBookings.rows[0] ? `${pBookings.rows[0].place_name} · ${pBookings.rows.length} активных` : 'Нет активных записей',
        pBookings.rows.length, 3, 'profile');
      add('partner', 'cash', 'Отметить наличные',
        pCash[0] ? `${pCash[0].place_name}: клиент ждёт закрытия` : 'Подтвердите получение',
        pCash.length, 4, 'profile');
      add('partner', 'queue', 'Очередь', pQueue.rows[0]?.place_name ?? 'Клиенты ждут',
        pQueue.rows.length, 3, 'profile');
      add('partner', 'shop', 'Заказы', pShop.rows[0]?.place_name ?? 'Новые заказы',
        pShop.rows.length, 3, 'profile');
      add('partner', 'service', 'Заявки на выезд', pService.rows[0]?.title ?? 'Открытые заявки',
        pService.rows.length, 2, 'profile');
      add('partner', 'chat', 'Сообщения клиентов', 'Непрочитанная переписка',
        chatUnread.rows[0]?.count ?? 0, 4, 'orders', 'chat');
    }

    if (isOp) {
      const [reviews, openService, activeTrips, pendingDelivery, reports] = await Promise.all([
        pool.query(`select count(*)::int as count from reviews where status = 'pending'`),
        pool.query(`select count(*)::int as count from service_requests where status = 'open'`),
        pool.query(`select count(*)::int as count from trips where status in ('requested', 'assigned', 'arrived', 'in_progress')`),
        pool.query(`select count(*)::int as count from delivery_jobs where status = 'pending'`),
        pool.query(`select count(*)::int as count from chat_reports where status = 'open'`),
      ]);
      add('operator', 'reviews', 'Модерация отзывов', 'Проверьте новые отзывы',
        reviews.rows[0]?.count ?? 0, 3, 'profile');
      add('operator', 'service', 'Открытые заявки', 'Нужен мастер',
        openService.rows[0]?.count ?? 0, 2, 'profile');
      add('operator', 'trips', 'Поездки', 'Активные заказы такси',
        activeTrips.rows[0]?.count ?? 0, 2, 'profile');
      add('operator', 'delivery', 'Доставка', 'Ждут курьера',
        pendingDelivery.rows[0]?.count ?? 0, 3, 'profile');
      add('operator', 'chat-reports', 'Жалобы в чате', 'Проверьте сообщения',
        reports.rows[0]?.count ?? 0, 3, 'profile');
    }

    if (isDriver) {
      const { rows } = await pool.query(
        `select status, cash_confirmed_driver_at from trips
         where driver_user_id = $1 and status in ('assigned', 'arrived', 'in_progress')
         order by created_at desc limit 10`, [auth.userId]);
      add('driver', 'trips', 'Мои поездки', rows[0] ? tripStatusText(rows[0].status) : 'Нет активной поездки',
        rows.length, 3, 'profile');
      add('driver', 'chat', 'Сообщения клиента', 'Переписка по поездке',
        chatUnread.rows[0]?.count ?? 0, 4, 'orders', 'chat');
    }

    if (isCourier) {
      const [mine, available] = await Promise.all([
        pool.query(`select count(*)::int as count from delivery_jobs where courier_user_id = $1 and status in ('assigned', 'picked_up')`, [auth.userId]),
        pool.query(`select count(*)::int as count from delivery_jobs where status = 'pending'`),
      ]);
      add('courier', 'deliveries', 'Мои доставки', 'Активные задания',
        mine.rows[0]?.count ?? 0, 3, 'profile');
      add('courier', 'available', 'Свободные доставки', 'Можно взять в работу',
        available.rows[0]?.count ?? 0, 2, 'profile');
    }

    tasks.sort((a, b) => b.priority - a.priority);
    reply.header('Cache-Control', 'no-store');
    return {
      generatedAt: new Date().toISOString(),
      roles: auth.roles.map(role => role.role),
      items: tasks,
    };
  });

  function tripStatusText(status) {
    return ({ requested: 'Ищем водителя', assigned: 'Водитель едет', arrived: 'Водитель на месте',
      in_progress: 'В пути', completed: 'Завершена', cancelled: 'Отменена' })[status] ?? status;
  }

  app.get('/api/v1/operator/chat/reports', async (request, reply) => {
    requireRole(request, 'operator');
    const { rows } = await pool.query(
      `select r.*, m.body, m.status as message_status, m.created_at as message_created_at,
              u.display_name as sender_name, rep.display_name as reporter_name,
              t.id as thread_id, t.kind, t.subject_id, t.client_user_id
       from chat_reports r
       join chat_messages m on m.id = r.message_id
       join chat_threads t on t.id = m.thread_id
       join users u on u.id = m.sender_user_id
       join users rep on rep.id = r.reporter_user_id
       where r.status = 'open'
       order by r.created_at asc limit 100`);
    reply.header('Cache-Control', 'no-store');
    return { items: rows.map(row => ({
      id: row.id,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
      reporter: { id: row.reporter_user_id, name: row.reporter_name },
      thread: { id: row.thread_id, kind: row.kind, subjectId: row.subject_id },
      message: {
        id: row.message_id, body: row.body, status: row.message_status,
        createdAt: row.message_created_at, sender: { id: row.sender_user_id, name: row.sender_name },
      },
    })) };
  });

  app.post('/api/v1/operator/chat/messages/:id/moderate', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['hide', 'restore'] },
        note: { type: 'string', maxLength: 300 },
      },
    } },
  }, async (request) => {
    requireRole(request, 'operator');
    const auth = requireUser(request);
    const messageId = uuidParam(request);
    const message = await pool.query('select id, thread_id from chat_messages where id = $1', [messageId]);
    if (!message.rows[0]) fail(404, 'message_not_found', 'Сообщение не найдено');
    const action = request.body.action;
    await withTransaction(pool, async client => {
      if (action === 'hide') {
        await client.query(
          `update chat_messages set status = 'hidden', hidden_at = now(), hidden_by = $2,
             moderation_note = $3 where id = $1`,
          [messageId, auth.userId, (request.body.note ?? '').trim()]);
      } else {
        await client.query(
          `update chat_messages set status = 'visible', hidden_at = null, hidden_by = null,
             moderation_note = $2 where id = $1`,
          [messageId, (request.body.note ?? '').trim()]);
      }
      if (action === 'hide') {
        await client.query(
          `update chat_reports set status = 'resolved', resolved_by = $2, resolved_at = now()
           where message_id = $1 and status = 'open'`, [messageId, auth.userId]);
      }
    });
    return { message: { id: messageId, status: action === 'hide' ? 'hidden' : 'visible' } };
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

      await client.query(
        `update waitlist_entries set status = 'converted', updated_at = now()
         where user_id = $1 and offer_id = $2 and status in ('waiting', 'notified')`,
        [auth.userId, found.offer_id]);

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


  async function notifyWaitlistForFreedSlot(client, booking) {
    const { rows } = await client.query(
      `select w.id, w.user_id, p.id as place_id, p.name as place_name, o.title
       from waitlist_entries w
       join availability_slots s on s.id = $2
       join offers o on o.id = w.offer_id
       join places p on p.id = o.place_id
       join cities c on c.slug = p.city_slug
       where w.offer_id = $1 and w.status = 'waiting' and w.expires_at > now()
         and w.user_id <> $3
         and (w.preferred_date is null
              or w.preferred_date = (s.starts_at at time zone c.timezone)::date)
       for update of w`,
      [booking.offer_id, booking.slot_id, booking.client_user_id]);
    for (const entry of rows) {
      const marked = await client.query(
        `update waitlist_entries set status = 'notified', notified_at = now(), updated_at = now()
         where id = $1 and status = 'waiting'`, [entry.id]);
      if (!marked.rowCount) continue;
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'booking_waitlist_open', $2)`,
        [entry.user_id, JSON.stringify({
          waitlistId: entry.id,
          offerId: booking.offer_id,
          placeId: entry.place_id,
          slotId: booking.slot_id,
          place: entry.place_name,
          title: entry.title,
          startsAt: booking.starts_at,
          message: `${entry.place_name} · ${entry.title}: освободилось время`,
        })]);
    }
  }

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
      if (to === 'cancelled' && booking.cash_confirmed_provider_at) {
        fail(409, 'cash_confirmed', 'Исполнитель уже подтвердил получение наличных');
      }
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
      if (to === 'cancelled') await notifyWaitlistForFreedSlot(client, booking);
      return { id: booking.id, status: updated.rows[0].status };
    });
  }

  app.post('/api/v1/bookings/:id/reschedule', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['slotId'],
      properties: { slotId: { type: 'string', format: 'uuid' } },
    } },
  }, async (request) => {
    const auth = requireUser(request);
    const bookingId = uuidParam(request);
    const slotId = request.body.slotId;
    if (!UUID_RE.test(slotId)) fail(404, 'slot_not_found', 'Окно недоступно');
    try {
      return await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `${BOOKING_SELECT} where b.id = $1 for update of b`, [bookingId]);
        const booking = rows[0];
        if (!booking) fail(404, 'booking_not_found', 'Запись не найдена');
        const partnerId = (await client.query(
          `select p.partner_id from offers o join places p on p.id = o.place_id where o.id = $1`,
          [booking.offer_id])).rows[0]?.partner_id;
        const isClient = booking.client_user_id === auth.userId;
        const owns = partnerIdsOf(auth).includes(partnerId);
        if (!isClient && !owns && !isOperator(auth)) fail(403, 'forbidden', 'Нет доступа к записи');
        if (!['requested', 'confirmed'].includes(booking.status)) {
          fail(409, 'invalid_transition', 'Запись уже в другом состоянии');
        }
        if (booking.cash_confirmed_provider_at) {
          fail(409, 'cash_confirmed', 'Исполнитель уже подтвердил получение наличных');
        }
        if (slotId === booking.slot_id) return bookingView(booking);
        const target = await client.query(
          `select s.id, s.starts_at, s.ends_at, o.id as offer_id, o.is_active, p.is_published
           from availability_slots s
           join offers o on o.id = s.offer_id
           join places p on p.id = o.place_id
           where s.id = $1`, [slotId]);
        const next = target.rows[0];
        if (!next || !next.is_active || !next.is_published) fail(404, 'slot_not_found', 'Окно недоступно');
        if (next.offer_id !== booking.offer_id) fail(409, 'slot_other_service', 'Окно относится к другой услуге');
        if (new Date(next.starts_at) <= new Date()) fail(409, 'slot_in_past', 'Это время уже прошло');
        const busy = await client.query(
          `select 1 from bookings where slot_id = $1 and id <> $2
             and status in ('requested', 'confirmed') limit 1`, [slotId, bookingId]);
        if (busy.rows[0]) fail(409, 'slot_taken', 'Это время уже заняли');

        await client.query(
          `update bookings set slot_id = $2, updated_at = now() where id = $1`, [bookingId, slotId]);
        await client.query(
          `insert into booking_events (booking_id, status, actor_user_id, note)
           values ($1, $2, $3, $4)`,
          [bookingId, booking.status, auth.userId, `rescheduled:${booking.slot_id}->${slotId}`]);

        // Старое окно снова свободно — разбудим лист ожидания.
        await notifyWaitlistForFreedSlot(client, booking);

        const payload = {
          bookingId,
          place: booking.place_name,
          startsAt: next.starts_at,
          previousStartsAt: booking.starts_at,
        };
        if (isClient) {
          const owners = await client.query(
            `select user_id from memberships where role = 'partner' and partner_id = $1`, [partnerId]);
          for (const owner of owners.rows) {
            await client.query(
              `insert into notifications (user_id, kind, payload) values ($1, 'booking_rescheduled', $2)`,
              [owner.user_id, JSON.stringify(payload)]);
          }
        } else {
          await client.query(
            `insert into notifications (user_id, kind, payload) values ($1, 'booking_rescheduled', $2)`,
            [booking.client_user_id, JSON.stringify(payload)]);
        }
        const view = await client.query(`${BOOKING_SELECT} where b.id = $1`, [bookingId]);
        return bookingView(view.rows[0]);
      });
    } catch (error) {
      if (isUniqueViolation(error) && error.constraint === 'bookings_active_slot_uq') {
        fail(409, 'slot_taken', 'Это время уже заняли');
      }
      throw error;
    }
  });

  app.post('/api/v1/bookings/:id/cancel', async (request) =>
    transition(request, { from: ACTIVE, to: 'cancelled', requireManager: false }));

  app.post('/api/v1/bookings/:id/confirm', async (request) =>
    transition(request, { from: ['requested'], to: 'confirmed', requireManager: true }));

  app.post('/api/v1/bookings/:id/complete', async (request) => {
    const auth = requireUser(request);
    const bookingId = uuidParam(request);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `${BOOKING_SELECT} where b.id = $1 for update of b`, [bookingId]);
      const booking = rows[0];
      if (!booking) fail(404, 'booking_not_found', 'Запись не найдена');
      const partnerId = (await client.query(
        `select p.partner_id from offers o join places p on p.id = o.place_id where o.id = $1`,
        [booking.offer_id])).rows[0]?.partner_id;
      if (!isOperator(auth) && !partnerIdsOf(auth).includes(partnerId)) {
        fail(403, 'forbidden', 'Действие доступно партнёру');
      }
      if (booking.cash_confirmed_provider_at) return bookingView(booking);
      if (booking.status !== 'confirmed') fail(409, 'invalid_transition', 'Запись уже в другом состоянии');
      await client.query(
        `update bookings set cash_confirmed_provider_at = now(), updated_at = now() where id = $1`,
        [bookingId]);
      await client.query(
        `insert into booking_events (booking_id, status, actor_user_id, note)
         values ($1, 'confirmed', $2, 'cash_confirmed_provider')`, [bookingId, auth.userId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'booking_awaiting_cash', $2)`,
        [booking.client_user_id, JSON.stringify({ bookingId, price: booking.price_cents })]);
      const view = await client.query(`${BOOKING_SELECT} where b.id = $1`, [bookingId]);
      return bookingView(view.rows[0]);
    });
  });

  app.post('/api/v1/bookings/:id/cash', async (request) => {
    const auth = requireUser(request);
    const bookingId = uuidParam(request);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `${BOOKING_SELECT} where b.id = $1 for update of b`, [bookingId]);
      const booking = rows[0];
      if (!booking) fail(404, 'booking_not_found', 'Запись не найдена');
      if (booking.client_user_id !== auth.userId) fail(403, 'forbidden', 'Это не ваша запись');
      if (booking.cash_confirmed_client_at) return bookingView(booking);
      if (booking.status !== 'confirmed' || !booking.cash_confirmed_provider_at) {
        fail(409, 'cash_not_ready', 'Исполнитель ещё не подтвердил получение наличных');
      }
      await client.query(
        `update bookings set status = 'completed', cash_confirmed_client_at = now(), updated_at = now()
         where id = $1`, [bookingId]);
      await client.query(
        `insert into booking_events (booking_id, status, actor_user_id, note)
         values ($1, 'completed', $2, 'cash_confirmed_client')`, [bookingId, auth.userId]);
      const partnerId = (await client.query(
        `select p.partner_id from offers o join places p on p.id = o.place_id where o.id = $1`,
        [booking.offer_id])).rows[0]?.partner_id;
      if (partnerId) {
        await notifyPartner(client, partnerId, 'booking_cash_confirmed',
          { bookingId, price: booking.price_cents });
      }
      const view = await client.query(`${BOOKING_SELECT} where b.id = $1`, [bookingId]);
      return bookingView(view.rows[0]);
    });
  });

  app.get('/api/v1/partner/bookings', async (request, reply) => {
    const auth = requireRole(request, 'partner', 'operator');
    const partnerIds = partnerIdsOf(auth);
    if (!isOperator(auth) && partnerIds.length === 0) fail(403, 'forbidden', 'Нет партнёрского кабинета');
    const status = request.query?.status;
    const { rows } = await pool.query(
      `${BOOKING_SELECT}
       where ($1::uuid[] is null or p.partner_id = any($1::uuid[]))
         and ($2::text is null or b.status::text = $2)
       order by case b.status when 'requested' then 0 when 'confirmed' then 1 else 2 end,
                s.starts_at asc limit 200`,
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
  async function hoursForPlaces(ids) {
    if (!ids.length) return new Map();
    const { rows } = await pool.query(
      `select h.place_id, h.weekday, h.is_closed, h.is_24h,
              to_char(i.opens_at, 'HH24:MI') as opens_at,
              to_char(i.closes_at, 'HH24:MI') as closes_at
       from place_hours h
       left join place_hour_intervals i
         on i.place_id = h.place_id and i.weekday = h.weekday
       where h.place_id = any($1::uuid[])
       order by h.place_id, h.weekday, i.position`, [ids]);
    return groupHourRows(rows);
  }

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

  app.get('/api/v1/partner/places/:id/hours', async (request, reply) => {
    const auth = requireRole(request, 'partner', 'operator');
    const placeId = uuidParam(request);
    await loadPlaceForManager(auth, placeId);
    const place = await pool.query(
      'select c.timezone from places p join cities c on c.slug = p.city_slug where p.id = $1', [placeId]);
    if (!place.rows[0]) fail(404, 'place_not_found', 'Заведение не найдено');
    const { rows } = await pool.query(
      `select h.place_id, h.weekday, h.is_closed, h.is_24h,
              to_char(i.opens_at, 'HH24:MI') as opens_at,
              to_char(i.closes_at, 'HH24:MI') as closes_at
       from place_hours h
       left join place_hour_intervals i
         on i.place_id = h.place_id and i.weekday = h.weekday
       where h.place_id = $1 order by h.weekday, i.position`, [placeId]);
    const view = hoursView(rows, place.rows[0].timezone);
    reply.header('Cache-Control', 'no-store');
    return { timezone: view.timezone, days: view.days, openNow: view.openNow };
  });

  app.put('/api/v1/partner/places/:id/hours', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['days'],
      properties: { days: {
        type: 'array', minItems: 7, maxItems: 7,
        items: { type: 'object', additionalProperties: false,
          required: ['weekday', 'isClosed', 'is24h'],
          properties: {
            weekday: { type: 'integer', minimum: 0, maximum: 6 },
            isClosed: { type: 'boolean' },
            is24h: { type: 'boolean' },
            intervals: { type: 'array', maxItems: 4, items: {
              type: 'object', additionalProperties: false, required: ['from', 'to'],
              properties: { from: { type: 'string', maxLength: 5 }, to: { type: 'string', maxLength: 5 } },
            } },
          } },
      } },
    } },
  }, async (request, reply) => {
    const auth = requireRole(request, 'partner', 'operator');
    const placeId = uuidParam(request);
    await loadPlaceForManager(auth, placeId);
    const days = validateSchedule(request.body.days);
    if (!days) fail(400, 'invalid_schedule', 'Проверьте дни и интервалы работы');
    await withTransaction(pool, async (client) => {
      await client.query('delete from place_hours where place_id = $1', [placeId]);
      for (const day of days) {
        await client.query(
          `insert into place_hours (place_id, weekday, is_closed, is_24h)
           values ($1, $2, $3, $4)`, [placeId, day.weekday, day.isClosed, day.is24h]);
      }
      for (const row of scheduleRowsForDb(days)) {
        await client.query(
          `insert into place_hour_intervals (place_id, weekday, position, opens_at, closes_at)
           values ($1, $2, $3, $4, $5)`,
          [placeId, row.weekday, row.position, row.opensAt, row.closesAt]);
      }
    });
    const place = await pool.query(
      'select c.timezone from places p join cities c on c.slug = p.city_slug where p.id = $1', [placeId]);
    const { rows } = await pool.query(
      `select h.place_id, h.weekday, h.is_closed, h.is_24h,
              to_char(i.opens_at, 'HH24:MI') as opens_at,
              to_char(i.closes_at, 'HH24:MI') as closes_at
       from place_hours h
       left join place_hour_intervals i
         on i.place_id = h.place_id and i.weekday = h.weekday
       where h.place_id = $1 order by h.weekday, i.position`, [placeId]);
    const view = hoursView(rows, place.rows[0].timezone);
    reply.header('Cache-Control', 'no-store');
    return { timezone: view.timezone, days: view.days, openNow: view.openNow, saved: true };
  });

  app.get('/api/v1/partner/places/:id/queue', async (request, reply) => {
    const auth = requireRole(request, 'partner', 'operator');
    const placeId = uuidParam(request);
    await loadPlaceForManager(auth, placeId);
    const settings = await pool.query(
      'select is_active, avg_minutes, notice from queue_settings where place_id = $1', [placeId]);
    const tickets = await pool.query(
      `${QUEUE_TICKET_SELECT} where t.place_id = $1 and t.day = current_date
       order by t.number`, [placeId]);
    reply.header('Cache-Control', 'no-store');
    return {
      settings: {
        isActive: Boolean(settings.rows[0]?.is_active),
        avgMinutes: settings.rows[0]?.avg_minutes ?? 10,
        notice: settings.rows[0]?.notice ?? '',
      },
      tickets: tickets.rows.map(queueTicketView),
    };
  });

  app.put('/api/v1/partner/places/:id/queue', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      properties: {
        isActive: { type: 'boolean' },
        avgMinutes: { type: 'integer', minimum: 1, maximum: 180 },
        notice: { type: 'string', maxLength: 200 },
      },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'partner', 'operator');
    const placeId = uuidParam(request);
    await loadPlaceForManager(auth, placeId);
    const current = await pool.query(
      'select is_active, avg_minutes, notice from queue_settings where place_id = $1', [placeId]);
    const previous = current.rows[0] ?? { is_active: false, avg_minutes: 10, notice: '' };
    const isActive = request.body.isActive ?? previous.is_active;
    const avgMinutes = request.body.avgMinutes ?? previous.avg_minutes;
    const notice = request.body.notice ?? previous.notice;
    const { rows } = await pool.query(
      `insert into queue_settings (place_id, is_active, avg_minutes, notice)
       values ($1, $2, $3, $4)
       on conflict (place_id) do update set is_active = excluded.is_active,
         avg_minutes = excluded.avg_minutes, notice = excluded.notice, updated_at = now()
       returning is_active, avg_minutes, notice`,
      [placeId, isActive, avgMinutes, notice]);
    return { isActive: rows[0].is_active, avgMinutes: rows[0].avg_minutes, notice: rows[0].notice };
  });

  app.post('/api/v1/partner/places/:id/queue/next', async (request) => {
    const auth = requireRole(request, 'partner', 'operator');
    const placeId = uuidParam(request);
    await loadPlaceForManager(auth, placeId);
    const result = await withTransaction(pool, async (client) => {
      const settings = await client.query(
        'select is_active from queue_settings where place_id = $1 for update', [placeId]);
      if (!settings.rows[0]?.is_active) fail(409, 'queue_closed', 'Очередь сейчас закрыта');
      const current = await client.query(
        `select id from queue_tickets where place_id = $1 and day = current_date
         and status in ('called', 'serving') limit 1`, [placeId]);
      if (current.rows[0]) fail(409, 'queue_busy', 'Сначала завершите текущий талон');
      const next = await client.query(
        `select * from queue_tickets where place_id = $1 and day = current_date
         and status = 'waiting' order by number limit 1 for update`, [placeId]);
      if (!next.rows[0]) fail(404, 'queue_empty', 'В очереди никого нет');
      await client.query(
        `update queue_tickets set status = 'called', called_at = now() where id = $1`, [next.rows[0].id]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'queue_called', $2)`,
        [next.rows[0].client_user_id, JSON.stringify({
          placeId, ticketId: next.rows[0].id, number: next.rows[0].number,
        })]);
      const view = await client.query(`${QUEUE_TICKET_SELECT} where t.id = $1`, [next.rows[0].id]);
      return queueTicketView(view.rows[0]);
    });
    return result;
  });

  app.post('/api/v1/partner/queue/:id/status', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: { action: { type: 'string', enum: ['serving', 'done', 'no_show'] } },
    } },
  }, async (request) => {
    const auth = requireRole(request, 'partner', 'operator');
    const ticketId = uuidParam(request);
    const result = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `${QUEUE_TICKET_SELECT} where t.id = $1 for update of t`, [ticketId]);
      const ticket = rows[0];
      if (!ticket) fail(404, 'queue_ticket_not_found', 'Талон не найден');
      await loadPlaceForManager(auth, ticket.place_id, client);
      const action = request.body.action;
      const allowed = {
        serving: ['called'],
        done: ['serving'],
        no_show: ['waiting', 'called'],
      };
      if (!allowed[action].includes(ticket.status)) {
        fail(409, 'invalid_transition', 'Талон уже в другом состоянии');
      }
      const status = action === 'no_show' ? 'no_show' : action;
      if (action === 'done' || action === 'no_show') {
        await client.query(
          `update queue_tickets set status = $2, closed_at = now() where id = $1`, [ticketId, status]);
      } else {
        await client.query('update queue_tickets set status = $2 where id = $1', [ticketId, status]);
      }
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'queue_status', $2)`,
        [ticket.client_user_id, JSON.stringify({
          placeId: ticket.place_id, ticketId, status, number: ticket.number,
        })]);
      const view = await client.query(`${QUEUE_TICKET_SELECT} where t.id = $1`, [ticketId]);
      return queueTicketView(view.rows[0]);
    });
    return result;
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
      properties: {
        from: POINT_SCHEMA,
        to: POINT_SCHEMA,
        stops: { type: 'array', maxItems: 3, items: POINT_SCHEMA },
      },
    } },
  }, async (request) => routeQuote(request.body.from, request.body.to, request.body.stops ?? []));

  app.post('/api/v1/trips', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['from', 'to'],
      properties: {
        from: POINT_SCHEMA,
        to: POINT_SCHEMA,
        stops: { type: 'array', maxItems: 3, items: POINT_SCHEMA },
        scheduledFor: { type: 'string', maxLength: 40 },
        passengers: { type: 'integer', minimum: 1, maximum: 6 },
        childSeat: { type: 'boolean' },
        luggage: { type: 'boolean' },
        pets: { type: 'boolean' },
        comment: { type: 'string', maxLength: 300 },
        idempotencyKey: { type: 'string', minLength: 8, maxLength: 80 },
      },
    } },
  }, async (request, reply) => {
    const auth = requireUser(request);
    const {
      from, to, stops = [], idempotencyKey = null,
      passengers = 1, childSeat = false, luggage = false, pets = false, comment = '',
    } = request.body;
    let scheduledFor = null;
    if (request.body.scheduledFor) {
      const date = new Date(request.body.scheduledFor);
      if (!Number.isFinite(date.getTime())) fail(400, 'invalid_time', 'Некорректное время поездки');
      if (date.getTime() < Date.now() - 60_000) fail(400, 'time_in_past', 'Время поездки уже прошло');
      if (date.getTime() > Date.now() + 7 * 86400_000) fail(400, 'time_too_far', 'Предзаказ доступен на 7 дней');
      scheduledFor = date.toISOString();
    }
    const cleanStops = stops.map(stop => ({
      label: String(stop.label).trim().slice(0, 200),
      address: stop.address ? String(stop.address).slice(0, 500) : undefined,
      lat: Number(stop.lat),
      lng: Number(stop.lng),
    })).filter(stop => stop.label && Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
    const quote = await routeQuote(from, to, cleanStops);
    const attempt = async () => withTransaction(pool, async (client) => {
      if (idempotencyKey) {
        const existing = await client.query(
          `${TRIP_SELECT} where t.client_user_id = $1 and t.idempotency_key = $2`, [auth.userId, idempotencyKey]);
        if (existing.rows[0]) return { trip: tripView(existing.rows[0]), created: false };
      }
      const inserted = await client.query(
        `insert into trips (client_user_id, from_label, from_address, from_lat, from_lng,
                            to_label, to_address, to_lat, to_lng,
                            distance_km, duration_min, idempotency_key, stops, scheduled_for,
                            passengers, child_seat, luggage, pets, ride_comment)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19)
         returning id`,
        [auth.userId, from.label, from.address ?? null, from.lat, from.lng,
          to.label, to.address ?? null, to.lat, to.lng,
          quote.distanceKm, quote.durationMin, idempotencyKey, JSON.stringify(cleanStops), scheduledFor,
          passengers, childSeat, luggage, pets, String(comment).trim().slice(0, 300)]);
      const tripId = inserted.rows[0].id;
      await client.query(
        `insert into trip_events (trip_id, status, actor_user_id) values ($1, 'requested', $2)`, [tripId, auth.userId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'trip_requested', $2)`,
        [auth.userId, JSON.stringify({ tripId, from: from.label, to: to.label, scheduledFor })]);
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
      `${TRIP_SELECT} where t.status = 'requested' order by t.created_at desc limit 50`);
    const mine = await pool.query(
      `${TRIP_SELECT} where t.driver_user_id = $1 and t.status in ('assigned', 'arrived', 'in_progress')
       order by t.created_at desc limit 50`, [auth.userId]);
    const completed = await pool.query(
      `${TRIP_SELECT} where t.driver_user_id = $1 and t.status = 'completed'
       order by t.completed_at desc limit 10`, [auth.userId]);
    const allIds = [...available.rows, ...mine.rows, ...completed.rows].map(row => row.id);
    const offers = await tripOffersForTrips(pool, allIds, auth.userId);
    reply.header('Cache-Control', 'no-store');
    return {
      available: available.rows.map(row => tripView(row, offers.get(row.id) ?? [])),
      mine: mine.rows.map(row => tripView(row, offers.get(row.id) ?? [])),
      completed: completed.rows.map(row => tripView(row, offers.get(row.id) ?? [])),
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
    driverTransition(request, ['assigned'], 'arrived', 'arrived_at'));
  app.post('/api/v1/trips/:id/start', async (request) =>
    driverTransition(request, ['arrived'], 'in_progress', 'started_at'));
  app.post('/api/v1/trips/:id/complete', async (request) =>
    driverTransition(request, ['in_progress'], 'completed', 'completed_at'));

  app.post('/api/v1/trips/:id/cash', async (request) => {
    const auth = requireUser(request);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query('select * from trips where id = $1 for update', [uuidParam(request)]);
      const trip = rows[0];
      if (!trip) fail(404, 'trip_not_found', 'Поездка не найдена');
      if (trip.status !== 'completed') fail(409, 'trip_not_completed', 'Поездка ещё не завершена');
      if (trip.price_cents == null) fail(409, 'price_not_agreed', 'Цена не согласована');
      const isClient = trip.client_user_id === auth.userId;
      const isDriver = trip.driver_user_id === auth.userId;
      if (!isClient && !isDriver) fail(403, 'forbidden', 'Нет доступа к поездке');
      const column = isClient ? 'cash_confirmed_client_at' : 'cash_confirmed_driver_at';
      await client.query(`update trips set ${column} = coalesce(${column}, now()), updated_at = now() where id = $1`, [trip.id]);
      const target = isClient ? trip.driver_user_id : trip.client_user_id;
      if (target) {
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'trip_cash', $2)`,
          [target, JSON.stringify({ tripId: trip.id, by: isClient ? 'client' : 'driver' })]);
      }
      const view = await client.query(`${TRIP_SELECT} where t.id = $1`, [trip.id]);
      const offers = await tripOffersForTrips(client, [trip.id]);
      return tripView(view.rows[0], offers.get(trip.id) ?? []);
    });
  });

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

  app.post('/api/v1/me/service-requests/:id/cash', async (request) => {
    const auth = requireUser(request);
    const requestId = uuidValue(request.params.id, 'Заявка');
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query('select * from service_requests where id = $1 for update', [requestId]);
      const item = rows[0];
      if (!item) fail(404, 'request_not_found', 'Заявка не найдена');
      if (item.client_user_id !== auth.userId) fail(403, 'forbidden', 'Это не ваша заявка');
      if (item.cash_confirmed_client_at) return loadServiceRequest(client, requestId);
      if (item.status !== 'awaiting_cash' || !item.cash_confirmed_provider_at) {
        fail(409, 'cash_not_ready', 'Исполнитель ещё не подтвердил получение наличных');
      }
      await client.query(
        `update service_requests set cash_confirmed_client_at = now(), status = 'completed',
                completed_at = now(), updated_at = now() where id = $1`, [requestId]);
      await client.query(
        `insert into service_request_events (request_id, status, actor_user_id, note)
         values ($1, 'completed', $2, 'cash_confirmed_client')`, [requestId, auth.userId]);
      if (item.partner_id) {
        await notifyPartner(client, item.partner_id, 'service_cash_confirmed',
          { requestId, price: item.price_cents });
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
      `${SERVICE_SELECT} where r.partner_id = any($1::uuid[]) and r.status in ('assigned', 'in_progress', 'awaiting_cash')
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

  app.post('/api/v1/partner/service-requests/:id/complete', async (request) => {
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
      if (item.status !== 'in_progress') fail(409, 'invalid_transition', 'Заявка уже в другом состоянии');
      if (item.price_cents === null) fail(409, 'price_not_agreed', 'Цена ещё не согласована');
      await client.query(
        `update service_requests set status = 'awaiting_cash', cash_confirmed_provider_at = now(),
                updated_at = now() where id = $1`, [requestId]);
      await client.query(
        `insert into service_request_events (request_id, status, actor_user_id, note)
         values ($1, 'awaiting_cash', $2, 'cash_confirmed_provider')`, [requestId, auth.userId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, 'service_awaiting_cash', $2)`,
        [item.client_user_id, JSON.stringify({ requestId, price: item.price_cents })]);
      return loadServiceRequest(client, requestId);
    });
  });

  app.get('/api/v1/operator/service-requests', async (request, reply) => {
    requireRole(request, 'operator');
    const { rows } = await pool.query(
      `${SERVICE_SELECT} where r.status in ('open', 'assigned', 'in_progress', 'awaiting_cash')
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

  app.post('/api/v1/me/shop-orders/:id/cash', async (request) => {
    const auth = requireUser(request);
    const orderId = uuidParam(request);
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `select o.*, p.partner_id from shop_orders o join places p on p.id = o.place_id
         where o.id = $1 for update`, [orderId]);
      const order = rows[0];
      if (!order) fail(404, 'order_not_found', 'Заказ не найден');
      if (order.client_user_id !== auth.userId) fail(403, 'forbidden', 'Это не ваш заказ');
      if (order.cash_confirmed_client_at) return loadShopOrder(client, orderId);
      if (order.status !== 'awaiting_cash' || !order.cash_confirmed_provider_at) {
        fail(409, 'cash_not_ready', 'Продавец или курьер ещё не подтвердил получение наличных');
      }
      await client.query(
        `update shop_orders set cash_confirmed_client_at = now(), status = 'completed',
                completed_at = now(), updated_at = now() where id = $1`, [orderId]);
      await client.query(
        `insert into shop_order_events (order_id, status, actor_user_id, note)
         values ($1, 'completed', $2, 'cash_confirmed_client')`, [orderId, auth.userId]);
      await notifyPartner(client, order.partner_id, 'shop_cash_confirmed',
        { orderId, total: order.total_cents });
      const job = await client.query(
        'select courier_user_id from delivery_jobs where order_id = $1', [orderId]);
      if (job.rows[0]?.courier_user_id) {
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'delivery_cash_confirmed', $2)`,
          [job.rows[0].courier_user_id, JSON.stringify({ orderId })]);
      }
      return loadShopOrder(client, orderId);
    });
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


  app.get('/api/v1/partner/analytics', {
    schema: { querystring: {
      type: 'object', additionalProperties: false,
      properties: { days: { type: 'integer', minimum: 7, maximum: 365 } },
    } },
  }, async (request, reply) => {
    const auth = requireRole(request, 'partner');
    const partnerIds = partnerIdsOf(auth);
    if (!partnerIds.length) fail(403, 'forbidden', 'Нет кабинета партнёра');
    const days = request.query.days ?? 30;
    const interval = `($2::int || ' days')::interval`;
    const base = `from bookings b
      join availability_slots s on s.id = b.slot_id
      join offers o on o.id = s.offer_id
      join places p on p.id = o.place_id
      join cities c on c.slug = p.city_slug
      where p.partner_id = any($1::uuid[]) and b.created_at >= now() - ${interval}`;
    const [totals, repeat, top, week, hours, queue] = await Promise.all([
      pool.query(
        `select count(*)::int as total,
                count(*) filter (where b.status = 'completed')::int as completed,
                count(*) filter (where b.status in ('cancelled', 'expired'))::int as cancelled,
                count(*) filter (where b.status = 'expired')::int as expired,
                count(distinct b.client_user_id)::int as clients,
                coalesce(sum(b.price_cents) filter (where b.status = 'completed'), 0)::bigint as revenue
         ${base}`, [partnerIds, days]),
      pool.query(
        `select count(*)::int as clients,
                count(*) filter (where visits >= 2)::int as repeat
         from (select b.client_user_id,
                      count(*) filter (where b.status = 'completed') as visits
               ${base} group by b.client_user_id) x`, [partnerIds, days]),
      pool.query(
        `select u.display_name as name, count(*)::int as visits, max(s.starts_at) as last_visit
         from bookings b
         join availability_slots s on s.id = b.slot_id
         join offers o on o.id = s.offer_id
         join places p on p.id = o.place_id
         join users u on u.id = b.client_user_id
         where p.partner_id = any($1::uuid[]) and b.created_at >= now() - ${interval}
           and b.status = 'completed'
         group by u.id, u.display_name order by visits desc, last_visit desc limit 5`, [partnerIds, days]),
      pool.query(
        `select extract(isodow from (s.starts_at at time zone c.timezone))::int as weekday,
                count(*)::int as bookings,
                count(*) filter (where b.status = 'completed')::int as completed
         ${base} group by 1 order by 1`, [partnerIds, days]),
      pool.query(
        `select extract(hour from (s.starts_at at time zone c.timezone))::int as hour,
                count(*)::int as bookings,
                count(*) filter (where b.status = 'completed')::int as completed
         ${base} group by 1 order by 1`, [partnerIds, days]),
      pool.query(
        `select count(*)::int as total,
                count(*) filter (where t.status = 'no_show')::int as no_show
         from queue_tickets t join places p on p.id = t.place_id
         where p.partner_id = any($1::uuid[]) and t.created_at >= now() - ${interval}`,
        [partnerIds, days]),
    ]);
    const total = totals.rows[0] ?? {};
    const repeatRow = repeat.rows[0] ?? {};
    const clients = Number(repeatRow.clients ?? 0);
    const repeatClients = Number(repeatRow.repeat ?? 0);
    const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const byWeekday = weekDays.map((label, index) => {
      const row = week.rows.find(item => Number(item.weekday) === index + 1);
      return { weekday: index + 1, label, bookings: Number(row?.bookings ?? 0), completed: Number(row?.completed ?? 0) };
    });
    const byHour = Array.from({ length: 24 }, (_, hour) => {
      const row = hours.rows.find(item => Number(item.hour) === hour);
      return { hour, bookings: Number(row?.bookings ?? 0), completed: Number(row?.completed ?? 0) };
    });
    const bestHour = [...byHour].sort((a, b) => (b.completed - a.completed) || (b.bookings - a.bookings))[0];
    const bestWeekday = [...byWeekday].sort((a, b) => (b.completed - a.completed) || (b.bookings - a.bookings))[0];
    const completed = Number(total.completed ?? 0);
    const revenue = Number(total.revenue ?? 0);
    reply.header('Cache-Control', 'no-store');
    return {
      periodDays: days,
      totals: {
        bookings: Number(total.total ?? 0), completed,
        cancelled: Number(total.cancelled ?? 0), expired: Number(total.expired ?? 0),
        clients: Number(total.clients ?? 0),
        revenue: money(revenue),
        avgCheck: money(completed ? Math.round(revenue / completed) : 0),
      },
      repeat: {
        clients, repeatClients,
        rate: clients ? Math.round((repeatClients / clients) * 1000) / 10 : 0,
      },
      noShow: {
        queueTotal: Number(queue.rows[0]?.total ?? 0),
        queueNoShow: Number(queue.rows[0]?.no_show ?? 0),
        expiredBookings: Number(total.expired ?? 0),
      },
      byWeekday,
      byHour,
      best: {
        hour: bestHour?.completed || bestHour?.bookings ? bestHour.hour : null,
        weekday: bestWeekday?.completed || bestWeekday?.bookings ? bestWeekday.weekday : null,
        count: Math.max(bestHour?.completed ?? 0, bestHour?.bookings ?? 0),
      },
      topClients: top.rows.map(row => ({
        name: row.name, visits: Number(row.visits), lastVisit: row.last_visit,
      })),
    };
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
      };
      let nextStatus;
      if (action === 'cancel') {
        if (!['placed', 'confirmed'].includes(order.status)) fail(409, 'invalid_transition', 'Заказ уже нельзя отменить');
        await restockShopOrder(client, orderId);
        await client.query(
          `update delivery_jobs set status = 'cancelled', cancelled_at = now(), updated_at = now()
           where order_id = $1 and status in ('pending', 'assigned')`, [orderId]);
        await client.query(
          `update shop_orders set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = $1`,
          [orderId]);
        nextStatus = 'cancelled';
      } else if (action === 'complete') {
        if (order.fulfillment === 'delivery') fail(409, 'courier_required', 'Доставку завершает курьер');
        if (order.status !== 'ready') fail(409, 'invalid_transition', 'Заказ уже в другом состоянии');
        await client.query(
          `update shop_orders set status = 'awaiting_cash', cash_confirmed_provider_at = now(),
                  updated_at = now() where id = $1`, [orderId]);
        nextStatus = 'awaiting_cash';
      } else {
        const transition = transitions[action];
        if (order.status !== transition.from) fail(409, 'invalid_transition', 'Заказ уже в другом состоянии');
        await client.query(
          `update shop_orders set status = $2, ${transition.stamp} = now(), updated_at = now() where id = $1`,
          [orderId, transition.to]);
        nextStatus = transition.to;
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
      await client.query(
        `insert into shop_order_events (order_id, status, actor_user_id) values ($1, $2, $3)`,
        [orderId, nextStatus, auth.userId]);
      await client.query(
        `insert into notifications (user_id, kind, payload) values ($1, $2, $3)`,
        [order.client_user_id, nextStatus === 'awaiting_cash' ? 'shop_awaiting_cash' : `shop_${nextStatus}`,
          JSON.stringify({ orderId, status: nextStatus, total: order.total_cents })]);
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
          `update shop_orders set status = 'awaiting_cash', cash_confirmed_provider_at = now(),
                  updated_at = now() where id = $1`, [job.order_id]);
        await client.query(
          `insert into shop_order_events (order_id, status, actor_user_id, note)
           values ($1, 'awaiting_cash', $2, 'cash_confirmed_courier')`, [job.order_id, auth.userId]);
        await client.query(
          `insert into notifications (user_id, kind, payload) values ($1, 'delivery_completed', $2)`,
          [job.client_user_id, JSON.stringify({ jobId, orderId: job.order_id, status: 'awaiting_cash' })]);
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
