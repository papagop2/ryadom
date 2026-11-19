-- Этап 4: поездки. Закрытый пилот: клиент заказывает, водитель принимает,
-- оператор может назначить вручную. Оплата на месте, без платёжного провайдера.
begin;

alter type user_role add value if not exists 'driver';

create table driver_profiles (
  user_id      uuid primary key references users(id) on delete cascade,
  car_model    text not null default '',
  plate        text not null default '',
  is_online    boolean not null default true,
  rating_avg   numeric(3, 2),
  rides_count  integer not null default 0,
  created_at   timestamptz not null default now()
);

create type trip_status as enum ('requested', 'assigned', 'arrived', 'in_progress', 'completed', 'cancelled');

create table trips (
  id              uuid primary key default gen_random_uuid(),
  client_user_id  uuid not null references users(id) on delete restrict,
  driver_user_id  uuid references users(id) on delete set null,
  status          trip_status not null default 'requested',
  from_label      text not null check (length(from_label) between 1 and 160),
  from_lat        numeric(9, 6) not null check (from_lat between -90 and 90),
  from_lng        numeric(9, 6) not null check (from_lng between -180 and 180),
  to_label        text not null check (length(to_label) between 1 and 160),
  to_lat          numeric(9, 6) not null check (to_lat between -90 and 90),
  to_lng          numeric(9, 6) not null check (to_lng between -180 and 180),
  distance_km     numeric(6, 2) not null check (distance_km >= 0),
  duration_min    integer not null check (duration_min > 0),
  price_cents     integer not null check (price_cents >= 0),
  currency        char(3) not null default 'RUB',
  idempotency_key text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz
);

-- Один активный заказ у клиента и одна активная поездка у водителя.
create unique index trips_client_active_uq on trips (client_user_id)
  where status in ('requested', 'assigned', 'arrived', 'in_progress');
create unique index trips_driver_active_uq on trips (driver_user_id)
  where driver_user_id is not null and status in ('assigned', 'arrived', 'in_progress');
create unique index trips_client_idem_uq on trips (client_user_id, idempotency_key)
  where idempotency_key is not null;
create index trips_status_idx on trips (status, created_at desc);
create index trips_driver_idx on trips (driver_user_id, created_at desc);

create table trip_events (
  id          bigserial primary key,
  trip_id     uuid not null references trips(id) on delete cascade,
  status      trip_status not null,
  actor_user_id uuid references users(id) on delete set null,
  note        text not null default '',
  created_at  timestamptz not null default now()
);
create index trip_events_trip_idx on trip_events (trip_id, created_at);

commit;
