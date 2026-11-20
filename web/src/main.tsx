import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { demoRequest } from './demo';
import { roadRoute, type RoadRoute } from './routing';
import { reverseAddress, searchAddress, type GeoPlace } from './geocoding';
import './style.css';

type Money = { cents: number; currency: string };
type PlaceSource = { name: string; url: string | null; reviewsUrl?: string | null; rating: number | null; ratingCount: number };
type PlaceCard = {
  id: string; name: string; category: Category; district: string; address: string; about: string;
  location: { lat: number; lng: number }; city: string; image: string | null;
  rating: number | null; ratingCount: number; source: PlaceSource | null;
  priceFrom: Money | null; offerCount: number; distanceKm: number | null;
};
type City = { slug: string; name: string; region: string; center: { lat: number; lng: number }; places: number };
type PlacePhoto = { small: string; large: string; full: string; author: string | null };
type Offer = { id: string; title: string; description: string; durationMin: number; price: Money; nextSlot: string | null };
type ShopProduct = { id: string; title: string; description: string; price: Money; stockQty: number; unit: string; isActive: boolean };
type ShopOrderItem = { id: string; productId: string | null; title: string; unit: string; qty: number; price: Money; total: Money };
type ShopOrderStatus = 'placed' | 'confirmed' | 'ready' | 'out_for_delivery' | 'completed' | 'cancelled';
type DeliveryStatus = 'pending' | 'assigned' | 'picked_up' | 'delivered' | 'cancelled';
type DeliveryZone = { id: string; district: string; fee: Money; minOrder: Money; etaMin: number; isActive: boolean };
type DeliveryInfo = {
  id: string; status: DeliveryStatus; address: string; district: string; fee: Money; etaMin: number;
  courier: { id: string; name: string } | null;
};
type ShopOrder = {
  id: string; status: ShopOrderStatus; total: Money; goods: Money; deliveryFee: Money;
  fulfillment: 'pickup' | 'delivery'; pickupCode: string; note: string; createdAt: string;
  client: { id: string; name: string };
  place: { id: string; name: string; address: string; district: string };
  delivery: DeliveryInfo | null;
  items: ShopOrderItem[];
};
type DeliveryJob = {
  id: string; orderId: string; status: DeliveryStatus; address: string; district: string;
  fee: Money; etaMin: number; createdAt: string; courier: { id: string; name: string } | null;
  order: {
    id: string; status: ShopOrderStatus; pickupCode: string; total: Money;
    client: { id: string; name: string }; place: { id: string; name: string; address: string };
  };
};
type CourierInfo = { id: string; display_name: string; transport: string; is_online: boolean; deliveries_count: number; active_jobs: number };
type PlaceDetail = { place: PlaceCard & { phone: string | null; bookable: boolean; photos?: PlacePhoto[];
  info?: { schedule: string | null; sites: string[] } }; offers: Offer[]; products: ShopProduct[];
  delivery: { available: boolean; zones: DeliveryZone[] }; reviews: Review[] };
type Slot = { id: string; startsAt: string; endsAt: string };
type Review = { id: string; source: 'own' | '2gis'; rating: number | null; body: string;
  createdAt: string; author: string; externalUrl: string | null };
type Booking = {
  id: string; status: 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'expired';
  note: string; price: Money; createdAt: string;
  slot: { id: string; startsAt: string; endsAt: string };
  offer: { id: string; title: string; durationMin: number };
  place: { id: string; name: string; address: string; district: string };
  review: { id: string; rating: number; status: 'pending' | 'published' | 'hidden' } | null;
};
type Me = { user: { id: string; phone: string; displayName: string }; roles: { role: string; partner_id: string | null }[]; partnerIds: string[] };
type TripPoint = { label: string; address?: string; lat: number; lng: number };
type TripStatus = 'requested' | 'assigned' | 'arrived' | 'in_progress' | 'completed' | 'cancelled';
type TripOffer = {
  id: string; price: Money; etaMin: number | null; message: string;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn'; createdAt: string;
  driver: { id: string; name: string; car: string; plate: string; rating?: number | null; ridesCount?: number; verified?: boolean };
};
type TripRequirements = {
  passengers: number; childSeat: boolean; luggage: boolean; pets: boolean; comment: string;
};
type Trip = {
  id: string; status: TripStatus; from: TripPoint; to: TripPoint; stops?: TripPoint[];
  scheduledFor?: string | null; requirements?: TripRequirements;
  distanceKm: number; durationMin: number;
  price: Money | null; createdAt: string; client: { id: string; name: string };
  driver: { id: string; name: string; car: string; plate: string; rating?: number | null; ridesCount?: number; verified?: boolean } | null;
  offers?: TripOffer[]; offersUntil?: string | null; offersLeft?: number;
  arrivedAt?: string | null; cash?: { client: boolean; driver: boolean };
};
type Estimate = { distanceKm: number; durationMin: number; route?: 'osrm' | 'straight' };
type ServiceCategory = 'repair' | 'cleaning' | 'beauty' | 'tutoring' | 'moving' | 'other';
type ServiceStatus = 'open' | 'assigned' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
type ServiceOffer = {
  id: string; price: Money; message: string; etaMin: number | null;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  createdAt: string; partner: { id: string; name: string };
};
type ServiceRequest = {
  id: string; status: ServiceStatus; category: ServiceCategory; title: string; description: string;
  address: string; budget: { min: Money; max: Money }; preferred: { from: string; to: string };
  price: Money | null; createdAt: string; client: { id: string; name: string };
  partner: { id: string; name: string } | null; offers: ServiceOffer[];
};
type PartnerOffer = { id: string; title: string; description: string; durationMin: number; price: Money; isActive: boolean; slotCount: number; nextSlot: string | null };
type PartnerPlace = {
  id: string; name: string; category: Category; district: string; address: string; about: string;
  phone: string | null; location: { lat: number; lng: number }; isPublished: boolean; updatedAt: string;
  offers: PartnerOffer[]; products: ShopProduct[]; zones: DeliveryZone[];
};
type Notice = { id: number; kind: string; payload: Record<string, unknown>; channel: string; created_at: string; read_at: string | null; delivered_at: string | null; last_error: string | null };
type ModerationItem = {
  id: string; rating: number; body: string; status: string; created_at: string; moderated_at: string | null;
  author: string; place_name: string; place_id: string; booking_id: string;
};

const categories: Record<string, string> = { all: 'Всё', salon: 'Красота', services: 'Мастера', health: 'Здоровье', food: 'Еда' };
type Category = 'salon' | 'services' | 'health' | 'food';
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const price = (value: Money | null) => value ? money.format(value.cents / 100) : '—';
const dayTime = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const timeOnly = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const roleLabel: Record<string, string> = { client: 'клиент', partner: 'партнёр', operator: 'оператор', driver: 'водитель', courier: 'курьер' };
const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;
const haptic = (pattern: number | number[] = 6) => {
  try { navigator.vibrate?.(pattern); } catch { /* вибрация необязательна */ }
};
const unitLabel = (unit: string, qty: number) => unit === 'порция'
  ? plural(qty, 'порция', 'порции', 'порций')
  : unit === 'стакан' ? plural(qty, 'стакан', 'стакана', 'стаканов') : unit;
const statusLabel: Record<Booking['status'], string> = {
  requested: 'Ждёт подтверждения', confirmed: 'Подтверждено', completed: 'Завершено',
  cancelled: 'Отменено', expired: 'Истекло',
};
const serviceCategories: Record<ServiceCategory, string> = {
  repair: 'Ремонт', cleaning: 'Уборка', beauty: 'Красота', tutoring: 'Занятия', moving: 'Переезд', other: 'Другое',
};
const serviceCategoryIcon: Record<ServiceCategory, IconName> = {
  repair: 'wrench', cleaning: 'sparkles', beauty: 'scissors', tutoring: 'edit', moving: 'car', other: 'dots',
};
const serviceStatusLabel: Record<ServiceStatus, string> = {
  open: 'Ищем мастера', assigned: 'Мастер выбран', in_progress: 'В работе', completed: 'Завершена',
  cancelled: 'Отменена', expired: 'Истекла',
};
const shopStatusLabel: Record<ShopOrderStatus, string> = {
  placed: 'Ждёт подтверждения', confirmed: 'Подтверждён', ready: 'Готов', out_for_delivery: 'В пути',
  completed: 'Выдан', cancelled: 'Отменён',
};
const deliveryStatusLabel: Record<DeliveryStatus, string> = {
  pending: 'Ищем курьера', assigned: 'Курьер назначен', picked_up: 'В пути', delivered: 'Доставлено', cancelled: 'Отменено',
};
const serviceOfferStatusLabel: Record<ServiceOffer['status'], string> = {
  pending: 'Ждёт ответа', accepted: 'Выбрано', declined: 'Отклонено', withdrawn: 'Отозвано',
};
const serviceWindow = (item: ServiceRequest) => {
  const from = new Date(item.preferred.from);
  const to = new Date(item.preferred.to);
  const sameDay = from.toDateString() === to.toDateString();
  return `${dayTime.format(from)} — ${sameDay ? timeOnly.format(to) : dayTime.format(to)}`;
};

const csrf = () => document.cookie.split('; ').find(row => row.startsWith('rjadom_csrf='))?.split('=')[1] ?? '';

const DEMO = import.meta.env.VITE_DEMO === '1';

async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (DEMO) return demoRequest<T>(path, init);
  const headers: Record<string, string> = { 'x-csrf-token': decodeURIComponent(csrf()) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
    signal: init.signal,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.message ?? 'Ошибка сети'), { code: data?.error });
  return data as T;
}

type IconName = 'home' | 'map' | 'receipt' | 'user' | 'search' | 'pin' | 'star' | 'clock' | 'chevron'
  | 'chevronDown' | 'bell' | 'sliders' | 'sparkles' | 'scissors' | 'spa' | 'food' | 'wrench' | 'grid'
  | 'arrowLeft' | 'plus' | 'check' | 'edit' | 'logout' | 'calendar' | 'shield' | 'close' | 'phone'
  | 'send' | 'heart' | 'bolt' | 'dots' | 'car' | 'download' | 'refresh' | 'child' | 'bag' | 'paw';

const iconPaths: Record<IconName, ReactNode> = {
  home: <><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" /></>,
  map: <><path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2z" /><path d="M9 4v14M15 6v14" /></>,
  receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  user: <><circle cx="12" cy="8" r="3.2" /><path d="M5 20c.7-3.4 3.4-5.2 7-5.2s6.3 1.8 7 5.2" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
  pin: <><path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></>,
  star: <><path d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.4l6.1-.8z" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
  chevron: <><path d="m9 6 6 6-6 6" /></>,
  chevronDown: <><path d="m6 9 6 6 6-6" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 21a2 2 0 0 0 4 0" /></>,
  sliders: <><path d="M4 7h9M18 7h2M4 17h4M13 17h7" /><circle cx="15.5" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  sparkles: <><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><path d="m12 9 1.3 1.7L15 12l-1.7 1.3L12 15l-1.3-1.7L9 12l1.7-1.3z" /></>,
  scissors: <><circle cx="6" cy="7" r="2.4" /><circle cx="6" cy="17" r="2.4" /><path d="M8 8.4 20 19M8 15.6 20 5" /></>,
  spa: <><path d="M12 21c-4.2 0-7.5-3.3-7.5-7.5C8.7 13.5 12 16.8 12 21zM12 21c4.2 0 7.5-3.3 7.5-7.5C15.3 13.5 12 16.8 12 21z" /><path d="M12 14c-2.2-1.8-3-4.7-1.2-7.2 2 2.5 3 5.2 1.2 7.2z" /></>,
  food: <><path d="M4 12h16a8 8 0 0 1-16 0z" /><path d="M8 8c0-1.8 1.6-2 1.6-3.6M12.5 8c0-1.8 1.6-2 1.6-3.6M17 8c0-1.8 1.6-2 1.6-3.6" /></>,
  wrench: <><path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17l3 3 5.5-5.5a4 4 0 0 0 5.2-5.2l-2.3 2.3-3-3z" /></>,
  grid: <><rect x="4" y="4" width="6" height="6" rx="2" /><rect x="14" y="4" width="6" height="6" rx="2" /><rect x="4" y="14" width="6" height="6" rx="2" /><rect x="14" y="14" width="6" height="6" rx="2" /></>,
  arrowLeft: <><path d="M19 12H5M11 6l-6 6 6 6" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  check: <><path d="m5 12.5 4.5 4.5L19 7" /></>,
  edit: <><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z" /><path d="m14 7 3 3" /></>,
  logout: <><path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M8 3v4M16 3v4M4 10h16" /></>,
  shield: <><path d="M12 3 5 6v6c0 4.4 3 7.5 7 9 4-1.5 7-4.6 7-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  phone: <><path d="M6 3h3l1.5 4-2 1.5a12 12 0 0 0 5 5L15 11.5 19 13v3a2 2 0 0 1-2.2 2A15 15 0 0 1 4 5.2 2 2 0 0 1 6 3z" /></>,
  send: <><path d="m21 3-7 18-3.5-7.5L3 10z" /><path d="M21 3 10.5 13.5" /></>,
  heart: <><path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.5A4 4 0 0 1 19 11c0 4.6-7 9-7 9z" /></>,
  bolt: <><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></>,
  dots: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>,
  car: <><path d="M5 15.5 6.6 10A3 3 0 0 1 9.5 8h5a3 3 0 0 1 2.9 2l1.6 5.5" /><path d="M4 15.5h16V19H4z" /><circle cx="7.5" cy="19" r="1.6" /><circle cx="16.5" cy="19" r="1.6" /></>,
  download: <><path d="M12 3v11m0 0 4-4m-4 4-4-4" /><path d="M5 20h14" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.4 5.7" /><path d="M20 4v7h-7" /></>,
  child: <><circle cx="12" cy="6" r="2.2" /><path d="M8 21v-4.5L10 14V9h4v5l2 2.5V21M10 12v3h4" /></>,
  bag: <><rect x="5" y="8" width="14" height="12" rx="2" /><path d="M9 8V6a3 3 0 0 1 6 0v2M9 13v3M15 13v3" /></>,
  paw: <><circle cx="7" cy="10" r="1.8" /><circle cx="12" cy="7" r="1.8" /><circle cx="17" cy="10" r="1.8" /><path d="M12 12c-3 0-5 2.2-5 4.2 0 1.5 1.3 2.3 2.6 2.3 1 0 1.7-.5 2.4-.5s1.4.5 2.4.5c1.3 0 2.6-.8 2.6-2.3 0-2-2-4.2-5-4.2z" /></>,
};

function Icon({ name, size = 20, stroke = 1.8, className = '' }: {
  name: IconName; size?: number; stroke?: number; className?: string;
}) {
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">{iconPaths[name]}</svg>;
}

const categoryIcon: Record<string, IconName> = {
  all: 'sparkles', salon: 'scissors', services: 'wrench', health: 'spa', food: 'food',
};

const tabIcon: Record<Tab, IconName> = { home: 'home', map: 'map', taxi: 'car', orders: 'receipt', profile: 'user' };

type Tab = 'home' | 'map' | 'taxi' | 'orders' | 'profile';
const tabs: { key: Tab; label: string }[] = [
  { key: 'home', label: 'Главная' }, { key: 'map', label: 'Карта' }, { key: 'taxi', label: 'Такси' },
  { key: 'orders', label: 'Заказы' }, { key: 'profile', label: 'Профиль' },
];
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function useModalHistory(open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const pushed = useRef(false);
  useEffect(() => {
    if (!open) return;
    const marker = `rjadom-${Math.random().toString(36).slice(2)}`;
    const base = history.state && typeof history.state === 'object' ? history.state : {};
    history.pushState({ ...base, rjadomModal: marker }, '');
    pushed.current = true;
    const onPop = () => {
      if (!pushed.current) return;
      if (history.state?.rjadomModal === marker) return;
      pushed.current = false;
      closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (pushed.current) {
        pushed.current = false;
        if (history.state?.rjadomModal === marker) history.back();
      }
    };
  }, [open]);
}

function Sheet({ open, onClose, title, children }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode;
}) {
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<number | null>(null);
  const lastDrag = useRef(0);
  useModalHistory(open, onClose);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  useEffect(() => { if (!open) { setDrag(0); lastDrag.current = 0; dragStart.current = null; } }, [open]);
  if (!open) return null;
  const onDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    dragStart.current = event.clientY;
    lastDrag.current = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStart.current === null) return;
    const next = Math.max(0, event.clientY - dragStart.current);
    lastDrag.current = next;
    setDrag(next);
  };
  const onDragEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (lastDrag.current > 84) onClose();
    else setDrag(0);
  };
  return createPortal(<div className="sheet-layer">
    <button type="button" className="sheet-backdrop" aria-label="Закрыть" onClick={onClose} />
    <section className={`sheet${drag ? ' dragging' : ''}`} role="dialog" aria-modal="true" aria-label={title}
      style={drag ? { transform: `translateY(${drag}px)` } : undefined}>
      <div className="sheet-drag" onPointerDown={onDragStart} onPointerMove={onDragMove}
        onPointerUp={onDragEnd} onPointerCancel={onDragEnd}>
        <span className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Закрыть">
            <Icon name="close" size={17} />
          </button>
        </div>
      </div>
      <div className="sheet-body">{children}</div>
    </section>
  </div>, document.body);
}

function PwaUpdate() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const reloading = useRef(false);
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null = null;
    let poll = 0;
    const show = (worker: ServiceWorker | null) => {
      if (!worker || !navigator.serviceWorker.controller || reloading.current) return;
      setWaiting(worker);
    };
    const watch = (worker: ServiceWorker | null) => {
      if (!worker) return;
      installing = worker;
      const onState = () => { if (worker.state === 'installed') show(worker); };
      worker.addEventListener('statechange', onState);
    };
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then(reg => {
      registration = reg;
      show(reg.waiting);
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      poll = window.setInterval(() => show(reg.waiting), 2000);
    }).catch(error => console.error('PWA registration failed', error));
    const onController = () => { if (reloading.current) window.location.reload(); };
    navigator.serviceWorker.addEventListener('controllerchange', onController);
    return () => {
      clearInterval(poll);
      navigator.serviceWorker.removeEventListener('controllerchange', onController);
      if (registration) registration.onupdatefound = null;
      if (installing) installing.onstatechange = null;
    };
  }, []);
  if (!waiting) return null;
  const apply = () => {
    reloading.current = true;
    setWaiting(null);
    haptic(12);
    waiting.postMessage({ type: 'SKIP_WAITING' });
    window.setTimeout(() => window.location.reload(), 1200);
  };
  return <div className="update-bar" role="status">
    <span><strong>Есть обновление</strong><small>Приложение обновится за секунду</small></span>
    <button type="button" onClick={apply}>Обновить</button>
  </div>;
}

