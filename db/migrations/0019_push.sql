-- Web Push: подписки устройства и отметка о напоминании по записи.
begin;

create table push_subscriptions (
  id           bigserial primary key,
  user_id      uuid not null references users(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text not null default '',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_error   text
);
create index push_subscriptions_user_idx on push_subscriptions (user_id);

alter table bookings add column reminder_sent_at timestamptz;

commit;
