-- Этап 3: доставка товаров. Зоны задаются партнёром по району,
-- заказ получает фиксированную стоимость доставки, курьер назначается
-- оператором или берёт готовый заказ сам.
begin;

alter type user_role add value if not exists 'courier';
alter type shop_order_status add value if not exists 'out_for_delivery';

create type fulfillment_type as enum ('pickup', 'delivery');
create type delivery_status as enum ('pending', 'assigned', 'picked_up', 'delivered', 'cancelled');

create table courier_profiles (
  user_id          uuid primary key references users(id) on delete cascade,
  transport        text not null default '',
  is_online        boolean not null default true,
  deliveries_count integer not null default 0,
  rating_avg       numeric(3, 2),
  created_at       timestamptz not null default now()
);

create table delivery_zones (
  id                uuid primary key default gen_random_uuid(),
  place_id          uuid not null references places(id) on delete cascade,
  district          text not null check (length(district) between 1 and 60),
  fee_cents         integer not null check (fee_cents >= 0),
  min_order_cents   integer not null default 0 check (min_order_cents >= 0),
  eta_min           integer not null check (eta_min between 5 and 180),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (place_id, district)
);
create index delivery_zones_place_idx on delivery_zones (place_id) where is_active;

alter table shop_orders add column goods_total_cents integer;
update shop_orders set goods_total_cents = total_cents;
alter table shop_orders alter column goods_total_cents set not null;
alter table shop_orders add constraint shop_orders_goods_total_check check (goods_total_cents >= 0);
alter table shop_orders add column fulfillment fulfillment_type not null default 'pickup';
alter table shop_orders add column delivery_address text;
alter table shop_orders add column delivery_district text;
alter table shop_orders add column delivery_fee_cents integer not null default 0
  check (delivery_fee_cents >= 0);

create table delivery_jobs (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null unique references shop_orders(id) on delete cascade,
  courier_user_id uuid references users(id) on delete set null,
  status          delivery_status not null default 'pending',
  address         text not null,
  district        text not null,
  fee_cents       integer not null check (fee_cents >= 0),
  eta_min         integer not null check (eta_min between 5 and 180),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  assigned_at     timestamptz,
  picked_up_at    timestamptz,
  delivered_at    timestamptz,
  cancelled_at    timestamptz
);
create unique index delivery_jobs_courier_active_uq on delivery_jobs (courier_user_id)
  where courier_user_id is not null and status in ('assigned', 'picked_up');
create index delivery_jobs_available_idx on delivery_jobs (status, created_at)
  where status = 'pending';
create index delivery_jobs_courier_idx on delivery_jobs (courier_user_id, created_at desc);

create table delivery_job_events (
  id            bigserial primary key,
  job_id        uuid not null references delivery_jobs(id) on delete cascade,
  status        delivery_status not null,
  actor_user_id uuid references users(id) on delete set null,
  note          text not null default '',
  created_at    timestamptz not null default now()
);
create index delivery_job_events_job_idx on delivery_job_events (job_id, created_at);

commit;
