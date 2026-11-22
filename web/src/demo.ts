// Демо-режим для GitHub Pages: тот же интерфейс и сценарии, но данные
// хранятся в localStorage, сеть и PostgreSQL не нужны. Включается VITE_DEMO=1.

import district from './demo-district.json';
import { openStateFromDays, validateSchedule } from '../../api/hours.mjs';

type Category = 'salon' | 'services' | 'health' | 'food';
type Money = { cents: number; currency: string };
type DemoSource = { kind: '2gis' | 'osm'; name: string; url: string | null; rating: number | null; ratingCount: number; license?: string };
type DemoDayHours = { weekday: number; isClosed: boolean; is24h: boolean; intervals: { from: string; to: string }[]; present?: boolean };
type DemoOpenNow = { state: 'open' | 'closed' | 'unknown'; label: string | null; opensAt: string | null; closesAt: string | null; weekday: number | null; is24h?: boolean };
type DemoPlace = {
  id: string; partnerId: string | null; city: string; name: string; category: Category;
  district: string; address: string; lat: number; lng: number; about: string; phone: string | null;
  image?: string | null; source?: DemoSource | null; timezone?: string; hours?: DemoDayHours[];
};

const ME_KEY = 'rjadom.demo.me';
const BOOKINGS_KEY = 'rjadom.demo.bookings';
const CODE_KEY = 'rjadom.demo.code';
const TRIPS_KEY = 'rjadom.demo.trips';
const SERVICE_KEY = 'rjadom.demo.services';
const PRODUCTS_KEY = 'rjadom.demo.products';
const SHOP_ORDERS_KEY = 'rjadom.demo.shop-orders';
const DELIVERY_ZONES_KEY = 'rjadom.demo.delivery-zones';
const DELIVERY_JOBS_KEY = 'rjadom.demo.delivery-jobs';
const PLACE_REVIEWS_KEY = 'rjadom.demo.place-reviews';
const QUEUE_SETTINGS_KEY = 'rjadom.demo.queue-settings';
const QUEUE_TICKETS_KEY = 'rjadom.demo.queue-tickets';
const FAVORITES_KEY = 'rjadom.demo.favorites';
const LOYALTY_PROGRAMS_KEY = 'rjadom.demo.loyalty-programs';
const LOYALTY_CARDS_KEY = 'rjadom.demo.loyalty-cards';
const LOYALTY_EVENTS_KEY = 'rjadom.demo.loyalty-events';
const WAITLIST_KEY = 'rjadom.demo.waitlist';
const CHAT_THREADS_KEY = 'rjadom.demo.chat-threads';
const CHAT_MESSAGES_KEY = 'rjadom.demo.chat-messages';
const CHAT_READS_KEY = 'rjadom.demo.chat-reads';
const CHAT_REPORTS_KEY = 'rjadom.demo.chat-reports';
const DAY = 86400000;

const demoPlaces: DemoPlace[] = [
  { id: 'forma', partnerId: 'p1', city: 'demograd', name: 'Форма', category: 'salon', district: 'Центр', address: 'ул. Мира, 12', lat: 55.7601, lng: 37.6186, about: 'Стрижки, укладка, окрашивание. Два мастера, окна с 10 до 19.', phone: '+79000000010' },
  { id: 'liniya', partnerId: 'p2', city: 'demograd', name: 'Линия', category: 'salon', district: 'Северный', address: 'пр. Победы, 4', lat: 55.7742, lng: 37.6011, about: 'Маникюр, педикюр, уход за руками.', phone: '+79000000011' },
  { id: 'ugol', partnerId: 'p2', city: 'demograd', name: 'Мастерская на углу', category: 'services', district: 'Центр', address: 'ул. Садовая, 3', lat: 55.7585, lng: 37.6290, about: 'Ремонт обуви и сумок, изготовление ключей.', phone: '+79000000011' },
  { id: 'tihiy-chas', partnerId: 'p1', city: 'demograd', name: 'Тихий час', category: 'health', district: 'Заречный', address: 'ул. Речная, 8', lat: 55.7490, lng: 37.6402, about: 'Массаж и восстановление после тренировок.', phone: null },
  { id: 'kuhnya', partnerId: 'p2', city: 'demograd', name: 'Кухня на районе', category: 'food', district: 'Южный', address: 'ул. Южная, 21', lat: 55.7402, lng: 37.6154, about: 'Домашние обеды, самовывоз с 11 до 20.', phone: '+79000000011' },
  { id: 'glaz', partnerId: 'p1', city: 'demograd', name: 'Глаз да глаз', category: 'services', district: 'Северный', address: 'ул. Северная, 15', lat: 55.7801, lng: 37.6103, about: 'Мелкий ремонт одежды, подгонка по фигуре.', phone: null },
];

const demoHours: Record<string, DemoDayHours[]> = {
  forma: [0, 1, 2, 3, 4, 5].map(weekday => ({ weekday, isClosed: false, is24h: false, intervals: [{ from: '10:00', to: '20:00' }] }))
    .concat([{ weekday: 6, isClosed: false, is24h: false, intervals: [{ from: '11:00', to: '18:00' }] }]),
  liniya: [0, 1, 2, 3, 4, 5].map(weekday => ({ weekday, isClosed: false, is24h: false, intervals: [{ from: '10:00', to: '20:00' }] }))
    .concat([{ weekday: 6, isClosed: false, is24h: false, intervals: [{ from: '11:00', to: '18:00' }] }]),
  ugol: [0, 1, 2, 3, 4].map(weekday => ({ weekday, isClosed: false, is24h: false, intervals: [{ from: '09:00', to: '19:00' }] }))
    .concat([{ weekday: 5, isClosed: false, is24h: false, intervals: [{ from: '10:00', to: '16:00' }] }, { weekday: 6, isClosed: true, is24h: false, intervals: [] }]),
  'tihiy-chas': Array.from({ length: 7 }, (_, weekday) => ({ weekday, isClosed: false, is24h: false, intervals: [{ from: '09:00', to: '22:00' }] })),
  kuhnya: Array.from({ length: 7 }, (_, weekday) => ({ weekday, isClosed: false, is24h: false, intervals: [{ from: '11:00', to: '02:00' }] })),
  glaz: [0, 1, 2, 3, 4].map(weekday => ({ weekday, isClosed: false, is24h: false, intervals: [{ from: '10:00', to: '19:00' }] }))
    .concat([{ weekday: 5, isClosed: false, is24h: false, intervals: [{ from: '11:00', to: '16:00' }] }, { weekday: 6, isClosed: true, is24h: false, intervals: [] }]),
};
for (const place of demoPlaces) {
  place.timezone = 'Europe/Moscow';
  place.hours = demoHours[place.id] ?? [];
}

const places: DemoPlace[] = [...demoPlaces, ...(district as DemoPlace[])];

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
type DemoTripPoint = { label: string; address?: string; lat: number; lng: number };
type DemoTripStatus = 'requested' | 'assigned' | 'arrived' | 'in_progress' | 'completed' | 'cancelled';
type DemoTripOffer = {
  id: string; price: Money; etaMin: number | null; message: string;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn'; createdAt: string;
  driver: { id: string; name: string; car: string; plate: string; rating?: number | null; ridesCount?: number; verified?: boolean };
};
type DemoTrip = {
  id: string; status: DemoTripStatus; from: DemoTripPoint; to: DemoTripPoint; distanceKm: number; durationMin: number;
  price: Money | null; createdAt: string; client: { id: string; name: string };
  driver: { id: string; name: string; car: string; plate: string; rating?: number | null; ridesCount?: number; verified?: boolean } | null;
  offers?: DemoTripOffer[]; offersUntil?: string | null; offersLeft?: number;
  stops?: DemoTripPoint[]; scheduledFor?: string | null;
  requirements?: { passengers: number; childSeat: boolean; luggage: boolean; pets: boolean; comment: string };
  arrivedAt?: string | null; cash?: { client: boolean; driver: boolean };
};
type DemoServiceOffer = {
  id: string; price: Money; message: string; etaMin: number | null;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  createdAt: string; partner: { id: string; name: string };
};
type DemoServiceRequest = {
  id: string; status: 'open' | 'assigned' | 'in_progress' | 'awaiting_cash' | 'completed' | 'cancelled' | 'expired';
  cash?: { client: boolean; provider: boolean };
  category: 'repair' | 'cleaning' | 'beauty' | 'tutoring' | 'moving' | 'other';
  title: string; description: string; address: string;
  budget: { min: Money; max: Money }; preferred: { from: string; to: string };
  price: Money | null; createdAt: string; key?: string | null;
  client: { id: string; name: string }; partner: { id: string; name: string } | null;
  offers: DemoServiceOffer[];
};
type DemoShopProduct = {
  id: string; placeId: string; title: string; description: string; price: Money;
  stockQty: number; unit: string; isActive: boolean;
};
type DemoShopOrderItem = { id: string; productId: string | null; title: string; unit: string; qty: number; price: Money; total: Money };
type DemoShopOrder = {
  id: string; status: 'placed' | 'confirmed' | 'ready' | 'out_for_delivery' | 'awaiting_cash' | 'completed' | 'cancelled';
  cash?: { client: boolean; provider: boolean };
  total: Money; goods?: Money; deliveryFee?: Money; fulfillment?: 'pickup' | 'delivery';
  pickupCode: string; note: string; createdAt: string; key?: string | null;
  client: { id: string; name: string };
  place: { id: string; name: string; address: string; district: string };
  deliveryJobId?: string | null;
  items: DemoShopOrderItem[];
};
type DemoDeliveryStatus = 'pending' | 'assigned' | 'picked_up' | 'delivered' | 'cancelled';
type DemoDeliveryZone = { id: string; placeId: string; district: string; feeCents: number; minOrderCents: number; etaMin: number; isActive: boolean };
type DemoDeliveryJob = {
  id: string; orderId: string; status: DemoDeliveryStatus; address: string; district: string;
  feeCents: number; etaMin: number; createdAt: string;
  courier: { id: string; name: string } | null;
};
type DemoReview = { id: string; rating: number; body: string; createdAt: string; author: string; status: 'pending' | 'published' | 'hidden' };
type DemoQueueTicket = {
  id: string; placeId: string; clientUserId: string; day: string; number: number;
  status: 'waiting' | 'called' | 'serving' | 'done' | 'cancelled' | 'no_show';
  note: string; createdAt: string; calledAt: string | null; closedAt: string | null;
  clientName: string;
};
type DemoQueueSettings = { placeId: string; isActive: boolean; avgMinutes: number; notice: string };
type DemoLoyaltyProgram = { placeId: string; isActive: boolean; goal: number; rewardTitle: string; rewardNote: string };
type DemoLoyaltyCard = {
  placeId: string; userId: string; clientName: string; stamps: number; totalVisits: number;
  rewardsAvailable: number; lastStampAt: string;
};
type DemoBooking = {
  id: string; status: 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'expired';
  clientUserId?: string;
  note: string; price: Money; createdAt: string;
  cash?: { client: boolean; provider: boolean };
  slot: { id: string; startsAt: string; endsAt: string };
  offer: { id: string; title: string; durationMin: number };
  place: { id: string; name: string; address: string; district: string };
  review: { id: string; rating: number; status: 'pending' | 'published' | 'hidden' } | null;
};

type DemoWaitlist = {
  id: string; userId: string; offerId: string; preferredDate: string | null;
  status: 'waiting' | 'notified' | 'converted' | 'cancelled';
  createdAt: string; notifiedAt: string | null;
};

