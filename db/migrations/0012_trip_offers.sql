-- Цена поездки договорная: клиент создаёт заказ без суммы, водители предлагают
-- свою цену, клиент выбирает предложение. Классы авто и фиксированный тариф
-- убираем.
begin;

alter table trips alter column price_cents drop not null;
alter table trips drop constraint if exists trips_tariff_check;
alter table trips drop column if exists tariff;

create table trip_offers (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid not null references trips(id) on delete cascade,
  driver_user_id  uuid not null references users(id) on delete cascade,
  price_cents     integer not null check (price_cents between 5000 and 10000000),
  eta_min         integer check (eta_min between 1 and 180),
  message         text not null default '' check (length(message) <= 200),
  status          text not null default 'pending'
                  check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Один актуальный оффер от водителя на заказ и только один выбранный оффер.
create unique index trip_offers_driver_uq on trip_offers (trip_id, driver_user_id);
create unique index trip_offers_accepted_uq on trip_offers (trip_id) where status = 'accepted';
create index trip_offers_trip_status_idx on trip_offers (trip_id, status, created_at);

commit;
