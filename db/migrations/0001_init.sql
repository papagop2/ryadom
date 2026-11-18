-- «Рядом»: начальная схема. Один город, каталог, расписание, запись, отзывы.
-- Миграции применяются db/migrate.mjs; каждая в отдельной транзакции.
begin;

create extension if not exists pgcrypto;

-- Пользователь один на все роли: СМС-код подтверждает телефон.
create table users (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null unique check (phone ~ '^\+7[0-9]{10}$'),
  display_name  text not null check (length(display_name) between 1 and 80),
  created_at    timestamptz not null default now()
);

-- Одноразовые коды входа. Хранится только хеш.
create table login_codes (
  id           bigserial primary key,
  phone        text not null,
  code_hash    text not null,
  attempts     smallint not null default 0,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz
);
create index login_codes_phone_idx on login_codes (phone, created_at desc);

create table sessions (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  csrf_token  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  last_seen   timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

create type partner_status as enum ('pending', 'approved', 'suspended');

create table partners (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  status         partner_status not null default 'pending',
  contact_phone  text,
  created_at     timestamptz not null default now()
);

create type user_role as enum ('client', 'partner', 'operator');

create table memberships (
  user_id     uuid not null references users(id) on delete cascade,
  role        user_role not null,
  partner_id  uuid references partners(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, role)
);
create index memberships_partner_idx on memberships (partner_id) where partner_id is not null;

create type place_category as enum ('salon', 'services', 'food', 'health');

create table places (
  id            uuid primary key default gen_random_uuid(),
  partner_id    uuid not null references partners(id) on delete restrict,
  city          text not null default 'Демоград',
  name          text not null check (length(name) between 1 and 120),
  category      place_category not null,
  district      text not null,
  address       text not null,
  lat           numeric(9, 6) not null check (lat between -90 and 90),
  lng           numeric(9, 6) not null check (lng between -180 and 180),
  about         text not null default '',
  phone         text,
  rating_avg    numeric(3, 2),
  rating_count  integer not null default 0,
  is_published  boolean not null default true,
  created_at    timestamptz not null default now()
);
create index places_category_district_idx on places (category, district) where is_published;
create index places_geo_idx on places (lat, lng) where is_published;

create table offers (
  id           uuid primary key default gen_random_uuid(),
  place_id     uuid not null references places(id) on delete cascade,
  title        text not null check (length(title) between 1 and 120),
  description  text not null default '',
  duration_min integer not null check (duration_min between 5 and 600),
  price_cents  integer not null check (price_cents >= 0),
  currency     char(3) not null default 'RUB',
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create index offers_place_idx on offers (place_id) where is_active;

-- Слот — конкретное окно услуги. На первом этапе вместимость 1.
create table availability_slots (
  id         uuid primary key default gen_random_uuid(),
  offer_id   uuid not null references offers(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  capacity   smallint not null default 1 check (capacity between 1 and 20),
  unique (offer_id, starts_at),
  check (ends_at > starts_at)
);
create index slots_offer_start_idx on availability_slots (offer_id, starts_at);

create type booking_status as enum ('requested', 'confirmed', 'completed', 'cancelled', 'expired');

create table bookings (
  id               uuid primary key default gen_random_uuid(),
  slot_id          uuid not null references availability_slots(id) on delete restrict,
  client_user_id   uuid not null references users(id) on delete restrict,
  status           booking_status not null default 'requested',
  note             text not null default '' check (length(note) <= 500),
  price_cents      integer not null,
  currency         char(3) not null default 'RUB',
  idempotency_key  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Один активный заказ на слот: незавершённые и незаменённые брони исключены.
-- Именно это ограничение, а не проверка в коде, защищает от гонки.
create unique index bookings_active_slot_uq on bookings (slot_id)
  where status in ('requested', 'confirmed');
create unique index bookings_client_idem_uq on bookings (client_user_id, idempotency_key)
  where idempotency_key is not null;
create index bookings_client_idx on bookings (client_user_id, created_at desc);
create index bookings_status_idx on bookings (status, created_at desc);

create table booking_events (
  id          bigserial primary key,
  booking_id  uuid not null references bookings(id) on delete cascade,
  status      booking_status not null,
  actor_user_id uuid references users(id) on delete set null,
  note        text not null default '',
  created_at  timestamptz not null default now()
);
create index booking_events_booking_idx on booking_events (booking_id, created_at);

create type review_status as enum ('pending', 'published', 'hidden');

create table reviews (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null unique references bookings(id) on delete cascade,
  place_id      uuid not null references places(id) on delete cascade,
  author_user_id uuid not null references users(id) on delete cascade,
  rating        smallint not null check (rating between 1 and 5),
  body          text not null default '' check (length(body) <= 1000),
  status        review_status not null default 'published',
  created_at    timestamptz not null default now()
);
create index reviews_place_idx on reviews (place_id, created_at desc) where status = 'published';

-- Внутренние уведомления и outbox: пишутся в той же транзакции, что и событие.
create table notifications (
  id           bigserial primary key,
  user_id      uuid not null references users(id) on delete cascade,
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  -- Внешняя отправка появится на этапе 3; пока null = только внутри приложения.
  delivered_at timestamptz
);
create index notifications_user_idx on notifications (user_id, created_at desc);

commit;
