// Демо-режим для GitHub Pages: тот же интерфейс и сценарии, но данные
// хранятся в localStorage, сеть и PostgreSQL не нужны. Включается VITE_DEMO=1.

type Category = 'salon' | 'services' | 'health' | 'food';
type Money = { cents: number; currency: string };

const ME_KEY = 'rjadom.demo.me';
const BOOKINGS_KEY = 'rjadom.demo.bookings';
const CODE_KEY = 'rjadom.demo.code';
const TRIPS_KEY = 'rjadom.demo.trips';
const DAY = 86400000;

const places = [
  { id: 'forma', partnerId: 'p1', name: 'Форма', category: 'salon', district: 'Центр', address: 'ул. Мира, 12', lat: 55.7601, lng: 37.6186, about: 'Стрижки, укладка, окрашивание. Два мастера, окна с 10 до 19.', phone: '+79000000010' },
  { id: 'liniya', partnerId: 'p2', name: 'Линия', category: 'salon', district: 'Северный', address: 'пр. Победы, 4', lat: 55.7742, lng: 37.6011, about: 'Маникюр, педикюр, уход за руками.', phone: '+79000000011' },
  { id: 'ugol', partnerId: 'p2', name: 'Мастерская на углу', category: 'services', district: 'Центр', address: 'ул. Садовая, 3', lat: 55.7585, lng: 37.6290, about: 'Ремонт обуви и сумок, изготовление ключей.', phone: '+79000000011' },
  { id: 'tihiy-chas', partnerId: 'p1', name: 'Тихий час', category: 'health', district: 'Заречный', address: 'ул. Речная, 8', lat: 55.7490, lng: 37.6402, about: 'Массаж и восстановление после тренировок.', phone: null },
  { id: 'kuhnya', partnerId: 'p2', name: 'Кухня на районе', category: 'food', district: 'Южный', address: 'ул. Южная, 21', lat: 55.7402, lng: 37.6154, about: 'Домашние обеды, самовывоз с 11 до 20.', phone: '+79000000011' },
  { id: 'glaz', partnerId: 'p1', name: 'Глаз да глаз', category: 'services', district: 'Северный', address: 'ул. Северная, 15', lat: 55.7801, lng: 37.6103, about: 'Мелкий ремонт одежды, подгонка по фигуре.', phone: null },
];

const offers = [
  { id: 'forma-cut', placeId: 'forma', title: 'Стрижка и укладка', durationMin: 60, price: 120000 },
  { id: 'forma-color', placeId: 'forma', title: 'Окрашивание корней', durationMin: 90, price: 240000 },
  { id: 'liniya-mani', placeId: 'liniya', title: 'Маникюр без покрытия', durationMin: 45, price: 100000 },
  { id: 'liniya-pedi', placeId: 'liniya', title: 'Педикюр с покрытием', durationMin: 75, price: 190000 },
  { id: 'ugol-repair', placeId: 'ugol', title: 'Ремонт обуви: профилактика', durationMin: 20, price: 60000 },
  { id: 'tihiy-massage', placeId: 'tihiy-chas', title: 'Массаж спины 45 минут', durationMin: 45, price: 180000 },
  { id: 'kuhnya-lunch', placeId: 'kuhnya', title: 'Обед дня (самовывоз)', durationMin: 15, price: 45000 },
  { id: 'glaz-fit', placeId: 'glaz', title: 'Подгонка брюк', durationMin: 30, price: 80000 },
];

const seedReviews: Record<string, { author: string; rating: number; body: string; daysAgo: number }[]> = {
  forma: [
    { author: 'Анна', rating: 5, body: 'Быстро, аккуратно и без лишних разговоров. Записалась за пять минут.', daysAgo: 6 },
    { author: 'Игорь', rating: 5, body: 'Удобно, что видно свободное время. Пришёл ровно к началу.', daysAgo: 18 },
    { author: 'Мария', rating: 4, body: 'Хорошая стрижка, чуть задержали начало.', daysAgo: 31 },
  ],
  liniya: [
    { author: 'Ольга', rating: 5, body: 'Маникюр держится третью неделю.', daysAgo: 9 },
    { author: 'Дарья', rating: 4, body: 'Уютно, но на севере добираться долго.', daysAgo: 22 },
  ],
  ugol: [
    { author: 'Пётр', rating: 5, body: 'Починили ботинки за двадцать минут при мне.', daysAgo: 12 },
  ],
  'tihiy-chas': [
    { author: 'Тест', rating: 5, body: 'Хорошо', daysAgo: 1 },
    { author: 'Тест', rating: 5, body: 'Хорошо', daysAgo: 1 },
  ],
  kuhnya: [
    { author: 'Сергей', rating: 4, body: 'Обед сытный, забирать удобно.', daysAgo: 4 },
  ],
  glaz: [],
};

