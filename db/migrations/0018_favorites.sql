-- Избранные заведения: личный список клиента, не смешивается с каталогом.
begin;

create table favorites (
  user_id    uuid not null references users(id) on delete cascade,
  place_id   uuid not null references places(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, place_id)
);

create index favorites_place_idx on favorites (place_id);

commit;
