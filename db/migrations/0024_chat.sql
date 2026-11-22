-- Чат по заказу: одна переписка на сущность (запись, заказ, поездка, заявка).
-- Доступ считается по самой сущности; отдельные участники не дублируются.
begin;

create table chat_threads (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('booking', 'shop_order', 'trip', 'service_request')),
  subject_id       uuid not null,
  client_user_id   uuid not null references users(id) on delete cascade,
  partner_id       uuid references partners(id) on delete set null,
  provider_user_id uuid references users(id) on delete set null,
  status           text not null default 'open' check (status in ('open', 'closed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_message_at  timestamptz,
  unique (kind, subject_id),
  check (partner_id is not null or provider_user_id is not null)
);
create index chat_threads_client_idx on chat_threads (client_user_id, coalesce(last_message_at, created_at) desc);
create index chat_threads_partner_idx on chat_threads (partner_id, coalesce(last_message_at, created_at) desc) where partner_id is not null;
create index chat_threads_provider_idx on chat_threads (provider_user_id, coalesce(last_message_at, created_at) desc) where provider_user_id is not null;

create table chat_messages (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references chat_threads(id) on delete cascade,
  sender_user_id uuid not null references users(id) on delete cascade,
  body         text not null check (length(btrim(body)) between 1 and 1000),
  quick_reply  text check (quick_reply is null or length(quick_reply) <= 60),
  status       text not null default 'visible' check (status in ('visible', 'hidden')),
  created_at   timestamptz not null default now(),
  hidden_at    timestamptz,
  hidden_by    uuid references users(id) on delete set null,
  moderation_note text not null default '' check (length(moderation_note) <= 300)
);
create index chat_messages_thread_idx on chat_messages (thread_id, created_at);
create index chat_messages_sender_idx on chat_messages (sender_user_id, created_at desc);

create table chat_reads (
  thread_id     uuid not null references chat_threads(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  last_read_at  timestamptz not null default now(),
  primary key (thread_id, user_id)
);

create table chat_reports (
  id                uuid primary key default gen_random_uuid(),
  message_id        uuid not null references chat_messages(id) on delete cascade,
  reporter_user_id  uuid not null references users(id) on delete cascade,
  reason            text not null default '' check (length(reason) <= 300),
  status            text not null default 'open' check (status in ('open', 'resolved')),
  created_at        timestamptz not null default now(),
  resolved_by       uuid references users(id) on delete set null,
  resolved_at       timestamptz,
  unique (message_id, reporter_user_id)
);
create index chat_reports_open_idx on chat_reports (created_at desc) where status = 'open';

commit;
