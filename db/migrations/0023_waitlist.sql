-- Лист ожидания: клиент просит сообщить, когда освободится окно на услугу.
-- Одна активная заявка на пару (клиент, услуга); дата необязательна.
begin;

create table waitlist_entries (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  offer_id       uuid not null references offers(id) on delete cascade,
  preferred_date date,
  status         text not null default 'waiting'
                 check (status in ('waiting', 'notified', 'converted', 'cancelled')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  notified_at    timestamptz,
  expires_at     timestamptz not null default now() + interval '30 days'
);

create unique index waitlist_waiting_uq on waitlist_entries (user_id, offer_id)
  where status = 'waiting';
create index waitlist_offer_idx on waitlist_entries (offer_id, status, preferred_date);
create index waitlist_user_idx on waitlist_entries (user_id, created_at desc);
create index waitlist_expiry_idx on waitlist_entries (expires_at) where status in ('waiting', 'notified');

commit;
