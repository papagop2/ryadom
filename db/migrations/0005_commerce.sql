-- Этап 2, вторая половина: витрина товаров и самовывоз.
-- Цена и состав заказа фиксируются в shop_order_items; остаток уменьшается
-- в той же транзакции, что и создание заказа.
begin;

create table products (
  id           uuid primary key default gen_random_uuid(),
  place_id     uuid not null references places(id) on delete cascade,
  title        text not null check (length(title) between 1 and 120),
  description  text not null default '' check (length(description) <= 1000),
  price_cents  integer not null check (price_cents > 0),
  currency     char(3) not null default 'RUB',
  stock_qty    integer not null default 0 check (stock_qty >= 0),
  unit         text not null default 'шт' check (length(unit) between 1 and 20),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index products_place_idx on products (place_id, is_active);
create index products_stock_idx on products (place_id) where is_active and stock_qty > 0;

create type shop_order_status as enum ('placed', 'confirmed', 'ready', 'completed', 'cancelled');

create table shop_orders (
  id              uuid primary key default gen_random_uuid(),
  place_id        uuid not null references places(id) on delete restrict,
  client_user_id  uuid not null references users(id) on delete restrict,
  status          shop_order_status not null default 'placed',
  total_cents     integer not null check (total_cents >= 0),
  currency        char(3) not null default 'RUB',
  pickup_code     char(4) not null,
  note            text not null default '' check (length(note) <= 300),
  idempotency_key text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  confirmed_at    timestamptz,
  ready_at        timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz
);
create unique index shop_orders_client_idem_uq
  on shop_orders (client_user_id, idempotency_key) where idempotency_key is not null;
create index shop_orders_client_idx on shop_orders (client_user_id, created_at desc);
create index shop_orders_place_idx on shop_orders (place_id, status, created_at desc);

create table shop_order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references shop_orders(id) on delete cascade,
  product_id        uuid references products(id) on delete set null,
  title             text not null,
  unit              text not null default 'шт',
  unit_price_cents  integer not null check (unit_price_cents >= 0),
  qty               integer not null check (qty > 0),
  total_cents       integer not null check (total_cents >= 0)
);
create index shop_order_items_order_idx on shop_order_items (order_id);

create table shop_order_events (
  id            bigserial primary key,
  order_id      uuid not null references shop_orders(id) on delete cascade,
  status        shop_order_status not null,
  actor_user_id uuid references users(id) on delete set null,
  note          text not null default '',
  created_at    timestamptz not null default now()
);
create index shop_order_events_order_idx on shop_order_events (order_id, created_at);

commit;
