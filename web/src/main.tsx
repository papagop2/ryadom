import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { demoRequest } from './demo';
import './style.css';

type Money = { cents: number; currency: string };
type PlaceCard = {
  id: string; name: string; category: Category; district: string; address: string; about: string;
  location: { lat: number; lng: number }; rating: number | null; ratingCount: number;
  priceFrom: Money | null; offerCount: number; distanceKm: number | null;
};
type Offer = { id: string; title: string; description: string; durationMin: number; price: Money; nextSlot: string | null };
type PlaceDetail = { place: PlaceCard & { phone: string | null }; offers: Offer[]; reviews: Review[] };
type Slot = { id: string; startsAt: string; endsAt: string };
type Review = { id: string; rating: number; body: string; createdAt: string; author: string };
type Booking = {
  id: string; status: 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'expired';
  note: string; price: Money; createdAt: string;
  slot: { id: string; startsAt: string; endsAt: string };
  offer: { id: string; title: string; durationMin: number };
  place: { id: string; name: string; address: string; district: string };
  review: { id: string; rating: number; status: 'pending' | 'published' | 'hidden' } | null;
};
type Me = { user: { id: string; phone: string; displayName: string }; roles: { role: string; partner_id: string | null }[]; partnerIds: string[] };
type PartnerOffer = { id: string; title: string; description: string; durationMin: number; price: Money; isActive: boolean; slotCount: number; nextSlot: string | null };
type PartnerPlace = {
  id: string; name: string; category: Category; district: string; address: string; about: string;
  phone: string | null; location: { lat: number; lng: number }; isPublished: boolean; updatedAt: string;
  offers: PartnerOffer[];
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
const statusLabel: Record<Booking['status'], string> = {
  requested: 'Ждёт подтверждения', confirmed: 'Подтверждено', completed: 'Завершено',
  cancelled: 'Отменено', expired: 'Истекло',
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

type Tab = 'home' | 'map' | 'orders' | 'profile';
const tabs: { key: Tab; label: string }[] = [
  { key: 'home', label: 'Главная' }, { key: 'map', label: 'Карта' },
  { key: 'orders', label: 'Заказы' }, { key: 'profile', label: 'Профиль' },
];

function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [me, setMe] = useState<Me | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);

  const refreshMe = useCallback(() => {
    void api<Me>('/api/v1/me').then(setMe).catch(() => setMe(null));
  }, []);
  useEffect(refreshMe, [refreshMe]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  return <main className="page">
    <div className="ambient" aria-hidden="true"><span /><span /><span /></div>
    <header className="mast">
      <a href="/" className="wordmark">рядом<span>.</span></a>
      <span className="badge">{DEMO ? 'Демо · Pages' : 'Демо-стенд'}</span>
    </header>
    {!online && <p className="notice" role="status">Нет сети. Записаться и подтвердить можно только онлайн.</p>}
    {toast && <p className="toast" role="status">{toast}</p>}

    {tab === 'home' && <Catalogue onPick={() => setTab('map')} notify={setToast} />}
    {tab === 'map' && <Catalogue withMap notify={setToast} />}
    {tab === 'orders' && <Orders me={me} notify={setToast} />}
    {tab === 'profile' && <Profile me={me} refreshMe={refreshMe} notify={setToast} />}

    <nav className="tabs" aria-label="Разделы">
      {tabs.map(item => <button key={item.key} type="button" aria-current={tab === item.key ? 'page' : undefined}
        onClick={() => setTab(item.key)}>{item.label}</button>)}
    </nav>
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

function MapView({ items, onOpen, notify }: { items: PlaceCard[]; onOpen: (place: PlaceCard) => void; notify: (text: string) => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; world: { x: number; y: number } } | null>(null);
  const centered = useRef(false);
  const [size, setSize] = useState({ w: 360, h: 320 });
  const [zoom, setZoom] = useState(14);
  const [center, setCenter] = useState(CITY);

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
    {items.map(item => {
      const pos = project(item.location.lat, item.location.lng, zoom);
      return <button key={item.id} type="button" className="tile-pin" title={item.name}
        aria-label={item.name} style={{ left: `${pos.x - left}px`, top: `${pos.y - top}px` }}
        onPointerDown={event => event.stopPropagation()} onClick={() => onOpen(item)}>
        <span>{item.name.slice(0, 1)}</span><em>{item.name}</em>
      </button>;
    })}
    <div className="map-tools">
      <button type="button" aria-label="Приблизить" onClick={() => setZoom(value => clamp(value + 1, 11, 18))}>+</button>
      <button type="button" aria-label="Отдалить" onClick={() => setZoom(value => clamp(value - 1, 11, 18))}>−</button>
      <button type="button" aria-label="Где я" onClick={() => {
        if (!navigator.geolocation) return notify('Геолокация недоступна');
        navigator.geolocation.getCurrentPosition(
          position => { setCenter({ lat: position.coords.latitude, lng: position.coords.longitude }); setZoom(15); },
          () => notify('Не удалось определить положение. Карта работает без геолокации.'),
          { timeout: 8000, maximumAge: 60000 });
      }}>◎</button>
    </div>
    <p className="map-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></p>
  </div>;
}

function Catalogue({ notify, withMap = false, onPick }: { notify: (text: string) => void; withMap?: boolean; onPick?: () => void }) {
  const [category, setCategory] = useState<'all' | Category>('all');
  const [district, setDistrict] = useState('all');
  const [query, setQuery] = useState('');
  const [districts, setDistricts] = useState<string[]>([]);
  const [items, setItems] = useState<PlaceCard[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<PlaceCard | null>(null);

  useEffect(() => {
    void api<{ items: string[] }>('/api/v1/districts').then(d => setDistricts(d.items)).catch(() => setDistricts([]));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (category !== 'all') params.set('category', category);
    if (district !== 'all') params.set('district', district);
    if (query.trim()) params.set('q', query.trim());
    setError(false);
    const timer = setTimeout(() => {
      void api<{ items: PlaceCard[] }>(`/api/v1/places?${params}`, { signal: controller.signal })
        .then(data => setItems(data.items))
        .catch(() => { if (!controller.signal.aborted) { setItems(null); setError(true); } });
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [category, district, query]);

  if (open) return <PlaceScreen place={open} onBack={() => setOpen(null)} notify={notify} />;

  return <>
    <section className="hero" aria-labelledby="title">
      <p className="label">ГОРОДСКИЕ УСЛУГИ</p>
      <h1 id="title">Нужное в городе.<br /><em>Ближе, чем кажется.</em></h1>
      <p>Найдите мастера, посмотрите свободное время и запишитесь за пару шагов.</p>
    </section>

    <div className="filters" aria-label="Категории">
      {(Object.keys(categories) as (keyof typeof categories)[]).map(key =>
        <button key={key} type="button" aria-pressed={category === key} onClick={() => setCategory(key as 'all' | Category)}>{categories[key]}</button>)}
    </div>

    <div className="search">
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск по названию" aria-label="Поиск" />
      <select value={district} onChange={event => setDistrict(event.target.value)} aria-label="Район">
        <option value="all">Все районы</option>
        {districts.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </div>

    {withMap && <MapView items={items ?? []} onOpen={setOpen} notify={notify} />}

    <section aria-labelledby="catalogue">
      <div className="section-title"><h2 id="catalogue">{withMap ? 'Рядом с вами' : 'Выбрать услугу'}</h2>
        <span>{items ? `${items.length} мест` : '—'}</span></div>
      {error ? <div className="notice" role="status">Каталог недоступен. <button type="button" onClick={() => setCategory(c => c)}>Повторить</button></div>
        : !items ? <p className="notice" role="status">Загружаем каталог…</p>
          : !items.length ? <p className="notice" role="status">Ничего не нашлось. Измените фильтры.</p>
            : <ul className="places">{items.map(place => <li key={place.id}>
              <button type="button" className="place-button" onClick={() => setOpen(place)}>
                <span className="stamp" aria-hidden="true">{place.name.slice(0, 1)}</span>
                <span className="details">
                  <span className="meta">{place.district} · {place.rating ? `★ ${place.rating.toFixed(1)} (${place.ratingCount})` : 'нет отзывов'}</span>
                  <strong className="title">{place.name}</strong>
                  <span className="sub">{place.about}</span>
                </span>
                <span className="price">от {price(place.priceFrom)}</span>
              </button>
            </li>)}</ul>}
    </section>
    {onPick && <p className="hint"><button type="button" onClick={onPick}>Открыть карту →</button></p>}
  </>;
}

function PlaceScreen({ place, onBack, notify }: { place: PlaceCard; onBack: () => void; notify: (text: string) => void }) {
  const [detail, setDetail] = useState<PlaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<PlaceDetail>(`/api/v1/places/${place.id}`).then(setDetail).catch(() => setError('Карточка недоступна'));
  }, [place.id]);

  useEffect(() => {
    if (!offer) return;
    setSlots(null);
    setSlot(null);
    void api<{ slots: Slot[] }>(`/api/v1/offers/${offer.id}/slots`)
      .then(data => setSlots(data.slots))
      .catch(() => setSlots([]));
  }, [offer]);

  async function book() {
    if (!slot) return;
    setBusy(true);
    try {
      await api<Booking>('/api/v1/bookings', {
        method: 'POST',
        body: { slotId: slot.id, note, idempotencyKey: `ui-${slot.id}-${Date.now()}` },
      });
      notify('Запись создана. Партнёр подтвердит её в кабинете.');
      onBack();
    } catch (requestError) {
      const code = (requestError as { code?: string }).code;
      notify(code === 'slot_taken' ? 'Это время только что заняли. Выберите другое.' : 'Не удалось записаться');
    } finally {
      setBusy(false);
    }
  }

  return <section className="detail">
    <button type="button" className="back" onClick={onBack}>← Назад</button>
    <h1>{place.name}</h1>
    <p className="meta">{place.district} · {place.address}</p>
    <p>{place.about}</p>
    {place.rating && <p className="rating">★ {place.rating.toFixed(1)} · {place.ratingCount} отзывов</p>}

    {error && <p className="notice">{error}</p>}
    {!detail && !error && <p className="notice">Открываем услуги…</p>}
    {detail && <ul className="offers">{detail.offers.map(item =>
      <li key={item.id} className={offer?.id === item.id ? 'selected' : ''}>
        <button type="button" onClick={() => setOffer(item)}>
          <strong>{item.title}</strong>
          <span>{item.durationMin} мин · {price(item.price)}</span>
        </button>
      </li>)}</ul>}

    {offer && <div className="booking">
      <h2>Свободное время</h2>
      {!slots ? <p className="notice">Загружаем окна…</p>
        : !slots.length ? <p className="notice">Свободных окон нет. Выберите другую услугу.</p>
          : <div className="slots">{slots.slice(0, 24).map(item =>
            <button key={item.id} type="button" aria-pressed={slot?.id === item.id} onClick={() => setSlot(item)}>
              <span>{dayTime.format(new Date(item.startsAt)).split(', ')[0]}</span>
              <strong>{timeOnly.format(new Date(item.startsAt))}</strong>
            </button>)}</div>}
      {slot && <div className="confirm">
        <p>Выберите время: <strong>{dayTime.format(new Date(slot.startsAt))}</strong></p>
        <label>Комментарий мастеру
          <input value={note} onChange={event => setNote(event.target.value)} maxLength={200} placeholder="Необязательно" />
        </label>
        <button type="button" className="primary" disabled={busy} onClick={() => void book()}>
          {busy ? 'Записываем…' : `Записаться · ${price(offer.price)}`}
        </button>
        <p className="hint">Оплата на месте. Отменить можно в разделе «Заказы».</p>
      </div>}
    </div>}

    {detail && detail.reviews.length > 0 && <div className="reviews">
      <h2>Отзывы</h2>
      <ul>{detail.reviews.map(review => <li key={review.id}>
        <strong>★ {review.rating}</strong> <span className="meta">{review.author}, {new Date(review.createdAt).toLocaleDateString('ru-RU')}</span>
        <p>{review.body}</p>
      </li>)}</ul>
    </div>}
  </section>;
}

function Orders({ me, notify }: { me: Me | null; notify: (text: string) => void }) {
  const [items, setItems] = useState<Booking[] | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!me) { setItems([]); return; }
    void api<{ items: Booking[] }>('/api/v1/me/orders').then(data => setItems(data.items)).catch(() => setItems([]));
  }, [me]);
  useEffect(load, [load]);

  if (!me) return <p className="notice">Войдите в профиле, чтобы видеть записи.</p>;

  async function cancel(id: string) {
    try {
      await api(`/api/v1/bookings/${id}/cancel`, { method: 'POST' });
      notify('Запись отменена, время снова свободно');
      load();
    } catch { notify('Отменить не удалось'); }
  }

  return <section>
    <div className="section-title"><h2>Мои записи</h2><span>{items ? items.length : '—'}</span></div>
    {!items && <p className="notice">Загружаем…</p>}
    {items && !items.length && <p className="notice">Пока нет записей. Выберите услугу на главной.</p>}
    <ul className="orders">{items?.map(item => <li key={item.id}>
      <div className="order-head">
        <strong>{item.place.name}</strong>
        <span className={`status ${item.status}`}>{statusLabel[item.status]}</span>
      </div>
      <p className="meta">{item.offer.title} · {dayTime.format(new Date(item.slot.startsAt))} · {price(item.price)}</p>
      {(item.status === 'requested' || item.status === 'confirmed') &&
        <button type="button" onClick={() => void cancel(item.id)}>Отменить</button>}
      {item.status === 'completed' && !item.review && (reviewing === item.id
        ? <ReviewForm bookingId={item.id} onDone={() => { setReviewing(null); load(); }} notify={notify} />
        : <button type="button" onClick={() => setReviewing(item.id)}>Оставить отзыв</button>)}
      {item.review && <p className="meta">{item.review.status === 'pending' ? 'Отзыв на модерации' : item.review.status === 'hidden' ? 'Отзыв скрыт модератором' : `Ваша оценка: ★ ${item.review.rating}`}</p>}
    </li>)}</ul>
  </section>;
}

function ReviewForm({ bookingId, onDone, notify }: { bookingId: string; onDone: () => void; notify: (text: string) => void }) {
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  return <div className="confirm">
    <label>Оценка
      <select value={rating} onChange={event => setRating(Number(event.target.value))}>
        {[5, 4, 3, 2, 1].map(value => <option key={value} value={value}>{value}</option>)}
      </select>
    </label>
    <label>Комментарий
      <input value={body} onChange={event => setBody(event.target.value)} maxLength={500} />
    </label>
    <button type="button" className="primary" onClick={() => {
      void api('/api/v1/reviews', { method: 'POST', body: { bookingId, rating, body } })
        .then(() => { notify('Отзыв отправлен на модерацию'); onDone(); })
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

  const loadPartner = useCallback(() => {
    if (!isPartner) return;
    void api<{ items: Booking[] }>('/api/v1/partner/bookings').then(data => setPartner(data.items)).catch(() => setPartner([]));
  }, [isPartner]);
  useEffect(loadPartner, [loadPartner]);

  if (!me) return <section className="login">
    <h1>Вход</h1>
    <p className="meta">Демо-стенд: код показывается на экране. На телефоне СМС не подключены.</p>
    <label>Телефон
      <input value={phone} onChange={event => setPhone(event.target.value)} inputMode="tel" placeholder="+79000000001" />
    </label>
    <button type="button" onClick={() => {
      void api<{ demoCode?: string }>('/api/v1/auth/code', { method: 'POST', body: { phone } })
        .then(data => { setDemoCode(data.demoCode ?? null); notify('Код готов'); })
        .catch(() => notify('Не удалось получить код'));
    }}>Получить код</button>
    {demoCode && <p className="code">Код: <strong>{demoCode}</strong></p>}
    <label>Код из шести цифр
      <input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" maxLength={6} />
    </label>
    <label>Как к вам обращаться
      <input value={name} onChange={event => setName(event.target.value)} maxLength={60} />
    </label>
    <button type="button" className="primary" onClick={() => {
      void api('/api/v1/auth/session', { method: 'POST', body: { phone, code, displayName: name } })
        .then(() => { refreshMe(); notify('Вы вошли'); })
        .catch(() => notify('Проверьте код'));
    }}>Войти</button>
  </section>;

  return <section className="profile">
    <div className="section-title"><h2>{me.user.displayName}</h2><span>{me.user.phone}</span></div>
    <p className="meta">Роли: {me.roles.map(role => role.role).join(', ')}</p>
    <button type="button" onClick={() => {
      void api('/api/v1/auth/logout', { method: 'POST' }).then(() => { refreshMe(); notify('Вы вышли'); });
    }}>Выйти</button>

    {isPartner && <div className="partner">
      <h2>Кабинет партнёра</h2>
      {!partner ? <p className="notice">Загружаем заявки…</p>
        : !partner.length ? <p className="notice">Заявок нет.</p>
          : <ul className="orders">{partner.map(item => <li key={item.id}>
            <div className="order-head"><strong>{item.place.name}</strong>
              <span className={`status ${item.status}`}>{statusLabel[item.status]}</span></div>
            <p className="meta">{item.offer.title} · {dayTime.format(new Date(item.slot.startsAt))} · {item.note || 'без комментария'}</p>
            {item.status === 'requested' && <div className="row">
              <button type="button" className="primary" onClick={() => void api(`/api/v1/bookings/${item.id}/confirm`, { method: 'POST' }).then(() => { notify('Подтверждено'); loadPartner(); })}>Подтвердить</button>
            </div>}
            {item.status === 'confirmed' && <button type="button" onClick={() => void api(`/api/v1/bookings/${item.id}/complete`, { method: 'POST' }).then(() => { notify('Запись закрыта'); loadPartner(); })}>Завершить</button>}
          </li>)}</ul>}
    </div>}

    {isPartner && <PartnerPlaces notify={notify} />}
    {isOperator && <Moderation notify={notify} />}
    <Notifications />
  </section>;
}

function PartnerPlaces({ notify }: { notify: (text: string) => void }) {
  const [items, setItems] = useState<PartnerPlace[] | null>(null);
  const [editing, setEditing] = useState<PartnerPlace | null>(null);
  const [openOffer, setOpenOffer] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: '', price: '1000', duration: '60' });
  const [busy, setBusy] = useState(false);

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

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(error => console.error('PWA registration failed', error));
}