type DemoRole = { role: string; partner_id: string | null };
type DemoMe = { user: { id: string; phone: string; displayName: string }; roles: DemoRole[]; partnerIds: string[] };
type DemoTripPoint = { label: string; lat: number; lng: number };
type DemoTripStatus = 'requested' | 'assigned' | 'arrived' | 'in_progress' | 'completed' | 'cancelled';
type DemoTrip = {
  id: string; status: DemoTripStatus; from: DemoTripPoint; to: DemoTripPoint; distanceKm: number; durationMin: number;
  price: Money; createdAt: string; client: { id: string; name: string };
  driver: { id: string; name: string; car: string; plate: string } | null;
};
type DemoReview = { id: string; rating: number; body: string; createdAt: string; author: string; status: 'pending' | 'published' | 'hidden' };
type DemoBooking = {
  id: string; status: 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'expired';
  note: string; price: Money; createdAt: string;
  slot: { id: string; startsAt: string; endsAt: string };
  offer: { id: string; title: string; durationMin: number };
  place: { id: string; name: string; address: string; district: string };
  review: { id: string; rating: number; status: 'pending' | 'published' | 'hidden' } | null;
};

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch { return fallback; }
};
const write = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
const pause = (ms = 160) => new Promise(resolve => setTimeout(resolve, ms));
const fail = (message: string, code?: string) => Promise.reject(Object.assign(new Error(message), { code }));

const getMe = () => read<DemoMe | null>(ME_KEY, null);
const getBookings = () => read<DemoBooking[]>(BOOKINGS_KEY, []);
const saveBookings = (items: DemoBooking[]) => write(BOOKINGS_KEY, items);
const getTrips = () => read<DemoTrip[]>(TRIPS_KEY, []);
const saveTrips = (items: DemoTrip[]) => write(TRIPS_KEY, items);
const TRIP_ACTIVE: DemoTripStatus[] = ['requested', 'assigned', 'arrived', 'in_progress'];

function tripQuote(from: DemoTripPoint, to: DemoTripPoint) {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(to.lat - from.lat);
  const dLng = rad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  const straight = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  const distanceKm = Math.max(0.3, Math.round(straight * 1.35 * 10) / 10);
  const durationMin = Math.max(4, Math.round(distanceKm / 24 * 60 + 3));
  const cents = Math.max(14900, Math.round((9900 + distanceKm * 2500 + durationMin * 500) / 1000) * 1000);
  return { distanceKm, durationMin, price: money(cents) };
}

const placeById = (id: string) => places.find(item => item.id === id);
const offerById = (id: string) => offers.find(item => item.id === id);
const money = (cents: number): Money => ({ cents, currency: 'RUB' });

function reviewsFor(placeId: string, bookings: DemoBooking[] = getBookings(), includePending = false): DemoReview[] {
  const seeded = (seedReviews[placeId] ?? []).map((review, index) => ({
    id: `seed-${placeId}-${index}`, rating: review.rating, body: review.body,
    author: review.author, createdAt: new Date(Date.now() - review.daysAgo * DAY).toISOString(),
    status: 'published' as const,
  }));
  const mine = bookings
    .filter(item => item.place.id === placeId && item.review)
    .map(item => ({ id: item.review!.id, rating: item.review!.rating, body: 'Спасибо, всё понравилось.',
      author: getMe()?.user.displayName ?? 'Клиент', createdAt: item.createdAt, status: item.review!.status }));
  return [...mine, ...seeded].filter(review => includePending || review.status === 'published');
}

