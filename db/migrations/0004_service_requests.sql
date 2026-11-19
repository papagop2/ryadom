-- Этап 2: частные услуги с выездом. Клиент описывает задачу и бюджет,
-- проверенный партнёр предлагает цену, клиент выбирает предложение.
-- Оплата на месте: цена фиксируется в заявке при выборе предложения.
begin;

create type service_category as enum ('repair', 'cleaning', 'beauty', 'tutoring', 'moving', 'other');
create type service_request_status as enum ('open', 'assigned', 'in_progress', 'completed', 'cancelled', 'expired');
create type service_offer_status as enum ('pending', 'accepted', 'declined', 'withdrawn');

create table service_requests (
  id                uuid primary key default gen_random_uuid(),
  client_user_id    uuid not null references users(id) on delete restrict,
  category          service_category not null,
  title             text not null check (length(title) between 3 and 120),
  description       text not null default '' check (length(description) <= 1500),
  address           text not null check (length(address) between 3 and 240),
  budget_min_cents  integer not null check (budget_min_cents >= 0),
  budget_max_cents  integer not null check (budget_max_cents >= budget_min_cents),
  preferred_from    timestamptz not null,
  preferred_to      timestamptz not null,
  status            service_request_status not null default 'open',
  partner_id        uuid references partners(id) on delete set null,
  accepted_offer_id uuid,
  price_cents       integer check (price_cents >= 0),
  currency          char(3) not null default 'RUB',
  idempotency_key   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  assigned_at       timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz,
  check (preferred_to > preferred_from)
);

create unique index service_requests_client_idem_uq
  on service_requests (client_user_id, idempotency_key) where idempotency_key is not null;
create index service_requests_open_idx on service_requests (category, created_at) where status = 'open';
create index service_requests_client_idx on service_requests (client_user_id, created_at desc);
create index service_requests_partner_idx on service_requests (partner_id, created_at desc)
  where partner_id is not null;

create table service_offers (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references service_requests(id) on delete cascade,
  partner_id  uuid not null references partners(id) on delete cascade,
  created_by  uuid not null references users(id) on delete restrict,
  price_cents integer not null check (price_cents > 0),
  message     text not null default '' check (length(message) <= 1000),
  eta_min     integer check (eta_min between 0 and 1440),
  status      service_offer_status not null default 'pending',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (request_id, partner_id)
);

-- У заявки не может быть двух принятых предложений.
create unique index service_offers_accepted_uq on service_offers (request_id) where status = 'accepted';
create index service_offers_request_idx on service_offers (request_id, created_at);
create index service_offers_partner_idx on service_offers (partner_id, created_at desc);

-- Ссылка на выбранное предложение добавляется после создания таблицы предложений.
alter table service_requests add constraint service_requests_accepted_offer_fk
  foreign key (accepted_offer_id) references service_offers(id) on delete set null
  deferrable initially deferred;

create table service_request_events (
  id            bigserial primary key,
  request_id    uuid not null references service_requests(id) on delete cascade,
  status        service_request_status not null,
  actor_user_id uuid references users(id) on delete set null,
  note          text not null default '',
  created_at    timestamptz not null default now()
);
create index service_request_events_request_idx on service_request_events (request_id, created_at);

commit;
