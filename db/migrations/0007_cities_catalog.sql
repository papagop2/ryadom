-- Пилотный город и импортированный каталог 2ГИС.
-- Организации без партнёра доступны только как справочник: карточка, контакты,
-- ссылка на источник и отзывы. Запись и заказы остаются у партнёрских мест.

begin;

create table cities (
  slug        text primary key check (slug ~ '^[a-z0-9-]{2,40}$'),
  name        text not null check (length(name) between 1 and 80),
  region      text not null default '',
  lat         numeric(9, 6) not null check (lat between -90 and 90),
  lng         numeric(9, 6) not null check (lng between -180 and 180),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into cities (slug, name, region, lat, lng)
values ('slyudyanka', 'Слюдянка', 'Иркутская область', 51.659713, 103.706825),
       ('demograd', 'Демоград', 'Демо-регион', 55.755800, 37.617300)
on conflict (slug) do nothing;

alter table places add column city_slug text not null default 'demograd' references cities(slug);
alter table places alter column partner_id drop not null;
alter table places add column source text not null default 'own'
  check (source in ('own', '2gis', 'osm'));
alter table places add column source_id text;
alter table places add column source_url text;
alter table places add column source_reviews_url text;
alter table places add column source_rating numeric(3, 2) check (source_rating between 0 and 5);
alter table places add column source_rating_count integer not null default 0 check (source_rating_count >= 0);
alter table places add column metadata jsonb not null default '{}'::jsonb;
create unique index places_source_uq on places (source, source_id) where source_id is not null;
create index places_city_idx on places (city_slug, category, district) where is_published;
create index places_city_rating_idx on places (city_slug, coalesce(rating_avg, source_rating) desc nulls last) where is_published;

-- Отзыв может быть не только по записи, но и просто от аккаунта «Рядом».
alter table reviews alter column booking_id drop not null;
alter table reviews alter column author_user_id drop not null;
alter table reviews alter column rating drop not null;
alter table reviews add column source text not null default 'own'
  check (source in ('own', '2gis'));
alter table reviews add column external_id text;
alter table reviews add column external_url text;
alter table reviews add column author_name text;
alter table reviews add column author_avatar_url text;
alter table reviews add column published_at timestamptz;
create unique index reviews_external_uq on reviews (place_id, source, external_id)
  where source = '2gis' and external_id is not null;
create unique index reviews_own_place_user_uq on reviews (place_id, author_user_id)
  where source = 'own' and author_user_id is not null;

commit;