function activeOffers(placeId: string) {
  return offers.filter(item => item.placeId === placeId && (item as { isActive?: boolean }).isActive !== false);
}

function card(place: typeof places[number], bookings = getBookings()) {
  const list = activeOffers(place.id);
  const reviews = reviewsFor(place.id, bookings);
  const rating = reviews.length ? reviews.reduce((sum, item) => sum + item.rating, 0) / reviews.length : null;
  return {
    id: place.id, name: place.name, category: place.category as Category, district: place.district,
    address: place.address, about: place.about, location: { lat: place.lat, lng: place.lng },
    rating: rating === null ? null : Math.round(rating * 10) / 10,
    ratingCount: reviews.length,
    priceFrom: list.length ? money(Math.min(...list.map(item => item.price))) : null,
    offerCount: list.length, distanceKm: null,
  };
}

function slotsFor(offerId: string): { id: string; startsAt: string; endsAt: string }[] {
  const offer = offerById(offerId);
  if (!offer || (offer as { isActive?: boolean }).isActive === false) return [];
  const busy = new Set(getBookings().filter(item => item.status === 'requested' || item.status === 'confirmed').map(item => item.slot.id));
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const result = [];
  for (let day = 1; day <= 10; day += 1) {
    for (const hour of [10, 12, 14, 16, 18]) {
      const begins = new Date(start.getTime() + day * DAY);
      begins.setHours(hour, 0, 0, 0);
      const id = `${offer.id}@${begins.toISOString()}`;
      if (busy.has(id)) continue;
      result.push({ id, startsAt: begins.toISOString(), endsAt: new Date(begins.getTime() + offer.durationMin * 60000).toISOString() });
    }
  }
  return result;
}

function partnerBookings(me: DemoMe): DemoBooking[] {
  const allowed = new Set<string>(places.filter(place => me.partnerIds.includes(place.partnerId)).map(place => place.id));
  return getBookings().filter(item => allowed.has(item.place.id));
}

const READ_KEY = 'rjadom.demo.read';

function partnerPlaceView(place: typeof places[number]) {
  return {
    id: place.id, name: place.name, category: place.category as Category, district: place.district,
    address: place.address, about: place.about, phone: place.phone,
    location: { lat: place.lat, lng: place.lng },
    isPublished: (place as { isPublished?: boolean }).isPublished !== false,
    updatedAt: new Date().toISOString(),
    offers: offers.filter(item => item.placeId === place.id).map(item => ({
      id: item.id, title: item.title, description: '', durationMin: item.durationMin,
      price: money(item.price), isActive: (item as { isActive?: boolean }).isActive !== false,
      slotCount: slotsFor(item.id).length, nextSlot: slotsFor(item.id)[0]?.startsAt ?? null,
    })),
  };
}

function demoNotifications(me: DemoMe) {
  const readIds = read<number[]>(READ_KEY, []);
  const kinds: Record<DemoBooking['status'], string> = {
    requested: 'booking_requested', confirmed: 'booking_confirmed', completed: 'booking_completed',
    cancelled: 'booking_cancelled', expired: 'booking_cancelled',
  };
  const items = getBookings().slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item, index) => {
      const id = 1000 + index;
      return {
        id, kind: item.status === 'requested' && me.partnerIds.length ? 'booking_new' : kinds[item.status],
        payload: { bookingId: item.id, place: item.place.name, status: item.status },
        channel: 'inapp', created_at: item.createdAt,
        read_at: readIds.includes(id) ? new Date().toISOString() : null,
        delivered_at: null, last_error: null,
      };
    });
  return items;
}