function tabFromLaunch(): Tab {
  const value = new URLSearchParams(location.search).get('tab');
  return tabs.some(item => item.key === value) ? value as Tab : 'home';
}

function App() {
  const [tab, setTab] = useState<Tab>(tabFromLaunch);
  const [me, setMe] = useState<Me | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [toast, setToast] = useState<string | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [cities, setCities] = useState<City[]>([]);
  const [citySlug, setCitySlug] = useState(() => localStorage.getItem('rjadom.city') || '');
  const [cityOpen, setCityOpen] = useState(false);
  const [installed, setInstalled] = useState(() =>
    window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  const city = cities.find(item => item.slug === citySlug) ?? null;

  useEffect(() => {
    void api<{ items: City[] }>('/api/v1/cities').then(data => {
      setCities(data.items);
      setCitySlug(current => data.items.some(item => item.slug === current) ? current : data.items[0]?.slug ?? '');
    }).catch(() => setCities([]));
  }, []);

  useEffect(() => {
    if (citySlug) localStorage.setItem('rjadom.city', citySlug);
  }, [citySlug]);

  useEffect(() => {
    if (!new URLSearchParams(location.search).has('tab')) return;
    const url = new URL(location.href);
    url.searchParams.delete('tab');
    history.replaceState(history.state, '', url);
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => { setInstalled(true); setInstallPrompt(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setInstalled(true);
    setInstallPrompt(null);
    haptic(12);
  }

  function goTab(next: Tab) {
    if (next === tab) return;
    haptic();
    setTab(next);
  }

  const refreshMe = useCallback(() => {
    void api<Me>('/api/v1/me').then(setMe).catch(() => setMe(null));
  }, []);
  useEffect(refreshMe, [refreshMe]);
  useEffect(() => {
    const badge = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (!badge.setAppBadge) return;
    if (!me) { void badge.clearAppBadge?.(); return; }
    let alive = true;
    const sync = () => {
      void api<{ items: { read_at: string | null }[] }>('/api/v1/me/notifications').then(data => {
        if (!alive) return;
        const count = data.items.filter(item => !item.read_at).length;
        return count ? badge.setAppBadge?.(count) : badge.clearAppBadge?.();
      }).catch(() => undefined);
    };
    void sync();
    const timer = setInterval(sync, 60000);
    return () => { alive = false; clearInterval(timer); };
  }, [me]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  return <main className="page">
    <div className="ambient" aria-hidden="true"><span /><span /><span /></div>
    <header className="appbar">
      <a href="/" className="brand" aria-label="Рядом — на главную">
        <span className="brand-mark" aria-hidden="true"><span /></span>
        <span className="brand-name">рядом<i>.</i></span>
      </a>
      <div className="appbar-right">
        <button type="button" className="status-pill city-pill" title="Выбрать город" onClick={() => { haptic(); setCityOpen(true); }}>
          <span className="pulse" aria-hidden="true" />{city?.name ?? 'Город'}<Icon name="chevronDown" size={11} />
        </button>
        {installPrompt && !installed && <button type="button" className="icon-btn install" onClick={() => void installApp()} aria-label="Установить приложение">
          <Icon name="download" size={17} />
        </button>}
        <button type="button" className="avatar" onClick={() => goTab('profile')} aria-label={me ? 'Профиль' : 'Войти'}>
          {me ? me.user.displayName.trim().slice(0, 1).toUpperCase() : <Icon name="user" size={18} />}
        </button>
      </div>
    </header>
    {!online && <p className="notice" role="status">Нет сети</p>}
    {toast && <p className="toast" role="status">{toast}</p>}
    <PwaUpdate />

    <div className="screen" key={tab}>
      {tab === 'home' && <Catalogue key={city?.slug ?? 'empty'} city={city} me={me} onPick={() => goTab('map')} notify={setToast} />}
      {tab === 'map' && <Catalogue key={city?.slug ?? 'empty'} city={city} me={me} withMap notify={setToast} />}
      {tab === 'taxi' && <TaxiScreen me={me} city={city} notify={setToast} onLogin={() => goTab('profile')} />}
      {tab === 'orders' && <Orders me={me} notify={setToast} />}
      {tab === 'profile' && <Profile me={me} refreshMe={refreshMe} notify={setToast} />}
    </div>

    <nav className="dock" aria-label="Разделы">
      {tabs.map(item => <button key={item.key} type="button" className={tab === item.key ? 'active' : ''}
        aria-current={tab === item.key ? 'page' : undefined} onClick={() => goTab(item.key)}>
        <span className="dock-icon"><Icon name={tabIcon[item.key]} size={21} /></span>
        <span className="dock-label">{item.label}</span>
      </button>)}
    </nav>

    <Sheet open={cityOpen} onClose={() => setCityOpen(false)} title="Город">
      <p className="sheet-hint">Выберите город. Новые города подключаются вместе с каталогом.</p>
      <div className="sheet-options city-options">
        {cities.map(item => <button key={item.slug} type="button"
          className={citySlug === item.slug ? 'selected' : ''}
          onClick={() => { haptic(); setCitySlug(item.slug); setCityOpen(false); }}>
          <span className="city-option"><strong>{item.name}</strong><small>{item.region} · {item.places} {plural(item.places, 'место', 'места', 'мест')}</small></span>
          {citySlug === item.slug && <Icon name="check" size={17} />}
        </button>)}
        {!cities.length && <p className="hint">Города загружаются…</p>}
      </div>
    </Sheet>
  </main>;
}

const TILE = 256;
const CITY = { lat: 55.7558, lng: 37.6173 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function project(lat: number, lng: number, zoom: number) {
  const size = TILE * 2 ** zoom;
  const phi = clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180;
  return {
    x: (lng + 180) / 360 * size,
    y: (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2 * size,
  };
}

function unproject(x: number, y: number, zoom: number) {
  const size = TILE * 2 ** zoom;
  const n = Math.PI - 2 * Math.PI * y / size;
  return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng: x / size * 360 - 180 };
}

function MapView({ items, center: cityCenter, onOpen, notify }: {
  items: PlaceCard[]; center: { lat: number; lng: number };
  onOpen: (place: PlaceCard) => void; notify: (text: string) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; world: { x: number; y: number } } | null>(null);
  const centered = useRef(false);
  const [size, setSize] = useState({ w: 360, h: 320 });
  const [zoom, setZoom] = useState(14);
  const [center, setCenter] = useState(cityCenter);
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    centered.current = false;
    setCenter(cityCenter);
    setZoom(14);
  }, [cityCenter.lat, cityCenter.lng]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setSize({ w: element.clientWidth, h: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (centered.current || !items.length) return;
    setCenter({
      lat: items.reduce((sum, item) => sum + item.location.lat, 0) / items.length,
      lng: items.reduce((sum, item) => sum + item.location.lng, 0) / items.length,
    });
    centered.current = true;
  }, [items]);

  const world = project(center.lat, center.lng, zoom);
  const left = world.x - size.w / 2;
  const top = world.y - size.h / 2;
  const tiles: { key: string; src: string; left: number; top: number }[] = [];
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + size.w) / TILE); tx += 1) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + size.h) / TILE); ty += 1) {
      const count = 2 ** zoom;
      const wrapped = ((tx % count) + count) % count;
      if (ty < 0 || ty >= count) continue;
      tiles.push({
        key: `${zoom}/${wrapped}/${ty}`,
        src: `https://tile.openstreetmap.org/${zoom}/${wrapped}/${ty}.png`,
        left: tx * TILE - left,
        top: ty * TILE - top,
      });
    }
  }

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, a')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, world };
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = unproject(
      drag.current.world.x - (event.clientX - drag.current.x),
      drag.current.world.y - (event.clientY - drag.current.y), zoom);
    setCenter({ lat: clamp(next.lat, -85, 85), lng: next.lng });
  };
  const endDrag = () => { drag.current = null; };

  return <div className="tile-map" ref={box} aria-label="Карта заведений"
    onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
    <div className="tile-layer">
      {tiles.map(tile => <img key={tile.key} src={tile.src} alt="" draggable={false} loading="lazy"
        style={{ left: `${tile.left}px`, top: `${tile.top}px` }} />)}
    </div>
    {me && (() => {
      const pos = project(me.lat, me.lng, zoom);
      const x = pos.x - left;
      const y = pos.y - top;
      if (x < -20 || y < -20 || x > size.w + 20 || y > size.h + 20) return null;
      return <span className="me-pin" style={{ left: `${x}px`, top: `${y}px` }} aria-label="Моё место" />;
    })()}
    {items.map(item => {
      const pos = project(item.location.lat, item.location.lng, zoom);
      return <button key={item.id} type="button" className="tile-pin" title={item.name}
        aria-label={item.name} style={{ left: `${pos.x - left}px`, top: `${pos.y - top}px` }}
        onPointerDown={event => event.stopPropagation()} onClick={() => onOpen(item)}>
        <span className={`tile-pin-photo${item.image ? ' with-photo' : ''}`}>
          <b>{item.name.slice(0, 1)}</b>
          {item.image && <img src={item.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
            onError={event => { event.currentTarget.style.display = 'none'; }} />}
        </span><em>{item.name}</em>
      </button>;
    })}
    <div className="map-tools">
      <button type="button" aria-label="Приблизить" onClick={() => setZoom(value => clamp(value + 1, 11, 18))}>+</button>
      <button type="button" aria-label="Отдалить" onClick={() => setZoom(value => clamp(value - 1, 11, 18))}>−</button>
      <button type="button" aria-label="Где я" onClick={() => {
        if (!navigator.geolocation) return notify('Геолокация недоступна');
        navigator.geolocation.getCurrentPosition(
          position => {
            const point = { lat: position.coords.latitude, lng: position.coords.longitude };
            setMe(point);
            setCenter(point);
            setZoom(15);
          },
          () => notify('Не удалось определить положение. Карта работает без геолокации.'),
          { timeout: 8000, enableHighAccuracy: true, maximumAge: 60000 });
      }}>◎</button>
    </div>
    <p className="map-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></p>
  </div>;
}

function destinationsFor(city: City | null): TripPoint[] {
  if (city?.slug === 'slyudyanka') {
    return [
      { label: 'Вокзал', lat: 51.658634, lng: 103.724241 },
      { label: 'Рынок', lat: 51.654955, lng: 103.717088 },
      { label: 'Центр', lat: city.center.lat, lng: city.center.lng },
    ];
  }
  return city ? [{ label: 'Центр', lat: city.center.lat, lng: city.center.lng }] : [];
}

const tripStatusLabel: Record<TripStatus, string> = {
  requested: 'Ищем водителя', assigned: 'Водитель едет', arrived: 'Водитель на месте',
  in_progress: 'В пути', completed: 'Завершена', cancelled: 'Отменена',
};
const TRIP_ACTIVE: TripStatus[] = ['requested', 'assigned', 'arrived', 'in_progress'];

function TripMap({ from, to, stops = [], center: mapCenter, onPick, readOnly = false, busy = false }: {
  from: TripPoint | null; to: TripPoint | null; stops?: TripPoint[];
  center: { lat: number; lng: number }; onPick: (point: { lat: number; lng: number }) => void;
  readOnly?: boolean; busy?: boolean;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 360, h: 220 });
  const [route, setRoute] = useState<RoadRoute | null>(null);
  const [view, setView] = useState<{ center: { lat: number; lng: number }; zoom: number } | null>(null);
  const drag = useRef<{ x: number; y: number; center: { lat: number; lng: number }; zoom: number; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number; center: { lat: number; lng: number } } | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setSize({ w: element.clientWidth, h: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const stopKey = stops.map(point => `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`).join(';');
  useEffect(() => {
    if (!from || !to) { setRoute(null); return; }
    let cancelled = false;
    setRoute(null);
    void roadRoute(from, to, stops).then(value => { if (!cancelled) setRoute(value); });
    return () => { cancelled = true; };
  }, [from?.lat, from?.lng, to?.lat, to?.lng, stopKey]);

  useEffect(() => { setView(null); }, [from?.lat, from?.lng, to?.lat, to?.lng, stopKey]);

  const routePoints = route?.points ?? (from && to
    ? [[from.lat, from.lng], ...stops.map(point => [point.lat, point.lng] as [number, number]), [to.lat, to.lng]]
    : []);
  const bounds = routePoints.length
    ? routePoints
    : from ? [[from.lat, from.lng] as [number, number]]
      : to ? [[to.lat, to.lng] as [number, number]]
        : [[mapCenter.lat, mapCenter.lng] as [number, number]];
  const lats = bounds.map(point => point[0]);
  const lngs = bounds.map(point => point[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const fitCenter = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
  let fitZoom = 14;
  if (from && to) {
    const latSpan = Math.max(maxLat - minLat, 0.002);
    const lngSpan = Math.max(maxLng - minLng, 0.002);
    const fitX = Math.log2((size.w * 0.82) * 360 / lngSpan / TILE);
    const mercator = 1 / Math.cos(fitCenter.lat * Math.PI / 180);
    const fitY = Math.log2((size.h * 0.72) * 360 / latSpan / mercator / TILE);
    fitZoom = clamp(Math.floor(Math.min(fitX, fitY)), 9, 16);
  } else if (from || to) {
    fitZoom = 16;
  }
  const activeCenter = view?.center ?? fitCenter;
  const zoom = view?.zoom ?? fitZoom;
  const world = project(activeCenter.lat, activeCenter.lng, zoom);
  const left = world.x - size.w / 2;
  const top = world.y - size.h / 2;
  const tiles: { key: string; src: string; left: number; top: number }[] = [];
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + size.w) / TILE); tx += 1) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + size.h) / TILE); ty += 1) {
      const count = 2 ** zoom;
      const wrapped = ((tx % count) + count) % count;
      if (ty < 0 || ty >= count) continue;
      tiles.push({ key: `${zoom}/${wrapped}/${ty}`, src: `https://tile.openstreetmap.org/${zoom}/${wrapped}/${ty}.png`,
        left: tx * TILE - left, top: ty * TILE - top });
    }
  }
  const routePath = routePoints.map(([lat, lng], index) => {
    const point = project(lat, lng, zoom);
    return `${index ? 'L' : 'M'}${point.x - left} ${point.y - top}`;
  }).join(' ');
  const pointStyle = (point: TripPoint) => {
    const projected = project(point.lat, point.lng, zoom);
    return { left: `${projected.x - left}px`, top: `${projected.y - top}px` };
  };

  function pickAt(clientX: number, clientY: number) {
    if (readOnly || !box.current) return;
    const rect = box.current.getBoundingClientRect();
    const point = unproject(left + clientX - rect.left, top + clientY - rect.top, zoom);
    onPick({ lat: point.lat, lng: point.lng });
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const wasTap = !cancelled && drag.current && !drag.current.moved && pointers.current.size === 1 && !pinch.current;
    pointers.current.delete(event.pointerId);
    if (wasTap) pickAt(event.clientX, event.clientY);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return <div className={`tile-map trip-map${readOnly ? ' readonly' : ''}`} ref={box} aria-label="Карта маршрута"
    onPointerDown={event => {
      if (event.button !== undefined && event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 1) {
        drag.current = { x: event.clientX, y: event.clientY, center: activeCenter, zoom, moved: false };
      } else if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom, center: activeCenter };
        drag.current = null;
      }
    }}
    onPointerMove={event => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch.current && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const nextZoom = clamp(Math.round(pinch.current.zoom + Math.log2(distance / pinch.current.distance)), 5, 19);
        setView({ center: pinch.current.center, zoom: nextZoom });
        return;
      }
      if (!drag.current || pointers.current.size !== 1) return;
      const dx = event.clientX - drag.current.x;
      const dy = event.clientY - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
      if (!drag.current.moved) return;
      const start = project(drag.current.center.lat, drag.current.center.lng, drag.current.zoom);
      const next = unproject(start.x - dx, start.y - dy, drag.current.zoom);
      setView({ center: next, zoom: drag.current.zoom });
    }}
    onPointerUp={event => endDrag(event)}
    onPointerCancel={event => endDrag(event, true)}
    onWheel={event => {
      event.preventDefault();
      const nextZoom = clamp(zoom + (event.deltaY < 0 ? 1 : -1), 5, 19);
      setView({ center: activeCenter, zoom: nextZoom });
    }}
    onDoubleClick={event => {
      event.preventDefault();
      setView({ center: activeCenter, zoom: clamp(zoom + 1, 5, 19) });
    }}>
    <div className="tile-layer">
      {tiles.map(tile => <img key={tile.key} src={tile.src} alt="" draggable={false} loading="lazy"
        style={{ left: `${tile.left}px`, top: `${tile.top}px` }} />)}
    </div>
    {from && to && <svg className="route-line" width={size.w} height={size.h} aria-hidden="true">
      <path className="route-casing" d={routePath} />
      <path className="route-path" d={routePath} />
    </svg>}
    {stops.map((stop, index) => <span className="trip-pin stop" key={`${stop.lat}-${stop.lng}-${index}`}
      style={pointStyle(stop)}><span>{index + 1}</span></span>)}
    {from && <span className="trip-pin from" style={pointStyle(from)}><span /></span>}
    {to && <span className="trip-pin to" style={pointStyle(to)}><span /></span>}
    <div className="trip-map-tools" onPointerDown={event => event.stopPropagation()}>
      <button type="button" aria-label="Приблизить" onClick={() => setView({ center: activeCenter, zoom: clamp(zoom + 1, 5, 19) })}>+</button>
      <button type="button" aria-label="Отдалить" onClick={() => setView({ center: activeCenter, zoom: clamp(zoom - 1, 5, 19) })}>−</button>
      <button type="button" aria-label="Показать весь маршрут" onClick={() => setView(null)}>⌖</button>
    </div>
    {busy && <div className="map-geo-busy"><Icon name="pin" size={14} />Определяем адрес…</div>}
    <p className="map-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></p>
    {!readOnly && !busy && <span className="trip-map-hint">Тяните и масштабируйте · тап по адресу</span>}
  </div>;
}