type DemoChatThread = {
  id: string; kind: 'booking' | 'shop_order' | 'trip' | 'service_request'; subjectId: string;
  clientId: string; partnerId: string | null; providerId: string | null;
  status: 'open' | 'closed'; createdAt: string; lastMessageAt: string | null;
};
type DemoChatMessage = {
  id: string; threadId: string; userId: string; senderName: string; body: string;
  quickReply: string | null; status: 'visible' | 'hidden'; createdAt: string;
};
type DemoChatReport = {
  id: string; messageId: string; reporterId: string; reason: string;
  status: 'open' | 'resolved'; createdAt: string;
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
const getBookings = (): DemoBooking[] => read<DemoBooking[]>(BOOKINGS_KEY, []).map(item => ({ ...item, cash: item.cash ?? { client: false, provider: false } }));
const saveBookings = (items: DemoBooking[]) => write(BOOKINGS_KEY, items);
const defaultQueueSettings: DemoQueueSettings[] = [
  { placeId: 'forma', isActive: true, avgMinutes: 12, notice: 'Сегодня работают два мастера' },
  { placeId: 'tihiy-chas', isActive: true, avgMinutes: 15, notice: 'Массаж по записи и живой очереди' },
  { placeId: '2gis-70000001118751203', isActive: true, avgMinutes: 18, notice: 'Свободные мастера сегодня' },
];
const getQueueSettings = (): DemoQueueSettings[] =>
  read<DemoQueueSettings[] | null>(QUEUE_SETTINGS_KEY, null) ?? defaultQueueSettings;
const saveQueueSettings = (items: DemoQueueSettings[]) => write(QUEUE_SETTINGS_KEY, items);
const getQueueTickets = (): DemoQueueTicket[] => read<DemoQueueTicket[]>(QUEUE_TICKETS_KEY, []);
const saveQueueTickets = (items: DemoQueueTicket[]) => write(QUEUE_TICKETS_KEY, items);
const defaultLoyaltyPrograms: DemoLoyaltyProgram[] = [
  { placeId: 'forma', isActive: true, goal: 3, rewardTitle: 'Стрижка со скидкой 20%', rewardNote: 'Покажите награду администратору' },
];
const getLoyaltyPrograms = (): DemoLoyaltyProgram[] =>
  read<DemoLoyaltyProgram[] | null>(LOYALTY_PROGRAMS_KEY, null) ?? defaultLoyaltyPrograms;
const saveLoyaltyPrograms = (items: DemoLoyaltyProgram[]) => write(LOYALTY_PROGRAMS_KEY, items);
const getLoyaltyCards = (): DemoLoyaltyCard[] => read<DemoLoyaltyCard[]>(LOYALTY_CARDS_KEY, []);
const saveLoyaltyCards = (items: DemoLoyaltyCard[]) => write(LOYALTY_CARDS_KEY, items);
const getLoyaltyEvents = (): string[] => read<string[]>(LOYALTY_EVENTS_KEY, []);
const saveLoyaltyEvents = (items: string[]) => write(LOYALTY_EVENTS_KEY, items);
const getWaitlist = (): DemoWaitlist[] => read<DemoWaitlist[]>(WAITLIST_KEY, []);
const saveWaitlist = (items: DemoWaitlist[]) => write(WAITLIST_KEY, items);

function demoDateInZone(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function waitlistView(entry: DemoWaitlist) {
  const offer = offerById(entry.offerId);
  const place = offer ? placeById(offer.placeId) : null;
  if (!offer || !place) return null;
  return {
    id: entry.id,
    status: entry.status,
    preferredDate: entry.preferredDate,
    createdAt: entry.createdAt,
    notifiedAt: entry.notifiedAt,
    offer: {
      id: offer.id, title: offer.title, durationMin: offer.durationMin,
      price: money(offer.price),
    },
    place: {
      id: place.id, name: place.name, address: place.address, district: place.district,
      image: place.image ?? null,
    },
  };
}

const getChatThreads = (): DemoChatThread[] => read<DemoChatThread[]>(CHAT_THREADS_KEY, []);
const saveChatThreads = (items: DemoChatThread[]) => write(CHAT_THREADS_KEY, items);
const getChatMessages = (): DemoChatMessage[] => read<DemoChatMessage[]>(CHAT_MESSAGES_KEY, []);
const saveChatMessages = (items: DemoChatMessage[]) => write(CHAT_MESSAGES_KEY, items);
const getChatReads = (): { threadId: string; userId: string; lastReadAt: string }[] => read(CHAT_READS_KEY, []);
const saveChatReads = (items: { threadId: string; userId: string; lastReadAt: string }[]) => write(CHAT_READS_KEY, items);
const getChatReports = (): DemoChatReport[] => read<DemoChatReport[]>(CHAT_REPORTS_KEY, []);
const saveChatReports = (items: DemoChatReport[]) => write(CHAT_REPORTS_KEY, items);

function demoChatSubject(kind: DemoChatThread['kind'], subjectId: string) {
  if (kind === 'booking') {
    const booking = getBookings().find(item => item.id === subjectId);
    if (!booking) return null;
    const place = placeById(booking.place.id);
    return {
      clientId: booking.clientUserId ?? 'u-000001', partnerId: place?.partnerId ?? null, providerId: null,
      title: `${booking.place.name} · ${booking.offer.title}`, subtitle: 'Запись',
    };
  }
  if (kind === 'shop_order') {
    const order = getShopOrders().find(item => item.id === subjectId);
    if (!order) return null;
    const place = placeById(order.place.id);
    return {
      clientId: order.client.id, partnerId: place?.partnerId ?? null, providerId: null,
      title: order.place.name, subtitle: `Заказ · код ${order.pickupCode}`,
    };
  }
  if (kind === 'trip') {
    const trip = getTrips().find(item => item.id === subjectId);
    if (!trip) return null;
    return {
      clientId: trip.client.id, partnerId: null, providerId: trip.driver?.id ?? null,
      title: `${trip.from.label} → ${trip.to.label}`, subtitle: 'Поездка',
    };
  }
  const request = getServices().find(item => item.id === subjectId);
  if (!request) return null;
  return {
    clientId: request.client.id, partnerId: request.partner?.id ?? null, providerId: null,
    title: request.title, subtitle: request.address,
  };
}

function demoChatAccess(thread: DemoChatThread, me: DemoMe) {
  if (me.user.id === thread.clientId) return 'client';
  if (thread.providerId === me.user.id) return 'provider';
  if (thread.partnerId && me.partnerIds.includes(thread.partnerId)) return 'provider';
  if (me.roles.some(role => role.role === 'operator')) return 'operator';
  return null;
}

function demoChatThreadView(thread: DemoChatThread, me: DemoMe) {
  const subject = demoChatSubject(thread.kind, thread.subjectId);
  const role = demoChatAccess(thread, me);
  if (!subject || !role) return null;
  const last = getChatMessages().filter(item => item.threadId === thread.id
    && item.status === 'visible').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const read = getChatReads().find(item => item.threadId === thread.id && item.userId === me.user.id);
  const since = read?.lastReadAt ?? '';
  const unread = getChatMessages().filter(item => item.threadId === thread.id
    && item.status === 'visible' && item.userId !== me.user.id && item.createdAt > since).length;
  return {
    id: thread.id, kind: thread.kind, subjectId: thread.subjectId,
    title: subject.title, subtitle: subject.subtitle, status: thread.status, role, unread,
    lastMessageAt: thread.lastMessageAt,
    lastMessage: last ? {
      id: last.id, body: last.body, quickReply: last.quickReply, status: last.status,
      createdAt: last.createdAt, mine: last.userId === me.user.id,
      sender: { id: last.userId, name: last.senderName },
    } : null,
    client: { id: subject.clientId, name: thread.clientId === me.user.id ? me.user.displayName : 'Клиент' },
    provider: { id: subject.providerId ?? subject.partnerId, name: subject.partnerId ? demoNames[subject.partnerId] ?? 'Исполнитель' : 'Водитель' },
    createdAt: thread.createdAt,
  };
}

function demoChatMessageView(message: DemoChatMessage, me: DemoMe) {
  return {
    id: message.id, body: message.status === 'hidden' ? 'Сообщение скрыто модератором' : message.body,
    quickReply: message.quickReply, status: message.status, createdAt: message.createdAt,
    mine: message.userId === me.user.id,
    sender: { id: message.userId, name: message.senderName },
  };
}

function notifyDemoWaitlist(booking: DemoBooking) {
  const offer = offerById(booking.offer.id);
  const place = offer ? placeById(offer.placeId) : null;
  if (!place) return;
  const wantedDate = demoDateInZone(booking.slot.startsAt, place.timezone ?? 'Europe/Moscow');
  const entries = getWaitlist();
  let changed = false;
  for (const entry of entries) {
    if (entry.offerId !== booking.offer.id || entry.status !== 'waiting') continue;
    if (entry.userId === (booking.clientUserId ?? 'u-000001')) continue;
    if (entry.preferredDate && entry.preferredDate !== wantedDate) continue;
    entry.status = 'notified';
    entry.notifiedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) saveWaitlist(entries);
}
function loyaltyState(card: DemoLoyaltyCard) {
  return { stamps: card.stamps, rewardsAvailable: card.rewardsAvailable, totalVisits: card.totalVisits, lastStampAt: card.lastStampAt };
}
function awardDemoLoyalty(placeId: string, userId: string, clientName: string, source: string, sourceId: string) {
  const program = getLoyaltyPrograms().find(item => item.placeId === placeId && item.isActive);
  if (!program) return;
  const events = getLoyaltyEvents();
  const key = `${source}:${sourceId}`;
  if (events.includes(key)) return;
  saveLoyaltyEvents([key, ...events].slice(0, 300));
  const cards = getLoyaltyCards();
  let card = cards.find(item => item.placeId === placeId && item.userId === userId);
  if (!card) {
    card = { placeId, userId, clientName, stamps: 0, totalVisits: 0, rewardsAvailable: 0, lastStampAt: '' };
    cards.push(card);
  }
  card.stamps += 1;
  card.totalVisits += 1;
  card.lastStampAt = new Date().toISOString();
  if (card.stamps >= program.goal) {
    card.stamps = 0;
    card.rewardsAvailable += 1;
  }
  saveLoyaltyCards(cards);
}
const getFavorites = (): string[] => read<string[]>(FAVORITES_KEY, []);
const saveFavorites = (items: string[]) => write(FAVORITES_KEY, items);
const queueDay = () => new Date().toISOString().slice(0, 10);
function queueTicketView(ticket: DemoQueueTicket) {
  const place = placeById(ticket.placeId);
  return {
    id: ticket.id, number: ticket.number, status: ticket.status, note: ticket.note,
    day: ticket.day, createdAt: ticket.createdAt, calledAt: ticket.calledAt, closedAt: ticket.closedAt,
    place: { id: ticket.placeId, name: place?.name ?? 'Точка', address: place?.address ?? '', district: place?.district ?? '' },
  };
}
function queueSnapshot(placeId: string, me: DemoMe | null) {
  const place = placeById(placeId);
  if (!place) return null;
  const settings = getQueueSettings().find(item => item.placeId === placeId);
  const today = getQueueTickets().filter(item => item.placeId === placeId && item.day === queueDay());
  const active = today.filter(item => ['waiting', 'called', 'serving'].includes(item.status));
  const mine = active.find(item => me && item.clientUserId === me.user.id) ?? null;
  const waiting = today.filter(item => item.status === 'waiting');
  return {
    active: Boolean(settings?.isActive),
    avgMinutes: settings?.avgMinutes ?? null,
    notice: settings?.notice ?? '',
    waiting: waiting.length,
    called: today.filter(item => item.status === 'called').length,
    serving: today.filter(item => item.status === 'serving').length,
    nextNumber: waiting[0]?.number ?? null,
    currentNumber: today.find(item => ['called', 'serving'].includes(item.status))?.number ?? null,
    myTicket: mine ? queueTicketView(mine) : null,
    position: mine?.status === 'waiting' ? waiting.filter(item => item.number < mine.number).length + 1 : null,
    place: { id: place.id, name: place.name, address: place.address, district: place.district },
  };
}
function queueError(message: string, code: string) { return fail(message, code); }
const getTrips = () => read<DemoTrip[]>(TRIPS_KEY, []);
const saveTrips = (items: DemoTrip[]) => write(TRIPS_KEY, items);
const TRIP_ACTIVE: DemoTripStatus[] = ['requested', 'assigned', 'arrived', 'in_progress'];
const defaultProducts: DemoShopProduct[] = [
  { id: 'sp-spray', placeId: 'forma', title: 'Стайлинг-спрей', description: 'Лёгкая фиксация, 150 мл', price: { cents: 120000, currency: 'RUB' }, stockQty: 8, unit: 'шт', isActive: true },
  { id: 'sp-comb', placeId: 'forma', title: 'Гребень', description: 'Для укладки', price: { cents: 60000, currency: 'RUB' }, stockQty: 12, unit: 'шт', isActive: true },
  { id: 'sp-lunch', placeId: 'kuhnya', title: 'Обед дня', description: 'Суп, горячее и напиток', price: { cents: 45000, currency: 'RUB' }, stockQty: 12, unit: 'порция', isActive: true },
  { id: 'sp-soup', placeId: 'kuhnya', title: 'Суп куриный', description: 'С домашней лапшой', price: { cents: 22000, currency: 'RUB' }, stockQty: 8, unit: 'порция', isActive: true },
  { id: 'sp-drink', placeId: 'kuhnya', title: 'Компот', description: 'Из ягод, без сахара', price: { cents: 8000, currency: 'RUB' }, stockQty: 15, unit: 'стакан', isActive: true },
  { id: 'sp-cream', placeId: 'ugol', title: 'Крем для обуви', description: 'Нейтральный, 50 мл', price: { cents: 35000, currency: 'RUB' }, stockQty: 6, unit: 'шт', isActive: true },
];
const getProducts = (): DemoShopProduct[] => {
  const saved = read<DemoShopProduct[] | null>(PRODUCTS_KEY, null);
  if (saved) return saved;
  write(PRODUCTS_KEY, defaultProducts);
  return defaultProducts;
};
const saveProducts = (items: DemoShopProduct[]) => write(PRODUCTS_KEY, items);
const getShopOrders = () => read<DemoShopOrder[]>(SHOP_ORDERS_KEY, []);
const saveShopOrders = (items: DemoShopOrder[]) => write(SHOP_ORDERS_KEY, items);
const defaultZones: DemoDeliveryZone[] = ['kuhnya', 'ugol', 'forma'].flatMap((placeId, placeIndex) => [
  { id: `dz-${placeId}-1`, placeId, district: 'Центр', feeCents: 9900 + placeIndex * 5000, minOrderCents: 30000, etaMin: 40, isActive: true },
  { id: `dz-${placeId}-2`, placeId, district: 'Северный', feeCents: 12900 + placeIndex * 5000, minOrderCents: 30000, etaMin: 45, isActive: true },
  { id: `dz-${placeId}-3`, placeId, district: 'Заречный', feeCents: 14900 + placeIndex * 5000, minOrderCents: 40000, etaMin: 50, isActive: true },
  { id: `dz-${placeId}-4`, placeId, district: 'Южный', feeCents: 14900 + placeIndex * 5000, minOrderCents: 40000, etaMin: 50, isActive: true },
]);
const getZones = (): DemoDeliveryZone[] => read<DemoDeliveryZone[] | null>(DELIVERY_ZONES_KEY, null) ?? defaultZones;
const saveZones = (items: DemoDeliveryZone[]) => write(DELIVERY_ZONES_KEY, items);
const getJobs = () => read<DemoDeliveryJob[]>(DELIVERY_JOBS_KEY, []);
const saveJobs = (items: DemoDeliveryJob[]) => write(DELIVERY_JOBS_KEY, items);

function orderView(order: DemoShopOrder) {
  const job = getJobs().find(item => item.orderId === order.id);
  const goods = order.goods ?? money(order.total.cents - (order.deliveryFee?.cents ?? 0));
  const fee = order.deliveryFee ?? money(0);
  return {
    ...order, goods, deliveryFee: fee, fulfillment: order.fulfillment ?? 'pickup',
    cash: order.cash ?? { client: false, provider: false },
    delivery: job ? {
      id: job.id, status: job.status, address: job.address, district: job.district,
      fee: money(job.feeCents), etaMin: job.etaMin, courier: job.courier,
    } : null,
  };
}

function jobView(job: DemoDeliveryJob) {
  const order = getShopOrders().find(item => item.id === job.orderId);
  const place = order ? placeById(order.place.id) : null;
  return {
    id: job.id, orderId: job.orderId, status: job.status, address: job.address, district: job.district,
    fee: money(job.feeCents), etaMin: job.etaMin, createdAt: job.createdAt, courier: job.courier,
    order: {
      id: job.orderId, status: order?.status ?? 'cancelled', pickupCode: order?.pickupCode ?? '',
      total: order?.total ?? money(0), client: order?.client ?? { id: '', name: '' },
      place: { id: place?.id ?? '', name: place?.name ?? 'Точка', address: place?.address ?? '' },
    },
  };
}
const SERVICE_ACTIVE = ['open', 'assigned', 'in_progress', 'awaiting_cash'];
const demoNames: Record<string, string> = { p1: 'Студия «Форма»', p2: 'Мастерская «Линия»' };
const getServices = () => read<DemoServiceRequest[]>(SERVICE_KEY, []);
const saveServices = (items: DemoServiceRequest[]) => write(SERVICE_KEY, items);

function tripQuote(from: DemoTripPoint, to: DemoTripPoint) {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(to.lat - from.lat);
  const dLng = rad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  const straight = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  const distanceKm = Math.max(0.3, Math.round(straight * 1.35 * 10) / 10);
  const durationMin = Math.max(4, Math.round(distanceKm / 24 * 60 + 3));
  return { distanceKm, durationMin };
}

const placeById = (id: string) => places.find(item => item.id === id);
const offerById = (id: string) => offers.find(item => item.id === id);
const money = (cents: number): Money => ({ cents, currency: 'RUB' });

function placeReviews(): { id: string; placeId: string; rating: number; body: string; author: string; createdAt: string }[] {
  try { return JSON.parse(localStorage.getItem(PLACE_REVIEWS_KEY) || '[]'); } catch { return []; }
}

function reviewsFor(placeId: string, bookings: DemoBooking[] = getBookings(), includePending = false): DemoReview[] {
  const seeded = (seedReviews[placeId] ?? []).map((review, index) => ({
    id: `seed-${placeId}-${index}`, source: 'own' as const, rating: review.rating, body: review.body,
    author: review.author, createdAt: new Date(Date.now() - review.daysAgo * DAY).toISOString(),
    status: 'published' as const,
  }));
  const added = placeReviews().filter(review => review.placeId === placeId).map(review => ({
    id: review.id, source: 'own' as const, rating: review.rating, body: review.body,
    author: review.author, createdAt: review.createdAt, status: 'published' as const,
  }));
  const mine = bookings
    .filter(item => item.place.id === placeId && item.review)
    .map(item => ({ id: item.review!.id, source: 'own' as const, rating: item.review!.rating, body: 'Спасибо, всё понравилось.',
      author: getMe()?.user.displayName ?? 'Клиент', createdAt: item.createdAt, status: item.review!.status }));
  return [...mine, ...added, ...seeded].filter(review => includePending || review.status === 'published');
}

function activeOffers(placeId: string) {
  return offers.filter(item => item.placeId === placeId && (item as { isActive?: boolean }).isActive !== false);
}

function demoHoursFor(place: DemoPlace): DemoDayHours[] {
  return Array.from({ length: 7 }, (_, weekday) => {
    const found = place.hours?.find(day => day.weekday === weekday);
    return found ? { ...found, present: true, intervals: found.intervals.map(interval => ({ ...interval })) }
      : { weekday, isClosed: true, is24h: false, intervals: [], present: false };
  });
}

function demoOpenNow(place: DemoPlace): DemoOpenNow {
  if (!place.hours?.length) return { state: 'unknown', label: null, opensAt: null, closesAt: null, weekday: null };
  const days = demoHoursFor(place).map(day => ({ ...day, present: true }));
  return openStateFromDays(days, place.timezone ?? 'Asia/Irkutsk');
}

function card(place: DemoPlace, bookings = getBookings()) {
  const list = activeOffers(place.id);
  const reviews = reviewsFor(place.id, bookings);
  const ownRating = reviews.length ? reviews.reduce((sum, item) => sum + item.rating, 0) / reviews.length : null;
  const photos = place.source
    ? (place.image ? [{ small: place.image, large: place.image, full: place.image, author: null }] : [])
    : [0, 1, 2].map(index => ({
      small: `https://picsum.photos/seed/rjadom-${place.id}-${index}/328/170`,
      large: `https://picsum.photos/seed/rjadom-${place.id}-${index}/656/340`,
      full: `https://picsum.photos/seed/rjadom-${place.id}-${index}/1200/800`,
      author: null,
    }));
  const rating = ownRating ?? place.source?.rating ?? null;
  return {
    id: place.id, name: place.name, category: place.category as Category, district: place.district,
    address: place.address, about: place.about, location: { lat: place.lat, lng: place.lng },
    city: place.city ?? 'demograd',
    image: place.image ?? photos[0]?.small ?? null,
    photos,
    rating: rating === null ? null : Math.round(rating * 10) / 10,
    ratingCount: reviews.length || place.source?.ratingCount || 0,
    source: place.source ?? null,
    priceFrom: list.length ? money(Math.min(...list.map(item => item.price))) : null,
    offerCount: list.length, distanceKm: null,
    openNow: demoOpenNow(place),
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
  const allowed = new Set<string>(places.filter(place => place.partnerId && place.partnerId !== null && me.partnerIds.includes(place.partnerId)).map(place => place.id));
  return getBookings().filter(item => allowed.has(item.place.id));
}

const READ_KEY = 'rjadom.demo.read';

function partnerPlaceView(place: DemoPlace) {
  return {
    id: place.id, name: place.name, category: place.category as Category, district: place.district,
    address: place.address, about: place.about, phone: place.phone,
    location: { lat: place.lat, lng: place.lng },
    isPublished: (place as { isPublished?: boolean }).isPublished !== false,
    updatedAt: new Date().toISOString(),
    products: getProducts().filter(item => item.placeId === place.id),
    zones: getZones().filter(item => item.placeId === place.id).map(item => ({
      id: item.id, district: item.district, fee: money(item.feeCents), minOrder: money(item.minOrderCents),
      etaMin: item.etaMin, isActive: item.isActive,
    })),
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
  const waitlistItems = getWaitlist()
    .filter(entry => entry.status === 'notified' && entry.userId === me.user.id)
    .slice(0, 20)
    .map((entry, index) => {
      const view = waitlistView(entry);
      const id = 5000 + index;
      return {
        id, kind: 'booking_waitlist_open',
        payload: {
          waitlistId: entry.id, offerId: entry.offerId, place: view?.place.name,
          title: view?.offer.title, message: `${view?.place.name ?? 'Заведение'} · ${view?.offer.title ?? 'услуга'}: освободилось время`,
        },
        channel: 'inapp', created_at: entry.notifiedAt ?? entry.createdAt,
        read_at: readIds.includes(id) ? new Date().toISOString() : null,
        delivered_at: null, last_error: null,
      };
    });
  return [...items, ...waitlistItems].sort((a, b) => b.created_at.localeCompare(a.created_at));
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
    clientUserId: 'u-000001',
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

  if (url.pathname === '/api/v1/cities') {
    return { items: [
      { slug: 'slyudyanka', name: 'Слюдянский район', region: 'Иркутская область',
        center: { lat: 51.6597, lng: 103.7068 }, places: places.filter(place => place.city === 'slyudyanka').length },
      { slug: 'demograd', name: 'Демоград', region: 'Демо-регион',
        center: { lat: 55.7558, lng: 37.6173 }, places: demoPlaces.length },
    ] } as T;
  }

  if (url.pathname === '/api/v1/districts') {
    return { items: [...new Set(places.map(place => place.district))] } as T;
  }

  if (url.pathname === '/api/v1/places') {
    const city = url.searchParams.get('city');
    const category = url.searchParams.get('category');
    const district = url.searchParams.get('district');
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const onlyOpen = ['1', 'true'].includes(url.searchParams.get('openNow') ?? '');
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const all = places
      .filter(place => !city || place.city === city)
      .filter(place => (!category || place.category === category) && (!district || place.district === district))
      .filter(place => !q || place.name.toLowerCase().includes(q) || place.about.toLowerCase().includes(q))
      .filter(place => !onlyOpen || demoOpenNow(place).state === 'open');
    return { items: all.slice(offset, offset + limit).map(place => card(place)),
      total: all.length, limit, offset } as T;
  }

  if (url.pathname === '/api/v1/places/map') {
    const city = url.searchParams.get('city');
    const onlyOpen = ['1', 'true'].includes(url.searchParams.get('openNow') ?? '');
    const items = places
      .filter(place => !city || place.city === city)
      .filter(place => !onlyOpen || demoOpenNow(place).state === 'open')
      .map(place => card(place));
    return { items, total: items.length } as T;
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
    return { place: { ...base, phone: place.phone, bookable: true,
      timezone: place.timezone ?? 'Asia/Irkutsk', hours: demoHoursFor(place), openNow: demoOpenNow(place) }, offers: list,
      products: getProducts().filter(item => item.placeId === place.id && item.isActive),
      delivery: { available: getZones().some(item => item.placeId === place.id && item.isActive),
        zones: getZones().filter(item => item.placeId === place.id && item.isActive).map(item => ({
          id: item.id, district: item.district, fee: money(item.feeCents), minOrder: money(item.minOrderCents),
          etaMin: item.etaMin, isActive: item.isActive,
        })) },
      reviews: reviewsFor(place.id, bookings) } as T;
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
      const courier = digits.endsWith('79000000005');
      const roles: DemoRole[] = [];
      if (partner) roles.push({ role: 'partner', partner_id: 'p1' });
      if (operator) roles.push({ role: 'operator', partner_id: null });
      if (driver) roles.push({ role: 'driver', partner_id: null });
      if (courier) roles.push({ role: 'courier', partner_id: null });
      roles.push({ role: 'client', partner_id: null });
      me = {
        user: { id: `u-${digits.slice(-6)}`, phone: `+${digits}`, displayName: String(body.displayName || '').trim() || (partner ? 'Партнёр Демо' : operator ? 'Оператор Демо' : driver ? 'Водитель Демо' : courier ? 'Курьер Демо' : 'Клиент Демо') },
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

  if (url.pathname === '/api/v1/queues') {
    const city = url.searchParams.get('city');
    const items = getQueueSettings().filter(setting => setting.isActive).map(setting => {
      const place = placeById(setting.placeId);
      if (!place || (city && place.city !== city)) return null;
      const today = getQueueTickets().filter(ticket => ticket.placeId === setting.placeId && ticket.day === queueDay());
      return {
        place: { id: place.id, name: place.name, category: place.category, district: place.district, address: place.address, image: place.image ?? null },
        waiting: today.filter(ticket => ticket.status === 'waiting').length,
        currentNumber: today.find(ticket => ['called', 'serving'].includes(ticket.status))?.number ?? null,
        avgMinutes: setting.avgMinutes, notice: setting.notice,
      };
    }).filter(Boolean);
    return { items } as T;
  }

  const placeQueueMatch = url.pathname.match(/^\/api\/v1\/places\/([^/]+)\/queue$/);
  if (placeQueueMatch) {
    const place = placeById(placeQueueMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    const me = getMe();
    if (method === 'GET') return queueSnapshot(place.id, me) as T;
    if (method === 'POST') {
      if (!me) return fail('Требуется вход', 'unauthorized');
      const settings = getQueueSettings().find(item => item.placeId === place.id);
      if (!settings?.isActive) return fail('Очередь сейчас закрыта', 'queue_closed');
      const tickets = getQueueTickets();
      const active = tickets.find(ticket => ticket.placeId === place.id && ticket.clientUserId === me.user.id
        && ['waiting', 'called', 'serving'].includes(ticket.status));
      if (active) return queueSnapshot(place.id, me) as T;
      const today = tickets.filter(ticket => ticket.placeId === place.id && ticket.day === queueDay());
      const number = Math.max(0, ...today.map(ticket => ticket.number)) + 1;
      tickets.push({
        id: `q-${Date.now()}`, placeId: place.id, clientUserId: me.user.id, day: queueDay(), number,
        status: 'waiting', note: String(body.note ?? '').slice(0, 200), createdAt: new Date().toISOString(),
        calledAt: null, closedAt: null, clientName: me.user.displayName,
      });
      saveQueueTickets(tickets);
      return queueSnapshot(place.id, me) as T;
    }
  }

  const queueCancelMatch = url.pathname.match(/^\/api\/v1\/queue\/([^/]+)\/cancel$/);
  if (queueCancelMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const tickets = getQueueTickets();
    const ticket = tickets.find(item => item.id === queueCancelMatch[1]);
    if (!ticket) return fail('Талон не найден', 'not_found');
    if (ticket.clientUserId !== me.user.id) return fail('Это не ваш талон', 'forbidden');
    if (ticket.status !== 'waiting') return fail('Талон уже нельзя отменить', 'invalid_transition');
    ticket.status = 'cancelled';
    ticket.closedAt = new Date().toISOString();
    saveQueueTickets(tickets);
    return queueTicketView(ticket) as T;
  }

  const loyaltyPlaceMatch = url.pathname.match(/^\/api\/v1\/places\/([^/]+)\/loyalty$/);
  if (loyaltyPlaceMatch) {
    const place = placeById(loyaltyPlaceMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    const program = getLoyaltyPrograms().find(item => item.placeId === place.id && item.isActive);
    if (!program) return { active: false } as T;
    const me = getMe();
    const card = me ? getLoyaltyCards().find(item => item.placeId === place.id && item.userId === me.user.id) : null;
    return { active: true, goal: program.goal, rewardTitle: program.rewardTitle, rewardNote: program.rewardNote,
      card: card ? loyaltyState(card) : null } as T;
  }

  if (url.pathname === '/api/v1/me/loyalty') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const programs = getLoyaltyPrograms();
    const items = getLoyaltyCards().filter(card => card.userId === me.user.id).map(card => {
      const program = programs.find(item => item.placeId === card.placeId && item.isActive);
      const place = placeById(card.placeId);
      if (!program || !place) return null;
      return { place: { id: place.id, name: place.name, category: place.category, district: place.district,
        address: place.address, image: place.image ?? null },
        goal: program.goal, rewardTitle: program.rewardTitle, rewardNote: program.rewardNote, card: loyaltyState(card) };
    }).filter(Boolean);
    return { items } as T;
  }

  const partnerHoursMatch = url.pathname.match(/^\/api\/v1\/partner\/places\/([^/]+)\/hours$/);
  if (partnerHoursMatch) {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const place = placeById(partnerHoursMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    if (!me.roles.some(role => role.role === 'operator') && (!place.partnerId || !me.partnerIds.includes(place.partnerId))) {
      return fail('Это не ваша карточка', 'forbidden');
    }
    if (method === 'GET') {
      const days = demoHoursFor(place);
      return { timezone: place.timezone ?? 'Asia/Irkutsk', days, openNow: demoOpenNow(place) } as T;
    }
    if (method === 'PUT') {
      const days = validateSchedule(body.days);
      if (!days) return fail('Проверьте дни и интервалы работы', 'invalid_schedule');
      place.hours = days;
      const normalized = demoHoursFor(place);
      return { timezone: place.timezone ?? 'Asia/Irkutsk', days: normalized, openNow: demoOpenNow(place), saved: true } as T;
    }
  }

  const partnerLoyaltyMatch = url.pathname.match(/^\/api\/v1\/partner\/places\/([^/]+)\/loyalty$/);
  if (partnerLoyaltyMatch) {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const place = placeById(partnerLoyaltyMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    if (!me.roles.some(role => role.role === 'operator') && (!place.partnerId || !me.partnerIds.includes(place.partnerId))) {
      return fail('Это не ваша карточка', 'forbidden');
    }
    if (method === 'GET') {
      const program = getLoyaltyPrograms().find(item => item.placeId === place.id)
        ?? { placeId: place.id, isActive: false, goal: 5, rewardTitle: 'Подарок', rewardNote: '' };
      return { settings: { isActive: program.isActive, goal: program.goal, rewardTitle: program.rewardTitle, rewardNote: program.rewardNote },
        cards: getLoyaltyCards().filter(card => card.placeId === place.id)
          .sort((a, b) => b.rewardsAvailable - a.rewardsAvailable || (b.lastStampAt || '').localeCompare(a.lastStampAt || ''))
          .map(card => ({ client: { id: card.userId, name: card.clientName }, ...loyaltyState(card) })) } as T;
    }
    if (method === 'PUT') {
      const all = getLoyaltyPrograms();
      const index = all.findIndex(item => item.placeId === place.id);
      const previous = all[index] ?? { placeId: place.id, isActive: false, goal: 5, rewardTitle: 'Подарок', rewardNote: '' };
      const next = { ...previous,
        isActive: body.isActive === undefined ? previous.isActive : Boolean(body.isActive),
        goal: body.goal === undefined ? previous.goal : Math.max(1, Math.min(50, Number(body.goal) || 5)),
        rewardTitle: body.rewardTitle === undefined ? previous.rewardTitle : String(body.rewardTitle).slice(0, 120),
        rewardNote: body.rewardNote === undefined ? previous.rewardNote : String(body.rewardNote).slice(0, 300) };
      if (index >= 0) all[index] = next; else all.push(next);
      saveLoyaltyPrograms(all);
      return { isActive: next.isActive, goal: next.goal, rewardTitle: next.rewardTitle, rewardNote: next.rewardNote } as T;
    }
  }

  const partnerLoyaltyRedeemMatch = url.pathname.match(/^\/api\/v1\/partner\/places\/([^/]+)\/loyalty\/redeem$/);
  if (partnerLoyaltyRedeemMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const place = placeById(partnerLoyaltyRedeemMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    if (!me.roles.some(role => role.role === 'operator') && (!place.partnerId || !me.partnerIds.includes(place.partnerId))) {
      return fail('Это не ваша карточка', 'forbidden');
    }
    const cards = getLoyaltyCards();
    const card = cards.find(item => item.placeId === place.id && item.userId === String(body.userId));
    if (!card) return fail('Карта не найдена', 'loyalty_card_not_found');
    if (card.rewardsAvailable < 1) return fail('Нет доступной награды', 'reward_not_available');
    card.rewardsAvailable -= 1;
    saveLoyaltyCards(cards);
    return { ...loyaltyState(card), redeemed: true } as T;
  }

  if (url.pathname === '/api/v1/me/favorites') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const city = url.searchParams.get('city');
    const items = getFavorites().map(id => placeById(id)).filter((place): place is DemoPlace => Boolean(place))
      .filter(place => !city || place.city === city)
      .map(place => ({ ...card(place), isFavorite: true }));
    return { items } as T;
  }

  const meFavoriteMatch = url.pathname.match(/^\/api\/v1\/me\/favorites\/([^/]+)$/);
  if (meFavoriteMatch && (method === 'POST' || method === 'DELETE')) {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const place = placeById(meFavoriteMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    const items = getFavorites();
    if (method === 'POST') {
      if (!items.includes(place.id)) saveFavorites([place.id, ...items]);
      return { favorite: true, placeId: place.id } as T;
    }
    saveFavorites(items.filter(id => id !== place.id));
    return { favorite: false, placeId: place.id } as T;
  }

  if (url.pathname === '/api/v1/me/queue') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const items = getQueueTickets().filter(ticket => ticket.clientUserId === me.user.id)
      .sort((a, b) => (['waiting', 'called', 'serving'].includes(b.status) ? 1 : 0)
        - (['waiting', 'called', 'serving'].includes(a.status) ? 1 : 0)
        || b.createdAt.localeCompare(a.createdAt));
    return { items: items.map(queueTicketView) } as T;
  }

  if (url.pathname === '/api/v1/me/waitlist') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const items = getWaitlist()
      .filter(entry => entry.userId === me.user.id && (entry.status === 'waiting' || entry.status === 'notified'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(waitlistView)
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return { items } as T;
  }

  const offerWaitlistMatch = url.pathname.match(/^\/api\/v1\/offers\/([^/]+)\/waitlist$/);
  if (offerWaitlistMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const offer = offerById(offerWaitlistMatch[1]);
    if (!offer) return fail('Услуга не найдена', 'not_found');
    const preferredDate = body.date ? String(body.date) : null;
    const entries = getWaitlist();
    const notified = entries.find(entry => entry.userId === me.user.id
      && entry.offerId === offer.id && entry.status === 'notified');
    if (notified) { notified.status = 'cancelled'; notified.notifiedAt = null; }
    const existing = entries.find(entry => entry.userId === me.user.id
      && entry.offerId === offer.id && entry.status === 'waiting');
    if (existing) {
      existing.preferredDate = preferredDate;
    } else {
      entries.unshift({
        id: `w-${Date.now()}`, userId: me.user.id, offerId: offer.id, preferredDate,
        status: 'waiting', createdAt: new Date().toISOString(), notifiedAt: null,
      });
    }
    saveWaitlist(entries);
    const entry = entries.find(item => item.userId === me.user.id
      && item.offerId === offer.id && item.status === 'waiting')!;
    return { entry: waitlistView(entry), place: placeById(offer.placeId)?.name } as T;
  }

  const waitlistDeleteMatch = url.pathname.match(/^\/api\/v1\/me\/waitlist\/([^/]+)$/);
  if (waitlistDeleteMatch && method === 'DELETE') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const entries = getWaitlist();
    const target = entries.find(entry => entry.id === waitlistDeleteMatch[1]
      && entry.userId === me.user.id && (entry.status === 'waiting' || entry.status === 'notified'));
    if (!target) return fail('Заявка не найдена', 'waitlist_not_found');
    target.status = 'cancelled';
    saveWaitlist(entries);
    return { cancelled: true, id: target.id } as T;
  }

  if (url.pathname === '/api/v1/today') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const tasks: {
      id: string; role: string; kind: string; title: string; subtitle: string;
      count: number; priority: number; action: { tab: string; view: string | null };
    }[] = [];
    const add = (role: string, kind: string, title: string, subtitle: string, count: number,
      priority: number, tab: string, view: string | null = null) => {
      if (count) tasks.push({ id: `${role}-${kind}`, role, kind, title, subtitle, count, priority, action: { tab, view } });
    };
    const bookings = getBookings().filter(item => (item.clientUserId ?? 'u-000001') === me.user.id
      && (item.status === 'requested' || item.status === 'confirmed'));
    const cash = bookings.filter(item => item.status === 'confirmed' && item.cash?.provider && !item.cash?.client);
    add('client', 'cash', 'Подтвердить наличные', cash[0]?.place.name ?? 'Ждут подтверждения', cash.length, 4, 'orders', 'bookings');
    add('client', 'bookings', 'Активные записи', bookings[0]?.place.name ?? '', bookings.length, 2, 'orders', 'bookings');
    const shop = getShopOrders().filter(item => item.client.id === me.user.id
      && ['placed', 'confirmed', 'ready', 'out_for_delivery', 'awaiting_cash'].includes(item.status));
    add('client', 'shop', 'Заказы и доставка', shop[0]?.place.name ?? '', shop.length, 2, 'orders', 'shop');
    const trips = getTrips().filter(item => item.client.id === me.user.id
      && TRIP_ACTIVE.includes(item.status));
    add('client', 'trips', 'Поездки', trips[0] ? `${trips[0].from.label} → ${trips[0].to.label}` : '', trips.length, 3, 'taxi');
    const services = getServices().filter(item => item.client.id === me.user.id
      && SERVICE_ACTIVE.includes(item.status));
    add('client', 'service', 'Заявки мастеру', services[0]?.title ?? '', services.length, 2, 'orders', 'requests');
    const tickets = getQueueTickets().filter(item => item.clientUserId === me.user.id
      && ['waiting', 'called', 'serving'].includes(item.status));
    add('client', 'queue', 'Живая очередь', tickets[0] ? `${tickets[0].placeId} · № ${String(tickets[0].number).padStart(2, '0')}` : '',
      tickets.length, 3, 'orders', 'queue');
    const notified = getWaitlist().filter(item => item.userId === me.user.id && item.status === 'notified');
    add('client', 'waitlist', 'Окно освободилось', 'Можно записаться на услугу', notified.length, 4, 'orders', 'bookings');
    const unread = getChatThreads().filter(thread => demoChatAccess(thread, me))
      .reduce((sum, thread) => sum + (demoChatThreadView(thread, me)?.unread ?? 0), 0);
    add('client', 'chat', 'Непрочитанные сообщения', 'Вам написали по заказу', unread, 4, 'orders', 'chat');

    if (me.partnerIds.length) {
      const pBookings = getBookings().filter(item => {
        const place = placeById(item.place.id);
        return place?.partnerId && me.partnerIds.includes(place.partnerId)
          && (item.status === 'requested' || item.status === 'confirmed');
      });
      const pCash = pBookings.filter(item => item.status === 'confirmed' && !item.cash?.provider);
      add('partner', 'bookings', 'Записи клиентов', pBookings[0]?.place.name ?? '', pBookings.length, 3, 'profile');
      add('partner', 'cash', 'Отметить наличные', pCash[0]?.place.name ?? '', pCash.length, 4, 'profile');
      const pShop = getShopOrders().filter(item => {
        const place = placeById(item.place.id);
        return place?.partnerId && me.partnerIds.includes(place.partnerId)
          && ['placed', 'confirmed', 'ready', 'out_for_delivery', 'awaiting_cash'].includes(item.status);
      });
      add('partner', 'shop', 'Заказы', pShop[0]?.place.name ?? '', pShop.length, 3, 'profile');
      const pService = getServices().filter(item => item.partner && me.partnerIds.includes(item.partner.id)
        && SERVICE_ACTIVE.includes(item.status));
      add('partner', 'service', 'Заявки на выезд', pService[0]?.title ?? '', pService.length, 2, 'profile');
      add('partner', 'chat', 'Сообщения клиентов', 'Непрочитанная переписка', unread, 4, 'orders', 'chat');
    }
    if (me.roles.some(role => role.role === 'operator')) {
      add('operator', 'reviews', 'Модерация отзывов', 'Проверьте новые отзывы',
        read<DemoReview[]>(PLACE_REVIEWS_KEY, []).filter(item => item.status === 'pending').length, 3, 'profile');
      add('operator', 'service', 'Открытые заявки', 'Нужен мастер',
        getServices().filter(item => item.status === 'open').length, 2, 'profile');
      add('operator', 'chat-reports', 'Жалобы в чате', 'Проверьте сообщения',
        getChatReports().filter(item => item.status === 'open').length, 3, 'profile');
    }
    tasks.sort((a, b) => b.priority - a.priority);
    return { generatedAt: new Date().toISOString(), roles: me.roles.map(role => role.role), items: tasks } as T;
  }

  if (url.pathname === '/api/v1/chat/threads/resolve' && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const kind = String(body.kind ?? '') as DemoChatThread['kind'];
    const subjectId = String(body.subjectId ?? '');
    const subject = demoChatSubject(kind, subjectId);
    if (!subject) return fail('Заказ не найден', 'chat_subject_not_found');
    if (kind === 'trip' && !subject.providerId) return fail('Чат появится после назначения водителя', 'chat_unavailable');
    if (kind !== 'trip' && !subject.partnerId) return fail('Чат появится после подключения исполнителя', 'chat_unavailable');
    const canOpen = me.user.id === subject.clientId
      || (subject.providerId !== null && me.user.id === subject.providerId)
      || (subject.partnerId !== null && me.partnerIds.includes(subject.partnerId))
      || me.roles.some(role => role.role === 'operator');
    if (!canOpen) return fail('Нет доступа к этому заказу', 'forbidden');
    const threads = getChatThreads();
    let thread = threads.find(item => item.kind === kind && item.subjectId === subjectId);
    if (!thread) {
      thread = {
        id: `ct-${kind}-${subjectId}`, kind, subjectId,
        clientId: subject.clientId, partnerId: subject.partnerId, providerId: subject.providerId,
        status: 'open', createdAt: new Date().toISOString(), lastMessageAt: null,
      };
      threads.unshift(thread);
      saveChatThreads(threads);
    } else if (thread.partnerId !== subject.partnerId || thread.providerId !== subject.providerId) {
      thread.partnerId = subject.partnerId;
      thread.providerId = subject.providerId;
      saveChatThreads(threads);
    }
    return { thread: demoChatThreadView(thread, me) } as T;
  }

  if (url.pathname === '/api/v1/chat/threads') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const items = getChatThreads().filter(thread => demoChatAccess(thread, me))
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
      .map(thread => demoChatThreadView(thread, me))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return { items } as T;
  }

  const chatMessagesMatch = url.pathname.match(/^\/api\/v1\/chat\/threads\/([^/]+)\/messages$/);
  if (chatMessagesMatch) {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const thread = getChatThreads().find(item => item.id === chatMessagesMatch[1]);
    if (!thread || !demoChatAccess(thread, me)) return fail('Нет доступа к переписке', 'forbidden');
    if (method === 'POST') {
      const text = String(body.body ?? '').trim();
      if (!text) return fail('Сообщение пустое', 'empty_message');
      const message: DemoChatMessage = {
        id: `cm-${Date.now()}`, threadId: thread.id, userId: me.user.id, senderName: me.user.displayName,
        body: text.slice(0, 1000), quickReply: body.quickReply ? String(body.quickReply).slice(0, 60) : null,
        status: 'visible', createdAt: new Date().toISOString(),
      };
      saveChatMessages([...getChatMessages(), message]);
      const threads = getChatThreads();
      const target = threads.find(item => item.id === thread.id);
      if (target) target.lastMessageAt = message.createdAt;
      saveChatThreads(threads);
      const reads = getChatReads();
      const mineRead = reads.find(item => item.threadId === thread.id && item.userId === me.user.id);
      if (mineRead) mineRead.lastReadAt = message.createdAt;
      else reads.push({ threadId: thread.id, userId: me.user.id, lastReadAt: message.createdAt });
      saveChatReads(reads);
      return { message: demoChatMessageView(message, me) } as T;
    }
    const items = getChatMessages().filter(item => item.threadId === thread.id
      && (item.status === 'visible' || me.roles.some(role => role.role === 'operator')))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(item => demoChatMessageView(item, me));
    return { thread: demoChatThreadView(thread, me), messages: items } as T;
  }

  const chatReadMatch = url.pathname.match(/^\/api\/v1\/chat\/threads\/([^/]+)\/read$/);
  if (chatReadMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const thread = getChatThreads().find(item => item.id === chatReadMatch[1]);
    if (!thread || !demoChatAccess(thread, me)) return fail('Нет доступа к переписке', 'forbidden');
    const reads = getChatReads();
    const mineRead = reads.find(item => item.threadId === thread.id && item.userId === me.user.id);
    if (mineRead) mineRead.lastReadAt = new Date().toISOString();
    else reads.push({ threadId: thread.id, userId: me.user.id, lastReadAt: new Date().toISOString() });
    saveChatReads(reads);
    return { ok: true } as T;
  }

  const chatReportMatch = url.pathname.match(/^\/api\/v1\/chat\/messages\/([^/]+)\/report$/);
  if (chatReportMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const message = getChatMessages().find(item => item.id === chatReportMatch[1]);
    const thread = message ? getChatThreads().find(item => item.id === message.threadId) : null;
    if (!message || !thread || !demoChatAccess(thread, me)) return fail('Сообщение не найдено', 'not_found');
    const reports = getChatReports();
    if (!reports.some(item => item.messageId === message.id && item.reporterId === me.user.id)) {
      reports.push({
        id: `cr-${Date.now()}`, messageId: message.id, reporterId: me.user.id,
        reason: String(body.reason ?? '').slice(0, 300), status: 'open', createdAt: new Date().toISOString(),
      });
      saveChatReports(reports);
    }
    return { reported: true } as T;
  }

  if (url.pathname === '/api/v1/operator/chat/reports') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const items = getChatReports().filter(item => item.status === 'open').map(report => {
      const message = getChatMessages().find(item => item.id === report.messageId);
      const thread = message ? getChatThreads().find(item => item.id === message.threadId) : null;
      return {
        id: report.id, reason: report.reason, status: report.status, createdAt: report.createdAt,
        reporter: { id: report.reporterId, name: '' },
        thread: thread ? { id: thread.id, kind: thread.kind, subjectId: thread.subjectId } : null,
        message: message ? {
          id: message.id, body: message.body, status: message.status, createdAt: message.createdAt,
          sender: { id: message.userId, name: message.senderName },
        } : null,
      };
    });
    return { items } as T;
  }

  const chatModerateMatch = url.pathname.match(/^\/api\/v1\/operator\/chat\/messages\/([^/]+)\/moderate$/);
  if (chatModerateMatch && method === 'POST') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const messages = getChatMessages();
    const target = messages.find(item => item.id === chatModerateMatch[1]);
    if (!target) return fail('Сообщение не найдено', 'not_found');
    target.status = body.action === 'hide' ? 'hidden' : 'visible';
    saveChatMessages(messages);
    if (target.status === 'hidden') {
      const reports = getChatReports();
      for (const report of reports) {
        if (report.messageId === target.id) report.status = 'resolved';
      }
      saveChatReports(reports);
    }
    return { message: { id: target.id, status: target.status } } as T;
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
      id: `b-${Date.now()}`, status: 'requested', clientUserId: me.user.id,
      note: String(body.note ?? '').slice(0, 200),
      price: money(offer.price), createdAt: new Date().toISOString(),
      slot: { id: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt },
      offer: { id: offer.id, title: offer.title, durationMin: offer.durationMin },
      place: { id: place.id, name: place.name, address: place.address, district: place.district },
      cash: { client: false, provider: false },
      review: null,
    };
    saveBookings([...getBookings(), booking]);
    const waitlist = getWaitlist();
    for (const entry of waitlist) {
      if (entry.userId === me.user.id && entry.offerId === offer.id
        && (entry.status === 'waiting' || entry.status === 'notified')) entry.status = 'converted';
    }
    saveWaitlist(waitlist);
    return booking as T;
  }

  const bookingCashMatch = url.pathname.match(/^\/api\/v1\/bookings\/([^/]+)\/cash$/);
  if (bookingCashMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const items = getBookings();
    const target = items.find(item => item.id === bookingCashMatch[1]);
    if (!target) return fail('Запись не найдена', 'not_found');
    if (target.cash?.client) return target as T;
    if (target.status !== 'confirmed' || !target.cash?.provider) {
      return fail('Исполнитель ещё не подтвердил получение наличных', 'cash_not_ready');
    }
    target.cash = { ...target.cash, client: true };
    target.status = 'completed';
    saveBookings(items);
    awardDemoLoyalty(target.place.id, me.user.id, me.user.displayName, 'booking', target.id);
    return target as T;
  }

  const rescheduleMatch = url.pathname.match(/^\/api\/v1\/bookings\/([^/]+)\/reschedule$/);
  if (rescheduleMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const items = getBookings();
    const target = items.find(item => item.id === rescheduleMatch[1]);
    if (!target) return fail('Запись не найдена', 'not_found');
    const place = placeById(target.place.id);
    const isClient = (target.clientUserId ?? 'u-000001') === me.user.id;
    const isPartner = Boolean(place?.partnerId && me.partnerIds.includes(place.partnerId));
    if (!isClient && !isPartner) return fail('Нет доступа к записи', 'forbidden');
    if (target.status !== 'requested' && target.status !== 'confirmed') {
      return fail('Запись уже в другом состоянии', 'invalid_transition');
    }
    if (target.cash?.provider) return fail('Исполнитель уже подтвердил получение наличных', 'cash_confirmed');
    const slot = slotsFor(target.offer.id).find(item => item.id === String(body.slotId ?? ''));
    if (!slot) return fail('Это время уже заняли', 'slot_taken');
    target.slot = { id: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt };
    saveBookings(items);
    return target as T;
  }

  const actionMatch = url.pathname.match(/^\/api\/v1\/bookings\/([^/]+)\/(cancel|confirm|complete)$/);
  if (actionMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const items = getBookings();
    const target = items.find(item => item.id === actionMatch[1]);
    if (!target) return fail('Запись не найдена', 'not_found');
    const action = actionMatch[2];
    if (action === 'cancel') {
      if (target.cash?.provider) return fail('Исполнитель уже подтвердил получение наличных', 'cash_confirmed');
      target.status = 'cancelled';
      notifyDemoWaitlist(target);
    }
    if (action === 'confirm') target.status = 'confirmed';
    if (action === 'complete') {
      if (target.status !== 'confirmed') return fail('Запись уже в другом состоянии', 'invalid_transition');
      target.cash = { client: false, provider: true };
    }
    saveBookings(items);
    return target as T;
  }

  const partnerQueueMatch = url.pathname.match(/^\/api\/v1\/partner\/places\/([^/]+)\/queue$/);
  if (partnerQueueMatch) {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const place = placeById(partnerQueueMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    if (!me.roles.some(role => role.role === 'operator') && (!place.partnerId || !me.partnerIds.includes(place.partnerId))) {
      return fail('Это не ваша карточка', 'forbidden');
    }
    if (method === 'GET') {
      const settings = getQueueSettings().find(item => item.placeId === place.id)
        ?? { placeId: place.id, isActive: false, avgMinutes: 10, notice: '' };
      const tickets = getQueueTickets().filter(ticket => ticket.placeId === place.id && ticket.day === queueDay())
        .sort((a, b) => a.number - b.number);
      return { settings: { isActive: settings.isActive, avgMinutes: settings.avgMinutes, notice: settings.notice },
        tickets: tickets.map(queueTicketView) } as T;
    }
    if (method === 'PUT') {
      const all = getQueueSettings();
      const index = all.findIndex(item => item.placeId === place.id);
      const previous = all[index] ?? { placeId: place.id, isActive: false, avgMinutes: 10, notice: '' };
      const next = {
        ...previous,
        isActive: body.isActive === undefined ? previous.isActive : Boolean(body.isActive),
        avgMinutes: body.avgMinutes === undefined ? previous.avgMinutes : Math.max(1, Math.min(180, Number(body.avgMinutes) || 10)),
        notice: body.notice === undefined ? previous.notice : String(body.notice).slice(0, 200),
      };
      if (index >= 0) all[index] = next; else all.push(next);
      saveQueueSettings(all);
      return { isActive: next.isActive, avgMinutes: next.avgMinutes, notice: next.notice } as T;
    }
  }

  const partnerQueueNextMatch = url.pathname.match(/^\/api\/v1\/partner\/places\/([^/]+)\/queue\/next$/);
  if (partnerQueueNextMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const place = placeById(partnerQueueNextMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    if (!me.roles.some(role => role.role === 'operator') && (!place.partnerId || !me.partnerIds.includes(place.partnerId))) {
      return fail('Это не ваша карточка', 'forbidden');
    }
    const settings = getQueueSettings().find(item => item.placeId === place.id);
    if (!settings?.isActive) return fail('Очередь сейчас закрыта', 'queue_closed');
    const tickets = getQueueTickets();
    const today = tickets.filter(ticket => ticket.placeId === place.id && ticket.day === queueDay());
    if (today.some(ticket => ['called', 'serving'].includes(ticket.status))) return fail('Сначала завершите текущий талон', 'queue_busy');
    const next = today.filter(ticket => ticket.status === 'waiting').sort((a, b) => a.number - b.number)[0];
    if (!next) return fail('В очереди никого нет', 'queue_empty');
    next.status = 'called';
    next.calledAt = new Date().toISOString();
    saveQueueTickets(tickets);
    return queueTicketView(next) as T;
  }

  const partnerQueueStatusMatch = url.pathname.match(/^\/api\/v1\/partner\/queue\/([^/]+)\/status$/);
  if (partnerQueueStatusMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const tickets = getQueueTickets();
    const ticket = tickets.find(item => item.id === partnerQueueStatusMatch[1]);
    if (!ticket) return fail('Талон не найден', 'not_found');
    const place = placeById(ticket.placeId);
    if (!place) return fail('Заведение не найдено', 'not_found');
    if (!me.roles.some(role => role.role === 'operator') && (!place.partnerId || !me.partnerIds.includes(place.partnerId))) {
      return fail('Это не ваша карточка', 'forbidden');
    }
    const action = String(body.action);
    const allowed: Record<string, string[]> = { serving: ['called'], done: ['serving'], no_show: ['waiting', 'called'] };
    if (!allowed[action]?.includes(ticket.status)) return fail('Талон уже в другом состоянии', 'invalid_transition');
    ticket.status = action === 'no_show' ? 'no_show' : action as DemoQueueTicket['status'];
    if (action === 'done' || action === 'no_show') ticket.closedAt = new Date().toISOString();
    saveQueueTickets(tickets);
    if (action === 'done') awardDemoLoyalty(ticket.placeId, ticket.clientUserId, ticket.clientName, 'queue', ticket.id);
    return queueTicketView(ticket) as T;
  }

  if (url.pathname === '/api/v1/partner/places') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    if (!me.partnerIds.length && !me.roles.some(role => role.role === 'operator')) return fail('Нет кабинета партнёра', 'forbidden');
    const visible = me.partnerIds.length
      ? places.filter(place => place.partnerId && place.partnerId !== null && me.partnerIds.includes(place.partnerId))
      : places;
    return { items: visible.map(partnerPlaceView) } as T;
  }

  const partnerPlaceMatch = url.pathname.match(/^\/api\/v1\/partner\/places\/([^/]+)$/);
  if (partnerPlaceMatch && method === 'PATCH') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const place = placeById(partnerPlaceMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    if (!me.roles.some(role => role.role === 'operator') && (!place.partnerId || !place.partnerId !== null && me.partnerIds.includes(place.partnerId))) return fail('Это не ваша карточка', 'forbidden');
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
    if (!me.roles.some(role => role.role === 'operator') && (!place.partnerId || !place.partnerId !== null && me.partnerIds.includes(place.partnerId))) return fail('Это не ваша карточка', 'forbidden');
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
    if (!me.roles.some(role => role.role === 'operator') && (!place.partnerId || !place.partnerId !== null && me.partnerIds.includes(place.partnerId))) return fail('Это не ваша услуга', 'forbidden');
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
    const stops = Array.isArray(body.stops) ? body.stops as DemoTripPoint[] : [];
    const trip: DemoTrip & { key?: string | null } = {
      id: `t-${Date.now()}`, status: 'requested', from, to, stops, ...quote, price: null,
      scheduledFor: typeof body.scheduledFor === 'string' ? body.scheduledFor : null,
      requirements: {
        passengers: Number(body.passengers) || 1,
        childSeat: Boolean(body.childSeat), luggage: Boolean(body.luggage), pets: Boolean(body.pets),
        comment: String(body.comment ?? '').slice(0, 300),
      },
      offersUntil: new Date(Date.now() + 3 * 60000).toISOString(), offersLeft: 180,
      arrivedAt: null, cash: { client: false, driver: false },
      createdAt: new Date().toISOString(), client: { id: me.user.id, name: me.user.displayName }, driver: null,
      offers: [], key,
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
      available: trips.filter(item => item.status === 'requested' && item.client.id !== me.user.id).map(item => ({
        ...item, offers: (item.offers ?? []).filter(offer => offer.driver.id === me.user.id),
      })),
      mine: trips.filter(item => item.driver?.id === me.user.id && TRIP_ACTIVE.includes(item.status)),
      completed: trips.filter(item => item.driver?.id === me.user.id && item.status === 'completed').slice(0, 10),
    } as T;
  }

  if (url.pathname === '/api/v1/operator/trips') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    return { items: getTrips().filter(item => TRIP_ACTIVE.includes(item.status)) } as T;
  }

  const tripOfferMatch = url.pathname.match(/^\/api\/v1\/trips\/([^/]+)\/offers$/);
  if (tripOfferMatch && method === 'POST') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'driver')) return fail('Недостаточно прав', 'forbidden');
    const trips = getTrips();
    const trip = trips.find(item => item.id === tripOfferMatch[1]);
    if (!trip) return fail('Поездка не найдена', 'not_found');
    if (trip.client.id === me.user.id) return fail('Нельзя предложить цену на свою поездку', 'own_trip');
    if (trip.status !== 'requested') return fail('Заказ уже разобрали', 'trip_taken');
    if (trips.some(item => item.driver?.id === me.user.id && TRIP_ACTIVE.includes(item.status))) {
      return fail('У вас уже есть активная поездка', 'driver_busy');
    }
    const priceCents = Number(body.priceCents);
    if (!Number.isInteger(priceCents) || priceCents < 5000 || priceCents > 10000000) {
      return fail('Укажите цену от 50 ₽', 'invalid_price');
    }
    const driver = { id: me.user.id, name: me.user.displayName, car: 'Kia Rio', plate: 'A123ВС77',
      rating: 4.9, ridesCount: 128, verified: true };
    const existing = (trip.offers ?? []).find(offer => offer.driver.id === me.user.id);
    if (existing && existing.status !== 'pending') return fail('Предложение уже обработано', 'offer_locked');
    const offer: DemoTripOffer = existing ?? {
      id: `to-${Date.now()}`, price: money(priceCents), etaMin: null, message: '',
      status: 'pending', createdAt: new Date().toISOString(), driver,
    };
    offer.price = money(priceCents);
    offer.etaMin = body.etaMin ? Number(body.etaMin) : null;
    offer.message = String(body.message ?? '').slice(0, 200);
    offer.createdAt = new Date().toISOString();
    trip.offers = [...(trip.offers ?? []).filter(item => item.id !== offer.id), offer];
    saveTrips(trips);
    return offer as T;
  }

  const tripOfferAcceptMatch = url.pathname.match(/^\/api\/v1\/trips\/([^/]+)\/offers\/([^/]+)\/accept$/);
  if (tripOfferAcceptMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const trips = getTrips();
    const trip = trips.find(item => item.id === tripOfferAcceptMatch[1]);
    if (!trip) return fail('Поездка не найдена', 'not_found');
    if (trip.client.id !== me.user.id) return fail('Это не ваша поездка', 'forbidden');
    if (trip.status !== 'requested') return fail('Поездка уже назначена', 'trip_taken');
    const offer = (trip.offers ?? []).find(item => item.id === tripOfferAcceptMatch[2] && item.status === 'pending');
    if (!offer) return fail('Предложение недоступно', 'offer_not_found');
    trip.status = 'assigned';
    trip.driver = offer.driver;
    trip.price = offer.price;
    trip.offers = (trip.offers ?? []).map(item => item.id === offer.id
      ? { ...item, status: 'accepted' as const }
      : item.status === 'pending' ? { ...item, status: 'declined' as const } : item);
    saveTrips(trips);
    return trip as T;
  }

  const cashMatch = url.pathname.match(/^\/api\/v1\/trips\/([^/]+)\/cash$/);
  if (cashMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const trips = getTrips();
    const trip = trips.find(item => item.id === cashMatch[1]);
    if (!trip) return fail('Поездка не найдена', 'not_found');
    if (trip.status !== 'completed') return fail('Поездка ещё не завершена', 'trip_not_completed');
    if (trip.client.id !== me.user.id && trip.driver?.id !== me.user.id) return fail('Нет доступа к поездке', 'forbidden');
    trip.cash = trip.cash ?? { client: false, driver: false };
    if (trip.client.id === me.user.id) trip.cash.client = true;
    else trip.cash.driver = true;
    saveTrips(trips);
    return trip as T;
  }

  const tripActionMatch = url.pathname.match(/^\/api\/v1\/trips\/([^/]+)\/(arrive|start|complete|cancel)$/);
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
      trip.offers = (trip.offers ?? []).map(item => item.status === 'pending' ? { ...item, status: 'declined' as const } : item);
    } else {
      if (!me.roles.some(role => role.role === 'driver' || role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
      if (trip.driver?.id !== me.user.id) return fail('Это не ваша поездка', 'forbidden');
      const next: Record<string, DemoTripStatus> = { arrive: 'arrived', start: 'in_progress', complete: 'completed' };
      const allowed: Record<string, DemoTripStatus> = { arrive: 'assigned', start: 'arrived', complete: 'in_progress' };
      if (trip.status !== allowed[action]) return fail('Поездка уже в другом состоянии', 'invalid_transition');
      if (action === 'complete' && !trip.price) return fail('Сначала согласуйте цену с клиентом', 'price_not_agreed');
      trip.status = next[action];
      if (action === 'arrive') trip.arrivedAt = new Date().toISOString();
      if (action === 'complete') trip.cash = trip.cash ?? { client: false, driver: false };
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

  if (url.pathname === '/api/v1/me/service-requests') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    if (method === 'POST') {
      const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null;
      const services = getServices();
      if (key) {
        const existing = services.find(item => item.client.id === me.user.id && item.key === key);
        if (existing) return existing as T;
      }
      const request: DemoServiceRequest = {
        id: `sr-${Date.now()}`, status: 'open',
        category: String(body.category ?? 'other') as DemoServiceRequest['category'],
        title: String(body.title ?? '').slice(0, 120), description: String(body.description ?? '').slice(0, 1500),
        address: String(body.address ?? '').slice(0, 240),
        budget: { min: money(Number(body.budgetMinCents) || 0), max: money(Number(body.budgetMaxCents) || 0) },
        preferred: { from: String(body.preferredFrom), to: String(body.preferredTo) },
        price: null, createdAt: new Date().toISOString(), key,
        client: { id: me.user.id, name: me.user.displayName }, partner: null, offers: [],
        cash: { client: false, provider: false },
      };
      saveServices([request, ...services]);
      return request as T;
    }
    return { items: getServices().filter(item => item.client.id === me.user.id) } as T;
  }

  const serviceAcceptMatch = url.pathname.match(/^\/api\/v1\/me\/service-requests\/([^/]+)\/offers\/([^/]+)\/accept$/);
  if (serviceAcceptMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const services = getServices();
    const request = services.find(item => item.id === serviceAcceptMatch[1]);
    if (!request) return fail('Заявка не найдена', 'not_found');
    if (request.client.id !== me.user.id) return fail('Это не ваша заявка', 'forbidden');
    if (request.status !== 'open') return fail('Заявка уже не открыта', 'request_closed');
    const offer = request.offers.find(item => item.id === serviceAcceptMatch[2] && item.status === 'pending');
    if (!offer) return fail('Предложение недоступно', 'offer_not_found');
    request.status = 'assigned';
    request.partner = offer.partner;
    request.price = offer.price;
    request.offers = request.offers.map(item => item.id === offer.id
      ? { ...item, status: 'accepted' as const }
      : item.status === 'pending' ? { ...item, status: 'declined' as const } : item);
    saveServices(services);
    return request as T;
  }

  const serviceCashMatch = url.pathname.match(/^\/api\/v1\/me\/service-requests\/([^/]+)\/cash$/);
  if (serviceCashMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const services = getServices();
    const request = services.find(item => item.id === serviceCashMatch[1]);
    if (!request) return fail('Заявка не найдена', 'not_found');
    if (request.client.id !== me.user.id) return fail('Это не ваша заявка', 'forbidden');
    if (request.status !== 'awaiting_cash' || !request.cash?.provider) {
      return fail('Исполнитель ещё не подтвердил получение наличных', 'cash_not_ready');
    }
    request.cash = { ...request.cash, client: true };
    request.status = 'completed';
    saveServices(services);
    return request as T;
  }

  const serviceCancelMatch = url.pathname.match(/^\/api\/v1\/me\/service-requests\/([^/]+)\/cancel$/);
  if (serviceCancelMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const services = getServices();
    const request = services.find(item => item.id === serviceCancelMatch[1]);
    if (!request) return fail('Заявка не найдена', 'not_found');
    if (request.client.id !== me.user.id) return fail('Это не ваша заявка', 'forbidden');
    if (!['open', 'assigned'].includes(request.status)) return fail('Заявку уже нельзя отменить', 'invalid_transition');
    request.status = 'cancelled';
    saveServices(services);
    return request as T;
  }

  if (url.pathname === '/api/v1/partner/service-requests') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'partner')) return fail('Недостаточно прав', 'forbidden');
    const partnerIds = me.partnerIds;
    const services = getServices();
    return {
      open: services.filter(item => item.status === 'open').map(item => ({
        ...item,
        offers: item.offers.filter(offer => partnerIds.includes(offer.partner.id)),
      })),
      jobs: services.filter(item => item.partner && partnerIds.includes(item.partner.id)
        && SERVICE_ACTIVE.includes(item.status) && item.status !== 'open'),
    } as T;
  }

  const servicePartnerOfferMatch = url.pathname.match(/^\/api\/v1\/partner\/service-requests\/([^/]+)\/offers$/);
  if (servicePartnerOfferMatch && method === 'POST') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'partner')) return fail('Недостаточно прав', 'forbidden');
    const partnerId = me.partnerIds[0];
    if (!partnerId) return fail('Нет кабинета партнёра', 'forbidden');
    const services = getServices();
    const request = services.find(item => item.id === servicePartnerOfferMatch[1]);
    if (!request) return fail('Заявка не найдена', 'not_found');
    if (request.client.id === me.user.id) return fail('Нельзя предлагать услугу самому себе', 'own_request');
    if (request.status !== 'open') return fail('Заявка уже не открыта', 'request_closed');
    const existing = request.offers.find(item => item.partner.id === partnerId);
    if (existing && ['pending', 'accepted'].includes(existing.status)) return fail('Вы уже предложили цену', 'already_offered');
    const priceCents = Math.max(1, Number(body.priceCents) || 0);
    const offer: DemoServiceOffer = existing
      ? { ...existing, price: money(priceCents), message: String(body.message ?? ''), etaMin: body.etaMin ? Number(body.etaMin) : null, status: 'pending' }
      : { id: `so-${Date.now()}`, price: money(priceCents), message: String(body.message ?? ''), etaMin: body.etaMin ? Number(body.etaMin) : null,
        status: 'pending', createdAt: new Date().toISOString(),
        partner: { id: partnerId, name: demoNames[partnerId] ?? 'Партнёр' } };
    request.offers = existing
      ? request.offers.map(item => item.id === existing.id ? offer : item)
      : [...request.offers, offer];
    saveServices(services);
    return offer as T;
  }

  const partnerWithdrawMatch = url.pathname.match(/^\/api\/v1\/partner\/service-offers\/([^/]+)\/withdraw$/);
  if (partnerWithdrawMatch && method === 'POST') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'partner')) return fail('Недостаточно прав', 'forbidden');
    const services = getServices();
    const request = services.find(item => item.offers.some(offer => offer.id === partnerWithdrawMatch[1]));
    const offer = request?.offers.find(item => item.id === partnerWithdrawMatch[1]);
    if (!request || !offer) return fail('Предложение не найдено', 'not_found');
    if (!me.partnerIds.includes(offer.partner.id)) return fail('Это не ваше предложение', 'forbidden');
    if (offer.status !== 'pending') return fail('Предложение уже нельзя отозвать', 'offer_closed');
    offer.status = 'withdrawn';
    saveServices(services);
    return { ok: true } as T;
  }

  const partnerServiceAction = url.pathname.match(/^\/api\/v1\/partner\/service-requests\/([^/]+)\/(start|complete)$/);
  if (partnerServiceAction && method === 'POST') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'partner' || role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const services = getServices();
    const request = services.find(item => item.id === partnerServiceAction[1]);
    if (!request) return fail('Заявка не найдена', 'not_found');
    if (request.partner && !me.partnerIds.includes(request.partner.id) && !me.roles.some(role => role.role === 'operator')) {
      return fail('Это не ваша заявка', 'forbidden');
    }
    const action = partnerServiceAction[2];
    if (action === 'start') {
      if (request.status !== 'assigned') return fail('Заявка уже в другом состоянии', 'invalid_transition');
      request.status = 'in_progress';
    } else {
      if (request.status !== 'in_progress') return fail('Заявка уже в другом состоянии', 'invalid_transition');
      request.status = 'awaiting_cash';
      request.cash = { client: false, provider: true };
    }
    saveServices(services);
    return request as T;
  }

  if (url.pathname === '/api/v1/me/shop-orders') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    if (method === 'POST') {
      const place = placeById(String(body.placeId ?? ''));
      if (!place) return fail('Заведение не найдено', 'not_found');
      const items = (body.items as unknown as { productId: string; qty: number }[] | undefined) ?? [];
      const products = getProducts();
      const wanted = new Map<string, number>();
      for (const item of items) wanted.set(item.productId, (wanted.get(item.productId) ?? 0) + Number(item.qty));
      const lines = [...wanted.entries()].map(([productId, qty]) => {
        const product = products.find(item => item.id === productId && item.placeId === place.id && item.isActive);
        if (!product) return null;
        if (product.stockQty < qty) return null;
        return { product, qty };
      });
      if (lines.some(line => !line)) return fail('Часть товаров уже недоступна', 'out_of_stock');
      const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null;
      const orders = getShopOrders();
      if (key) {
        const existing = orders.find(item => item.client.id === me.user.id && item.key === key);
        if (existing) return orderView(existing) as T;
      }
      const goodsCents = lines.reduce((sum, line) => sum + line!.product.price.cents * line!.qty, 0);
      const fulfillment = body.fulfillment === 'delivery' ? 'delivery' : 'pickup';
      let deliveryFeeCents = 0;
      let zone: DemoDeliveryZone | undefined;
      if (fulfillment === 'delivery') {
        const address = String(body.deliveryAddress ?? '').trim();
        const district = String(body.deliveryDistrict ?? '');
        if (address.length < 3 || !district) return fail('Укажите адрес доставки', 'delivery_address_required');
        zone = getZones().find(item => item.placeId === place.id && item.district === district && item.isActive);
        if (!zone) return fail('Доставка в этот район недоступна', 'delivery_unavailable');
        if (goodsCents < zone.minOrderCents) return fail('Сумма меньше минимальной для доставки', 'min_order');
        deliveryFeeCents = zone.feeCents;
      }
      const totalCents = goodsCents + deliveryFeeCents;
      const order: DemoShopOrder = {
        id: `sh-${Date.now()}`, status: 'placed', total: money(totalCents),
        goods: money(goodsCents), deliveryFee: money(deliveryFeeCents), fulfillment,
        pickupCode: String(Math.floor(1000 + Math.random() * 9000)), note: String(body.note ?? '').slice(0, 300),
        createdAt: new Date().toISOString(), key,
        cash: { client: false, provider: false },
        client: { id: me.user.id, name: me.user.displayName },
        place: { id: place.id, name: place.name, address: place.address, district: place.district },
        items: lines.map((line, index) => ({
          id: `soi-${Date.now()}-${index}`, productId: line!.product.id, title: line!.product.title,
          unit: line!.product.unit, qty: line!.qty, price: line!.product.price,
          total: money(line!.product.price.cents * line!.qty),
        })),
      };
      if (fulfillment === 'delivery' && zone) {
        const job: DemoDeliveryJob = {
          id: `dj-${Date.now()}`, orderId: order.id, status: 'pending',
          address: String(body.deliveryAddress).trim(), district: zone.district,
          feeCents: zone.feeCents, etaMin: zone.etaMin, createdAt: order.createdAt, courier: null,
        };
        order.deliveryJobId = job.id;
        saveJobs([job, ...getJobs()]);
      }
      for (const line of lines) line!.product.stockQty -= line!.qty;
      saveProducts(products);
      saveShopOrders([order, ...orders]);
      return orderView(order) as T;
    }
    return { items: getShopOrders().filter(item => item.client.id === me.user.id).map(orderView) } as T;
  }

  const shopCashMatch = url.pathname.match(/^\/api\/v1\/me\/shop-orders\/([^/]+)\/cash$/);
  if (shopCashMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const orders = getShopOrders();
    const order = orders.find(item => item.id === shopCashMatch[1]);
    if (!order) return fail('Заказ не найден', 'not_found');
    if (order.client.id !== me.user.id) return fail('Это не ваш заказ', 'forbidden');
    if (order.status !== 'awaiting_cash' || !order.cash?.provider) {
      return fail('Продавец или курьер ещё не подтвердил получение наличных', 'cash_not_ready');
    }
    order.cash = { ...order.cash, client: true };
    order.status = 'completed';
    saveShopOrders(orders);
    awardDemoLoyalty(order.place.id, me.user.id, me.user.displayName, 'shop', order.id);
    return orderView(order) as T;
  }

  const shopCancelMatch = url.pathname.match(/^\/api\/v1\/me\/shop-orders\/([^/]+)\/cancel$/);
  if (shopCancelMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const orders = getShopOrders();
    const order = orders.find(item => item.id === shopCancelMatch[1]);
    if (!order) return fail('Заказ не найден', 'not_found');
    if (order.client.id !== me.user.id) return fail('Это не ваш заказ', 'forbidden');
    if (!['placed', 'confirmed'].includes(order.status)) return fail('Заказ уже нельзя отменить', 'invalid_transition');
    order.status = 'cancelled';
    const jobs = getJobs();
    const job = jobs.find(item => item.orderId === order.id && ['pending', 'assigned'].includes(item.status));
    if (job) job.status = 'cancelled';
    saveJobs(jobs);
    const products = getProducts();
    for (const line of order.items) {
      const product = products.find(item => item.id === line.productId);
      if (product) product.stockQty += line.qty;
    }
    saveProducts(products);
    saveShopOrders(orders);
    return orderView(order) as T;
  }

  if (url.pathname === '/api/v1/partner/analytics') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    if (!me.partnerIds.length) return fail('Нет кабинета партнёра', 'forbidden');
    const days = Math.min(365, Math.max(7, Number(url.searchParams.get('days')) || 30));
    const since = Date.now() - days * DAY;
    const mine = getBookings().filter(item => {
      const place = placeById(item.place.id);
      return place?.partnerId && me.partnerIds.includes(place.partnerId)
        && new Date(item.createdAt).getTime() >= since;
    });
    const completed = mine.filter(item => item.status === 'completed');
    const clients = new Map<string, { name: string; visits: number; last: string }>();
    for (const item of completed) {
      const id = item.clientUserId ?? 'u-000001';
      const current = clients.get(id) ?? { name: me.user.displayName, visits: 0, last: item.slot.startsAt };
      current.visits += 1;
      if (item.slot.startsAt > current.last) current.last = item.slot.startsAt;
      clients.set(id, current);
    }
    const week = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label, index) => ({
      weekday: index + 1, label, bookings: 0, completed: 0,
    }));
    const hour = Array.from({ length: 24 }, (_, value) => ({ hour: value, bookings: 0, completed: 0 }));
    for (const item of mine) {
      const date = new Date(item.slot.startsAt);
      const day = week[(date.getDay() + 6) % 7];
      day.bookings += 1;
      if (item.status === 'completed') day.completed += 1;
      const slot = hour[date.getHours()];
      slot.bookings += 1;
      if (item.status === 'completed') slot.completed += 1;
    }
    const bestHour = [...hour].sort((a, b) => b.bookings - a.bookings)[0];
    const bestDay = [...week].sort((a, b) => b.bookings - a.bookings)[0];
    const revenue = completed.reduce((sum, item) => sum + item.price.cents, 0);
    const queue = getQueueTickets().filter(ticket => {
      const place = placeById(ticket.placeId);
      return place?.partnerId && me.partnerIds.includes(place.partnerId) && new Date(ticket.createdAt).getTime() >= since;
    });
    const repeatClients = [...clients.values()].filter(item => item.visits >= 2).length;
    return {
      periodDays: days,
      totals: {
        bookings: mine.length, completed: completed.length,
        cancelled: mine.filter(item => item.status === 'cancelled').length,
        expired: mine.filter(item => item.status === 'expired').length,
        clients: clients.size, revenue: money(revenue),
        avgCheck: money(completed.length ? Math.round(revenue / completed.length) : 0),
      },
      repeat: { clients: clients.size, repeatClients, rate: clients.size ? Math.round(repeatClients / clients.size * 1000) / 10 : 0 },
      noShow: { queueTotal: queue.length, queueNoShow: queue.filter(item => item.status === 'no_show').length,
        expiredBookings: mine.filter(item => item.status === 'expired').length },
      byWeekday: week,
      byHour: hour,
      best: { hour: bestHour.bookings ? bestHour.hour : null, weekday: bestDay.bookings ? bestDay.weekday : null,
        count: Math.max(bestHour.bookings, bestDay.bookings) },
      topClients: [...clients.values()].sort((a, b) => b.visits - a.visits).slice(0, 5)
        .map(item => ({ name: item.name, visits: item.visits, lastVisit: item.last })),
    } as T;
  }

  if (url.pathname === '/api/v1/partner/shop-orders') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'partner')) return fail('Недостаточно прав', 'forbidden');
    const orders = getShopOrders().filter(order => {
      const place = placeById(order.place.id);
      return place && place.partnerId !== null && me.partnerIds.includes(place.partnerId)
        && ['placed', 'confirmed', 'ready', 'out_for_delivery', 'awaiting_cash'].includes(order.status);
    });
    return { items: orders.map(orderView) } as T;
  }

  const shopStatusMatch = url.pathname.match(/^\/api\/v1\/partner\/shop-orders\/([^/]+)\/status$/);
  if (shopStatusMatch && method === 'POST') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'partner' || role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const orders = getShopOrders();
    const order = orders.find(item => item.id === shopStatusMatch[1]);
    if (!order) return fail('Заказ не найден', 'not_found');
    const place = placeById(order.place.id);
    if (!place || ((!place.partnerId || !place.partnerId !== null && me.partnerIds.includes(place.partnerId)) && !me.roles.some(role => role.role === 'operator'))) {
      return fail('Это не ваш заказ', 'forbidden');
    }
    const action = String(body.action);
    const flow: Record<string, string> = { confirm: 'placed', ready: 'confirmed', complete: 'ready' };
    if (action === 'complete' && order.fulfillment === 'delivery') return fail('Доставку завершает курьер', 'courier_required');
    if (action === 'cancel') {
      if (!['placed', 'confirmed'].includes(order.status)) return fail('Заказ уже нельзя отменить', 'invalid_transition');
      order.status = 'cancelled';
      const jobs = getJobs();
      const job = jobs.find(item => item.orderId === order.id && ['pending', 'assigned'].includes(item.status));
      if (job) job.status = 'cancelled';
      saveJobs(jobs);
      const products = getProducts();
      for (const line of order.items) {
        const product = products.find(item => item.id === line.productId);
        if (product) product.stockQty += line.qty;
      }
      saveProducts(products);
    } else if (action === 'complete') {
      if (order.status !== 'ready') return fail('Заказ уже в другом состоянии', 'invalid_transition');
      order.status = 'awaiting_cash';
      order.cash = { client: false, provider: true };
    } else {
      const from = flow[action];
      if (!from || order.status !== from) return fail('Заказ уже в другом состоянии', 'invalid_transition');
      order.status = ({ confirm: 'confirmed', ready: 'ready' } as Record<string, DemoShopOrder['status']>)[action];
    }
    saveShopOrders(orders);
    return orderView(order) as T;
  }

  const partnerProductAdd = url.pathname.match(/^\/api\/v1\/partner\/places\/([^/]+)\/products$/);
  if (partnerProductAdd && method === 'POST') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'partner' || role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const place = placeById(partnerProductAdd[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    if ((!place.partnerId || !place.partnerId !== null && me.partnerIds.includes(place.partnerId)) && !me.roles.some(role => role.role === 'operator')) return fail('Это не ваша карточка', 'forbidden');
    const products = getProducts();
    const product: DemoShopProduct = {
      id: `sp-${Date.now()}`, placeId: place.id, title: String(body.title ?? '').slice(0, 120),
      description: String(body.description ?? ''), price: money(Number(body.priceCents) || 1),
      stockQty: Math.max(0, Number(body.stockQty) || 0), unit: String(body.unit || 'шт'), isActive: true,
    };
    products.push(product);
    saveProducts(products);
    return product as T;
  }

  const partnerProductMatch = url.pathname.match(/^\/api\/v1\/partner\/products\/([^/]+)$/);
  if (partnerProductMatch && method === 'PATCH') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'partner' || role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const products = getProducts();
    const product = products.find(item => item.id === partnerProductMatch[1]);
    if (!product) return fail('Товар не найден', 'not_found');
    const place = placeById(product.placeId);
    if (!place || ((!place.partnerId || !place.partnerId !== null && me.partnerIds.includes(place.partnerId)) && !me.roles.some(role => role.role === 'operator'))) return fail('Это не ваш товар', 'forbidden');
    if (body.priceCents !== undefined) product.price = money(Number(body.priceCents));
    if (body.stockQty !== undefined) product.stockQty = Math.max(0, Number(body.stockQty));
    if (body.title !== undefined) product.title = String(body.title).slice(0, 120);
    if (body.unit !== undefined) product.unit = String(body.unit).slice(0, 20);
    if (body.isActive !== undefined) product.isActive = Boolean(body.isActive);
    saveProducts(products);
    return product as T;
  }

  if (url.pathname === '/api/v1/partner/bookings') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    return { items: partnerBookings(me) } as T;
  }

  const placeReviewMatch = url.pathname.match(/^\/api\/v1\/places\/([^/]+)\/reviews$/);
  if (placeReviewMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    const place = placeById(placeReviewMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    const items = placeReviews();
    if (items.some(item => item.placeId === place.id && item.author === me.user.displayName)) {
      return fail('Вы уже оставляли отзыв об этом месте', 'review_exists');
    }
    items.push({ id: `place-review-${Date.now()}`, placeId: place.id, rating: Number(body.rating) || 5,
      body: String(body.body ?? '').slice(0, 1000), author: me.user.displayName, createdAt: new Date().toISOString() });
    localStorage.setItem(PLACE_REVIEWS_KEY, JSON.stringify(items));
    return { ok: true, status: 'published' } as T;
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

  const zoneAddMatch = url.pathname.match(/^\/api\/v1\/partner\/places\/([^/]+)\/zones$/);
  if (zoneAddMatch && method === 'POST') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'partner' || role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const place = placeById(zoneAddMatch[1]);
    if (!place) return fail('Заведение не найдено', 'not_found');
    if ((!place.partnerId || !place.partnerId !== null && me.partnerIds.includes(place.partnerId)) && !me.roles.some(role => role.role === 'operator')) return fail('Это не ваша карточка', 'forbidden');
    const zones = getZones();
    const district = String(body.district ?? '');
    const existing = zones.find(item => item.placeId === place.id && item.district === district);
    const zone: DemoDeliveryZone = existing ?? {
      id: `dz-${Date.now()}`, placeId: place.id, district, feeCents: 0, minOrderCents: 0, etaMin: 45, isActive: true,
    };
    zone.feeCents = Math.max(0, Number(body.feeCents) || 0);
    zone.minOrderCents = Math.max(0, Number(body.minOrderCents) || 0);
    zone.etaMin = Math.max(5, Number(body.etaMin) || 45);
    zone.isActive = true;
    if (!existing) zones.push(zone);
    saveZones(zones);
    return { id: zone.id, district: zone.district, fee: money(zone.feeCents), minOrder: money(zone.minOrderCents),
      etaMin: zone.etaMin, isActive: zone.isActive } as T;
  }

  const zoneMatch = url.pathname.match(/^\/api\/v1\/partner\/zones\/([^/]+)$/);
  if (zoneMatch && method === 'PATCH') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'partner' || role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const zones = getZones();
    const zone = zones.find(item => item.id === zoneMatch[1]);
    if (!zone) return fail('Зона не найдена', 'not_found');
    const place = placeById(zone.placeId);
    if (!place || ((!place.partnerId || !place.partnerId !== null && me.partnerIds.includes(place.partnerId)) && !me.roles.some(role => role.role === 'operator'))) return fail('Это не ваша зона', 'forbidden');
    if (body.feeCents !== undefined) zone.feeCents = Math.max(0, Number(body.feeCents));
    if (body.minOrderCents !== undefined) zone.minOrderCents = Math.max(0, Number(body.minOrderCents));
    if (body.etaMin !== undefined) zone.etaMin = Math.max(5, Number(body.etaMin));
    if (body.isActive !== undefined) zone.isActive = Boolean(body.isActive);
    saveZones(zones);
    return { id: zone.id, district: zone.district, fee: money(zone.feeCents), minOrder: money(zone.minOrderCents),
      etaMin: zone.etaMin, isActive: zone.isActive } as T;
  }

  if (url.pathname === '/api/v1/courier/delivery-jobs') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    if (!me.roles.some(role => role.role === 'courier')) return fail('Недостаточно прав', 'forbidden');
    const jobs = getJobs();
    const orderById = new Map(getShopOrders().map(item => [item.id, item]));
    return {
      available: jobs.filter(job => job.status === 'pending' && orderById.get(job.orderId)?.status === 'ready').map(jobView),
      mine: jobs.filter(job => job.courier?.id === me.user.id && ['assigned', 'picked_up'].includes(job.status)).map(jobView),
    } as T;
  }

  const courierActionMatch = url.pathname.match(/^\/api\/v1\/courier\/delivery-jobs\/([^/]+)\/(claim|pickup|deliver)$/);
  if (courierActionMatch && method === 'POST') {
    const me = getMe();
    if (!me) return fail('Требуется вход', 'unauthorized');
    if (!me.roles.some(role => role.role === 'courier')) return fail('Недостаточно прав', 'forbidden');
    const jobs = getJobs();
    const job = jobs.find(item => item.id === courierActionMatch[1]);
    if (!job) return fail('Доставка не найдена', 'not_found');
    const orders = getShopOrders();
    const order = orders.find(item => item.id === job.orderId);
    if (!order) return fail('Заказ не найден', 'not_found');
    const action = courierActionMatch[2];
    if (action === 'claim') {
      if (job.status !== 'pending') return fail('Доставку уже взяли', 'delivery_taken');
      if (order.status !== 'ready') return fail('Заказ ещё не готов', 'not_ready');
      if (jobs.some(item => item.courier?.id === me.user.id && ['assigned', 'picked_up'].includes(item.status))) {
        return fail('У вас уже есть активная доставка', 'courier_busy');
      }
      job.status = 'assigned';
      job.courier = { id: me.user.id, name: me.user.displayName };
    } else if (action === 'pickup') {
      if (job.courier?.id !== me.user.id) return fail('Это не ваша доставка', 'forbidden');
      if (job.status !== 'assigned') return fail('Доставка уже в другом состоянии', 'invalid_transition');
      job.status = 'picked_up';
      order.status = 'out_for_delivery';
    } else {
      if (job.courier?.id !== me.user.id) return fail('Это не ваша доставка', 'forbidden');
      if (job.status !== 'picked_up') return fail('Доставка уже в другом состоянии', 'invalid_transition');
      job.status = 'delivered';
      order.status = 'awaiting_cash';
      order.cash = { client: false, provider: true };
    }
    saveJobs(jobs);
    saveShopOrders(orders);
    return jobView(job) as T;
  }

  if (url.pathname === '/api/v1/operator/delivery-jobs') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    return { items: getJobs().filter(job => ['pending', 'assigned', 'picked_up'].includes(job.status)).map(jobView) } as T;
  }

  if (url.pathname === '/api/v1/operator/couriers') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const jobs = getJobs();
    const items = [{
      id: 'u-000005', display_name: 'Курьер Демо', transport: 'Велосипед', is_online: true, deliveries_count: 0,
      active_jobs: jobs.filter(job => job.courier?.id === 'u-000005' && ['assigned', 'picked_up'].includes(job.status)).length,
    }];
    if (me.roles.some(role => role.role === 'courier') && !items.some(item => item.id === me.user.id)) {
      items.push({ id: me.user.id, display_name: me.user.displayName, transport: 'Пешком', is_online: true,
        deliveries_count: 0, active_jobs: jobs.filter(job => job.courier?.id === me.user.id && ['assigned', 'picked_up'].includes(job.status)).length });
    }
    return { items } as T;
  }

  const assignMatch = url.pathname.match(/^\/api\/v1\/operator\/delivery-jobs\/([^/]+)\/assign$/);
  if (assignMatch && method === 'POST') {
    const me = getMe();
    if (!me?.roles.some(role => role.role === 'operator')) return fail('Недостаточно прав', 'forbidden');
    const jobs = getJobs();
    const job = jobs.find(item => item.id === assignMatch[1]);
    if (!job) return fail('Доставка не найдена', 'not_found');
    if (['picked_up', 'delivered'].includes(job.status)) return fail('Доставку уже нельзя переназначить', 'invalid_transition');
    const courierId = String(body.courierUserId ?? '');
    job.status = 'assigned';
    job.courier = { id: courierId, name: courierId === 'u-000005' ? 'Курьер Демо' : getMe()?.user.displayName ?? 'Курьер' };
    saveJobs(jobs);
    return jobView(job) as T;
  }

  return fail('Демо-метод не найден', 'not_found');
}