function seedBookingsOnce(me: DemoMe) {
  if (localStorage.getItem(BOOKINGS_KEY) !== null) return;
  const offer = offerById('forma-cut')!;
  const place = placeById('forma')!;
  const completedStart = new Date(Date.now() - DAY);
  completedStart.setHours(12, 0, 0, 0);
  const requestedStart = new Date(Date.now() + DAY);
  requestedStart.setHours(14, 0, 0, 0);
  const base = {
    note: '', price: money(offer.price), createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
    offer: { id: offer.id, title: offer.title, durationMin: offer.durationMin },
    place: { id: place.id, name: place.name, address: place.address, district: place.district },
  };
  const items: DemoBooking[] = [
    {
      ...base, id: 'seed-completed', status: 'completed', review: null,
      slot: { id: `${offer.id}@${completedStart.toISOString()}`, startsAt: completedStart.toISOString(), endsAt: new Date(completedStart.getTime() + offer.durationMin * 60000).toISOString() },
    },
    {
      ...base, id: 'seed-requested', status: 'requested', review: null,
      note: 'Первый раз, подскажите, пожалуйста, по парковке.',
      slot: { id: `${offer.id}@${requestedStart.toISOString()}`, startsAt: requestedStart.toISOString(), endsAt: new Date(requestedStart.getTime() + offer.durationMin * 60000).toISOString() },
    },
  ];
  if (!me.roles.some(role => role.role === 'client')) items.pop();
  saveBookings(items);
}

