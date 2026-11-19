// Демо-режим для GitHub Pages: тот же интерфейс и сценарии, но данные
// хранятся в localStorage, сеть и PostgreSQL не нужны. Включается VITE_DEMO=1.

type Category = 'salon' | 'services' | 'health' | 'food';
type Money = { cents: number; currency: string };

const ME_KEY = 'rjadom.demo.me';
const BOOKINGS_KEY = 'rjadom.demo.bookings';
const CODE_KEY = 'rjadom.demo.code';
const DAY = 86400000;

const places = [
  { id: 'forma', partnerId: 'p1', name: 'Форма', category: 'salon', district: 'Центр', address: 'ул. Мира, 12', lat: 55.7601, lng: 37.6186, about: 'Стрижки, укладка, окрашивание. Два мастера, окна с 10 до 19.', phone: '+79000000010' },
  { id: 'liniya', partnerId: 'p2', name: 'Линия', category: 'salon', district: 'Северный', address: 'пр. Победы, 4', lat: 55.7742, lng: 37.6011, about: 'Маникюр, педикюр, уход за руками.', phone: '+79000000011' },
  { id: 'ugol', partnerId: 'p2', name: 'Мастерская на углу', category: 'services', district: 'Центр', address: 'ул. Садовая, 3', lat: 55.7585, lng: 37.6290, about: 'Ремонт обуви и сумок, изготовление ключей.', phone: '+79000000011' },
  { id: 'tihiy-chas', partnerId: 'p1', name: 'Тихий час', category: 'health', district: 'Заречный', address: 'ул. Речная, 8', lat: 55.7490, lng: 37.6402, about: 'Массаж и восстановление после тренировок.', phone: null },
  { id: 'kuhnya', partnerId: 'p2', name: 'Кухня на районе', category: 'food', district: 'Южный', address: 'ул. Южная, 21', lat: 55.7402, lng: 37.6154, about: 'Домашние обеды, самовывоз с 11 до 20.', phone: '+79000000011' },
  { id: 'glaz', partnerId: 'p1', name: 'Глаз да глаз', category: 'services', district: 'Северный', address: 'ул. Северная, 15', lat: 55.7801, lng: 37.6103, about: 'Мелкий ремонт одежды, подгонка по фигуре.', phone: null },
] as const;

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
type DemoReview = { id: string; rating: number; body: string; createdAt: string; author: string };
type DemoBooking = {
  id: string; status: 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'expired';
  note: string; price: Money; createdAt: string;
  slot: { id: string; startsAt: string; endsAt: string };
  offer: { id: string; title: string; durationMin: number };
  place: { id: string; name: string; address: string; district: string };
  review: { id: string; rating: number } | null;
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

const placeById = (id: string) => places.find(item => item.id === id);
const offerById = (id: string) => offers.find(item => item.id === id);
const money = (cents: number): Money => ({ cents, currency: 'RUB' });

function reviewsFor(placeId: string, bookings: DemoBooking[] = getBookings()): DemoReview[] {
  const seeded = (seedReviews[placeId] ?? []).map((review, index) => ({
    id: `seed-${placeId}-${index}`, rating: review.rating, body: review.body,
    author: review.author, createdAt: new Date(Date.now() - review.daysAgo * DAY).toISOString(),
  }));
  const mine = bookings
    .filter(item => item.place.id === placeId && item.review)
    .map(item => ({ id: item.review!.id, rating: item.review!.rating, body: 'Спасибо, всё понравилось.', author: getMe()?.user.displayName ?? 'Клиент', createdAt: item.createdAt }));
  return [...mine, ...seeded];
}

function card(place: typeof places[number], bookings = getBookings()) {
  const list = offers.filter(item => item.placeId === place.id);
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
  if (!offer) return [];
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
    const list = offers.filter(item => item.placeId === place.id).map(item => ({
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
      const roles: DemoRole[] = [];
      if (partner) roles.push({ role: 'partner', partner_id: 'p1' });
      if (operator) roles.push({ role: 'operator', partner_id: null });
      roles.push({ role: 'client', partner_id: null });
      me = {
        user: { id: `u-${digits.slice(-6)}`, phone: `+${digits}`, displayName: String(body.displayName || '').trim() || (partner ? 'Партнёр Демо' : operator ? 'Оператор Демо' : 'Клиент Демо') },
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
    target.review = { id: `r-${Date.now()}`, rating: Number(body.rating) || 5 };
    saveBookings(items);
    return { ok: true } as T;
  }

  return fail('Демо-метод не найден', 'not_found');
}
