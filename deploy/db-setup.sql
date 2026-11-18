-- «Рядом»: создание ролей и базы. Выполнять суперпользователем postgres.
-- Пароли не хранить в репозитории: передать через psql-переменные, например
--   psql -U postgres -v migrator_password='...' -v app_password='...' -f deploy/db-setup.sql
-- Скрипт идемпотентен: повторный запуск не падает на существующих объектах.

\set ON_ERROR_STOP on

-- Роль миграций: владелец схемы, нужна только для db/migrate.mjs.
select format('create role rjadom_migrator login password %L', :'migrator_password')
where not exists (select 1 from pg_roles where rolname = 'rjadom_migrator')\gexec
select format('alter role rjadom_migrator with login password %L', :'migrator_password')\gexec

-- Роль приложения: без владения и без права менять схему, только DML.
select format('create role rjadom_app login password %L', :'app_password')
where not exists (select 1 from pg_roles where rolname = 'rjadom_app')\gexec
select format('alter role rjadom_app with login password %L', :'app_password')\gexec

select format('create database rjadom owner rjadom_migrator encoding %L', 'UTF8')
where not exists (select 1 from pg_database where datname = 'rjadom')\gexec

-- Публичный CONNECT отзывается ниже, поэтому роли получают его явно.
grant connect on database rjadom to rjadom_migrator, rjadom_app;

\connect rjadom

-- Схема принадлежит мигратору, приложение получает только работу с данными.
alter schema public owner to rjadom_migrator;
grant usage on schema public to rjadom_app;
alter default privileges for role rjadom_migrator in schema public
  grant select, insert, update, delete on tables to rjadom_app;
alter default privileges for role rjadom_migrator in schema public
  grant usage, select on sequences to rjadom_app;
-- Уже созданные таблицы (если скрипт запускают после миграций).
grant select, insert, update, delete on all tables in schema public to rjadom_app;
grant usage, select on all sequences in schema public to rjadom_app;

-- Приложению не нужен и не должен быть доступен DDL.
revoke create on schema public from rjadom_app;
revoke all on database rjadom from public;
