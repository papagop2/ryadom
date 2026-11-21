-- Штампы лояльности: партнёр задаёт программу, визит автоматически добавляет
-- штамп, награда выдаётся на кассе. Деньги не участвуют.
begin;

create table loyalty_programs (
  place_id     uuid primary key references places(id) on delete cascade,
  is_active    boolean not null default true,
  goal         smallint not null default 5 check (goal between 1 and 50),
  reward_title text not null default 'Подарок' check (length(reward_title) between 1 and 120),
  reward_note  text not null default '' check (length(reward_note) <= 300),
  updated_at   timestamptz not null default now()
);

create table loyalty_cards (
  user_id           uuid not null references users(id) on delete cascade,
  place_id          uuid not null references places(id) on delete cascade,
  stamps            smallint not null default 0 check (stamps >= 0),
  total_visits      integer not null default 0 check (total_visits >= 0),
  rewards_available smallint not null default 0 check (rewards_available >= 0),
  last_stamp_at     timestamptz,
  created_at        timestamptz not null default now(),
  primary key (user_id, place_id)
);
create index loyalty_cards_place_idx on loyalty_cards (place_id, last_stamp_at desc);

create table loyalty_events (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  place_id   uuid not null references places(id) on delete cascade,
  delta      smallint not null,
  kind       text not null check (kind in ('stamp', 'reward', 'adjust')),
  source     text not null,
  source_id  uuid,
  created_at timestamptz not null default now()
);
create unique index loyalty_events_source_uq on loyalty_events (source, source_id)
  where source_id is not null;
create index loyalty_events_card_idx on loyalty_events (user_id, place_id, created_at desc);

create or replace function award_loyalty_stamp() returns trigger
language plpgsql as $$
declare
  v_place uuid;
  v_user uuid;
  v_goal smallint;
  v_event bigint;
  v_source text := TG_ARGV[0];
begin
  if TG_TABLE_NAME = 'bookings' then
    select o.place_id, b.client_user_id into v_place, v_user
    from bookings b
    join availability_slots s on s.id = b.slot_id
    join offers o on o.id = s.offer_id
    where b.id = new.id;
  elsif TG_TABLE_NAME = 'shop_orders' then
    v_place := new.place_id;
    v_user := new.client_user_id;
  elsif TG_TABLE_NAME = 'queue_tickets' then
    v_place := new.place_id;
    v_user := new.client_user_id;
  end if;
  if v_place is null or v_user is null then return new; end if;

  select goal into v_goal from loyalty_programs where place_id = v_place and is_active;
  if v_goal is null then return new; end if;

  insert into loyalty_events (user_id, place_id, delta, kind, source, source_id)
  values (v_user, v_place, 1, 'stamp', v_source, new.id)
  on conflict (source, source_id) where source_id is not null do nothing
  returning id into v_event;
  if v_event is null then return new; end if;

  insert into loyalty_cards (user_id, place_id, stamps, total_visits, rewards_available, last_stamp_at)
  values (v_user, v_place, case when v_goal <= 1 then 0 else 1 end, 1,
          case when v_goal <= 1 then 1 else 0 end, now())
  on conflict (user_id, place_id) do update set
    stamps = case when loyalty_cards.stamps + 1 >= v_goal then 0 else loyalty_cards.stamps + 1 end,
    total_visits = loyalty_cards.total_visits + 1,
    rewards_available = loyalty_cards.rewards_available
      + case when loyalty_cards.stamps + 1 >= v_goal then 1 else 0 end,
    last_stamp_at = now();
  return new;
end $$;

create trigger bookings_loyalty after update of status on bookings
  for each row when (new.status = 'completed' and old.status is distinct from 'completed')
  execute function award_loyalty_stamp('booking');
create trigger shop_orders_loyalty after update of status on shop_orders
  for each row when (new.status = 'completed' and old.status is distinct from 'completed')
  execute function award_loyalty_stamp('shop_order');
create trigger queue_tickets_loyalty after update of status on queue_tickets
  for each row when (new.status = 'done' and old.status is distinct from 'done')
  execute function award_loyalty_stamp('queue_ticket');

commit;
