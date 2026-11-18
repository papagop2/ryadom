import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
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
  review: { id: string; rating: number } | null;
};
type Me = { user: { id: string; phone: string; displayName: string }; roles: { role: string; partner_id: string | null }[]; partnerIds: string[] };

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

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf()) },
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
    <header className="mast">
      <a href="/" className="wordmark">рядом<span>.</span></a>
      <span className="badge">Демо-стенд</span>
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
      void fetch(`/api/v1/places?${params}`, { signal: controller.signal, cache: 'no-store' })
        .then(async response => {
          if (!response.ok) throw new Error('catalogue');
          setItems((await response.json()).items);
        })
        .catch(() => { if (!controller.signal.aborted) { setItems(null); setError(true); } });
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [category, district, query]);

  if (open) return <PlaceScreen place={open} onBack={() => setOpen(null)} notify={notify} />;

  const points = useMemo(() => {
    if (!items?.length) return [];
    const lats = items.map(item => item.location.lat);
    const lngs = items.map(item => item.location.lng);
    const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
    const [minLng, maxLng] = [Math.min(...lngs), Math.max(...lngs)];
    return items.map(item => ({
      item,
      x: maxLng === minLng ? 50 : 8 + ((item.location.lng - minLng) / (maxLng - minLng)) * 84,
      y: maxLat === minLat ? 50 : 92 - ((item.location.lat - minLat) / (maxLat - minLat)) * 84,
    }));
  }, [items]);

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

    {withMap && <div className="map" role="img" aria-label="Схема расположения заведений">
      {points.map(({ item, x, y }) => <button key={item.id} type="button" className="pin" style={{ left: `${x}%`, top: `${y}%` }}
        onClick={() => setOpen(item)} title={item.name}><span>{item.name.slice(0, 1)}</span></button>)}
      <p className="map-hint">Схема без внешней карты. Нажмите метку, чтобы открыть карточку.</p>
    </div>}

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
      {item.review && <p className="meta">Ваша оценка: ★ {item.review.rating}</p>}
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
        .then(() => { notify('Спасибо за отзыв'); onDone(); })
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

  return <section>
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
  </section>;
}

createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(error => console.error('PWA registration failed', error));
}
