-- Живая очередь для локальных сервисов: клиент берёт номер, партнёр вызывает
-- следующего и закрывает визит. Один активный номер на клиента в заведении.
begin;

create type queue_ticket_status as enum ('waiting', 'called', 'serving', 'done', 'cancelled', 'no_show');

create table queue_settings (
  place_id    uuid primary key references places(id) on delete cascade,
  is_active   boolean not null default true,
  avg_minutes smallint not null default 10 check (avg_minutes between 1 and 180),
  notice      text not null default '' check (length(notice) <= 200),
  updated_at  timestamptz not null default now()
);

create table queue_days (
  place_id    uuid not null references places(id) on delete cascade,
  day         date not null,
  last_number integer not null default 0 check (last_number >= 0),
  primary key (place_id, day)
);

create table queue_tickets (
  id             uuid primary key default gen_random_uuid(),
  place_id       uuid not null references places(id) on delete cascade,
  client_user_id uuid not null references users(id) on delete restrict,
  day            date not null,
  number         integer not null check (number > 0),
  status         queue_ticket_status not null default 'waiting',
  note           text not null default '' check (length(note) <= 200),
  created_at     timestamptz not null default now(),
  called_at      timestamptz,
  closed_at      timestamptz,
  unique (place_id, day, number)
);
create unique index queue_tickets_active_uq
  on queue_tickets (place_id, client_user_id)
  where status in ('waiting', 'called', 'serving');
create index queue_tickets_place_day_idx
  on queue_tickets (place_id, day, status, number);
create index queue_tickets_client_idx
  on queue_tickets (client_user_id, created_at desc);

commit;