export async function demoRequest<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  await pause();
  const url = new URL(path, 'https://demo.local');
  const method = init.method ?? 'GET';
  const body = (init.body ?? {}) as Record<string, string>;

  if (url.pathname === '/api/v1/districts') {
    return { items: [...new Set(places.map(place => place.district))] } as T;
  }

  if (url.pathname === '/api/v1/places') {
    const category = url.searchParams.get('category');
    const district = url.searchParams.get('district');
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const items = places
      .filter(place => (place as { isPublished?: boolean }).isPublished !== false)
      .filter(place => (!category || place.category === category) && (!district || place.district === district))
      .filter(place => !q || place.name.toLowerCase().includes(q) || place.about.toLowerCase().includes(q))
      .map(place => card(place));
    return { items } as T;
  }

  const placeMatch = url.pathname.match(/^\/api\/v1\/places\/([^/]+)$/);
  if (placeMatch) {
    const place = placeById(placeMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    const bookings = getBookings();
    const list = activeOffers(place.id).map(item => ({
      ...item, price: money(item.price), nextSlot: slotsFor(item.id)[0]?.startsAt ?? null,
    }));
    const base = card(place, bookings);
    return { place: { ...base, phone: place.phone }, offers: list, reviews: reviewsFor(place.id, bookings) } as T;
  }

  const slotsMatch = url.pathname.match(/^\/api\/v1\/offers\/([^/]+)\/slots$/);
  if (slotsMatch) {
    if (!offerById(slotsMatch[1])) return fail('Услуга не найдена', 'not_found');
    return { slots: slotsFor(slotsMatch[1]) } as T;
  }

  if (url.pathname === '/api/v1/me') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    return me as T;
  }

  if (url.pathname === '/api/v1/auth/code' && method === 'POST') {
    const digits = String(body.phone ?? '').replace(/\D/g, '');
    if (digits.length < 10) return fail('Введите телефон', 'invalid_phone');
    const code = String(Math.floor(100000 + Math.random() * 900000));
    sessionStorage.setItem(CODE_KEY, JSON.stringify({ phone: digits, code }));
    return { demoCode: code } as T;
  }

  if (url.pathname === '/api/v1/auth/session' && method === 'POST') {
    const digits = String(body.phone ?? '').replace(/\D/g, '');
    let saved: { phone: string; code: string } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(CODE_KEY) || 'null'); } catch { saved = null; }
    if (!saved || saved.phone !== digits || saved.code !== String(body.code ?? '').trim()) {
      return fail('Неверный код', 'invalid_code');
    }
    let me = getMe();
    if (!me || me.user.phone.replace(/\D/g, '') !== digits) {
      const partner = digits.endsWith('79000000002');
      const operator = digits.endsWith('79000000003');
      const driver = digits.endsWith('79000000004');
      const roles: DemoRole[] = [];
      if (partner) roles.push({ role: 'partner', partner_id: 'p1' });
      if (operator) roles.push({ role: 'operator', partner_id: null });
      if (driver) roles.push({ role: 'driver', partner_id: null });
      roles.push({ role: 'client', partner_id: null });
      me = {
        user: { id: `u-${digits.slice(-6)}`, phone: `+${digits}`, displayName: String(body.displayName || '').trim() || (partner ? 'Партнёр Демо' : operator ? 'Оператор Демо' : driver ? 'Водитель Демо' : 'Клиент Демо') },
        roles, partnerIds: partner ? ['p1'] : [],
      };
      write(ME_KEY, me);
      seedBookingsOnce(me);
    }
    return me as T;
  }

  if (url.pathname === '/api/v1/auth/logout' && method === 'POST') {
    localStorage.removeItem(ME_KEY);
    return { ok: true } as T;
  }

  if (url.pathname === '/api/v1/me/orders') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    return { items: getBookings().slice().sort((a, b) => b.slot.startsAt.localeCompare(a.slot.startsAt)) } as T;
  }

  if (url.pathname === '/api/v1/bookings' && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const slotId = String(body.slotId ?? '');
    const offerId = slotId.split('@')[0];
    const offer = offerById(offerId);
    if (!offer) return fail('Услуга не найдена', 'not_found');
    const slot = slotsFor(offerId).find(item => item.id === slotId);
    if (!slot) return fail('Это время уже занято', 'slot_taken');
    const place = placeById(offer.placeId)!;
    const booking: DemoBooking = {
      id: `b-${Date.now()}`, status: 'requested', note: String(body.note ?? '').slice(0, 200),
      price: money(offer.price), createdAt: new Date().toISOString(),
      slot: { id: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt },
      offer: { id: offer.id, title: offer.title, durationMin: offer.durationMin },
      place: { id: place.id, name: place.name, address: place.address, district: place.district },
      review: null,
    };
    saveBookings([...getBookings(), booking]);
    return booking as T;
  }

  const actionMatch = url.pathname.match(/^\/api\/v1\/bookings\/([^/]+)\/(cancel|confirm|complete)$/);
  if (actionMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const items = getBookings();
    const target = items.find(item => item.id === actionMatch[1]);
    if (!target) return fail('Запись не найдена', 'not_found');
    const action = actionMatch[2];
    if (action === 'cancel') target.status = 'cancelled';
    if (action === 'confirm') target.status = 'confirmed';
    if (action === 'complete') target.status = 'completed';
    saveBookings(items);
    return { ok: true } as T;
  }

  if (url.pathname === '/api/v1/partner/places') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    if (!me.partnerIds.length && !me.roles.some(role => role.role === 'operator')) return fail('Нет кабинета партнёра', 'forbidden');
    const visible = me.partnerIds.length
      ? places.filter(place => me.partnerIds.includes(place.partnerId))
      : places;
    return { items: visible.map(partnerPlaceView) } as T;
  }

  const partnerPlaceMatch = url.pathname.match(/^\/api\/v1\/partner\/places\/([^/]+)$/);
  if (partnerPlaceMatch && method === 'PATCH') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const place = placeById(partnerPlaceMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    if (!me.roles.some(role => role.role === 'operator') && !me.partnerIds.includes(place.partnerId)) return fail('Это не ваша карточка', 'forbidden');
    if (body.name !== undefined) place.name = String(body.name).slice(0, 120);
    if (body.category !== undefined) place.category = body.category as typeof place.category;
    if (body.district !== undefined) place.district = String(body.district).slice(0, 60);
    if (body.address !== undefined) place.address = String(body.address).slice(0, 160);
    if (body.about !== undefined) place.about = String(body.about).slice(0, 2000);
    if (body.phone !== undefined) place.phone = body.phone ? String(body.phone) : null;
    if (body.lat !== undefined) place.lat = Number(body.lat);
    if (body.lng !== undefined) place.lng = Number(body.lng);
    if (body.isPublished !== undefined) (place as { isPublished?: boolean }).isPublished = Boolean(body.isPublished);
    return partnerPlaceView(place) as T;
  }

  const partnerOffersMatch = url.pathname.match(/^\/api\/v1\/partner\/places\/([^/]+)\/offers$/);
  if (partnerOffersMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const place = placeById(partnerOffersMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    if (!me.roles.some(role => role.role === 'operator') && !me.partnerIds.includes(place.partnerId)) return fail('Это не ваша карточка', 'forbidden');
    const title = String(body.title ?? '').trim();
    if (title.length < 2) return fail('Укажите название', 'invalid_title');
    offers.push({
      id: `demo-offer-${Date.now()}`, placeId: place.id, title,
      durationMin: Math.max(5, Number(body.durationMin) || 60),
      price: Math.max(0, Number(body.priceCents) || 0),
    });
    const created = offers[offers.length - 1];
    return partnerPlaceView(place).offers.find(item => item.id === created.id) as T;
  }

  const partnerOfferMatch = url.pathname.match(/^\/api\/v1\/partner\/offers\/([^/]+)$/);
  if (partnerOfferMatch && method === 'PATCH') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const offer = offerById(partnerOfferMatch[1]);
    if (!offer) return fail('Услуга не найдена', 'not_found');
    const place = placeById(offer.placeId)!;
    if (!me.roles.some(role => role.role === 'operator') && !me.partnerIds.includes(place.partnerId)) return fail('Это не ваша услуга', 'forbidden');
    if (body.title !== undefined) offer.title = String(body.title).slice(0, 120);
    if (body.durationMin !== undefined) offer.durationMin = Number(body.durationMin);
    if (body.priceCents !== undefined) offer.price = Number(body.priceCents);
    if (body.isActive !== undefined) (offer as { isActive?: boolean }).isActive = Boolean(body.isActive);
    return partnerPlaceView(place).offers.find(item => item.id === offer.id) as T;
  }

  const partnerSlotsMatch = url.pathname.match(/^\/api\/v1\/partner\/offers\/([^/]+)\/slots$/);
  if (partnerSlotsMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    if (!offerById(partnerSlotsMatch[1])) return fail('Услуга не найдена', 'not_found');
    return { created: 0, days: Number(body.days) || 14 } as T;
  }

  if (url.pathname === '/api/v1/operator/reviews') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const status = url.searchParams.get('status') ?? 'pending';
    const items = getBookings()
      .filter(item => item.review && (status === 'all' || item.review.status === status))
      .map(item => ({
        id: item.review!.id, rating: item.review!.rating, body: 'Спасибо, всё понравилось.',
        status: item.review!.status, created_at: item.createdAt, moderated_at: null,
        author: 'Клиент', place_name: item.place.name,
        place_id: item.place.id, booking_id: item.id,
      }));
    return { items } as T;
  }

  const moderationMatch = url.pathname.match(/^\/api\/v1\/operator\/reviews\/([^/]+)\/moderate$/);
  if (moderationMatch && method === 'POST') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const items = getBookings();
    const target = items.find(item => item.review?.id === moderationMatch[1]);
    if (!target) return fail('Отзыв не найден', 'not_found');
    target.review!.status = body.action === 'publish' ? 'published' : 'hidden';
    saveBookings(items);
    return { id: target.review!.id, status: target.review!.status } as T;
  }

  if (url.pathname === '/api/v1/me/notifications') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    return { items: demoNotifications(me) } as T;
  }

  if (url.pathname === '/api/v1/me/notifications/read' && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const current = demoNotifications(me);
    const readIds = read<number[]>(READ_KEY, []);
    if (body.id) readIds.push(Number(body.id));
    else current.forEach(item => readIds.push(item.id));
    write(READ_KEY, [...new Set(readIds)]);
    return { ok: true } as T;
  }

  if (url.pathname === '/api/v1/trips/estimate' && method === 'POST') {
    const from = body.from as unknown as DemoTripPoint;
    const to = body.to as unknown as DemoTripPoint;
    if (!from || !to) return fail('Укажите маршрут', 'invalid_route');
    return tripQuote(from, to) as T;
  }

  if (url.pathname === '/api/v1/trips' && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const from = body.from as unknown as DemoTripPoint;
    const to = body.to as unknown as DemoTripPoint;
    if (!from || !to) return fail('Укажите маршрут', 'invalid_route');
    const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null;
    const trips = getTrips();
    if (key) {
      const existing = trips.find(item => item.client.id === me.user.id && (item as { key?: string }).key === key);
      if (existing) return existing as T;
    }
    if (trips.some(item => item.client.id === me.user.id && TRIP_ACTIVE.includes(item.status))) {
      return fail('У вас уже есть активная поездка', 'active_trip');
    }
    const quote = tripQuote(from, to);
    const trip: DemoTrip & { key?: string | null } = {
      id: `t-${Date.now()}`, status: 'requested', from, to, ...quote,
      createdAt: new Date().toISOString(), client: { id: me.user.id, name: me.user.displayName }, driver: null, key,
    };
    saveTrips([trip, ...trips]);
    return trip as T;
  }

  if (url.pathname === '/api/v1/me/trips') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const items = getTrips().filter(item => item.client.id === me.user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items } as T;
  }

  if (url.pathname === '/api/v1/driver/trips') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'driver' || role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const trips = getTrips();
    return {
      available: trips.filter(item => item.status === 'requested' && item.client.id !== me.user.id),
      mine: trips.filter(item => item.driver?.id === me.user.id && TRIP_ACTIVE.includes(item.status)),
    } as T;
  }

  if (url.pathname === '/api/v1/operator/trips') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    return { items: getTrips().filter(item => TRIP_ACTIVE.includes(item.status)) } as T;
  }

  const tripActionMatch = url.pathname.match(/^\/api\/v1\/trips\/([^/]+)\/(accept|arrive|start|complete|cancel)$/);
  if (tripActionMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const trips = getTrips();
    const trip = trips.find(item => item.id === tripActionMatch[1]);
    if (!trip) return fail('Поездка не найдена', 'not_found');
    const action = tripActionMatch[2];
    if (action === 'cancel') {
      const isClient = trip.client.id === me.user.id;
      const isDriver = trip.driver?.id === me.user.id;
      const clientCan = isClient && ['requested', 'assigned', 'arrived'].includes(trip.status);
      const driverCan = isDriver && ['assigned', 'arrived'].includes(trip.status);
      if (!clientCan && !driverCan) return fail('Отменить поездку нельзя', 'forbidden');
      trip.status = 'cancelled';
    } else {
      if (!me.roles.some(role => role.role === 'driver' || role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
      if (action === 'accept') {
        if (trip.status !== 'requested') return fail('Поездку уже приняли', 'trip_taken');
        if (getTrips().some(item => item.driver?.id === me.user.id && TRIP_ACTIVE.includes(item.status))) {
          return fail('У вас уже есть активная поездка', 'driver_busy');
        }
        trip.status = 'assigned';
        trip.driver = { id: me.user.id, name: me.user.displayName, car: 'Kia Rio', plate: 'A123ВС77' };
      } else {
        if (trip.driver?.id !== me.user.id) return fail('Это не ваша поездка', 'forbidden');
        const next: Record<string, DemoTripStatus> = { arrive: 'arrived', start: 'in_progress', complete: 'completed' };
        const allowed: Record<string, DemoTripStatus> = { arrive: 'assigned', start: 'arrived', complete: 'in_progress' };
        if (trip.status !== allowed[action]) return fail('Поездка уже в другом состоянии', 'invalid_transition');
        trip.status = next[action];
      }
    }
    saveTrips(trips);
    return trip as T;
  }

  const tripMatch = url.pathname.match(/^\/api\/v1\/trips\/([^/]+)$/);
  if (tripMatch) {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const trip = getTrips().find(item => item.id === tripMatch[1]);
    if (!trip) return fail('Поездка не найдена', 'not_found');
    if (trip.client.id !== me.user.id && trip.driver?.id !== me.user.id
      && !me.roles.some(role => role.role === 'operator')) return fail('Нет доступа к поездке', 'forbidden');
    return trip as T;
  }

  if (url.pathname === '/api/v1/partner/bookings') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    return { items: partnerBookings(me) } as T;
  }

  if (url.pathname === '/api/v1/reviews' && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const items = getBookings();
    const target = items.find(item => item.id === String(body.bookingId ?? ''));
    if (!target) return fail('Запись не найдена', 'not_found');
    if (target.review) return fail('Отзыв уже оставлен', 'already_reviewed');
    target.review = { id: `r-${Date.now()}`, rating: Number(body.rating) || 5, status: 'pending' };
    saveBookings(items);
    return { ok: true, status: 'pending' } as T;
  }

  return fail('Демо-метод не найден', 'not_found');
}