function TripProgress({ status }: { status: TripStatus }) {
  const steps: { key: TripStatus[]; label: string }[] = [
    { key: ['requested'], label: 'Заказ' },
    { key: ['assigned', 'arrived'], label: 'Водитель' },
    { key: ['in_progress'], label: 'В пути' },
    { key: ['completed'], label: 'Финиш' },
  ];
  const index = status === 'completed' ? 3 : steps.findIndex(step => step.key.includes(status));
  return <div className="trip-progress" aria-label="Этапы поездки">
    {steps.map((step, position) => <div key={step.label}
      className={`trip-step${position < index ? ' done' : ''}${position === index ? ' current' : ''}`}>
      <span className="trip-step-dot" />
      <span className="trip-step-label">{step.label}</span>
    </div>)}
  </div>;
}

function formatRideTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function TripSummary({ trip, children, showClient = false, onRepeat, onCash, cashLabel = 'Наличные переданы' }: {
  trip: Trip; children?: ReactNode; showClient?: boolean;
  onRepeat?: () => void; onCash?: () => void; cashLabel?: string;
}) {
  const requirements = trip.requirements;
  const stops = trip.stops ?? [];
  const hasRequirements = requirements && (requirements.passengers > 1 || requirements.childSeat
    || requirements.luggage || requirements.pets || requirements.comment);
  return <div className="trip-card">
    <div className="trip-card-head">
      <span className={`status ${trip.status}`}><span className="dot" />{tripStatusLabel[trip.status]}</span>
      <strong>{trip.price ? price(trip.price) : 'Договорная'}</strong>
    </div>
    <div className="trip-route">
      <span className="route-dot from" />
      <p>{trip.from.label}</p>
      <span className="route-dot to" />
      <p>{trip.to.label}</p>
    </div>
    {stops.length > 0 && <p className="meta trip-stops"><Icon name="pin" size={12} />через {stops.map(stop => stop.label).join(' → ')}</p>}
    <p className="meta trip-meta"><Icon name="car" size={13} />{trip.distanceKm.toFixed(1)} км · {trip.durationMin} мин
      {trip.scheduledFor ? ` · на ${formatRideTime(trip.scheduledFor)}` : ''}</p>
    {hasRequirements && <div className="ride-tags">
      {requirements.passengers > 1 && <span><Icon name="user" size={11} />{requirements.passengers}</span>}
      {requirements.childSeat && <span><Icon name="child" size={11} />Ребёнок</span>}
      {requirements.luggage && <span><Icon name="bag" size={11} />Багаж</span>}
      {requirements.pets && <span><Icon name="paw" size={11} />Питомец</span>}
      {requirements.comment && <span className="ride-comment">{requirements.comment}</span>}
    </div>}
    {showClient && <p className="meta trip-client"><Icon name="user" size={13} />{trip.client.name}</p>}
    {trip.driver && <div className="driver-line">
      <span className="mini-avatar">{trip.driver.name.slice(0, 1)}</span>
      <strong>{trip.driver.name}</strong>
      <span className="meta">{trip.driver.car} · {trip.driver.plate}</span>
      {trip.driver.rating != null && <span className="driver-rating"><Icon name="star" size={10} />{trip.driver.rating.toFixed(1)}</span>}
      {trip.driver.verified && <span className="driver-verified">Проверен</span>}
    </div>}
    {trip.status === 'completed' && <p className="meta cash-state">
      <Icon name="receipt" size={12} />
      {trip.cash?.client ? 'клиент передал' : 'клиент не подтвердил'} · {trip.cash?.driver ? 'водитель получил' : 'водитель не подтвердил'}
    </p>}
    {(children || onRepeat || onCash) && <div className="trip-actions">
      {children}
      {onRepeat && <button type="button" className="ghost-mini" onClick={onRepeat}>Повторить</button>}
      {onCash && <button type="button" className="ghost-mini accent" onClick={onCash}>{cashLabel}</button>}
    </div>}
  </div>;
}

type AddressTarget = { kind: 'from' | 'to' | 'stop'; id?: string };
type StopDraft = { id: string; query: string; point: TripPoint | null };

function pointFromPlace(place: GeoPlace): TripPoint {
  return { label: place.label, address: place.address, lat: place.lat, lng: place.lng };
}

function localDateTimeValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function WaitingTimer({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return <span className="wait-timer"><Icon name="clock" size={12} />Ожидание {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>;
}

function TripOffers({ offers, offersLeft, busyOffer, onChoose }: {
  offers: TripOffer[]; offersLeft?: number; busyOffer: string | null; onChoose: (offer: TripOffer) => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(offersLeft ?? 0);
  useEffect(() => { setSecondsLeft(offersLeft ?? 0); }, [offersLeft]);
  useEffect(() => {
    const timer = setInterval(() => setSecondsLeft(value => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, []);
  const pending = offers.filter(offer => offer.status === 'pending')
    .sort((a, b) => a.price.cents - b.price.cents
      || (b.driver.rating ?? 0) - (a.driver.rating ?? 0)
      || (a.etaMin ?? 999) - (b.etaMin ?? 999));
  const shown = pending.slice(0, 3);
  const windowSeconds = secondsLeft;
  return <div className="trip-offers">
    <div className="section-title"><h2>Предложения водителей</h2>
      {windowSeconds > 0
        ? <span className="offer-window"><Icon name="clock" size={11} />{Math.floor(windowSeconds / 60)}:{String(windowSeconds % 60).padStart(2, '0')}</span>
        : <span className="count-chip">{pending.length}</span>}
    </div>
    {shown.length === 0
      ? <div className="trip-offers-empty">
        <span className="taxi-empty-icon"><Icon name="car" size={19} /></span>
        <div><strong>Ждём предложения</strong><span>Водители увидят заказ и предложат цену</span></div>
      </div>
      : shown.map(offer => <div className="trip-offer" key={offer.id}>
        <span className="mini-avatar">{offer.driver.name.slice(0, 1)}</span>
        <div className="trip-offer-info">
          <strong>{offer.driver.name}</strong>
          <span>{offer.driver.car} · {offer.driver.plate}{offer.etaMin ? ` · ${offer.etaMin} мин` : ''}</span>
          {(offer.driver.rating != null || offer.driver.ridesCount) && <em>
            {offer.driver.rating != null ? `★ ${offer.driver.rating.toFixed(1)}` : ''}
            {offer.driver.rating != null && offer.driver.ridesCount ? ' · ' : ''}
            {offer.driver.ridesCount ? `${offer.driver.ridesCount} поездок` : ''}
            {offer.driver.verified ? ' · проверен' : ''}
          </em>}
          {offer.message && <p>{offer.message}</p>}
        </div>
        <div className="trip-offer-price">
          <strong>{price(offer.price)}</strong>
          <button type="button" className="primary mini" disabled={busyOffer === offer.id}
            onClick={() => onChoose(offer)}>{busyOffer === offer.id ? 'Выбираем…' : 'Выбрать'}</button>
        </div>
      </div>)}
    {pending.length > shown.length && <p className="offer-more">Ещё {pending.length - shown.length} предложения</p>}
  </div>;
}

function TaxiScreen({ me, city, notify, onLogin }: {
  me: Me | null; city: City | null; notify: (text: string) => void; onLogin: () => void;
}) {
  const cityPoint = city?.center ?? CITY;
  const destinations = destinationsFor(city);
  const [from, setFrom] = useState<TripPoint | null>(null);
  const [to, setTo] = useState<TripPoint | null>(null);
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [stops, setStops] = useState<StopDraft[]>([]);
  const [active, setActive] = useState<AddressTarget | null>(null);
  const [suggestions, setSuggestions] = useState<GeoPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [pickBusy, setPickBusy] = useState(false);
  const [preorder, setPreorder] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [scheduledFor, setScheduledFor] = useState('');
  const [passengers, setPassengers] = useState(1);
  const [childSeat, setChildSeat] = useState(false);
  const [luggage, setLuggage] = useState(false);
  const [pets, setPets] = useState(false);
  const [comment, setComment] = useState('');
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyOffer, setBusyOffer] = useState<string | null>(null);

  const stopKey = stops.map(stop => stop.point ? `${stop.point.lat.toFixed(5)},${stop.point.lng.toFixed(5)}` : stop.id).join(';');
  const activeText = active?.kind === 'from' ? fromText
    : active?.kind === 'to' ? toText
      : active?.kind === 'stop' ? stops.find(stop => stop.id === active.id)?.query ?? ''
        : '';

  const load = useCallback(() => {
    if (!me) { setTrips([]); return; }
    void api<{ items: Trip[] }>('/api/v1/me/trips').then(data => setTrips(data.items)).catch(() => setTrips([]));
  }, [me]);
  useEffect(load, [load]);

  const activeTrip = trips?.find(trip => TRIP_ACTIVE.includes(trip.status)) ?? null;
  useEffect(() => {
    if (!activeTrip) return;
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [activeTrip?.id, load]);

  useEffect(() => {
    setFrom(null); setTo(null); setFromText(''); setToText(''); setStops([]);
    setActive(null); setSuggestions([]); setPreorder(false); setScheduledFor('');
  }, [city?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const query = activeText.trim();
    if (!active || query.length < 3) { setSuggestions([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void searchAddress(query, city?.slug)
        .then(items => { if (!cancelled) setSuggestions(items); })
        .catch(() => { if (!cancelled) setSuggestions([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, activeText, city?.slug]);

  useEffect(() => {
    if (!from || !to) { setEstimate(null); setQuoteLoading(false); return; }
    let cancelled = false;
    setQuoteLoading(true);
    setEstimate(null);
    const selectedStops = stops.map(stop => stop.point).filter(Boolean) as TripPoint[];
    void api<Estimate>('/api/v1/trips/estimate', { method: 'POST', body: { from, to, stops: selectedStops } })
      .then(data => { if (!cancelled) setEstimate(data); })
      .catch(() => { if (!cancelled) setEstimate(null); })
      .finally(() => { if (!cancelled) setQuoteLoading(false); });
    return () => { cancelled = true; };
  }, [from?.lat, from?.lng, to?.lat, to?.lng, stopKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function setAddressText(target: AddressTarget, value: string) {
    setActive(target);
    if (target.kind === 'from') {
      setFromText(value);
      if (from && value !== from.label) setFrom(null);
    } else if (target.kind === 'to') {
      setToText(value);
      if (to && value !== to.label) setTo(null);
    } else {
      setStops(current => current.map(stop => stop.id === target.id ? { ...stop, query: value, point: null } : stop));
    }
  }

  function applyPlace(place: GeoPlace, target: AddressTarget) {
    const point = pointFromPlace(place);
    haptic(4);
    if (target.kind === 'from') { setFrom(point); setFromText(point.label); }
    else if (target.kind === 'to') { setTo(point); setToText(point.label); }
    else setStops(current => current.map(stop => stop.id === target.id ? { ...stop, query: point.label, point } : stop));
    setActive(null);
    setSuggestions([]);
  }

  async function pickOnMap(point: { lat: number; lng: number }) {
    const target = active ?? (!from ? { kind: 'from' as const } : { kind: 'to' as const });
    setPickBusy(true);
    try {
      const place = await reverseAddress(point.lat, point.lng);
      if (!place) { notify('Адрес не найден — введите улицу и дом вручную'); return; }
      applyPlace(place, target);
    } catch {
      notify('Не удалось определить адрес — введите его вручную');
    } finally { setPickBusy(false); }
  }

  async function locateFrom() {
    if (!navigator.geolocation) return notify('Геолокация недоступна');
    notify('Определяем адрес…');
    navigator.geolocation.getCurrentPosition(async position => {
      setPickBusy(true);
      try {
        const place = await reverseAddress(position.coords.latitude, position.coords.longitude);
        if (!place) { notify('Адрес не найден — введите его вручную'); return; }
        applyPlace(place, { kind: 'from' });
      } catch {
        notify('Не удалось определить адрес');
      } finally { setPickBusy(false); }
    }, () => notify('Не удалось определить положение'), { timeout: 10000, enableHighAccuracy: true, maximumAge: 30000 });
  }

  async function quickDestination(point: TripPoint) {
    setActive({ kind: 'to' });
    setTo(null);
    setToText(point.label);
    try {
      const items = await searchAddress(point.label, city?.slug);
      if (items[0]) applyPlace(items[0], { kind: 'to' });
      else notify('Уточните адрес в строке «Куда»');
    } catch {
      notify('Не удалось найти адрес');
    }
  }

  function addStop() {
    if (stops.length >= 2) return;
    const id = `stop-${Date.now()}`;
    setStops(current => [...current, { id, query: '', point: null }]);
    setActive({ kind: 'stop', id });
    haptic(3);
  }

  function removeStop(id: string) {
    setStops(current => current.filter(stop => stop.id !== id));
    if (active?.kind === 'stop' && active.id === id) setActive(null);
  }

  async function order() {
    if (!me) { onLogin(); return; }
    if (!from || !to) {
      setActive({ kind: !from ? 'from' : 'to' });
      notify(!from ? 'Укажите адрес отправления' : 'Укажите адрес назначения');
      return;
    }
    if (preorder && !scheduledFor) { notify('Укажите время поездки'); return; }
    if (preorder && new Date(scheduledFor).getTime() <= Date.now() + 60_000) {
      notify('Время поездки должно быть в будущем'); return;
    }
    setBusy(true);
    try {
      const selectedStops = stops.map(stop => stop.point).filter(Boolean) as TripPoint[];
      await api<Trip>('/api/v1/trips', {
        method: 'POST',
        body: {
          from, to, stops: selectedStops,
          scheduledFor: preorder && scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
          passengers, childSeat, luggage, pets, comment,
          idempotencyKey: `taxi-${Date.now()}`,
        },
      });
      notify(preorder ? 'Предзаказ создан — ждём предложения водителей' : 'Заказ создан, ждём предложения водителей');
      load();
    } catch (error) {
      const code = (error as { code?: string }).code;
      notify(code === 'active_trip' ? 'У вас уже есть активная поездка'
        : code === 'time_in_past' ? 'Время поездки уже прошло'
          : 'Не удалось заказать такси');
    } finally { setBusy(false); }
  }

  async function cancel(id: string) {
    try {
      await api(`/api/v1/trips/${id}/cancel`, { method: 'POST' });
      notify('Поездка отменена');
      load();
    } catch { notify('Не удалось отменить'); }
  }

  async function chooseOffer(trip: Trip, offer: TripOffer) {
    setBusyOffer(offer.id);
    try {
      await api(`/api/v1/trips/${trip.id}/offers/${offer.id}/accept`, { method: 'POST' });
      notify(`Водитель выбран · ${price(offer.price)}`);
      load();
    } catch (error) {
      const code = (error as { code?: string }).code;
      notify(code === 'driver_busy' ? 'Водитель уже занят другой поездкой' : 'Не удалось выбрать водителя');
    } finally { setBusyOffer(null); }
  }

  async function confirmCash(trip: Trip) {
    try {
      await api(`/api/v1/trips/${trip.id}/cash`, { method: 'POST' });
      notify('Передача наличных отмечена');
      load();
    } catch { notify('Не удалось отметить оплату'); }
  }

  function repeatTrip(trip: Trip) {
    setFrom(trip.from); setFromText(trip.from.label);
    setTo(trip.to); setToText(trip.to.label);
    setStops((trip.stops ?? []).map(stop => ({ id: `stop-${Math.random()}`, query: stop.label, point: stop })));
    if (trip.requirements) {
      setPassengers(trip.requirements.passengers);
      setChildSeat(trip.requirements.childSeat);
      setLuggage(trip.requirements.luggage);
      setPets(trip.requirements.pets);
      setComment(trip.requirements.comment);
    }
    setActive(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const detailsLabel = [passengers > 1 ? `${passengers}` : '', childSeat ? 'ребёнок' : '',
    luggage ? 'багаж' : '', pets ? 'питомец' : ''].filter(Boolean).join(' · ') || 'Детали';
  const history = (trips ?? []).filter(trip => !TRIP_ACTIVE.includes(trip.status)).slice(0, 5);
  const scheduleMin = localDateTimeValue(new Date(Date.now() + 5 * 60000));
  const scheduleMax = localDateTimeValue(new Date(Date.now() + 7 * 86400_000));
  const suggestionsOpen = !!active && activeText.trim().length >= 3;

  return <section className="taxi">
    <div className="taxi-head">
      <span className="taxi-badge"><Icon name="car" size={24} /></span>
      <div><h1>Такси</h1><span className="meta">по городу · цена договорная · наличными</span></div>
    </div>

    {activeTrip ? <>
      <div className="taxi-map-shell active">
        <TripMap from={activeTrip.from} to={activeTrip.to} stops={activeTrip.stops ?? []} center={cityPoint}
          onPick={() => {}} readOnly />
        <div className="taxi-map-badge"><span><Icon name="car" size={13} />{tripStatusLabel[activeTrip.status]}</span><span>наличными</span></div>
      </div>
      <TripSummary trip={activeTrip}>
        {(activeTrip.status === 'requested' || activeTrip.status === 'assigned' || activeTrip.status === 'arrived') &&
          <button type="button" className="ghost-mini" onClick={() => void cancel(activeTrip.id)}>Отменить поездку</button>}
        {activeTrip.status === 'arrived' && activeTrip.arrivedAt && <WaitingTimer since={activeTrip.arrivedAt} />}
        {activeTrip.status === 'in_progress' && <span className="meta"><Icon name="shield" size={13} /> В пути</span>}
      </TripSummary>
      {activeTrip.status === 'requested' && <TripOffers offers={activeTrip.offers ?? []} offersLeft={activeTrip.offersLeft}
        busyOffer={busyOffer} onChoose={offer => void chooseOffer(activeTrip, offer)} />}
      <TripProgress status={activeTrip.status} />
      <p className="hint">{activeTrip.status === 'requested'
        ? 'Водители предлагают цену, вы выбираете. Оплата наличными водителю.'
        : 'Статус обновляется автоматически. Водитель подтвердит посадку.'}</p>
    </> : <>
      <div className="taxi-map-shell">
        <TripMap from={from} to={to} stops={stops.map(stop => stop.point).filter(Boolean) as TripPoint[]}
          center={cityPoint} onPick={point => void pickOnMap(point)} busy={pickBusy} />
        <div className="taxi-map-badge">
          <span><Icon name="pin" size={13} />{city?.name ?? 'Город'}</span>
          <span>наличными</span>
        </div>
      </div>

      <div className="taxi-panel">
        <div className="route-card">
          <div className="route-line-row">
            <span className="route-dot from" />
            <div className="route-field">
              <span className="meta">Откуда</span>
              <input value={fromText} onChange={event => setAddressText({ kind: 'from' }, event.target.value)}
                onFocus={() => setActive({ kind: 'from' })} placeholder="Улица и дом" autoComplete="off" />
            </div>
            <button type="button" className="round-btn locate" aria-label="Моё место" onClick={() => void locateFrom()}>
              <Icon name="pin" size={17} />
            </button>
          </div>
          {stops.map((stop, index) => <div className="route-line-row stop-row" key={stop.id}>
            <span className="route-dot stop" />
            <div className="route-field">
              <span className="meta">Заезд {index + 1}</span>
              <input value={stop.query} onChange={event => setAddressText({ kind: 'stop', id: stop.id }, event.target.value)}
                onFocus={() => setActive({ kind: 'stop', id: stop.id })} placeholder="Промежуточный адрес" autoComplete="off" />
            </div>
            <button type="button" className="route-remove" aria-label="Убрать заезд" onClick={() => removeStop(stop.id)}>
              <Icon name="close" size={14} />
            </button>
          </div>)}
          <div className="route-line-row">
            <span className="route-dot to" />
            <div className="route-field to">
              <span className="meta">Куда</span>
              <input value={toText} onChange={event => setAddressText({ kind: 'to' }, event.target.value)}
                onFocus={() => setActive({ kind: 'to' })} placeholder="Адрес или место" autoComplete="off" />
            </div>
            <button type="button" className="route-add" aria-label="Добавить заезд" onClick={addStop} disabled={stops.length >= 2}>
              <Icon name="plus" size={15} />
            </button>
          </div>
        </div>

        {suggestionsOpen && <div className="address-suggestions">
          <div className="address-suggestions-head">
            <span>{searching ? 'Ищем адрес…' : suggestions.length ? 'Выберите адрес' : 'Ничего не найдено'}</span>
            <button type="button" aria-label="Закрыть подсказки" onClick={() => setActive(null)}><Icon name="close" size={12} /></button>
          </div>
          {suggestions.map((place, index) => <button type="button" key={`${place.lat}-${place.lng}-${index}`}
            className="address-suggestion" onMouseDown={event => event.preventDefault()}
            onClick={() => applyPlace(place, active!)}>
            <span className="address-suggestion-icon"><Icon name="pin" size={14} /></span>
            <span><strong>{place.label}</strong><small>{place.address}</small></span>
          </button>)}
        </div>}

        {!to && <div className="quick-dest">
          {destinations.map(point => <button key={point.label} type="button" onClick={() => void quickDestination(point)}>
            <Icon name="pin" size={12} />{point.label}
          </button>)}
        </div>}

        {to && <>
          <div className="ride-details-row">
            <div className="segmented two compact">
              <button type="button" className={!preorder ? 'active' : ''} onClick={() => setPreorder(false)}>Сейчас</button>
              <button type="button" className={preorder ? 'active' : ''} onClick={() => {
                setPreorder(true);
                if (!scheduledFor) setScheduledFor(localDateTimeValue(new Date(Date.now() + 30 * 60000)));
              }}>Предзаказ</button>
            </div>
            <button type="button" className={`details-toggle${detailsOpen ? ' open' : ''}`}
              aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}>
              <Icon name="user" size={11} />{detailsLabel}<Icon name="chevron" size={11} />
            </button>
          </div>
          {preorder && <input className="preorder-time" type="datetime-local" value={scheduledFor} min={scheduleMin} max={scheduleMax}
            onChange={event => setScheduledFor(event.target.value)} aria-label="Время поездки" />}
          {detailsOpen && <div className="ride-details">
            <div className="ride-options">
              <label className="passenger-picker" title="Пассажиры">
                <Icon name="user" size={14} />
                <select value={passengers} onChange={event => setPassengers(Number(event.target.value))} aria-label="Пассажиры">
                  {[1, 2, 3, 4, 5, 6].map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <button type="button" className={childSeat ? 'active' : ''} aria-pressed={childSeat}
                onClick={() => setChildSeat(value => !value)}><Icon name="child" size={13} />Ребёнок</button>
              <button type="button" className={luggage ? 'active' : ''} aria-pressed={luggage}
                onClick={() => setLuggage(value => !value)}><Icon name="bag" size={13} />Багаж</button>
              <button type="button" className={pets ? 'active' : ''} aria-pressed={pets}
                onClick={() => setPets(value => !value)}><Icon name="paw" size={13} />Питомец</button>
            </div>
            <input className="ride-comment-input" value={comment} maxLength={300}
              onChange={event => setComment(event.target.value)} placeholder="Комментарий водителю (необязательно)" />
          </div>}
        </>}

        {quoteLoading && <div className="estimate-card estimate-loading">
          <span><Icon name="refresh" size={14} />Строим маршрут по дорогам…</span>
        </div>}

        {estimate && <div className="estimate-card">
          <div className="route-summary">
            <span className="route-summary-icon"><Icon name="pin" size={19} /></span>
            <div><strong>Маршрут готов</strong>
              <span>{estimate.distanceKm.toFixed(1)} км · {estimate.durationMin} мин · {estimate.route === 'osrm' ? 'по дорогам' : 'напрямую'}</span></div>
          </div>
          <button type="button" className="primary" disabled={busy || !to || !from} onClick={() => void order()}>
            {busy ? 'Заказываем…' : me ? (preorder ? 'Оформить предзаказ' : 'Заказать поездку') : 'Войти и заказать'}<Icon name="chevron" size={16} />
          </button>
          <p className="hint">Цену предложат водители — вы выберете подходящую.</p>
        </div>}
      </div>
    </>}

    {history.length > 0 && <>
      <div className="section-title"><h2>История</h2><span className="count-chip">{history.length}</span></div>
      <div className="trip-history">{history.map(trip => <TripSummary key={trip.id} trip={trip}
        onRepeat={() => repeatTrip(trip)}
        onCash={trip.status === 'completed' && !trip.cash?.client ? () => void confirmCash(trip) : undefined} />)}</div>
    </>}
  </section>;
}

function DriverPanel({ notify }: { notify: (text: string) => void }) {
  const [data, setData] = useState<{ available: Trip[]; mine: Trip[]; completed: Trip[] } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { price: string; eta: string }>>({});
  const load = useCallback(() => {
    void api<{ available: Trip[]; mine: Trip[]; completed: Trip[] }>('/api/v1/driver/trips')
      .then(setData).catch(() => setData({ available: [], mine: [], completed: [] }));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(id: string, action: 'arrive' | 'start' | 'complete') {
    try {
      await api(`/api/v1/trips/${id}/${action}`, { method: 'POST' });
      const text = { arrive: 'Отмечено: на месте', start: 'Поездка начата', complete: 'Поездка завершена' };
      notify(text[action]);
      load();
    } catch (error) {
      const code = (error as { code?: string }).code;
      notify(code === 'price_not_agreed' ? 'Сначала согласуйте цену с клиентом' : 'Не удалось обновить поездку');
    }
  }

  async function offer(trip: Trip) {
    const draft = drafts[trip.id] ?? { price: '', eta: '' };
    const rubles = Number(draft.price.replace(',', '.'));
    if (!Number.isFinite(rubles) || rubles < 50) {
      notify('Укажите цену от 50 ₽');
      return;
    }
    const eta = draft.eta ? Number(draft.eta) : null;
    try {
      await api(`/api/v1/trips/${trip.id}/offers`, {
        method: 'POST',
        body: { priceCents: Math.round(rubles * 100), etaMin: eta && eta > 0 ? Math.round(eta) : undefined },
      });
      notify(`Предложение отправлено · ${Math.round(rubles)} ₽`);
      load();
    } catch (error) {
      const code = (error as { code?: string }).code;
      notify(code === 'driver_busy' ? 'У вас уже есть активная поездка'
        : code === 'trip_taken' ? 'Заказ уже разобрали'
          : 'Не удалось отправить предложение');
    }
  }

  async function confirmCash(trip: Trip) {
    try {
      await api(`/api/v1/trips/${trip.id}/cash`, { method: 'POST' });
      notify('Получение наличных отмечено');
      load();
    } catch { notify('Не удалось отметить оплату'); }
  }

  function actions(trip: Trip) {
    if (trip.status === 'assigned') return <button type="button" className="primary mini" onClick={() => void act(trip.id, 'arrive')}>Я на месте</button>;
    if (trip.status === 'arrived') return <button type="button" className="primary mini" onClick={() => void act(trip.id, 'start')}>В путь</button>;
    if (trip.status === 'in_progress') return <button type="button" className="primary mini" onClick={() => void act(trip.id, 'complete')}>Завершить · наличные</button>;
    return null;
  }

  function offerControls(trip: Trip) {
    const own = trip.offers?.[0];
    if (own?.status === 'pending') {
      return <span className="my-offer"><span>Ваше предложение</span><strong>{price(own.price)}</strong></span>;
    }
    const draft = drafts[trip.id] ?? { price: '', eta: '' };
    const setDraft = (patch: Partial<{ price: string; eta: string }>) =>
      setDrafts(current => ({ ...current, [trip.id]: { ...draft, ...patch } }));
    return <div className="driver-offer-form">
      <input inputMode="decimal" placeholder="Цена, ₽" value={draft.price}
        onChange={event => setDraft({ price: event.target.value.replace(/[^0-9.,]/g, '').slice(0, 7) })} />
      <input inputMode="numeric" placeholder="мин" value={draft.eta}
        onChange={event => setDraft({ eta: event.target.value.replace(/[^0-9]/g, '').slice(0, 3) })} />
      <button type="button" className="primary mini" onClick={() => void offer(trip)}>Предложить</button>
    </div>;
  }

  return <div className="driver-panel">
    <div className="panel-title"><h2>Кабинет водителя</h2><span className="count-chip">{data ? data.mine.length : '—'}</span></div>
    {!data ? <div className="skeleton-card" />
      : !data.mine.length ? <p className="notice">Нет назначенных поездок</p>
        : data.mine.map(trip => <TripSummary key={trip.id} trip={trip} showClient>{actions(trip)}</TripSummary>)}
    {data && data.available.length > 0 && <>
      <h3 className="sub-title">Заказы без водителя</h3>
      {data.available.map(trip => <TripSummary key={trip.id} trip={trip} showClient>
        {offerControls(trip)}
      </TripSummary>)}
    </>}
    {data && data.completed.length > 0 && <>
      <h3 className="sub-title">Завершённые</h3>
      {data.completed.map(trip => <TripSummary key={trip.id} trip={trip} showClient
        onCash={!trip.cash?.driver ? () => void confirmCash(trip) : undefined}
        cashLabel="Наличные получены" />)}
    </>}
  </div>;
}

function DeliveryCard({ job, children }: { job: DeliveryJob; children?: ReactNode }) {
  return <div className="service-card delivery-card">
    <div className="service-card-head">
      <span className={`status ${job.status}`}><span className="dot" />{deliveryStatusLabel[job.status]}</span>
      <strong>{price(job.fee)}</strong>
    </div>
    <h3>{job.order.place.name}</h3>
    <p className="meta"><Icon name="pin" size={13} />{job.address} · {job.district}</p>
    <p className="meta"><Icon name="user" size={13} />{job.order.client.name} · заказ {price(job.order.total)} · {job.etaMin} мин</p>
    <div className="trip-actions">
      <span className="pickup-code"><Icon name="receipt" size={12} />{job.order.pickupCode}</span>
      {children}
    </div>
  </div>;
}

function CourierPanel({ notify }: { notify: (text: string) => void }) {
  const [data, setData] = useState<{ available: DeliveryJob[]; mine: DeliveryJob[] } | null>(null);
  const load = useCallback(() => {
    void api<{ available: DeliveryJob[]; mine: DeliveryJob[] }>('/api/v1/courier/delivery-jobs')
      .then(setData).catch(() => setData({ available: [], mine: [] }));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(id: string, action: 'claim' | 'pickup' | 'deliver') {
    try {
      await api(`/api/v1/courier/delivery-jobs/${id}/${action}`, { method: 'POST' });
      notify({ claim: 'Доставка взята', pickup: 'Заказ у вас, в путь', deliver: 'Доставлено' }[action]);
      load();
    } catch (error) {
      const code = (error as { code?: string }).code;
      notify(code === 'courier_busy' ? 'У вас уже есть активная доставка'
        : code === 'delivery_taken' ? 'Доставку уже взяли'
          : 'Не удалось обновить доставку');
    }
  }

  return <div className="driver-panel">
    <div className="panel-title"><h2>Кабинет курьера</h2><span className="count-chip">{data ? data.mine.length : '—'}</span></div>
    {!data ? <div className="skeleton-card" />
      : !data.mine.length ? <p className="notice">Нет активных доставок</p>
        : data.mine.map(job => <DeliveryCard key={job.id} job={job}>
          {job.status === 'assigned' && <button type="button" className="primary mini" onClick={() => void act(job.id, 'pickup')}>Забрал заказ</button>}
          {job.status === 'picked_up' && <button type="button" className="primary mini" onClick={() => void act(job.id, 'deliver')}>Доставил · наличные</button>}
        </DeliveryCard>)}
    {data && data.available.length > 0 && <>
      <h3 className="sub-title">Готовые заказы</h3>
      {data.available.map(job => <DeliveryCard key={job.id} job={job}>
        <button type="button" className="primary mini" onClick={() => void act(job.id, 'claim')}>Взять</button>
      </DeliveryCard>)}
    </>}
  </div>;
}

function OperatorDeliveries({ notify }: { notify: (text: string) => void }) {
  const [jobs, setJobs] = useState<DeliveryJob[] | null>(null);
  const [couriers, setCouriers] = useState<CourierInfo[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const load = useCallback(() => {
    void Promise.all([
      api<{ items: DeliveryJob[] }>('/api/v1/operator/delivery-jobs'),
      api<{ items: CourierInfo[] }>('/api/v1/operator/couriers'),
    ]).then(([jobsData, courierData]) => {
      setJobs(jobsData.items);
      setCouriers(courierData.items);
    }).catch(() => setJobs([]));
  }, []);
  useEffect(load, [load]);

  async function assign(job: DeliveryJob) {
    const courierUserId = picked[job.id];
    if (!courierUserId) return;
    try {
      await api(`/api/v1/operator/delivery-jobs/${job.id}/assign`, { method: 'POST', body: { courierUserId } });
      notify('Курьер назначен');
      load();
    } catch (error) {
      const code = (error as { code?: string }).code;
      notify(code === 'courier_busy' ? 'У курьера уже есть активная доставка' : 'Не удалось назначить');
    }
  }

  return <div className="partner-service">
    <div className="panel-title"><h2>Доставка</h2><span className="count-chip">{jobs ? jobs.length : '—'}</span></div>
    {!jobs && <div className="skeleton-card" />}
    {jobs && !jobs.length && <p className="notice">Активных доставок нет</p>}
    {jobs?.map(job => <div className="service-card delivery-card" key={job.id}>
      <div className="service-card-head">
        <span className={`status ${job.status}`}><span className="dot" />{deliveryStatusLabel[job.status]}</span>
        <strong>{price(job.fee)}</strong>
      </div>
      <h3>{job.order.place.name} → {job.address}</h3>
      <p className="meta"><Icon name="user" size={13} />{job.order.client.name} · {job.district} · {job.etaMin} мин</p>
      {job.courier && <p className="meta"><Icon name="car" size={13} />{job.courier.name}</p>}
      {job.status === 'pending' || job.status === 'assigned' ? <div className="assign-row">
        <select value={picked[job.id] ?? job.courier?.id ?? ''} onChange={event => setPicked(current => ({ ...current, [job.id]: event.target.value }))}>
          <option value="">Курьер</option>
          {couriers.map(courier => <option key={courier.id} value={courier.id}>
            {courier.display_name} · {courier.active_jobs > 0 ? 'занят' : courier.transport || 'свободен'}
          </option>)}
        </select>
        <button type="button" className="primary mini" disabled={!picked[job.id] && !job.courier}
          onClick={() => void assign(job)}>Назначить</button>
      </div> : null}
    </div>)}
  </div>;
}

function PlaceThumb({ place }: { place: PlaceCard }) {
  const [failed, setFailed] = useState(false);
  if (place.image && !failed) return <img className="place-thumb" src={place.image} alt=""
    loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  return <span className={`cat-avatar ${place.category}`} aria-hidden="true">
    <Icon name={categoryIcon[place.category]} size={21} />
  </span>;
}

function PlaceCover({ place, photos, onOpen }: {
  place: PlaceCard; photos?: PlacePhoto[]; onOpen?: (index: number) => void;
}) {
  const [failed, setFailed] = useState(false);
  const src = photos?.[0]?.large ?? place.image;
  if (!src || failed) return null;
  const content = <>
    <img src={src} alt={place.name} loading="eager" decoding="async"
      referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    <span className="cover-source">{place.source ? `2ГИС · ${photos?.length ?? 1} фото` : 'Фото'}</span>
  </>;
  return onOpen
    ? <button type="button" className="place-cover" onClick={() => onOpen(0)}
      aria-label={`Фотографии: ${place.name}`}>{content}</button>
    : <a className="place-cover" href={place.source ? `${place.source.url ?? '#'}/tab/photos` : src}
      target="_blank" rel="noopener noreferrer" aria-label={`Фотографии: ${place.name}`}>{content}</a>;
}

function PhotoRail({ photos, onOpen }: { photos: PlacePhoto[]; onOpen: (index: number) => void }) {
  if (photos.length < 2) return null;
  return <div className="photo-rail" aria-label="Фотографии организации">
    {photos.map((photo, index) => <button key={photo.small + index} type="button" className="photo-rail-item"
      onClick={() => onOpen(index)} aria-label={`Фото ${index + 1}`}>
      <img src={photo.small} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
    </button>)}
  </div>;
}

function Catalogue({ me, notify, withMap = false, onPick, city }: {
  me: Me | null; notify: (text: string) => void; withMap?: boolean; onPick?: () => void; city: City | null;
}) {
  const [category, setCategory] = useState<'all' | Category>('all');
  const [district, setDistrict] = useState('all');
  const [query, setQuery] = useState('');
  const [districts, setDistricts] = useState<string[]>([]);
  const [items, setItems] = useState<PlaceCard[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<PlaceCard | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const pullRef = useRef(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    void api<{ items: string[] }>(`/api/v1/districts?city=${encodeURIComponent(city?.slug ?? '')}`)
      .then(d => setDistricts(d.items)).catch(() => setDistricts([]));
  }, [city?.slug]);

  useEffect(() => {
    if (!city) return;
    if (district !== 'all') setDistrict('all');
  }, [city?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!city) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ city: city.slug, limit: '50' });
    if (category !== 'all') params.set('category', category);
    if (district !== 'all') params.set('district', district);
    if (query.trim()) params.set('q', query.trim());
    if (coords) {
      params.set('lat', String(coords.lat));
      params.set('lng', String(coords.lng));
    }
    setError(false);
    const timer = setTimeout(() => {
      void api<{ items: PlaceCard[]; total: number }>(`/api/v1/places?${params}`, { signal: controller.signal })
        .then(data => {
          if (controller.signal.aborted) return;
          setItems(data.items);
          setTotal(data.total ?? data.items.length);
          setRefreshing(false);
          setPull(0);
          pullRef.current = 0;
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setItems(null);
          setError(true);
          setRefreshing(false);
          setPull(0);
          pullRef.current = 0;
        });
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [category, district, query, refreshKey, city?.slug, coords?.lat, coords?.lng]);

  useEffect(() => {
    if (open || filterOpen || refreshing) return;
    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || window.scrollY > 0) return;
      touchStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const onMove = (event: TouchEvent) => {
      const start = touchStart.current;
      if (!start) return;
      if (window.scrollY > 0) { touchStart.current = null; pullRef.current = 0; setPull(0); return; }
      const dy = event.touches[0].clientY - start.y;
      const dx = event.touches[0].clientX - start.x;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
        if (dy < -4) { touchStart.current = null; pullRef.current = 0; setPull(0); }
        return;
      }
      if (dy > 6) event.preventDefault();
      const next = Math.min(108, Math.max(0, (dy - 6) * 0.55));
      pullRef.current = next;
      setPull(next);
    };
    const onEnd = () => {
      if (!touchStart.current) return;
      touchStart.current = null;
      if (pullRef.current > 56) {
        setRefreshing(true);
        setPull(52);
        pullRef.current = 52;
        setRefreshKey(value => value + 1);
      } else {
        setPull(0);
        pullRef.current = 0;
      }
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [open, filterOpen, refreshing]);

  function locate() {
    if (!navigator.geolocation) return notify('Геолокация недоступна');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      position => {
        setCoords({ lat: position.coords.latitude, lng: position.coords.longitude });
        setLocating(false);
        haptic([6, 20, 6]);
        notify('Сортируем по расстоянию от вас');
      },
      () => { setLocating(false); notify('Не удалось определить положение'); },
      { timeout: 8000, enableHighAccuracy: true, maximumAge: 60000 });
  }

  async function loadMore() {
    if (!city || !items || loadingMore || items.length >= total) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ city: city.slug, limit: '50', offset: String(items.length) });
      if (category !== 'all') params.set('category', category);
      if (district !== 'all') params.set('district', district);
      if (query.trim()) params.set('q', query.trim());
      if (coords) {
        params.set('lat', String(coords.lat));
        params.set('lng', String(coords.lng));
      }
      const data = await api<{ items: PlaceCard[]; total: number }>(`/api/v1/places?${params}`);
      setItems(current => current ? [...current, ...data.items] : data.items);
      setTotal(data.total ?? data.items.length);
      haptic(4);
    } catch {
      notify('Не удалось загрузить ещё');
    } finally { setLoadingMore(false); }
  }

  useModalHistory(Boolean(open), () => setOpen(null));
  if (open) return <PlaceScreen place={open} me={me} onBack={() => setOpen(null)} notify={notify} />;

  const firstName = me?.user.displayName.split(' ')[0];

  return <>
    <div className={`pull-indicator${refreshing || pull > 4 ? ' visible' : ''}${refreshing ? ' refreshing' : ''}`}
      style={{ transform: `translate(-50%, ${(refreshing ? 52 : pull) - 46}px)` }} role="status">
      <Icon name="refresh" size={15} />
      <span>{refreshing ? 'Обновляем…' : pull > 56 ? 'Отпустите' : 'Потяните вниз'}</span>
    </div>
    {withMap ? <div className="map-head">
      <span className="eyebrow"><Icon name="pin" size={14} /> {city?.name ?? 'Город'}</span>
      <span className="map-count">{total ? `${total} мест` : '…'}</span>
    </div> : <section className="spotlight">
      <div className="spotlight-copy">
        <span className="eyebrow"><span className="pulse" aria-hidden="true" />{firstName ? `${firstName}, вы рядом` : `${city?.name ?? 'Город'} · онлайн`}</span>
        <h1>Что делаем <em>сегодня?</em></h1>
        <div className="spotlight-tags">
          <span><Icon name="bolt" size={13} /> {total ? `${total} рядом` : 'ищем…'}</span>
          <span><Icon name="clock" size={13} /> свободно сейчас</span>
        </div>
      </div>
      <div className="spotlight-art" aria-hidden="true">
        <span className="orb" />
        <Icon name="sparkles" size={26} />
        {onPick && <button type="button" className="map-chip" onClick={onPick} aria-label="Открыть карту">
          <Icon name="map" size={17} />
        </button>}
      </div>
    </section>}

    <div className="search-row">
      <label className="search-box">
        <Icon name="search" size={17} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск" aria-label="Поиск" />
        {query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Очистить"><Icon name="close" size={14} /></button>}
      </label>
      <button type="button" className={`filter-button ${district !== 'all' ? 'active' : ''}`}
        onClick={() => { haptic(); setFilterOpen(true); }} aria-label="Фильтр по району">
        <Icon name="sliders" size={18} />
        {district !== 'all' && <span className="filter-dot" aria-hidden="true" />}
      </button>
    </div>

    {district !== 'all' && <button type="button" className="active-filter" onClick={() => { haptic(); setDistrict('all'); }}>
      <Icon name="pin" size={12} />{district}<Icon name="close" size={12} />
    </button>}

    <div className="filters" aria-label="Категории">
      {(Object.keys(categories) as (keyof typeof categories)[]).map(key =>
        <button key={key} type="button" className={category === key ? 'active' : ''} aria-pressed={category === key}
          onClick={() => { haptic(); setCategory(key as 'all' | Category); }}>
          <span className="filter-icon"><Icon name={categoryIcon[key]} size={16} /></span>
          <span>{categories[key]}</span>
        </button>)}
    </div>

    {withMap && <MapView key={city?.slug} items={items ?? []} center={city?.center ?? CITY} onOpen={setOpen} notify={notify} />}

    <section aria-labelledby="catalogue">
      <div className="section-title">
        <h2 id="catalogue">{withMap ? 'На карте' : 'Рядом с вами'}</h2>
        <span className="title-actions">
          <button type="button" className={`locate-chip${coords ? ' active' : ''}`}
            disabled={locating} onClick={locate} aria-label="Сортировать по расстоянию">
            <Icon name="pin" size={12} />{locating ? 'Ищем…' : coords ? 'Ближе' : 'Где я'}
          </button>
          <span className="count-chip">{total || (items ? items.length : '—')}</span>
        </span>
      </div>

      {error ? <div className="notice" role="status">
        <span>Каталог недоступен</span>
        <button type="button" className="ghost-mini" onClick={() => setCategory(c => c)}>Повторить</button>
      </div>
        : !items ? <ul className="places skeleton-list" aria-hidden="true">
          {[0, 1, 2].map(index => <li key={index}><div className="skeleton-card" style={{ animationDelay: `${index * 90}ms` }} /></li>)}
        </ul>
          : !items.length ? <div className="empty-state">
            <Icon name="search" size={26} />
            <p>Ничего не нашлось</p>
            <button type="button" className="ghost-mini" onClick={() => { setQuery(''); setDistrict('all'); setCategory('all'); }}>Сбросить</button>
          </div>
            : <ul className="places">{items.map((place, index) => {
              const rating = place.rating ?? place.source?.rating ?? null;
              return <li key={place.id} style={{ animationDelay: `${index * 45}ms` }}>
                <button type="button" className="place-button" onClick={() => setOpen(place)}>
                  <PlaceThumb place={place} />
                  <span className="details">
                    <span className="title-row">
                      <strong className="title">{place.name}</strong>
                      {rating !== null && <span className="rating"><Icon name="star" size={11} stroke={0} />{rating.toFixed(1)}</span>}
                    </span>
                    <span className="sub">
                      <span>{place.district}</span>
                      {place.distanceKm !== null && <span>{place.distanceKm.toFixed(1)} км</span>}
                      {place.offerCount > 0
                        ? <span>{place.offerCount} {plural(place.offerCount, 'услуга', 'услуги', 'услуг')}</span>
                        : place.source ? <span className="source-note">{place.source.name}</span> : null}
                    </span>
                  </span>
                  <span className="price-block">
                    <span className={`price${place.priceFrom === null ? ' source-price' : ''}`}>
                      {place.priceFrom === null && place.source ? place.source.name : price(place.priceFrom)}
                    </span>
                    <Icon name="chevron" size={16} />
                  </span>
                </button>
              </li>;
            })}</ul>}
      {items && total > items.length && <button type="button" className="ghost-mini wide load-more"
        disabled={loadingMore} onClick={() => void loadMore()}>
        {loadingMore ? 'Загружаем…' : `Показать ещё · ${total - items.length}`}
      </button>}
    </section>

    <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Район">
      <div className="sheet-options">
        {['all', ...districts].map(item => <button key={item} type="button"
          className={district === item ? 'selected' : ''}
          onClick={() => { haptic(); setDistrict(item); setFilterOpen(false); }}>
          <span>{item === 'all' ? 'Весь город' : item}</span>
          {district === item && <Icon name="check" size={17} />}
        </button>)}
      </div>
    </Sheet>
  </>;
}

function PlaceScreen({ place, me, onBack, notify }: { place: PlaceCard; me: Me | null; onBack: () => void; notify: (text: string) => void }) {
  const [detail, setDetail] = useState<PlaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [note, setNote] = useState('');
  const [showAllSlots, setShowAllSlots] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [fulfillment, setFulfillment] = useState<'pickup' | 'delivery'>('pickup');
  const [deliveryDistrict, setDeliveryDistrict] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewBody, setReviewBody] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewSent, setReviewSent] = useState(false);
  const [photoIndex, setPhotoIndex] = useState<number | null>(null);

  const loadDetail = useCallback(() => {
    void api<PlaceDetail>(`/api/v1/places/${place.id}`).then(setDetail).catch(() => setError('Карточка недоступна'));
  }, [place.id]);
  useEffect(loadDetail, [loadDetail]);

  useEffect(() => {
    if (!offer) return;
    setSlots(null);
    setSlot(null);
    setShowAllSlots(false);
    void api<{ slots: Slot[] }>(`/api/v1/offers/${offer.id}/slots`)
      .then(data => setSlots(data.slots))
      .catch(() => setSlots([]));
  }, [offer]);

  const cartItems = Object.entries(cart).filter(([, qty]) => qty > 0);
  const cartCount = cartItems.reduce((sum, [, qty]) => sum + qty, 0);
  const cartTotal = cartItems.reduce((sum, [id, qty]) => {
    const product = detail?.products.find(item => item.id === id);
    return sum + (product ? product.price.cents * qty : 0);
  }, 0);
  const zones = detail?.delivery.zones ?? [];
  const activeDistrict = deliveryDistrict || zones[0]?.district || '';
  const zone = zones.find(item => item.district === activeDistrict) ?? null;
  const deliveryFee = fulfillment === 'delivery' && zone ? zone.fee.cents : 0;
  const grandTotal = cartTotal + deliveryFee;

  function changeQty(product: ShopProduct, delta: number) {
    if (!me) { notify('Войдите, чтобы заказать'); return; }
    haptic(delta > 0 ? 5 : 3);
    setCart(current => {
      const next = Math.max(0, Math.min(product.stockQty, (current[product.id] ?? 0) + delta));
      return { ...current, [product.id]: next };
    });
  }

  async function checkout() {
    if (!me) { notify('Войдите, чтобы заказать'); return; }
    if (!cartItems.length) return;
    if (fulfillment === 'delivery') {
      if (!zone) { notify('Выберите район доставки'); return; }
      if (cartTotal < zone.minOrder.cents) {
        notify(`Минимальный заказ с доставкой — ${price(zone.minOrder)}`); return;
      }
      if (deliveryAddress.trim().length < 3) { notify('Укажите адрес доставки'); return; }
    }
    setBusy(true);
    try {
      const order = await api<ShopOrder>('/api/v1/me/shop-orders', { method: 'POST', body: {
        placeId: place.id,
        items: cartItems.map(([productId, qty]) => ({ productId, qty })),
        note,
        fulfillment,
        deliveryDistrict: fulfillment === 'delivery' ? activeDistrict : undefined,
        deliveryAddress: fulfillment === 'delivery' ? deliveryAddress.trim() : undefined,
        idempotencyKey: `shop-${place.id}-${Date.now()}`,
      } });
      notify(fulfillment === 'delivery'
        ? `Заказ оформлен, курьер привезёт · ${price(order.total)}`
        : `Заказ оформлен, код ${order.pickupCode}`);
      setCheckoutOpen(false);
      haptic([8, 40, 12]);
      setCart({});
      loadDetail();
      onBack();
    } catch (error) {
      const code = (error as { code?: string }).code;
      notify(code === 'out_of_stock' ? 'Часть товаров уже разобрали'
        : code === 'min_order' ? 'Сумма меньше минимальной для доставки'
          : code === 'delivery_unavailable' ? 'Доставка в этот район недоступна'
            : (error as Error).message || 'Не удалось оформить');
    } finally { setBusy(false); }
  }

  async function submitReview() {
    if (!me) { notify('Войдите, чтобы оставить отзыв'); return; }
    setReviewBusy(true);
    try {
      const result = await api<{ status?: string }>(`/api/v1/places/${place.id}/reviews`, {
        method: 'POST', body: { rating: reviewRating, body: reviewBody.trim() },
      });
      setReviewOpen(false);
      setReviewBody('');
      if (result?.status === 'published') {
        loadDetail();
        notify('Спасибо! Отзыв опубликован');
      } else {
        setReviewSent(true);
        notify('Отзыв отправлен на проверку');
      }
      haptic([8, 30, 12]);
    } catch (error) {
      notify((error as { code?: string }).code === 'review_exists'
        ? 'Вы уже оставляли отзыв об этом месте'
        : (error as Error).message || 'Не удалось отправить отзыв');
    } finally { setReviewBusy(false); }
  }

  async function book() {
    if (!slot) return;
    setBusy(true);
    try {
      await api<Booking>('/api/v1/bookings', {
        method: 'POST',
        body: { slotId: slot.id, note, idempotencyKey: `ui-${slot.id}-${Date.now()}` },
      });
      notify('Записали. Ждём подтверждения');
      onBack();
    } catch (requestError) {
      const code = (requestError as { code?: string }).code;
      notify(code === 'slot_taken' ? 'Время только что заняли' : 'Не удалось записаться');
    } finally {
      setBusy(false);
    }
  }

  return <section className="detail">
    <div className="detail-top">
      <button type="button" className="round-btn" onClick={onBack} aria-label="Назад"><Icon name="arrowLeft" size={19} /></button>
      <div className="detail-heading">
        <h1>{place.name}</h1>
        <span className="meta"><Icon name="pin" size={12} />{place.district} · {place.address}</span>
      </div>
      {(place.rating ?? place.source?.rating) !== null && <span className="score"><Icon name="star" size={12} stroke={0} />{(place.rating ?? place.source?.rating)!.toFixed(1)}</span>}
    </div>

    <PlaceCover place={place} photos={detail?.place.photos} onOpen={setPhotoIndex} />
    <PhotoRail photos={detail?.place.photos ?? []} onOpen={setPhotoIndex} />

    <div className="chips-row">
      <span className="chip"><Icon name={categoryIcon[place.category]} size={14} />{categories[place.category]}</span>
      {place.rating !== null && <span className="chip"><Icon name="heart" size={14} />{place.ratingCount} {plural(place.ratingCount, 'отзыв', 'отзыва', 'отзывов')}</span>}
      {place.source && <a className="chip source-chip" href={place.source.url ?? '#'} target="_blank" rel="noopener noreferrer">
        <span className="source-badge">2ГИС</span>{place.source.rating !== null ? place.source.rating.toFixed(1) : 'карточка'}
      </a>}
      {detail?.place.phone && <a className="chip" href={`tel:${detail.place.phone}`}><Icon name="phone" size={14} />Позвонить</a>}
      <a className="chip" href={`https://yandex.ru/maps/?rtext=~${place.location.lat},${place.location.lng}&rtt=auto`}
        target="_blank" rel="noopener noreferrer"><Icon name="map" size={14} />Маршрут</a>
      {place.source?.url && <a className="chip" href={`${place.source.url}/tab/photos`}
        target="_blank" rel="noopener noreferrer"><Icon name="sparkles" size={14} />Фото</a>}
      {detail?.place.info?.sites?.[0] && <a className="chip" target="_blank" rel="noopener noreferrer"
        href={/^https?:\/\//i.test(detail.place.info.sites[0]) ? detail.place.info.sites[0] : `https://${detail.place.info.sites[0]}`}>
        Сайт
      </a>}
    </div>

    <p className="about">{place.about}</p>
    {detail?.place.info?.schedule && <p className="hint place-schedule">
      <Icon name="clock" size={13} />{detail.place.info.schedule}
    </p>}

    {place.source && <a className="source-card" href={place.source.url ?? '#'} target="_blank" rel="noopener noreferrer">
      <span className="source-badge">2ГИС</span>
      <span><strong>Данные и отзывы — 2ГИС</strong>
        <small>{place.source.ratingCount} {plural(place.source.ratingCount, 'отзыв', 'отзыва', 'отзывов')} · открыть карточку организации</small></span>
      <Icon name="chevron" size={16} />
    </a>}

    {error && <div className="notice"><span>{error}</span></div>}
    {!detail && !error && <div className="skeleton-card tall" />}

    {detail && <>
    {detail && detail.products.length > 0 && <>
      <div className="panel-title"><h2>Товары</h2><span className="count-chip">{detail.products.length}</span></div>
      <ul className="shop-products">{detail.products.map(product => {
        const qty = cart[product.id] ?? 0;
        return <li key={product.id}>
          <div className="shop-product-info">
            <strong>{product.title}</strong>
            <span className="meta">{price(product.price)} · {product.unit} · {product.stockQty > 0 ? `осталось ${product.stockQty}` : 'нет в наличии'}</span>
            {product.description && <span className="shop-product-note">{product.description}</span>}
          </div>
          <div className="stepper">
            {qty > 0 && <button type="button" aria-label="Убрать" onClick={() => changeQty(product, -1)}>−</button>}
            {qty > 0 && <span>{qty}</span>}
            <button type="button" aria-label="Добавить" disabled={product.stockQty === 0 || qty >= product.stockQty}
              onClick={() => changeQty(product, 1)}>+</button>
          </div>
        </li>;
      })}</ul>
    </>}

      {detail.offers.length > 0 ? <>
      <div className="panel-title"><h2>Услуги</h2><span className="count-chip">{detail.offers.length}</span></div>
      <ul className="offers compact">{detail.offers.map(item =>
        <li key={item.id} className={offer?.id === item.id ? 'selected' : ''}>
          <button type="button" onClick={() => setOffer(item)}>
            <span className="offer-check"><Icon name={offer?.id === item.id ? 'check' : 'plus'} size={14} /></span>
            <span className="offer-info">
              <strong>{item.title}</strong>
              <span className="meta"><Icon name="clock" size={12} />{item.durationMin} мин</span>
            </span>
            <span className="offer-price">{price(item.price)}</span>
          </button>
        </li>)}
      </ul>

      {offer && <div className="booking-sheet">
        <span className="sheet-grip" aria-hidden="true" />
        <div className="panel-title"><h2>Свободное время</h2><span className="count-chip">{slots ? slots.length : '…'}</span></div>
        {!slots ? <div className="slots-skeleton">{Array.from({ length: 8 }).map((_, index) => <span key={index} />)}</div>
          : !slots.length ? <div className="empty-state small"><Icon name="calendar" size={22} /><p>Свободных окон нет</p></div>
            : <div className="slots">{slots.slice(0, showAllSlots ? 24 : 8).map(item =>
              <button key={item.id} type="button" aria-pressed={slot?.id === item.id} onClick={() => setSlot(item)}>
                <span>{dayTime.format(new Date(item.startsAt)).split(', ')[0]}</span>
                <strong>{timeOnly.format(new Date(item.startsAt))}</strong>
              </button>)}</div>}
        {slots && slots.length > 8 && <button type="button" className="ghost-mini wide more-slots" onClick={() => setShowAllSlots(value => !value)}>
          {showAllSlots ? 'Свернуть' : `Ещё ${Math.min(slots.length, 24) - 8}`}
        </button>}

        {slot && <>
          <label className="note-field"><Icon name="edit" size={14} />
            <input value={note} onChange={event => setNote(event.target.value)} maxLength={200} placeholder="Комментарий мастеру" />
          </label>
          <p className="hint">Оплата наличными на месте · отмена в «Заказах»</p>
        </>}
      </div>}
      </> : place.source ? <div className="source-unbookable">
        <span className="source-badge">2ГИС</span>
        <p><strong>Справочная карточка</strong><br />Онлайн-запись и заказы появятся, когда заведение подключится к «Рядом».</p>
      </div> : null}
    </>}

    {detail && <>
      {(() => {
        const ownReviews = detail.reviews.filter(review => review.source === 'own');
        const sourceReviews = detail.reviews.filter(review => review.source === '2gis');
        return <>
          {(ownReviews.length > 0 || place.source) && <div className="panel-title"><h2>Отзывы</h2>
            <span className="count-chip">{ownReviews.length + (place.source?.ratingCount ?? 0)}</span></div>}
          {ownReviews.length > 0 && <ul className="reviews compact">{ownReviews.slice(0, 6).map(review => <li key={review.id}>
            <div className="review-head">
              <span className="mini-avatar">{review.author.slice(0, 1)}</span>
              <strong>{review.author}</strong>
              {review.rating !== null && <span className="rating"><Icon name="star" size={11} stroke={0} />{review.rating}</span>}
            </div>
            {review.body && <p>{review.body}</p>}
          </li>)}</ul>}
          {place.source && <div className="source-reviews-head">
            <span className="source-badge">2ГИС</span>
            <a href={place.source.reviewsUrl ?? place.source.url ?? '#'} target="_blank" rel="noopener noreferrer">
              Все отзывы{place.source.rating !== null ? ` · ${place.source.rating.toFixed(1)}` : ''}<Icon name="chevron" size={13} />
            </a>
          </div>}
          {sourceReviews.length > 0 && <ul className="reviews compact source-reviews">
            {sourceReviews.slice(0, 5).map(review => <li key={review.id}>
              <div className="review-head">
                <span className="mini-avatar">{review.author.slice(0, 1)}</span>
                <strong>{review.author}</strong>
                <span className="review-source">2ГИС</span>
              </div>
              {review.body && <p>{review.body}</p>}
            </li>)}
          </ul>}
          {me && !reviewSent && ownReviews.length === 0 && <button type="button" className="ghost-mini wide review-cta"
            onClick={() => { haptic(); setReviewOpen(true); }}>
            <Icon name="star" size={14} />Оставить свой отзыв
          </button>}
          {!me && <p className="hint">Свой отзыв можно оставить после входа в аккаунт «Рядом».</p>}
        </>;
      })()}
    </>}

    {cartCount > 0 ? <div className="book-bar shop-bar">
      <div><span className="meta">{cartCount} {plural(cartCount, 'товар', 'товара', 'товаров')} · {fulfillment === 'delivery' ? 'доставка' : 'самовывоз'}</span>
        <strong>{price({ cents: grandTotal, currency: 'RUB' })}</strong></div>
      <button type="button" className="primary" disabled={busy} onClick={() => {
        if (!me) { notify('Войдите, чтобы заказать'); return; }
        haptic();
        setCheckoutOpen(true);
      }}>
        {busy ? 'Оформляем…' : 'Заказать'}<Icon name="chevron" size={16} />
      </button>
    </div> : slot && offer && <div className="book-bar">
      <div><span className="meta">{dayTime.format(new Date(slot.startsAt))}</span><strong>{price(offer.price)}</strong></div>
      <button type="button" className="primary" disabled={busy} onClick={() => void book()}>
        {busy ? 'Записываем…' : 'Записаться'}<Icon name="chevron" size={16} />
      </button>
    </div>}

    <Sheet open={checkoutOpen} onClose={() => { if (!busy) setCheckoutOpen(false); }} title="Оформление">
      <div className="checkout-sheet">
        <div className="checkout-lines">
          {cartItems.map(([id, qty]) => {
            const product = detail?.products.find(item => item.id === id);
            if (!product) return null;
            return <div key={id}><span>{product.title} × {qty}</span><strong>{price({ cents: product.price.cents * qty, currency: 'RUB' })}</strong></div>;
          })}
        </div>
        {zones.length > 0 && <div className="segmented two">
          <button type="button" className={fulfillment === 'pickup' ? 'active' : ''}
            onClick={() => { haptic(); setFulfillment('pickup'); }}><Icon name="receipt" size={14} />Самовывоз</button>
          <button type="button" className={fulfillment === 'delivery' ? 'active' : ''}
            onClick={() => { haptic(); setFulfillment('delivery'); }}><Icon name="car" size={14} />Доставка</button>
        </div>}
        {fulfillment === 'delivery' && zones.length > 0 ? <>
          <div className="delivery-fields">
            <label>Район<select value={activeDistrict} onChange={event => setDeliveryDistrict(event.target.value)}>
              {zones.map(item => <option key={item.id} value={item.district}>{item.district}</option>)}
            </select></label>
            <label>Адрес<input value={deliveryAddress} maxLength={240} placeholder="улица, дом, квартира"
              onChange={event => setDeliveryAddress(event.target.value)} /></label>
          </div>
          <p className="hint">{zone
            ? `${price(zone.fee)} · ${zone.etaMin} мин · от ${price(zone.minOrder)}`
            : 'Выберите район'}</p>
        </> : <p className="hint">Заберите в заведении: {detail?.place.address}</p>}
        <div className="checkout-total"><span>Итого</span><strong>{price({ cents: grandTotal, currency: 'RUB' })}</strong></div>
        <p className="hint cash-line"><Icon name="receipt" size={13} />Оплата наличными при получении</p>
        <button type="button" className="primary wide" disabled={busy || !cartItems.length}
          onClick={() => void checkout()}>
          {busy ? 'Оформляем…' : 'Подтвердить заказ'}<Icon name="chevron" size={16} />
        </button>
      </div>
    </Sheet>

    <Sheet open={reviewOpen} onClose={() => { if (!reviewBusy) setReviewOpen(false); }} title="Свой отзыв">
      <div className="review-form">
        <div className="review-stars" role="radiogroup" aria-label="Оценка">
          {[1, 2, 3, 4, 5].map(value => <button key={value} type="button" role="radio" aria-checked={reviewRating === value}
            aria-label={`${value} из 5`} className={value <= reviewRating ? 'active' : ''}
            onClick={() => { haptic(4); setReviewRating(value); }}>
            <Icon name="star" size={28} stroke={0} />
          </button>)}
        </div>
        <textarea value={reviewBody} onChange={event => setReviewBody(event.target.value)} maxLength={1000} rows={5}
          placeholder="Что понравилось или что стоит улучшить" />
        <p className="hint">Отзыв появится после проверки. Он не меняет карточку и рейтинг 2ГИС.</p>
        <button type="button" className="primary wide" disabled={reviewBusy} onClick={() => void submitReview()}>
          {reviewBusy ? 'Отправляем…' : 'Отправить отзыв'}<Icon name="chevron" size={16} />
        </button>
      </div>
    </Sheet>

    <Sheet open={photoIndex !== null} onClose={() => setPhotoIndex(null)}
      title={`Фото · ${detail?.place.photos?.length ?? 0}`}>
      {photoIndex !== null && detail?.place.photos?.[photoIndex] && <div className="photo-viewer">
        <img src={detail.place.photos[photoIndex].large} alt={`${place.name}, фото ${photoIndex + 1}`}
          referrerPolicy="no-referrer" />
        <div className="photo-viewer-bar">
          <button type="button" className="ghost-mini" disabled={photoIndex === 0}
            onClick={() => setPhotoIndex(photoIndex - 1)}>Назад</button>
          <span>{photoIndex + 1} / {detail.place.photos.length}</span>
          <button type="button" className="ghost-mini" disabled={photoIndex === detail.place.photos.length - 1}
            onClick={() => setPhotoIndex(photoIndex + 1)}>Дальше</button>
        </div>
        <p className="hint">Источник фото — 2ГИС{detail.place.photos[photoIndex].author ? ` · ${detail.place.photos[photoIndex].author}` : ''}</p>
      </div>}
    </Sheet>
  </section>;
}

function toLocalInput(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function ServiceRequestForm({ onDone, notify }: { onDone: () => void; notify: (text: string) => void }) {
  const start = new Date(Date.now() + 86400000);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 4 * 3600000);
  const [category, setCategory] = useState<ServiceCategory>('repair');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [min, setMin] = useState('1500');
  const [max, setMax] = useState('4000');
  const [from, setFrom] = useState(toLocalInput(start));
  const [to, setTo] = useState(toLocalInput(end));
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const budgetMinCents = Math.max(0, Math.round(Number(min) * 100));
    const budgetMaxCents = Math.max(0, Math.round(Number(max) * 100));
    if (title.trim().length < 3) return notify('Опишите задачу');
    if (address.trim().length < 3) return notify('Укажите адрес');
    if (budgetMaxCents < budgetMinCents) return notify('Максимум меньше минимума');
    setBusy(true);
    try {
      await api<ServiceRequest>('/api/v1/me/service-requests', { method: 'POST', body: {
        category, title: title.trim(), description: description.trim(), address: address.trim(),
        budgetMinCents, budgetMaxCents,
        preferredFrom: new Date(from).toISOString(), preferredTo: new Date(to).toISOString(),
        idempotencyKey: `service-${Date.now()}`,
      } });
      notify('Заявка опубликована');
      onDone();
    } catch (error) {
      notify((error as Error).message || 'Не удалось создать заявку');
    } finally { setBusy(false); }
  }

  return <form className="service-form" onSubmit={event => void submit(event)}>
    <div className="service-cats">
      {(Object.keys(serviceCategories) as ServiceCategory[]).map(key =>
        <button key={key} type="button" className={category === key ? 'active' : ''} onClick={() => setCategory(key)}>
          <Icon name={serviceCategoryIcon[key]} size={15} />{serviceCategories[key]}
        </button>)}
    </div>
    <label className="field"><span>Что нужно</span>
      <input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} placeholder="Например, починить смеситель" />
    </label>
    <label className="field"><span>Подробности</span>
      <textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={1500} rows={2}
        placeholder="Что случилось и что важно учесть" />
    </label>
    <label className="field"><span>Адрес</span>
      <input value={address} onChange={event => setAddress(event.target.value)} maxLength={240} placeholder="Улица, дом, квартира" />
    </label>
    <div className="field-row">
      <label className="field"><span>Бюджет от, ₽</span>
        <input inputMode="numeric" value={min} onChange={event => setMin(event.target.value)} />
      </label>
      <label className="field"><span>до, ₽</span>
        <input inputMode="numeric" value={max} onChange={event => setMax(event.target.value)} />
      </label>
    </div>
    <div className="field-row">
      <label className="field"><span>Когда</span>
        <input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} />
      </label>
      <label className="field"><span>До</span>
        <input type="datetime-local" value={to} onChange={event => setTo(event.target.value)} />
      </label>
    </div>
    <p className="hint">Оплата наличными мастеру после работы. Сервис не принимает деньги за мастера.</p>
    <button type="submit" className="primary wide" disabled={busy}>
      {busy ? 'Публикуем…' : 'Опубликовать заявку'}<Icon name="send" size={15} />
    </button>
  </form>;
}

function ServiceRequestCard({ item, me, notify, onChanged }: {
  item: ServiceRequest; me: Me | null; notify: (text: string) => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const pending = item.offers.filter(offer => offer.status === 'pending');

  async function accept(offerId: string) {
    setBusy(offerId);
    try {
      await api(`/api/v1/me/service-requests/${item.id}/offers/${offerId}/accept`, { method: 'POST' });
      notify('Мастер выбран');
      onChanged();
    } catch (error) { notify((error as Error).message || 'Не удалось выбрать мастера'); }
    finally { setBusy(null); }
  }

  async function cancel() {
    setBusy('cancel');
    try {
      await api(`/api/v1/me/service-requests/${item.id}/cancel`, { method: 'POST' });
      notify('Заявка отменена');
      onChanged();
    } catch (error) { notify((error as Error).message || 'Не удалось отменить'); }
    finally { setBusy(null); }
  }

  return <div className={`service-card ${item.status}`}>
    <div className="service-card-head">
      <span className={`status ${item.status}`}><span className="dot" />{serviceStatusLabel[item.status]}</span>
      <strong>{item.status === 'open' ? `до ${price(item.budget.max)}` : item.price ? price(item.price) : '—'}</strong>
    </div>
    <h3>{item.title}</h3>
    <p className="meta"><Icon name={serviceCategoryIcon[item.category]} size={13} />{serviceCategories[item.category]} · {serviceWindow(item)}</p>
    <p className="meta"><Icon name="pin" size={13} />{item.address}</p>
    {item.description && <p className="service-desc">{item.description}</p>}

    {item.status === 'open' && <>
      <div className="service-budget"><span>Бюджет</span><strong>{price(item.budget.min)} — {price(item.budget.max)}</strong></div>
      {pending.length > 0 ? <div className="offers-list">
        <span className="offers-title">Предложения мастеров</span>
        {pending.map(offer => <div className="offer-row" key={offer.id}>
          <div><strong>{offer.partner.name}</strong>
            <span className="meta">{offer.etaMin ? `приедет через ${offer.etaMin} мин` : 'готов приехать'}{offer.message ? ` · ${offer.message}` : ''}</span>
          </div>
          <strong>{price(offer.price)}</strong>
          <button type="button" className="primary mini" disabled={busy === offer.id}
            onClick={() => void accept(offer.id)}>{busy === offer.id ? '…' : 'Выбрать'}</button>
        </div>)}
      </div> : <p className="meta service-empty">Предложений пока нет — мастера увидят заявку</p>}
    </>}

    {item.partner && item.status !== 'open' && <div className="assigned-line">
      <span className="mini-avatar">{item.partner.name.slice(0, 1)}</span>
      <div><strong>{item.partner.name}</strong><span className="meta">мастер назначен · {price(item.price)}</span></div>
    </div>}

    {(item.status === 'open' || item.status === 'assigned') && (me?.user.id === item.client.id) &&
      <div className="service-actions">
        <button type="button" className="ghost-mini" disabled={busy === 'cancel'} onClick={() => void cancel()}>Отменить заявку</button>
      </div>}
  </div>;
}

function ServiceRequestsPanel({ me, notify }: { me: Me | null; notify: (text: string) => void }) {
  const [items, setItems] = useState<ServiceRequest[] | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    if (!me) { setItems([]); return; }
    void api<{ items: ServiceRequest[] }>('/api/v1/me/service-requests')
      .then(data => setItems(data.items)).catch(() => setItems([]));
  }, [me]);
  useEffect(load, [load]);

  if (!me) return <div className="empty-state"><Icon name="user" size={30} /><p>Войдите, чтобы заказать мастера</p></div>;

  return <div className="service-panel">
    <div className="service-intro">
      <div><strong>Мастер на дом</strong><span className="meta">Опишите задачу — партнёры предложат цену</span></div>
      <button type="button" className="primary mini" onClick={() => setCreating(value => !value)}>
        <Icon name={creating ? 'close' : 'plus'} size={14} />{creating ? 'Закрыть' : 'Заявка'}
      </button>
    </div>
    {creating && <ServiceRequestForm onDone={() => { setCreating(false); load(); }} notify={notify} />}
    {!items && <div className="skeleton-card tall" />}
    {items && !items.length && !creating && <div className="empty-state small">
      <Icon name="wrench" size={28} /><p>Заявок пока нет</p><span className="meta">Создайте первую — это займёт минуту</span>
    </div>}
    {items?.map(item => <ServiceRequestCard key={item.id} item={item} me={me} notify={notify} onChanged={load} />)}
  </div>;
}

function ServiceOfferForm({ item, notify, onDone }: { item: ServiceRequest; notify: (text: string) => void; onDone: () => void }) {
  const [value, setValue] = useState(String(Math.round(item.budget.max.cents / 100)));
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const priceCents = Math.round(Number(value) * 100);
    if (!Number.isFinite(priceCents) || priceCents <= 0) return notify('Укажите цену');
    setBusy(true);
    try {
      await api(`/api/v1/partner/service-requests/${item.id}/offers`, {
        method: 'POST', body: { priceCents, etaMin: 60 },
      });
      notify('Предложение отправлено');
      onDone();
    } catch (error) { notify((error as Error).message || 'Не удалось отправить'); }
    finally { setBusy(false); }
  }
  return <form className="offer-form" onSubmit={event => void submit(event)}>
    <label className="field"><span>Ваша цена, ₽</span>
      <input inputMode="numeric" value={value} onChange={event => setValue(event.target.value)} />
    </label>
    <button type="submit" className="primary mini" disabled={busy}>{busy ? '…' : 'Предложить'}</button>
  </form>;
}

function PartnerServiceRequests({ notify }: { notify: (text: string) => void }) {
  const [data, setData] = useState<{ open: ServiceRequest[]; jobs: ServiceRequest[] } | null>(null);
  const load = useCallback(() => {
    void api<{ open: ServiceRequest[]; jobs: ServiceRequest[] }>('/api/v1/partner/service-requests')
      .then(setData).catch(() => setData({ open: [], jobs: [] }));
  }, []);
  useEffect(load, [load]);

  async function act(id: string, action: 'withdraw' | 'start' | 'complete', offerId?: string) {
    try {
      const path = action === 'withdraw'
        ? `/api/v1/partner/service-offers/${offerId}/withdraw`
        : `/api/v1/partner/service-requests/${id}/${action}`;
      await api(path, { method: 'POST' });
      notify({ withdraw: 'Предложение отозвано', start: 'Работа начата', complete: 'Заявка завершена' }[action]);
      load();
    } catch (error) { notify((error as Error).message || 'Не удалось обновить'); }
  }

  return <div className="partner-service">
    <div className="panel-title"><h2>Выезд</h2><span className="count-chip">{data ? data.open.length : '—'}</span></div>
    {!data && <div className="skeleton-card" />}
    {data && !data.open.length && <p className="notice">Открытых заявок нет</p>}
    {data?.open.map(item => {
      const myOffer = item.offers[0];
      return <div className="service-card partner-open" key={item.id}>
        <div className="service-card-head">
          <span className="status open"><span className="dot" />{serviceCategories[item.category]}</span>
          <strong>до {price(item.budget.max)}</strong>
        </div>
        <h3>{item.title}</h3>
        <p className="meta"><Icon name="pin" size={13} />{item.address}</p>
        <p className="meta"><Icon name="clock" size={13} />{serviceWindow(item)} · бюджет от {price(item.budget.min)}</p>
        {item.description && <p className="service-desc">{item.description}</p>}
        {myOffer && <div className="my-offer">
          <div><span className={`status ${myOffer.status}`}><span className="dot" />{serviceOfferStatusLabel[myOffer.status]}</span>
            <strong>{price(myOffer.price)}</strong></div>
          {myOffer.status === 'pending' && <button type="button" className="ghost-mini"
            onClick={() => void act(item.id, 'withdraw', myOffer.id)}>Отозвать</button>}
        </div>}
        {(!myOffer || !['pending', 'accepted'].includes(myOffer.status)) &&
          <ServiceOfferForm item={item} notify={notify} onDone={load} />}
      </div>;
    })}
    {data && data.jobs.length > 0 && <>
      <h3 className="sub-title">Назначенные</h3>
      {data.jobs.map(item => <div className="service-card" key={item.id}>
        <div className="service-card-head">
          <span className={`status ${item.status}`}><span className="dot" />{serviceStatusLabel[item.status]}</span>
          <strong>{price(item.price)}</strong>
        </div>
        <h3>{item.title}</h3>
        <p className="meta"><Icon name="user" size={13} />{item.client.name} · <Icon name="pin" size={13} />{item.address}</p>
        <p className="meta"><Icon name="clock" size={13} />{serviceWindow(item)}</p>
        <div className="service-actions">
          {item.status === 'assigned' && <button type="button" className="primary mini" onClick={() => void act(item.id, 'start')}>Начать работу</button>}
          {item.status === 'in_progress' && <button type="button" className="primary mini" onClick={() => void act(item.id, 'complete')}>Завершить · оплата</button>}
        </div>
      </div>)}
    </>}
  </div>;
}

function ShopOrdersPanel({ me, notify }: { me: Me | null; notify: (text: string) => void }) {
  const [items, setItems] = useState<ShopOrder[] | null>(null);
  const load = useCallback(() => {
    if (!me) { setItems([]); return; }
    void api<{ items: ShopOrder[] }>('/api/v1/me/shop-orders')
      .then(data => setItems(data.items)).catch(() => setItems([]));
  }, [me]);
  useEffect(load, [load]);

  if (!me) return <div className="empty-state"><Icon name="user" size={30} /><p>Войдите, чтобы видеть заказы</p></div>;

  async function cancel(id: string) {
    try {
      await api(`/api/v1/me/shop-orders/${id}/cancel`, { method: 'POST' });
      notify('Заказ отменён');
      load();
    } catch (error) { notify((error as Error).message || 'Не удалось отменить'); }
  }

  return <div className="service-panel">
    <div className="service-intro"><div><strong>Мои заказы</strong><span className="meta">Самовывоз или доставка курьером</span></div></div>
    {!items && <div className="skeleton-card tall" />}
    {items && !items.length && <div className="empty-state small">
      <Icon name="food" size={28} /><p>Заказов пока нет</p><span className="meta">Добавьте товары в карточке заведения</span>
    </div>}
    {items?.map(item => <div className="service-card shop-order-card" key={item.id}>
      <div className="service-card-head">
        <span className={`status ${item.status}`}><span className="dot" />{shopStatusLabel[item.status]}</span>
        <strong>{price(item.total)}</strong>
      </div>
      <h3>{item.place.name}</h3>
      <p className="meta"><Icon name="pin" size={13} />{item.fulfillment === 'delivery' && item.delivery ? item.delivery.address : item.place.address}</p>
      <div className="shop-order-items">{item.items.map(line => <span key={line.id}>
        <span>{line.title} × {line.qty} {unitLabel(line.unit, line.qty)}</span><strong>{price(line.total)}</strong>
      </span>)}</div>
      {item.fulfillment === 'delivery' && item.delivery && <p className="delivery-line">
        <Icon name="car" size={13} />{deliveryStatusLabel[item.delivery.status]}
        <span>{price(item.deliveryFee)} · {item.delivery.etaMin} мин</span>
      </p>}
      <div className="trip-actions">
        {item.fulfillment === 'pickup'
          ? <span className="pickup-code"><Icon name="receipt" size={12} />Код {item.pickupCode}</span>
          : <span className="meta">{item.delivery?.courier ? `Курьер ${item.delivery.courier.name}` : 'Курьер ещё не назначен'}</span>}
        {(item.status === 'placed' || item.status === 'confirmed') &&
          <button type="button" className="ghost-mini" onClick={() => void cancel(item.id)}>Отменить</button>}
      </div>
    </div>)}
  </div>;
}

function Orders({ me, notify }: { me: Me | null; notify: (text: string) => void }) {
  const [view, setView] = useState<'bookings' | 'requests' | 'shop'>('bookings');
  const [items, setItems] = useState<Booking[] | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!me) { setItems([]); return; }
    void api<{ items: Booking[] }>('/api/v1/me/orders').then(data => setItems(data.items)).catch(() => setItems([]));
  }, [me]);
  useEffect(load, [load]);

  if (!me) return <div className="empty-state"><Icon name="user" size={30} /><p>Войдите, чтобы видеть записи</p></div>;

  async function cancel(id: string) {
    try {
      await api(`/api/v1/bookings/${id}/cancel`, { method: 'POST' });
      notify('Запись отменена');
      load();
    } catch { notify('Не удалось отменить'); }
  }

  return <section>
    <div className="section-title"><h2>Заказы</h2>{view === 'bookings' && <span className="count-chip">{items ? items.length : '—'}</span>}</div>
    <div className="segmented">
      <button type="button" className={view === 'bookings' ? 'active' : ''} onClick={() => setView('bookings')}>Записи</button>
      <button type="button" className={view === 'requests' ? 'active' : ''} onClick={() => setView('requests')}>Выезд</button>
      <button type="button" className={view === 'shop' ? 'active' : ''} onClick={() => setView('shop')}>Товары</button>
    </div>
    {view === 'requests' ? <ServiceRequestsPanel me={me} notify={notify} /> : view === 'shop' ? <ShopOrdersPanel me={me} notify={notify} /> : <>
      {!items && <div className="skeleton-card tall" />}
      {items && !items.length && <div className="empty-state">
        <Icon name="receipt" size={30} /><p>Пока пусто</p>
        <span className="meta">Выберите услугу на главной</span>
      </div>}
      <ul className="orders">{items?.map(item => <li key={item.id}>
        <div className="order-head">
          <strong>{item.place.name}</strong>
          <span className={`status ${item.status}`}><span className="dot" />{statusLabel[item.status]}</span>
        </div>
        <p className="meta"><Icon name="clock" size={13} />{dayTime.format(new Date(item.slot.startsAt))}</p>
        <p className="order-offer">{item.offer.title} <span>{price(item.price)}</span></p>
        <div className="order-actions">
          {(item.status === 'requested' || item.status === 'confirmed') &&
            <button type="button" className="ghost-mini" onClick={() => void cancel(item.id)}>Отменить</button>}
          {item.status === 'completed' && !item.review && (reviewing === item.id
            ? <ReviewForm bookingId={item.id} onDone={() => { setReviewing(null); load(); }} notify={notify} />
            : <button type="button" className="ghost-mini accent" onClick={() => setReviewing(item.id)}><Icon name="star" size={14} />Оценить</button>)}
          {item.review && <span className="review-state"><Icon name={item.review.status === 'published' ? 'check' : 'clock'} size={13} />
            {item.review.status === 'pending' ? 'На проверке' : item.review.status === 'hidden' ? 'Скрыт' : `Оценка ${item.review.rating}`}</span>}
        </div>
      </li>)}</ul>
    </>}
  </section>;
}

function ReviewForm({ bookingId, onDone, notify }: { bookingId: string; onDone: () => void; notify: (text: string) => void }) {
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  return <div className="review-form">
    <div className="star-picker" role="radiogroup" aria-label="Оценка">
      {[1, 2, 3, 4, 5].map(value => <button key={value} type="button" role="radio" aria-checked={rating === value}
        aria-label={`${value} из 5`} className={value <= rating ? 'lit' : ''} onClick={() => setRating(value)}>
        <Icon name="star" size={19} stroke={0} />
      </button>)}
    </div>
    <input value={body} onChange={event => setBody(event.target.value)} maxLength={500} placeholder="Пара слов (необязательно)" />
    <button type="button" className="primary mini" onClick={() => {
      void api('/api/v1/reviews', { method: 'POST', body: { bookingId, rating, body } })
        .then(() => { notify('Отзыв на модерации'); onDone(); })
        .catch(() => notify('Отзыв уже оставлен'));
    }}>Отправить</button>
  </div>;
}

function Profile({ me, refreshMe, notify }: { me: Me | null; refreshMe: () => void; notify: (text: string) => void }) {
  const [phone, setPhone] = useState('+79');
  const [code, setCode] = useState('');
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [partner, setPartner] = useState<Booking[] | null>(null);
  const isPartner = Boolean(me?.partnerIds.length) || Boolean(me?.roles.some(role => role.role === 'operator'));
  const isOperator = Boolean(me?.roles.some(role => role.role === 'operator'));
  const isDriver = Boolean(me?.roles.some(role => role.role === 'driver'));
  const isCourier = Boolean(me?.roles.some(role => role.role === 'courier'));

  const loadPartner = useCallback(() => {
    if (!isPartner) return;
    void api<{ items: Booking[] }>('/api/v1/partner/bookings').then(data => setPartner(data.items)).catch(() => setPartner([]));
  }, [isPartner]);
  useEffect(loadPartner, [loadPartner]);

  if (!me) return <section className="login">
    <div className="login-orb" aria-hidden="true"><span /></div>
    <h1>Вход</h1>
    <p className="meta">Код покажем здесь же</p>
    <label>Телефон
      <span className="input-wrap"><Icon name="phone" size={16} />
        <input value={phone} onChange={event => setPhone(event.target.value)} inputMode="tel" placeholder="+79000000001" />
      </span>
    </label>
    <button type="button" className="ghost-mini wide" onClick={() => {
      void api<{ demoCode?: string }>('/api/v1/auth/code', { method: 'POST', body: { phone } })
        .then(data => { setDemoCode(data.demoCode ?? null); notify('Код готов'); })
        .catch(() => notify('Не удалось получить код'));
    }}>Получить код<Icon name="send" size={15} /></button>
    {demoCode && <div className="code"><span>Код</span><strong>{demoCode}</strong></div>}
    <label>Код из шести цифр
      <span className="input-wrap"><Icon name="shield" size={16} />
        <input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" maxLength={6} />
      </span>
    </label>
    <label>Как к вам обращаться
      <span className="input-wrap"><Icon name="user" size={16} />
        <input value={name} onChange={event => setName(event.target.value)} maxLength={60} />
      </span>
    </label>
    <button type="button" className="primary" onClick={() => {
      void api('/api/v1/auth/session', { method: 'POST', body: { phone, code, displayName: name } })
        .then(() => { refreshMe(); notify('Вы вошли'); })
        .catch(() => notify('Проверьте код'));
    }}>Войти<Icon name="chevron" size={16} /></button>
  </section>;

  return <section className="profile">
    <div className="profile-card">
      <span className="avatar big">{me.user.displayName.slice(0, 1).toUpperCase()}</span>
      <div className="profile-copy"><h2>{me.user.displayName}</h2><span className="meta">{me.user.phone}</span></div>
      <button type="button" className="round-btn" aria-label="Выйти" onClick={() => {
        void api('/api/v1/auth/logout', { method: 'POST' }).then(() => { refreshMe(); notify('Вы вышли'); });
      }}><Icon name="logout" size={18} /></button>
    </div>
    <div className="chips-row">{me.roles.map(role => <span className="chip" key={role.role}>
      <Icon name={role.role === 'operator' ? 'shield' : role.role === 'partner' ? 'edit' : role.role === 'courier' ? 'car' : 'user'} size={13} />{roleLabel[role.role] ?? role.role}
    </span>)}</div>

    {isPartner && <div className="partner">
      <div className="panel-title"><h2>Заявки</h2><span className="count-chip">{partner ? partner.length : '—'}</span></div>
      {!partner ? <div className="skeleton-card" />
        : !partner.length ? <p className="notice">Заявок нет</p>
          : <ul className="orders">{partner.map(item => <li key={item.id}>
            <div className="order-head"><strong>{item.place.name}</strong>
              <span className={`status ${item.status}`}><span className="dot" />{statusLabel[item.status]}</span></div>
            <p className="meta"><Icon name="clock" size={13} />{dayTime.format(new Date(item.slot.startsAt))} · {item.offer.title}</p>
            {item.note && <p className="order-offer">{item.note}</p>}
            <div className="order-actions">
              {item.status === 'requested' && <button type="button" className="primary mini" onClick={() => void api(`/api/v1/bookings/${item.id}/confirm`, { method: 'POST' }).then(() => { notify('Подтверждено'); loadPartner(); })}>Подтвердить</button>}
              {item.status === 'confirmed' && <button type="button" className="ghost-mini" onClick={() => void api(`/api/v1/bookings/${item.id}/complete`, { method: 'POST' }).then(() => { notify('Запись закрыта, оплата получена'); loadPartner(); })}>Завершить · оплата</button>}
            </div>
          </li>)}</ul>}
    </div>}

    {Boolean(me.partnerIds.length) && <PartnerServiceRequests notify={notify} />}
    {Boolean(me.partnerIds.length) && <PartnerShopOrders notify={notify} />}
    {isPartner && <PartnerPlaces notify={notify} />}
    {isDriver && <DriverPanel notify={notify} />}
    {isCourier && <CourierPanel notify={notify} />}
    {isOperator && <OperatorDeliveries notify={notify} />}
    {isOperator && <Moderation notify={notify} />}
    <Notifications />
  </section>;
}

function ProductEditor({ product, notify, reload, onClose }: {
  product: ShopProduct; notify: (text: string) => void; reload: () => void; onClose: () => void;
}) {
  const [value, setValue] = useState(String(Math.round(product.price.cents / 100)));
  const [stock, setStock] = useState(String(product.stockQty));
  const [active, setActive] = useState(product.isActive);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api(`/api/v1/partner/products/${product.id}`, { method: 'PATCH', body: {
        priceCents: Math.round(Number(value) * 100), stockQty: Number(stock), isActive: active,
      } });
      notify('Товар обновлён');
      onClose();
      reload();
    } catch (error) { notify((error as Error).message || 'Не удалось сохранить товар'); }
    finally { setBusy(false); }
  }
  return <div className="confirm compact">
    <div className="row">
      <label>Цена, ₽<input value={value} inputMode="decimal" onChange={event => setValue(event.target.value)} /></label>
      <label>Остаток<input value={stock} inputMode="numeric" onChange={event => setStock(event.target.value)} /></label>
    </div>
    <label className="check"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} /> Показывать в витрине</label>
    <div className="row">
      <button type="button" className="primary" disabled={busy} onClick={() => void save()}>Сохранить</button>
      <button type="button" onClick={onClose}>Отмена</button>
    </div>
  </div>;
}

function PartnerShopOrders({ notify }: { notify: (text: string) => void }) {
  const [items, setItems] = useState<ShopOrder[] | null>(null);
  const load = useCallback(() => {
    void api<{ items: ShopOrder[] }>('/api/v1/partner/shop-orders')
      .then(data => setItems(data.items)).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  async function act(id: string, action: 'confirm' | 'ready' | 'complete' | 'cancel') {
    try {
      await api(`/api/v1/partner/shop-orders/${id}/status`, { method: 'POST', body: { action } });
      notify({ confirm: 'Заказ подтверждён', ready: 'Заказ готов', complete: 'Заказ выдан', cancel: 'Заказ отменён' }[action]);
      load();
    } catch (error) { notify((error as Error).message || 'Не удалось обновить'); }
  }

  const active = items?.filter(item => ['placed', 'confirmed', 'ready', 'out_for_delivery'].includes(item.status)) ?? [];
  return <div className="partner-service">
    <div className="panel-title"><h2>Заказы</h2><span className="count-chip">{items ? active.length : '—'}</span></div>
    {!items && <div className="skeleton-card" />}
    {items && !items.length && <p className="notice">Заказов пока нет</p>}
    {active.map(item => <div className="service-card shop-order-card" key={item.id}>
      <div className="service-card-head">
        <span className={`status ${item.status}`}><span className="dot" />{shopStatusLabel[item.status]}</span>
        <strong>{price(item.total)}</strong>
      </div>
      <h3>{item.client.name} · {item.fulfillment === 'delivery' ? 'доставка' : `код ${item.pickupCode}`}</h3>
      {item.fulfillment === 'delivery' && item.delivery && <p className="meta"><Icon name="pin" size={13} />{item.delivery.address} · {item.delivery.district}</p>}
      <div className="shop-order-items">{item.items.map(line => <span key={line.id}>
        <span>{line.title} × {line.qty} {unitLabel(line.unit, line.qty)}</span><strong>{price(line.total)}</strong>
      </span>)}</div>
      {item.note && <p className="service-desc">{item.note}</p>}
      <div className="service-actions">
        {item.status === 'placed' && <button type="button" className="primary mini" onClick={() => void act(item.id, 'confirm')}>Подтвердить</button>}
        {item.status === 'confirmed' && <button type="button" className="primary mini" onClick={() => void act(item.id, 'ready')}>
          {item.fulfillment === 'delivery' ? 'Готов к доставке' : 'Готов к выдаче'}</button>}
        {item.status === 'ready' && item.fulfillment === 'pickup' && <button type="button" className="primary mini" onClick={() => void act(item.id, 'complete')}>Выдан · наличные</button>}
        {item.status === 'out_for_delivery' && <span className="meta">Курьер везёт заказ</span>}
        {['placed', 'confirmed'].includes(item.status) && <button type="button" className="ghost-mini" onClick={() => void act(item.id, 'cancel')}>Отменить</button>}
      </div>
    </div>)}
  </div>;
}

function PartnerPlaces({ notify }: { notify: (text: string) => void }) {
  const [items, setItems] = useState<PartnerPlace[] | null>(null);
  const [editing, setEditing] = useState<PartnerPlace | null>(null);
  const [openOffer, setOpenOffer] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: '', price: '1000', duration: '60' });
  const [openProduct, setOpenProduct] = useState<string | null>(null);
  const [addingProduct, setAddingProduct] = useState<string | null>(null);
  const [productDraft, setProductDraft] = useState({ title: '', price: '300', stock: '10', unit: 'шт' });
  const [districts, setDistricts] = useState<string[]>([]);
  const [addingZone, setAddingZone] = useState<string | null>(null);
  const [zoneDraft, setZoneDraft] = useState({ district: '', fee: '199', min: '500', eta: '45' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ items: string[] }>('/api/v1/districts').then(data => setDistricts(data.items)).catch(() => setDistricts([]));
  }, []);

  const load = useCallback(() => {
    void api<{ items: PartnerPlace[] }>('/api/v1/partner/places')
      .then(data => setItems(data.items)).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  async function savePlace() {
    if (!editing) return;
    setBusy(true);
    try {
      await api(`/api/v1/partner/places/${editing.id}`, { method: 'PATCH', body: {
        name: editing.name, category: editing.category, district: editing.district,
        address: editing.address, about: editing.about, phone: editing.phone || null,
        isPublished: editing.isPublished, lat: editing.location.lat, lng: editing.location.lng,
      } });
      notify('Карточка сохранена');
      setEditing(null);
      load();
    } catch { notify('Не удалось сохранить карточку'); }
    finally { setBusy(false); }
  }

  async function addOffer(placeId: string) {
    setBusy(true);
    try {
      await api(`/api/v1/partner/places/${placeId}/offers`, { method: 'POST', body: {
        title: draft.title.trim(), durationMin: Number(draft.duration),
        priceCents: Math.round(Number(draft.price) * 100),
      } });
      notify('Услуга добавлена');
      setDraft({ title: '', price: '1000', duration: '60' });
      setAdding(null);
      load();
    } catch { notify('Проверьте название, цену и длительность'); }
    finally { setBusy(false); }
  }

  async function addProduct(placeId: string) {
    setBusy(true);
    try {
      await api(`/api/v1/partner/places/${placeId}/products`, { method: 'POST', body: {
        title: productDraft.title.trim(), priceCents: Math.round(Number(productDraft.price) * 100),
        stockQty: Number(productDraft.stock), unit: productDraft.unit.trim() || 'шт',
      } });
      notify('Товар добавлен');
      setProductDraft({ title: '', price: '300', stock: '10', unit: 'шт' });
      setAddingProduct(null);
      load();
    } catch (error) { notify((error as Error).message || 'Проверьте название и цену'); }
    finally { setBusy(false); }
  }

  async function addZone(placeId: string) {
    setBusy(true);
    try {
      await api(`/api/v1/partner/places/${placeId}/zones`, { method: 'POST', body: {
        district: zoneDraft.district, feeCents: Math.round(Number(zoneDraft.fee) * 100),
        minOrderCents: Math.round(Number(zoneDraft.min) * 100), etaMin: Number(zoneDraft.eta),
      } });
      notify('Зона доставки сохранена');
      setAddingZone(null);
      load();
    } catch (error) { notify((error as Error).message || 'Проверьте зону доставки'); }
    finally { setBusy(false); }
  }

  async function toggleZone(zone: DeliveryZone) {
    try {
      await api(`/api/v1/partner/zones/${zone.id}`, { method: 'PATCH', body: { isActive: !zone.isActive } });
      load();
    } catch { notify('Не удалось изменить зону'); }
  }

  if (!items) return <p className="notice">Загружаем карточки…</p>;
  if (!items.length) return <p className="notice">Нет доступных карточек.</p>;

  return <div className="partner-places">
    <div className="section-title"><h2>Мои точки</h2><span>{items.length}</span></div>
    {items.map(place => <div className="place-editor" key={place.id}>
      {editing?.id === place.id ? <div className="confirm">
        <label>Название<input value={editing.name} maxLength={120} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
        <label>Категория<select value={editing.category} onChange={event => setEditing({ ...editing, category: event.target.value as Category })}>
          {Object.entries(categories).filter(([key]) => key !== 'all').map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Район<input value={editing.district} maxLength={60} onChange={event => setEditing({ ...editing, district: event.target.value })} /></label>
        <label>Адрес<input value={editing.address} maxLength={160} onChange={event => setEditing({ ...editing, address: event.target.value })} /></label>
        <label>Описание<textarea value={editing.about} maxLength={2000} rows={3} onChange={event => setEditing({ ...editing, about: event.target.value })} /></label>
        <label>Телефон<input value={editing.phone ?? ''} maxLength={32} inputMode="tel" onChange={event => setEditing({ ...editing, phone: event.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={editing.isPublished} onChange={event => setEditing({ ...editing, isPublished: event.target.checked })} /> Показывать в каталоге</label>
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => void savePlace()}>Сохранить</button>
          <button type="button" onClick={() => setEditing(null)}>Отмена</button>
        </div>
      </div> : <>
        <div className="order-head">
          <div><strong>{place.name}</strong>
            <p className="meta">{categories[place.category]} · {place.district} · {place.address}</p></div>
          <button type="button" onClick={() => setEditing({ ...place })}>Изменить</button>
        </div>
        {!place.isPublished && <p className="meta">Скрыто из каталога</p>}
        <ul className="partner-offers">{place.offers.map(offer => <li key={offer.id}>
          <div className="offer-line">
            <div><strong>{offer.title}</strong><span className="meta"> {price(offer.price)} · {offer.durationMin} мин · окон: {offer.slotCount}</span></div>
            <button type="button" onClick={() => setOpenOffer(openOffer === offer.id ? null : offer.id)}>Изменить</button>
          </div>
          {openOffer === offer.id && <OfferEditor offer={offer} notify={notify} reload={load}
            onClose={() => setOpenOffer(null)} />}
        </li>)}</ul>
        {place.products.length > 0 && <>
          <p className="partner-sub">Товары</p>
          <ul className="partner-offers">{place.products.map(product => <li key={product.id}>
            <div className="offer-line">
              <div><strong>{product.title}</strong><span className="meta"> {price(product.price)} · остаток {product.stockQty} {product.unit}</span></div>
              <button type="button" onClick={() => setOpenProduct(openProduct === product.id ? null : product.id)}>Изменить</button>
            </div>
            {openProduct === product.id && <ProductEditor product={product} notify={notify} reload={load}
              onClose={() => setOpenProduct(null)} />}
          </li>)}</ul>
        </>}
        <p className="partner-sub">Доставка</p>
        <ul className="partner-offers">{place.zones.map(zone => <li key={zone.id}>
          <div className="offer-line">
            <div><strong>{zone.district}</strong><span className="meta"> {price(zone.fee)} · от {price(zone.minOrder)} · {zone.etaMin} мин</span></div>
            <button type="button" onClick={() => void toggleZone(zone)}>{zone.isActive ? 'Скрыть' : 'Включить'}</button>
          </div>
        </li>)}</ul>
        {addingZone === place.id ? <div className="confirm">
          <div className="row">
            <label>Район<select value={zoneDraft.district} onChange={event => setZoneDraft({ ...zoneDraft, district: event.target.value })}>
              <option value="">Выберите</option>
              {districts.map(district => <option key={district} value={district}>{district}</option>)}
            </select></label>
            <label>Доставка, ₽<input value={zoneDraft.fee} inputMode="decimal" onChange={event => setZoneDraft({ ...zoneDraft, fee: event.target.value })} /></label>
          </div>
          <div className="row">
            <label>Мин. заказ, ₽<input value={zoneDraft.min} inputMode="decimal" onChange={event => setZoneDraft({ ...zoneDraft, min: event.target.value })} /></label>
            <label>Минут<input value={zoneDraft.eta} inputMode="numeric" onChange={event => setZoneDraft({ ...zoneDraft, eta: event.target.value })} /></label>
          </div>
          <div className="row">
            <button type="button" className="primary" disabled={busy || !zoneDraft.district} onClick={() => void addZone(place.id)}>Сохранить</button>
            <button type="button" onClick={() => setAddingZone(null)}>Отмена</button>
          </div>
        </div> : <button type="button" className="add-offer" onClick={() => { setAddingZone(place.id); setZoneDraft({ district: districts[0] ?? '', fee: '199', min: '500', eta: '45' }); }}>+ Зона доставки</button>}
        {addingProduct === place.id ? <div className="confirm">
          <label>Название товара<input value={productDraft.title} maxLength={120} onChange={event => setProductDraft({ ...productDraft, title: event.target.value })} /></label>
          <div className="row">
            <label>Цена, ₽<input value={productDraft.price} inputMode="decimal" onChange={event => setProductDraft({ ...productDraft, price: event.target.value })} /></label>
            <label>Остаток<input value={productDraft.stock} inputMode="numeric" onChange={event => setProductDraft({ ...productDraft, stock: event.target.value })} /></label>
          </div>
          <div className="row">
            <button type="button" className="primary" disabled={busy || productDraft.title.trim().length < 2} onClick={() => void addProduct(place.id)}>Добавить</button>
            <button type="button" onClick={() => setAddingProduct(null)}>Отмена</button>
          </div>
        </div> : <button type="button" className="add-offer" onClick={() => { setAddingProduct(place.id); setProductDraft({ title: '', price: '300', stock: '10', unit: 'шт' }); }}>+ Товар</button>}
        {adding === place.id ? <div className="confirm">
          <label>Название услуги<input value={draft.title} maxLength={120} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
          <div className="row">
            <label>Цена, ₽<input value={draft.price} inputMode="decimal" onChange={event => setDraft({ ...draft, price: event.target.value })} /></label>
            <label>Минут<input value={draft.duration} inputMode="numeric" onChange={event => setDraft({ ...draft, duration: event.target.value })} /></label>
          </div>
          <div className="row">
            <button type="button" className="primary" disabled={busy || draft.title.trim().length < 2} onClick={() => void addOffer(place.id)}>Добавить</button>
            <button type="button" onClick={() => setAdding(null)}>Отмена</button>
          </div>
        </div> : <button type="button" className="add-offer" onClick={() => { setAdding(place.id); setDraft({ title: '', price: '1000', duration: '60' }); }}>+ Услуга</button>}
      </>}
    </div>)}
  </div>;
}

function OfferEditor({ offer, notify, reload, onClose }: {
  offer: PartnerOffer; notify: (text: string) => void; reload: () => void; onClose: () => void;
}) {
  const [title, setTitle] = useState(offer.title);
  const [priceRub, setPriceRub] = useState(String(Math.round(offer.price.cents / 100)));
  const [duration, setDuration] = useState(String(offer.durationMin));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api(`/api/v1/partner/offers/${offer.id}`, { method: 'PATCH', body: {
        title, durationMin: Number(duration), priceCents: Math.round(Number(priceRub) * 100),
      } });
      notify('Услуга сохранена');
      reload();
      onClose();
    } catch { notify('Проверьте поля услуги'); }
    finally { setBusy(false); }
  }

  async function toggle() {
    try {
      await api(`/api/v1/partner/offers/${offer.id}`, { method: 'PATCH', body: { isActive: !offer.isActive } });
      notify(offer.isActive ? 'Услуга скрыта' : 'Услуга снова доступна');
      reload();
    } catch { notify('Не удалось изменить услугу'); }
  }

  async function addSlots() {
    setBusy(true);
    try {
      const result = await api<{ created: number }>(`/api/v1/partner/offers/${offer.id}/slots`, { method: 'POST', body: { days: 14 } });
      notify(`Добавлено окон: ${result.created}`);
      reload();
    } catch { notify('Не удалось добавить окна'); }
    finally { setBusy(false); }
  }

  return <div className="confirm offer-edit">
    <label>Название<input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>
    <div className="row">
      <label>Цена, ₽<input value={priceRub} inputMode="decimal" onChange={event => setPriceRub(event.target.value)} /></label>
      <label>Минут<input value={duration} inputMode="numeric" onChange={event => setDuration(event.target.value)} /></label>
    </div>
    <div className="row">
      <button type="button" className="primary" disabled={busy} onClick={() => void save()}>Сохранить</button>
      <button type="button" onClick={() => void toggle()}>{offer.isActive ? 'Скрыть' : 'Вернуть'}</button>
      <button type="button" disabled={busy} onClick={() => void addSlots()}>Окна +14 дней</button>
    </div>
  </div>;
}

function Moderation({ notify }: { notify: (text: string) => void }) {
  const [items, setItems] = useState<ModerationItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    void api<{ items: ModerationItem[] }>('/api/v1/operator/reviews?status=pending')
      .then(data => setItems(data.items)).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  async function moderate(id: string, action: 'publish' | 'hide') {
    setBusy(id);
    try {
      await api(`/api/v1/operator/reviews/${id}/moderate`, { method: 'POST', body: { action } });
      notify(action === 'publish' ? 'Отзыв опубликован' : 'Отзыв скрыт');
      load();
    } catch { notify('Не удалось изменить отзыв'); }
    finally { setBusy(null); }
  }

  return <div className="moderation">
    <div className="section-title"><h2>Модерация отзывов</h2><span>{items ? items.length : '—'}</span></div>
    {!items ? <p className="notice">Загружаем очередь…</p>
      : !items.length ? <p className="notice">Очередь пуста.</p>
        : <ul className="orders">{items.map(item => <li key={item.id}>
          <div className="order-head"><strong>{item.place_name}</strong>
            <span className="status requested">★ {item.rating}</span></div>
          <p className="meta">{item.author} · {new Date(item.created_at).toLocaleDateString('ru-RU')}</p>
          <p>{item.body || 'Без комментария'}</p>
          <div className="row">
            <button type="button" className="primary" disabled={busy === item.id} onClick={() => void moderate(item.id, 'publish')}>Опубликовать</button>
            <button type="button" disabled={busy === item.id} onClick={() => void moderate(item.id, 'hide')}>Скрыть</button>
          </div>
        </li>)}</ul>}
  </div>;
}

const noticeLabel: Record<string, string> = {
  booking_requested: 'Запись создана', booking_new: 'Новая заявка', booking_confirmed: 'Запись подтверждена',
  booking_completed: 'Запись завершена', booking_cancelled: 'Запись отменена',
  review_moderated: 'Отзыв проверен', login_code: 'Код входа',
  service_offer: 'Новое предложение мастера', service_offer_accepted: 'Предложение выбрано',
  service_offer_declined: 'Предложение отклонено', service_cancelled: 'Заявка отменена',
  service_assigned: 'Мастер назначен', service_in_progress: 'Работа началась', service_completed: 'Заявка завершена',
  shop_order_new: 'Новый заказ', shop_placed: 'Заказ оформлен', shop_confirmed: 'Заказ подтверждён',
  shop_ready: 'Заказ готов к выдаче', shop_completed: 'Заказ выдан', shop_cancelled: 'Заказ отменён',
};

function Notifications() {
  const [items, setItems] = useState<Notice[] | null>(null);
  const load = useCallback(() => {
    void api<{ items: Notice[] }>('/api/v1/me/notifications').then(data => setItems(data.items)).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);
  const unread = items?.filter(item => !item.read_at).length ?? 0;

  return <div className="notifications">
    <div className="section-title"><h2>Уведомления</h2><span>{unread ? `${unread} новых` : 'всё прочитано'}</span></div>
    {!items ? <p className="notice">Загружаем…</p>
      : !items.length ? <p className="notice">Пока нет уведомлений.</p>
        : <>
          <ul className="notice-list">{items.slice(0, 12).map(item => <li key={item.id} className={item.read_at ? '' : 'unread'}>
            <div><strong>{noticeLabel[item.kind] ?? item.kind}</strong>
              <span className="meta"> {new Date(item.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
            <p className="meta">{String(item.payload.place ?? item.payload.status ?? item.payload.hint ?? '')}</p>
          </li>)}</ul>
          {unread > 0 && <button type="button" onClick={() => void api('/api/v1/me/notifications/read', { method: 'POST' }).then(load)}>Прочитать все</button>}
        </>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
