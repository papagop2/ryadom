-- Часы работы: одна строка на день + произвольные интервалы (перерыв — второй
-- интервал, ночная смена — закрытие меньше открытия). Время хранится в часовом
-- поясе города; глобальный «открыто сейчас» считается по нему, а не по серверу.
begin;

alter table cities add column timezone text not null default 'Asia/Irkutsk'
  check (length(timezone) between 3 and 60);
update cities set timezone = 'Europe/Moscow' where slug = 'demograd';

create table place_hours (
  place_id  uuid not null references places(id) on delete cascade,
  weekday   smallint not null check (weekday between 0 and 6), -- 0 = Пн
  is_closed boolean not null default false,
  is_24h    boolean not null default false,
  primary key (place_id, weekday),
  check (not (is_closed and is_24h))
);

create table place_hour_intervals (
  place_id  uuid not null,
  weekday   smallint not null,
  position  smallint not null check (position between 0 and 7),
  opens_at  time not null,
  closes_at time not null,
  primary key (place_id, weekday, position),
  foreign key (place_id, weekday) references place_hours(place_id, weekday) on delete cascade,
  check (opens_at <> closes_at)
);

create index place_hours_open_idx on place_hours (weekday, is_closed, is_24h);

-- Снимок 2ГИС уже содержит рабочие часы; переносим их без потери перерывов.
with days(weekday, key) as (
  values (0, 'Mon'), (1, 'Tue'), (2, 'Wed'), (3, 'Thu'),
         (4, 'Fri'), (5, 'Sat'), (6, 'Sun')
)
insert into place_hours (place_id, weekday, is_closed, is_24h)
select p.id, d.weekday,
       coalesce(jsonb_array_length(p.metadata->'schedule'->d.key->'working_hours'), 0) = 0,
       exists (
         select 1 from jsonb_array_elements(coalesce(p.metadata->'schedule'->d.key->'working_hours', '[]'::jsonb)) w
         where w->>'from' = '00:00' and w->>'to' = '24:00'
       )
from places p cross join days d
where p.metadata ? 'schedule'
on conflict (place_id, weekday) do nothing;

with days(weekday, key) as (
  values (0, 'Mon'), (1, 'Tue'), (2, 'Wed'), (3, 'Thu'),
         (4, 'Fri'), (5, 'Sat'), (6, 'Sun')
)
insert into place_hour_intervals (place_id, weekday, position, opens_at, closes_at)
select p.id, d.weekday, (x.ord - 1)::smallint,
       (case when w->>'from' = '24:00' then '00:00' else w->>'from' end)::time,
       (case when w->>'to' = '24:00' then '00:00' else w->>'to' end)::time
from places p
cross join days d
cross join lateral jsonb_array_elements(
  coalesce(p.metadata->'schedule'->d.key->'working_hours', '[]'::jsonb)
) with ordinality as x(w, ord)
where p.metadata ? 'schedule'
  and not (w->>'from' = '00:00' and w->>'to' = '24:00')
  and w->>'from' <> w->>'to'
on conflict (place_id, weekday, position) do nothing;

-- Свои карточки без структурированных часов получают обычный график,
-- чтобы партнёр мог сразу поправить его в кабинете.
with days(weekday) as (values (0), (1), (2), (3), (4), (5), (6))
insert into place_hours (place_id, weekday, is_closed, is_24h)
select p.id, d.weekday, false, false
from places p cross join days d
where p.source = 'own'
  and not exists (select 1 from place_hours h where h.place_id = p.id)
on conflict (place_id, weekday) do nothing;

with days(weekday) as (values (0), (1), (2), (3), (4), (5), (6))
insert into place_hour_intervals (place_id, weekday, position, opens_at, closes_at)
select p.id, d.weekday, 0,
       (case when d.weekday = 6 then '11:00' else '10:00' end)::time,
       (case when d.weekday = 6 then '18:00' else '20:00' end)::time
from places p cross join days d
where p.source = 'own'
  and not exists (select 1 from place_hour_intervals i where i.place_id = p.id)
on conflict (place_id, weekday, position) do nothing;

commit;
